// service/audit.mjs — 审计日志（本地留痕 + 查询）
//
// 目的：AI 每次对浏览器「动手」（有副作用的命令）都在本地留一条流水账，一条命令
// （ab_audit）随时翻账。纯本地 JSONL 文件，零网络。
//
// 记录点（单一咽喉）：service/connection.mjs 的 BrowserConnection.cmd() —— 所有出站
// 命令必经之处；这里按 AUDITED_COMMANDS 白名单过滤，只记「有副作用」的命令。读类
// 命令（*_info、*_get、open_tabs、history、list、cdp_events、webmcp_list_tools、
// screenshot、element_screenshot 等）一概不记。
//
// 行格式（每行一个 JSON）：{ts, cmd, tabId?, session?, paramsLite, redacted?}
//   - ts：ISO 毫秒；cmd：命令名；tabId/session 出站参数里有才记。
//   - paramsLite：只留关键参数，值脱敏——locator_action 的 value（fill/press 输入，
//     可能含密码）与 js dialog 的 promptText 一律记 "[redacted]" 并置 redacted:true；
//     tab_cdp_call 的 params 只记键名列表（paramKeys）；webmcp_invoke_tool 只记工具名；
//     download_open 只记 downloadId；cua_* 屏幕操作走专用 recordCua（cmd=cua_<tool>，
//     只记目标摘要——xy 点击记坐标、type 记 [redacted] 与长度、key 记键名）。
//   - policy.approve(token) 成功时记一条 {cmd:"policy_approve", paramsLite:{description}}。
//
// 存储：<包根>/audit/audit-YYYYMMDD.jsonl（追加写）；单文件超 maxFileBytes（默认 5MB）
//   轮转成 .1（仅保留一代）；按 mtime 保留最近 retentionDays（默认 14）天，构造时清理，
//   失败一律吞掉不影响主流程。audit/ 已加入 .gitignore。
//
// 关闭开关：host-config.json 可选字段 auditDisabled:true，或环境变量 CAB_AUDIT=off
//   （off/0/false/no 均可）。默认开启；关闭时 query 返回 {disabled:true}。
//
// 多实例共享：frontend 模式与 service 模式跑在同一个包目录，审计落盘同一批文件，
//   查询天然读到全部进程的流水（追加写按行原子，本地用途足够）。

import process from 'node:process';
import {
  appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = join(ROOT, 'audit');
const DEFAULT_CONFIG_PATH = join(ROOT, 'host', 'host-config.json');
const FILE_RE = /^audit-(\d{8})\.jsonl(?:\.(\d+))?$/;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const OFF_ENV_RE = /^(off|0|false|no)$/i;
const REDACTED = '[redacted]';

/** 有副作用才入档的命令白名单（element_screenshot 只读，不记）。 */
export const AUDITED_COMMANDS = new Set([
  'tab_create', 'tab_close', 'tab_claim',
  'navigate_tab_url', 'navigate_tab_back', 'navigate_tab_forward', 'navigate_tab_reload',
  'locator_action',
  'tab_handle_js_dialog',
  'browser_viewport_set', 'browser_visibility_set',
  'webmcp_invoke_tool', 'download_open', 'tab_cdp_call',
  'session_finalize', 'tab_mark',
]);

// 各命令 paramsLite 里「原样保留」（截断字符串）的参数键；tabId/sessionId 提到条目顶层。
const PARAM_KEYS = {
  tab_create: ['url', 'background', 'windowId'],
  tab_claim: ['providerTabId', 'title', 'url'],
  navigate_tab_url: ['url'],
  tab_mark: ['status'],
  browser_viewport_set: ['width', 'height'],
  browser_visibility_set: ['visible'],
  webmcp_invoke_tool: ['name'], // 只记工具名（args 可能含敏感值）
  download_open: ['downloadId'],
};

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const truncStr = (v, n) => trunc(String(v), n);

function safeJson(v) {
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
}

/** selector 摘要：{kind, value(截断), name?, exact?, first?, nth?}；and 组合的 value 转字符串。 */
function selectorLite(sel) {
  if (!sel || typeof sel !== 'object') return null;
  const o = {};
  if (typeof sel.kind === 'string') o.kind = sel.kind;
  if (sel.value !== undefined) o.value = typeof sel.value === 'string' ? trunc(sel.value, 120) : trunc(safeJson(sel.value), 120);
  if (typeof sel.name === 'string') o.name = trunc(sel.name, 60);
  if (sel.exact !== undefined) o.exact = sel.exact === true;
  if (sel.first === true) o.first = true;
  if (Number.isInteger(sel.nth)) o.nth = sel.nth;
  return Object.keys(o).length ? o : null;
}

/** 命令 → {lite, redacted}：脱敏后的关键参数。 */
function buildLite(cmd, p) {
  const o = {};
  let redacted = false;
  if (cmd === 'locator_action') {
    if (typeof p.action === 'string') o.action = p.action;
    const sel = selectorLite(p.selector);
    if (sel) o.selector = sel;
    if (p.value !== undefined) { o.value = REDACTED; redacted = true; } // fill/press 输入可能含密码
  } else if (cmd === 'tab_handle_js_dialog') {
    if (typeof p.accept === 'boolean') o.accept = p.accept;
    if (p.promptText !== undefined) { o.promptText = REDACTED; redacted = true; }
  } else if (cmd === 'tab_cdp_call') {
    if (typeof p.method === 'string') o.method = p.method;
    if (p.params && typeof p.params === 'object' && !Array.isArray(p.params)) o.paramKeys = Object.keys(p.params);
  } else if (cmd === 'session_finalize') {
    if (Array.isArray(p.keepTabIds)) o.keepTabCount = p.keepTabIds.length; // id 列表不整份入档
  } else {
    for (const k of PARAM_KEYS[cmd] ?? []) {
      if (p[k] === undefined) continue;
      o[k] = typeof p[k] === 'string' ? trunc(p[k], k === 'url' ? 500 : 200) : p[k];
    }
  }
  return { lite: o, redacted };
}

function buildEntry(cmd, params) {
  const p = (params && typeof params === 'object') ? params : {};
  const entry = { ts: new Date().toISOString(), cmd };
  if (Number.isInteger(p.tabId)) entry.tabId = p.tabId;
  if (typeof p.sessionId === 'string' && p.sessionId) entry.session = p.sessionId;
  const { lite, redacted } = buildLite(cmd, p);
  entry.paramsLite = lite;
  if (redacted) entry.redacted = true;
  return entry;
}

/** 文件排序键：日期在前；同日轮转档（.1 内容更旧）排在现行文件之前。 */
function fileKey(name) {
  const m = name.match(FILE_RE);
  if (!m) return name;
  const rot = m[2] !== undefined ? Number(m[2]) : Number.MAX_SAFE_INTEGER;
  return `${m[1]}:${String(rot).padStart(10, '0')}`;
}

function readConfigDisabled(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')).auditDisabled === true; } catch { return false; }
}

/**
 * 创建审计实例。
 * @param {object} [opts]
 *   dir           —— 审计目录（默认 <包根>/audit）
 *   maxFileBytes  —— 单文件轮转上限（默认 5MB）
 *   retentionDays —— 保留天数（默认 14，按 mtime）
 *   disabled      —— 显式开关（优先于环境变量与 host-config）
 *   configPath    —— host-config.json 路径（默认 <包根>/host/host-config.json）
 */
export function createAudit(opts = {}) {
  const dir = typeof opts.dir === 'string' && opts.dir ? opts.dir : DEFAULT_DIR;
  const maxFileBytes = Number.isInteger(opts.maxFileBytes) && opts.maxFileBytes > 0 ? opts.maxFileBytes : DEFAULT_MAX_FILE_BYTES;
  const retentionDays = Number.isFinite(opts.retentionDays) && opts.retentionDays >= 0 ? opts.retentionDays : DEFAULT_RETENTION_DAYS;
  const configPath = typeof opts.configPath === 'string' && opts.configPath ? opts.configPath : DEFAULT_CONFIG_PATH;

  // 关闭开关优先级：显式 opts.disabled > 环境变量 CAB_AUDIT > host-config.auditDisabled > 默认开启
  let disabled = false;
  if (typeof opts.disabled === 'boolean') disabled = opts.disabled;
  else if (OFF_ENV_RE.test(String(process.env.CAB_AUDIT ?? ''))) disabled = true;
  else if (readConfigDisabled(configPath)) disabled = true;

  let dirReady = false;

  const audit = {
    disabled,
    dir,

    /** 咽喉点调用：白名单内的副作用命令出站留痕（失败自吞，绝不影响主流程）。 */
    record(cmd, params) {
      if (audit.disabled || !AUDITED_COMMANDS.has(cmd)) return;
      audit._appendLine(JSON.stringify(buildEntry(cmd, params)));
    },

    /** policy.approve(token) 成功后的确认事件留痕。 */
    recordApprove(description) {
      if (audit.disabled) return;
      audit._appendLine(JSON.stringify({
        ts: new Date().toISOString(),
        cmd: 'policy_approve',
        paramsLite: { description: truncStr(description ?? '', 200) },
      }));
    },

    /**
     * ab_login 留痕（v0.3.2）：一条 ab_login（origin + filled 字段名列表——只有字段名，
     * 绝无凭据值；凭据本身的 fill 走 locator_action，那里 value 已记 [redacted]）。
     * suspicious 时追加一条 login_suspicious（from/to 只记 origin，不记带参完整 URL）。
     */
    recordLogin({ tabId, origin, filled, submitted, suspicious, landedOrigin }) {
      if (audit.disabled) return;
      const entry = { ts: new Date().toISOString(), cmd: 'ab_login' };
      if (Number.isInteger(tabId)) entry.tabId = tabId;
      entry.paramsLite = {
        origin: truncStr(origin ?? '', 300),
        filled: Array.isArray(filled) ? filled.filter((f) => typeof f === 'string') : [],
        submitted: submitted === true,
      };
      audit._appendLine(JSON.stringify(entry));
      if (suspicious === true) {
        const sus = { ts: new Date().toISOString(), cmd: 'login_suspicious' };
        if (Number.isInteger(tabId)) sus.tabId = tabId;
        sus.paramsLite = { from: truncStr(origin ?? '', 300), to: truncStr(landedOrigin ?? '', 300) };
        audit._appendLine(JSON.stringify(sus));
      }
    },

    /**
     * cua_* 屏幕操作动作留痕（v0.5.0）：cmd 记 `cua_<tool>`，paramsLite 只留目标摘要——
     * xy 点击记坐标；type 只记长度与 [redacted]（输入可能含密码/私密内容）；key 记键名与
     * 修饰键（键名不是秘密，审计要能回答「按过什么键」）。读类（status/windows/ax_tree/
     * screenshot/verify）不留痕，与浏览器命令只记副作用的原则一致。
     */
    recordCua({ tool, mode, app, pid, role, title, x, y, text, key, modifiers }) {
      if (audit.disabled || typeof tool !== 'string' || !tool) return;
      const lite = {};
      let redacted = false;
      if (mode) lite.mode = mode;
      if (app) lite.app = truncStr(app, 120);
      if (Number.isInteger(pid) && pid > 0) lite.pid = pid;
      if (role) lite.role = truncStr(role, 60);
      if (title) lite.title = truncStr(title, 120);
      if (Number.isFinite(x) && Number.isFinite(y)) { lite.x = x; lite.y = y; }
      if (text !== undefined) {
        lite.chars = typeof text === 'string' ? text.length : 0;
        lite.text = REDACTED;
        redacted = true;
      }
      if (key) {
        lite.key = truncStr(key, 30);
        if (Array.isArray(modifiers) && modifiers.length) lite.modifiers = modifiers.map((m) => truncStr(m, 10));
      }
      const entry = { ts: new Date().toISOString(), cmd: `cua_${tool}`, paramsLite: lite };
      if (redacted) entry.redacted = true;
      audit._appendLine(JSON.stringify(entry));
    },

    /**
     * 查询流水（倒序，最新在前）。
     * @returns {{total:number, entries:object[]}|{disabled:true}}
     */
    query({ limit, cmd, tabId, since, last } = {}) {
      if (audit.disabled) return { disabled: true };
      const lim = Number.isInteger(limit) ? limit : (Number.isInteger(last) ? last : 50);
      const eff = Math.max(1, Math.min(500, lim));
      let sinceMs = null;
      if (since !== undefined && since !== null) {
        sinceMs = Date.parse(String(since));
        if (Number.isNaN(sinceMs)) throw new Error(`since 需为合法 ISO 时间字符串，收到: ${since}`);
      }
      const matched = [];
      try {
        mkdirSync(dir, { recursive: true });
        const names = readdirSync(dir).filter((n) => FILE_RE.test(n)).sort((a, b) => (fileKey(a) < fileKey(b) ? -1 : fileKey(a) > fileKey(b) ? 1 : 0));
        for (const name of names) {
          let text;
          try { text = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
          for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; } // 坏行跳过，查询不炸
            if (!e || typeof e !== 'object') continue;
            if (cmd !== undefined && e.cmd !== cmd) continue;
            if (tabId !== undefined && e.tabId !== tabId) continue;
            if (sinceMs !== null) {
              const t = Date.parse(e.ts);
              if (!Number.isNaN(t) && t < sinceMs) continue; // ts 解析失败的行不按时间剔除
            }
            matched.push(e);
          }
        }
      } catch { /* 读不了就当空（本地文件，正常不该发生） */ }
      matched.reverse(); // 收集序（文件序+行序）即时间序 → 倒序
      return { total: matched.length, entries: matched.slice(0, eff) };
    },

    /** 清理超过保留期的文件（构造时自动执行一次；失败自吞）。 */
    cleanupExpired() {
      try {
        mkdirSync(dir, { recursive: true });
        const cutoff = Date.now() - retentionDays * 86_400_000;
        for (const name of readdirSync(dir)) {
          if (!FILE_RE.test(name)) continue; // 只动自己命名规则的文件
          const full = join(dir, name);
          try { if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true }); } catch { /* 单文件失败跳过 */ }
        }
      } catch { /* 清理失败不影响主流程 */ }
    },

    // ---- 内部 ----

    _appendLine(line) {
      try {
        if (!dirReady) { mkdirSync(dir, { recursive: true }); dirReady = true; }
        const file = join(dir, `audit-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`);
        try {
          if (statSync(file).size >= maxFileBytes) { // 超上限 → 轮转（仅保留一代 .1）
            try { rmSync(`${file}.1`, { force: true }); } catch { /* 无旧档更好 */ }
            renameSync(file, `${file}.1`);
          }
        } catch (err) { if (err.code !== 'ENOENT') throw err; }
        appendFileSync(file, `${line}\n`);
      } catch { dirReady = false; /* 审计失败绝不影响主流程 */ }
    },
  };

  if (!audit.disabled) audit.cleanupExpired(); // 启动清理（关闭时连目录都不建；失败不影响主流程）
  return audit;
}
