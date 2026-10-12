// service/mcp.mjs — MCP 服务器（工具面）
//
// buildMcpServer({ api, policy, connections }) → McpServer 实例（不启动 transport，
// 便于测试注入 InMemoryTransport；入口见 service/mcp-entry.mjs）。
//
// 两层工具面（对照规格书 §13 路线图第 3 条「粗粒度工具 + REPL 双层」）：
//   - ab_* 粗粒度工具：开标签/导航/截图/无障碍树/认领/CDP/下载确认，全部过策略门；
//   - browser_eval：REPL 型工具，node:vm 沙箱内执行 JS，注入 `agent`（createAgentApi
//     的返回对象，即可写 `const t = await (await agent.browsers.getDefault()).tabs.new()`）
//     与 `nodeRepl.write(x)`（收集输出）；不注入 require；console.* 一并收集。
//
// 沙箱边界（诚实声明，README 同步写明）：这是本地受信工具。vm 隔离只覆盖同步执行段
// （干净上下文，无 require/process/Buffer 等 Node 全局），async 续段在宿主事件循环执行；
// 不做严格沙箱逃逸防护（例如经注入对象的原型链可回到宿主——受信场景接受）。
//
// 确认流注意：policy 的确认 token 是一次性的（使用即焚）。api.mjs 的 cdp.send 内部会
// 自行调用 policy.check 并消费 token，因此 ab_cdp 不在工具层预检策略、而是透传
// confirmationToken 并把 api 抛出的 needsConfirmation 错误转成结构化结果；
// ab_download_open 没有对应 api 路径，由工具层直接走 policy + connection.cmd。

import vm from 'node:vm';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CDP_ALLOWLIST } from '../shared/protocol.mjs';

const EVAL_TIMEOUT_MS = 30_000;

// ---------- 小工具：统一可读结果 ----------

/** 结构化 payload → MCP 文本 content（JSON 缩进两格；isError 时标记错误结果）。 */
function textResult(payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const content = [{ type: 'text', text }];
  return isError ? { content, isError: true } : { content };
}

/** JS Error → 可读 payload；有 .code 时保留（LEASE_CONFLICT/TAB_NOT_FOUND 等线缆码）。 */
function errPayload(err) {
  const p = { error: String((err && err.message) || err) };
  if (err && err.code !== undefined) p.code = err.code;
  return p;
}

/** connections 参数归一化：支持 () => conns / ConnectionManager / 数组。 */
function liveConns(connections) {
  if (!connections) return [];
  if (typeof connections === 'function') return connections() ?? [];
  if (typeof connections.liveConnections === 'function') return connections.liveConnections() ?? [];
  if (Array.isArray(connections)) return connections;
  return [];
}

// ---------- browser_eval：结果序列化（尽量 JSON，不行给 String()） ----------

function serializeResult(result) {
  if (result === undefined) return null;
  let s;
  try { s = JSON.stringify(result); } catch { s = undefined; } // 循环引用/BigInt 等
  if (typeof s !== 'string') return String(result);
  try { return JSON.parse(s); } catch { return String(result); }
}

function fmtValue(v) {
  if (typeof v === 'string') return v;
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
}

/**
 * 构建 MCP 服务器（12 个工具）。
 * @param {{api: object, policy?: object|null, connections?: Function|object|Array|null}} opts
 *   api         —— createAgentApi 的返回值（必填）
 *   policy      —— service/policy.mjs 的 Policy 实例（缺省时跳过工具层策略，api 层仍可能拦）
 *   connections —— 取活连接的方式（ab_download_open 需要直连 connection.cmd）
 */
export function buildMcpServer({ api, policy = null, connections = null } = {}) {
  if (!api || typeof api.browsers?.getDefault !== 'function') {
    throw new TypeError('buildMcpServer requires { api } — createAgentApi() 的返回对象');
  }
  const server = new McpServer({ name: 'chrome-agent-browser', version: '0.1.0' });

  // tabId → { browser, tab }：new/claim 时登记；未知 tabId 跨浏览器探测后缓存
  const tabRegistry = new Map();

  const policyCheck = (input, opts) => (policy ? policy.check(input, opts) : { allowed: true });

  /** 解析 tabId 到句柄：优先缓存；否则逐浏览器探测（tab.url() 缓存未命中会打 tab_info，第一个认账的赢）。 */
  async function resolveTab(tabId) {
    const hit = tabRegistry.get(tabId);
    if (hit && !hit.tab._closed) return hit;
    const list = api.browsers.list();
    if (!list.length) { const e = new Error('no browser connected'); e.code = -32000; throw e; }
    let lastErr = null;
    for (const info of list) {
      const browser = api.browsers.get(info.id);
      const tab = browser.tabs.get(tabId);
      try {
        await tab.url(); // TAB_NOT_FOUND 会抛，换下一个浏览器
        const rec = { browser, tab };
        tabRegistry.set(tabId, rec);
        return rec;
      } catch (err) { lastErr = err; }
    }
    throw lastErr ?? new Error(`tab not found: ${tabId}`);
  }

  /** 统一错误兜底：handler 抛错 → isError 文本结果（payload 保留 .code）。 */
  const guard = (fn) => async (args) => {
    try { return await fn(args); } catch (err) { return textResult(errPayload(err), true); }
  };

  // ---- 1. ab_list_browsers ----
  server.registerTool('ab_list_browsers', {
    title: '列出浏览器',
    description: '列出当前连接到 service 的浏览器实例（extension 家族，含 instanceId）。返回 {browsers:[{id,family,name,type}]}。',
    inputSchema: {},
  }, guard(async () => textResult({ browsers: api.browsers.list() })));

  // ---- 2. ab_open_tabs ----
  server.registerTool('ab_open_tabs', {
    title: '列出用户打开的标签页',
    description: '列出默认浏览器中用户当前打开的标签页（只读，不认领）。返回 {tabs:[...]}。',
    inputSchema: {},
  }, guard(async () => textResult({ tabs: await api.browsers.getDefault().user.openTabs() })));

  // ---- 3. ab_new_tab ----
  server.registerTool('ab_new_tab', {
    title: '新建标签页',
    description: '在默认浏览器新建标签页（agent 会话租约自动登记）。若给 url 先过 navigate 策略，被拦返回 {blocked,reason}。成功返回 {tabId}。',
    inputSchema: { url: z.string().min(1).optional().describe('初始 URL，可省略（about:blank）') },
  }, guard(async ({ url }) => {
    if (url !== undefined) {
      const v = policyCheck({ kind: 'navigate', url });
      if (!v.allowed) return textResult({ blocked: true, reason: v.reason, code: v.code ?? 'POLICY_BLOCKED' });
    }
    const browser = api.browsers.getDefault();
    const tab = await browser.tabs.new(url !== undefined ? { url } : {});
    tabRegistry.set(tab.id, { browser, tab });
    return textResult({ tabId: tab.id });
  }));

  // ---- 4. ab_tab_info ----
  server.registerTool('ab_tab_info', {
    title: '标签页信息',
    description: '读取标签页当前 url/title。返回 {tabId,url,title}。',
    inputSchema: { tabId: z.number().int().describe('标签页 id（ab_new_tab/ab_claim_tab 返回）') },
  }, guard(async ({ tabId }) => {
    const { browser } = await resolveTab(tabId);
    const ctx = await browser.user.getTabContext({ tabId }); // 只读 tab_info，绕过句柄缓存取最新
    return textResult({ tabId, url: ctx.url, title: ctx.title });
  }));

  // ---- 5. ab_navigate ----
  server.registerTool('ab_navigate', {
    title: '导航',
    description: '让标签页跳转到 url。策略先拦（chrome://settings 等被拦返回 {blocked,reason}）；成功返回 {ok:true,tabId,url}。',
    inputSchema: {
      tabId: z.number().int(),
      url: z.string().min(1),
    },
  }, guard(async ({ tabId, url }) => {
    const v = policyCheck({ kind: 'navigate', url });
    if (!v.allowed) return textResult({ blocked: true, reason: v.reason, code: v.code ?? 'POLICY_BLOCKED' });
    const { tab } = await resolveTab(tabId);
    await tab.goto(url); // api 层会再过一次同规则策略（幂等，无害）
    return textResult({ ok: true, tabId, url });
  }));

  // ---- 6. ab_screenshot ----
  server.registerTool('ab_screenshot', {
    title: '截图',
    description: '截取标签页可视区截图，返回 MCP image content（base64）+ 一行文本摘要。format: png（默认）| jpeg。',
    inputSchema: {
      tabId: z.number().int(),
      format: z.enum(['png', 'jpeg']).optional().describe('默认 png'),
    },
  }, guard(async ({ tabId, format }) => {
    const fmt = format === 'jpeg' ? 'jpeg' : 'png';
    const { tab } = await resolveTab(tabId);
    const bytes = await tab.screenshot({ format: fmt }); // Uint8Array（规格 §9；api 层已解码）
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    return {
      content: [
        { type: 'text', text: `screenshot: tabId=${tabId} format=${fmt} bytes=${bytes.length}` },
        { type: 'image', data, mimeType: fmt === 'jpeg' ? 'image/jpeg' : 'image/png' },
      ],
    };
  }));

  // ---- 7. ab_ax_state ----
  server.registerTool('ab_ax_state', {
    title: '无障碍树',
    description: '读取标签页的完整无障碍树（文本表示，含元素索引，供 ax 动作定位）。返回 {tabId,ax}。',
    inputSchema: { tabId: z.number().int() },
  }, guard(async ({ tabId }) => {
    const { tab } = await resolveTab(tabId);
    const ax = await tab.ax.get();
    return textResult({ tabId, ax });
  }));

  // ---- 8. ab_claim_tab ----
  server.registerTool('ab_claim_tab', {
    title: '认领已有标签页',
    description: '把用户已打开的标签页认领进 agent 会话（三重匹配 providerTabId+title+url，他人持有会返回 lease conflict）。返回 {tabId}。',
    inputSchema: {
      providerTabId: z.number().int().describe('浏览器原生 tabId（ab_open_tabs 里的 tabId）'),
      title: z.string().optional(),
      url: z.string().optional(),
    },
  }, guard(async ({ providerTabId, title, url }) => {
    const browser = api.browsers.getDefault();
    const tab = await browser.user.claimTab({
      providerTabId,
      ...(title !== undefined ? { title } : {}),
      ...(url !== undefined ? { url } : {}),
    });
    tabRegistry.set(tab.id, { browser, tab });
    return textResult({ tabId: tab.id });
  }));

  // ---- 9. ab_cdp ----
  server.registerTool('ab_cdp', {
    title: 'CDP 直通（白名单+确认）',
    description: '对标签页发原始 CDP 命令。白名单外直接 {blocked}（默认拒绝，白名单见 shared/protocol.mjs CDP_ALLOWLIST）；confirmCdp 名单内首次返回 {needConfirmation,description,token}，经 ab_confirm 批准后带 confirmationToken 重试放行。成功返回 {ok:true,result}。',
    inputSchema: {
      tabId: z.number().int(),
      method: z.string().min(1).describe('CDP 方法名，如 Runtime.evaluate'),
      params: z.record(z.any()).optional().describe('CDP 参数对象'),
      confirmationToken: z.string().optional().describe('ab_confirm 批准后的一次性令牌'),
    },
  }, guard(async ({ tabId, method, params, confirmationToken }) => {
    // 第一道门：白名单（服务端预检，命令不出门）
    if (!CDP_ALLOWLIST.has(method)) {
      return textResult({ blocked: true, reason: `CDP method not in allowlist: ${method}`, code: 'CDP_DENIED' });
    }
    const { tab } = await resolveTab(tabId);
    const cdp = tab.capabilities.get('cdp');
    if (!cdp) return textResult({ blocked: true, reason: 'browser has no cdp capability' });
    try {
      // 第二道门（确认流）在 api 层：token 由 api 消费（一次性），工具层不预检
      const result = await cdp.send(method, params ?? {}, confirmationToken ? { confirmationToken } : {});
      return textResult({ ok: true, method, result });
    } catch (err) {
      if (err && err.needsConfirmation) {
        return textResult({ needConfirmation: true, description: err.description, token: err.token });
      }
      if (err && err.code === 'CDP_DENIED') {
        return textResult({ blocked: true, reason: err.message, code: err.code });
      }
      throw err; // guard 统一转结构化错误
    }
  }));

  // ---- 10. ab_download_open ----
  server.registerTool('ab_download_open', {
    title: '打开下载文件（确认门）',
    description: '在系统查看器中打开已下载文件（高危：执行本地文件）。默认策略需人工确认：首次返回 {needConfirmation,description,token}，ab_confirm 批准后带 confirmationToken 重试即执行。返回 {ok:true,downloadId}。',
    inputSchema: {
      downloadId: z.number().int(),
      confirmationToken: z.string().optional().describe('ab_confirm 批准后的一次性令牌'),
    },
  }, guard(async ({ downloadId, confirmationToken }) => {
    const v = policyCheck({ kind: 'download_open', downloadId }, confirmationToken ? { confirmationToken } : {});
    if (v.needConfirmation) return textResult({ needConfirmation: true, description: v.description, token: v.token });
    if (!v.allowed) return textResult({ blocked: true, reason: v.reason, code: v.code ?? 'POLICY_BLOCKED' });
    const conns = liveConns(connections);
    if (!conns.length) return textResult({ error: 'no browser connected' }, true);
    await conns[0].cmd('download_open', { downloadId }); // 默认浏览器（第一个活连接）
    return textResult({ ok: true, downloadId });
  }));

  // ---- 11. ab_confirm ----
  server.registerTool('ab_confirm', {
    title: '批准待确认动作',
    description: '批准一个待确认动作（token 来自 ab_cdp / ab_download_open 的 needConfirmation 响应；5 分钟内有效、单次使用）。返回 {ok:true,description} 或 {ok:false,reason}。',
    inputSchema: { token: z.string().min(1) },
  }, guard(async ({ token }) => {
    if (!policy || typeof policy.approve !== 'function') {
      return textResult({ ok: false, reason: 'policy not configured' });
    }
    return textResult(policy.approve(token)); // {ok:true,description} | {ok:false,reason}
  }));

  // ---- 12. browser_eval（REPL，本项目核心特色） ----
  server.registerTool('browser_eval', {
    title: '浏览器 REPL（node:vm 沙箱）',
    description: '在服务端 node:vm 沙箱上下文中执行一段 JS（支持顶层 await），注入 `agent`（Agent API：agent.browsers.getDefault().tabs.new() 等）与 `nodeRepl.write(x)`（收集输出行）；不注入 require，console.* 一并收集。30s 超时；未捕获异常返回 {error,stack,output}；成功返回 {result,output}。注意：这是本地受信工具，非逃逸加固沙箱。',
    inputSchema: { code: z.string().min(1).describe('要执行的 JS 代码（整段包进 async 函数）') },
  }, guard(async ({ code }) => {
    const output = [];
    const nodeRepl = { write: (v) => { output.push(fmtValue(v)); } };
    const collect = (...a) => { output.push(a.map(fmtValue).join(' ')); };
    const sandboxConsole = { log: collect, info: collect, warn: collect, error: collect, debug: collect };
    // 干净上下文：无 require/process/Buffer/globalThis.* Node 全局；只有下面注入的成员
    const sandbox = {
      agent: api,
      nodeRepl,
      console: sandboxConsole,
      setTimeout,
      clearTimeout,
    };
    const ctx = vm.createContext(sandbox);
    let timer = null;
    try {
      const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'browser_eval.vm.js' });
      // vm timeout 只约束同步段；整体墙钟由 Promise.race 兜底（超时后放弃等待，不杀底层任务）
      const p = script.runInContext(ctx, { timeout: EVAL_TIMEOUT_MS });
      const timeoutP = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`browser_eval timeout after ${EVAL_TIMEOUT_MS}ms`)), EVAL_TIMEOUT_MS);
        if (timer.unref) timer.unref();
      });
      const result = await Promise.race([p, timeoutP]);
      return textResult({ result: serializeResult(result), output: output.join('\n') });
    } catch (err) {
      return textResult({
        error: String((err && err.message) || err),
        stack: err && err.stack ? String(err.stack) : null,
        output: output.join('\n'),
      }, true);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));

  return server;
}
