// service/policy.mjs — 策略门（对照规格书 §11 精神：默认拒绝危险面 + 人类确认）
//
// 务实实现：
//   - navigate：blockedUrlPatterns 通配匹配（fnmatch 风格 * ?；尾缀 "/*" 同时匹配裸前缀）
//   - tab_create：maxTabsPerSession 上限
//   - download_open / cdp：confirmActions / confirmCdp 需要人工确认
//   - webmcp_invoke：页面申报的非只读工具需确认（页面内容不可信）
//   - cua_action：屏幕操作按键的危险组合（默认 cmd+q / cmd+w，confirmCuaKeys 可配）需确认
// 确认流程：check() 返回 {needConfirmation:true, token}；policy.approve(token) 批准后，
// 带 {confirmationToken: token} 重试同一动作即放行（token 一次性、内存保存 5 分钟）。
// 审计（v0.3.1）：构造时可传 {audit}，approve 成功即留痕一条 policy_approve 事件。

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'policy-defaults.json');
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** fnmatch 风格通配 → RegExp（'chrome://settings/*' → ^chrome://settings/.*$）。 */
export function wildcardToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** 模式匹配 URL；尾缀 '/*' 视为「该前缀整个站点」（裸前缀也拦）。 */
export function wildcardMatch(pattern, url) {
  const p = String(pattern);
  const u = String(url ?? '');
  if (p.endsWith('/*')) {
    const base = p.slice(0, -2);
    if (u === base || u.startsWith(`${base}/`) || u.startsWith(`${base}?`)) return true;
  }
  return wildcardToRegExp(p).test(u);
}

export class Policy {
  constructor(rules = {}, { audit = null } = {}) {
    this.audit = audit; // approve 成功留痕（service/audit.mjs）
    this.rules = {
      blockedUrlPatterns: Array.isArray(rules.blockedUrlPatterns) ? rules.blockedUrlPatterns : [],
      confirmActions: Array.isArray(rules.confirmActions) ? rules.confirmActions : [],
      confirmCdp: Array.isArray(rules.confirmCdp) ? rules.confirmCdp : [],
      // cua_key 危险组合键（"cmd+q" 风格；默认退程序/关窗需确认，其余组合直行）
      confirmCuaKeys: Array.isArray(rules.confirmCuaKeys) ? rules.confirmCuaKeys.map(String) : ['cmd+q', 'cmd+w'],
      // 幽魂光标叠加（AI 动手位置可见化；默认开，关掉后服务侧一切叠加调用跳过）
      cuaOverlay: typeof rules.cuaOverlay === 'boolean' ? rules.cuaOverlay : true,
      maxTabsPerSession: Number.isFinite(rules.maxTabsPerSession) ? rules.maxTabsPerSession : Infinity,
    };
    this.blockedRes = null; // 惰性编译
    this._tokens = new Map(); // token -> {kind, description, approved, expiresAt}
  }

  /**
   * policy.check({kind, url?, method?, sessionTabs?, downloadId?}, {confirmationToken?}) →
   *   {allowed:true} | {allowed:false, reason, code:'POLICY_BLOCKED'|'LIMIT'}
   *   | {needConfirmation:true, description, token}
   */
  check(input, opts = {}) {
    const kind = input?.kind;
    if (kind === 'navigate') {
      if (this._blocked(input.url)) {
        return { allowed: false, code: 'POLICY_BLOCKED', reason: `navigate blocked by policy: ${input.url}` };
      }
      return { allowed: true };
    }
    if (kind === 'tab_create') {
      const n = Number(input.sessionTabs ?? 0);
      if (n >= this.rules.maxTabsPerSession) {
        return { allowed: false, code: 'LIMIT', reason: `session tab limit reached (${this.rules.maxTabsPerSession})` };
      }
      return { allowed: true };
    }
    if (kind === 'download_open') {
      if (this.rules.confirmActions.includes('download_open')) {
        return this._confirm('download_open', `Open downloaded file in the system viewer (downloadId=${input.downloadId ?? '?'})`, input, opts);
      }
      return { allowed: true };
    }
    if (kind === 'cdp') {
      if (this.rules.confirmCdp.includes(input.method)) {
        return this._confirm('cdp', `CDP method requires confirmation: ${input.method}`, input, opts);
      }
      return { allowed: true };
    }
    if (kind === 'webmcp_invoke') {
      // 页面自声明工具：页面内容不可信，readOnly 标注之外的动作（写状态/提交/下单等）需人工确认
      if (input.readOnly === true) return { allowed: true };
      if (this.rules.confirmActions.includes('webmcp_invoke')) {
        const name = String(input.name ?? '?');
        const desc = String(input.description ?? '').slice(0, 200);
        return this._confirm(
          'webmcp_invoke',
          `调用页面申报的非只读 WebMCP 工具「${name}」${desc ? `：${desc}` : ''}（该工具由网页自己声明，可能修改页面/站点状态）`,
          input,
          opts,
        );
      }
      return { allowed: true };
    }
    if (kind === 'cua_action') {
      // 屏幕操作：默认只有 cua_key 的危险组合键（cmd+q 退程序 / cmd+w 关窗）需确认，
      // 其余动作（点击/输入/切前台）直行——它们已在审计与物理验证覆盖之下
      if (input.tool === 'cua_key' && this.rules.confirmCuaKeys.includes(input.combo)) {
        return this._confirm('cua_action', `屏幕按键组合 ${input.combo}（可能退出应用/关闭窗口）需人工确认`, input, opts);
      }
      return { allowed: true };
    }
    // fail-closed：未知 kind 一律拒绝（规格书 §11 精神）
    return { allowed: false, code: 'POLICY_BLOCKED', reason: `unknown policy kind: ${String(kind)}` };
  }

  /** 批准一个待确认动作（5 分钟内有效，单次使用）。 */
  approve(token) {
    const rec = typeof token === 'string' ? this._tokens.get(token) : null;
    if (!rec || rec.expiresAt <= Date.now()) return { ok: false, reason: 'unknown or expired token' };
    rec.approved = true;
    if (this.audit) this.audit.recordApprove(rec.description); // 确认事件留痕（失败自吞）
    return { ok: true, description: rec.description };
  }

  _blocked(url) {
    if (!this.blockedRes) this.blockedRes = this.rules.blockedUrlPatterns.map(wildcardToRegExp);
    if (typeof url !== 'string') return false;
    return this.rules.blockedUrlPatterns.some((p) => wildcardMatch(p, url));
  }

  _confirm(kind, description, input, opts) {
    const token = opts.confirmationToken;
    if (typeof token === 'string') {
      const rec = this._tokens.get(token);
      if (rec && rec.kind === kind && rec.approved && rec.expiresAt > Date.now()) {
        this._tokens.delete(token); // 一次性使用
        return { allowed: true };
      }
    }
    const t = createHash('sha256')
      .update(`${JSON.stringify(this._stableAction(input))}:${Date.now()}:${randomBytes(8).toString('hex')}`)
      .digest('hex');
    this._gc();
    this._tokens.set(t, { kind, description, approved: false, expiresAt: Date.now() + TOKEN_TTL_MS });
    return { needConfirmation: true, description, token: t };
  }

  _stableAction(input) {
    const out = { kind: input.kind };
    for (const k of ['url', 'method', 'downloadId', 'name', 'combo']) if (input[k] !== undefined) out[k] = input[k];
    return out;
  }

  _gc() {
    const now = Date.now();
    for (const [t, rec] of this._tokens) if (rec.expiresAt <= now) this._tokens.delete(t);
  }
}

/** 从 JSON 文件加载策略；path 为空时用内置默认 policy-defaults.json。opts.audit 透传给 Policy。 */
export function loadPolicy(path, opts = {}) {
  const file = path ?? DEFAULTS_PATH;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot load policy file ${file}: ${err.message}`);
  }
  return new Policy(raw, opts);
}
