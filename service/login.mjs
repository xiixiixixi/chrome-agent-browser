// service/login.mjs — ab_login 流程：钥匙串取凭据 → 探测表单 → 填写 → 提交 → 提交监视
//
// 安全主线（对应 README「全自动凭据仓」）：
//   - 入口只有 tabId；凭据由本模块从钥匙串取出后**只在本函数作用域内存活**，
//     经 locator_action 直达扩展填进真实输入框，返回即出作用域（用完即弃）。
//     任何返回值/错误文本/审计条目都不含凭据明文（fill 在审计层天然 [redacted]）。
//   - 防钓鱼第一锁：页面 origin（tab_info 直读，非缓存）必须与某个已存 origin 一致
//     （仅容忍 www. 前缀差异）；不一致/未存 → 返回设置指引，一个页面动作都不发。
//   - 防钓鱼第二锁（轻量）：提交后 POST_SUBMIT_WATCH_MS 内 tab 跳到完全不同的域
//     （非同站后缀）→ 结果标 suspicious:true + 审计 login_suspicious。不拦截——
//     如实报告，供人工复核。
//
// 依赖注入：credentials（service/credentials.mjs 句柄）、audit（可空）。

import { Locator } from './locator.mjs';
import { totpCode } from './totp.mjs';
import { parseOrigin, originsEquivalent, sameSite } from './credentials.mjs';

const POST_SUBMIT_WATCH_MS = 3000;
const NOT_STORED_GUIDANCE = (origin) => `该站点未存凭据。在本机运行 npm run credential -- set ${origin} 存一次，之后全自动`;

/**
 * @param {{credentials: object|null, audit?: object|null}} deps
 * @returns {{login: Function}}
 */
export function createLogin({ credentials, audit = null } = {}) {
  /**
   * @param {{browser: object, tab: object, tabId: number}} args
   * @returns {Promise<object>} 结果对象（绝不含凭据值）
   */
  async function login({ browser, tab, tabId }) {
    // 1. 页面当前 origin（tab_info 直读，绕过句柄缓存——钓鱼锁必须看真实地址）
    const ctx = await browser.user.getTabContext({ tabId });
    const pageOrigin = parseOrigin(ctx.url);
    if (!pageOrigin) {
      return {
        ok: false, reason: 'cannot-parse-origin', url: ctx.url,
        guidance: '当前页面不是 http(s) 地址（或无法解析），无法匹配凭据仓',
      };
    }

    // 2. 防钓鱼第一锁：与已存 origin 精确匹配（容忍 www.）；不匹配零动作
    const stored = await credentials.list();
    const match = stored.find((o) => originsEquivalent(o, pageOrigin.raw));
    if (!match) {
      return {
        ok: false, reason: 'not-stored', origin: pageOrigin.raw, storedCount: stored.length,
        guidance: NOT_STORED_GUIDANCE(pageOrigin.raw),
      };
    }

    // 3. 凭据取到本作用域内存（返回即弃；竞态：list 后被删 → 按未存处理）
    let cred = await credentials.get(match);
    if (!cred) {
      return { ok: false, reason: 'not-stored', origin: pageOrigin.raw, guidance: NOT_STORED_GUIDANCE(pageOrigin.raw) };
    }

    try {
      // 4. 探测登录表单（扩展在页面里找密码框/用户名框/提交按钮；只读命令）
      const det = await tab._cmd('login_detect', { tabId });
      if (!det || det.found !== true) {
        return { ok: false, reason: 'no-login-form', detail: (det && det.reason) || 'unknown', origin: match };
      }

      // 5. 填写：值经 service → 扩展直达页面输入框（不进任何日志/审计明文）
      const filled = [];
      if (det.username && typeof cred.username === 'string' && cred.username) {
        await new Locator(tab, det.username).fill(cred.username);
        filled.push('username');
      }
      if (det.password) {
        await new Locator(tab, det.password).fill(cred.password);
        filled.push('password');
      }
      let totpNote = null;
      if (cred.totp) {
        if (det.totp) {
          const code = totpCode(cred.totp); // 本地生成当前 6 位码，种子不出本进程
          await new Locator(tab, det.totp).fill(code);
          filled.push('totp');
        } else {
          totpNote = 'totp-seed-stored-but-no-field'; // 种子存了但页面没有验证码框
        }
      }

      // 6. 提交
      let submitted = false;
      if (det.submit) {
        await new Locator(tab, det.submit).click();
        submitted = true;
      }

      // 7. 防钓鱼第二锁：提交后窗口期内跳到完全不同的域 → suspicious（不拦，如实报告）
      let suspicious = false;
      let landedOrigin = null;
      if (submitted) {
        await new Promise((r) => setTimeout(r, POST_SUBMIT_WATCH_MS));
        try {
          const after = await browser.user.getTabContext({ tabId });
          const afterOrigin = parseOrigin(after.url);
          if (afterOrigin && !sameSite(pageOrigin.raw, after.url)) {
            suspicious = true;
            landedOrigin = afterOrigin.key; // 归一化 origin，不记带查询串的完整 URL
          }
        } catch { /* tab 已关等：无落点不定罪 */ }
      }

      // 8. 审计 + 返回（filled 只有字段名；无任何凭据值）
      if (audit) audit.recordLogin({ tabId, origin: match, filled, submitted, suspicious, landedOrigin });
      return {
        ok: true, origin: match, filled, submitted,
        ...(totpNote ? { totp: totpNote } : {}),
        ...(suspicious ? { suspicious: true, landedAt: landedOrigin } : {}),
      };
    } finally {
      cred = null; // 显式丢引用：凭据仅存活于本次调用
    }
  }

  return { login };
}
