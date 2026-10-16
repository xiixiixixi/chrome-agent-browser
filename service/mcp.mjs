// service/mcp.mjs — MCP 服务器（工具面）
//
// buildMcpServer({ api, policy, connections }) → McpServer 实例（不启动 transport，
// 便于测试注入 InMemoryTransport；入口见 service/mcp-entry.mjs）。
//
// 两层工具面（对照规格书 §13 路线图第 3 条「粗粒度工具 + REPL 双层」）：
//   - ab_* 粗粒度工具：开标签/导航/截图（整页/元素）/实时投屏帧（ab_screencast）/
//     无障碍树/认领/CDP/下载确认/批量读页/视口/凭据仓（ab_login 凭据只在本机流转，
//     不进模型），全部过策略门；
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
import { Locator } from './locator.mjs';
import { createLogin } from './login.mjs';

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
 * 构建 MCP 服务器（21 个工具）。
 * @param {{api: object, policy?: object|null, connections?: Function|object|Array|null, audit?: object|null, credentials?: object|null}} opts
 *   api         —— createAgentApi 的返回值（必填）
 *   policy      —— service/policy.mjs 的 Policy 实例（缺省时跳过工具层策略，api 层仍可能拦）
 *   connections —— 取活连接的方式（ab_download_open / ab_viewport 需要直连 connection.cmd）
 *   audit       —— service/audit.mjs 的审计实例（ab_audit 查询用；缺省时该工具报未装配）
 *   credentials —— service/credentials.mjs 的凭据仓句柄（ab_login/ab_credentials 用；缺省时报不支持）
 */
export function buildMcpServer({ api, policy = null, connections = null, serviceInfo = null, audit = null, credentials = null } = {}) {
  if (!api || typeof api.browsers?.getDefault !== 'function') {
    throw new TypeError('buildMcpServer requires { api } — createAgentApi() 的返回对象');
  }
  // capabilities.logging：声明后 sendLoggingMessage 才会真的发 notifications/message
  //（SDK 1.32.1 实测：Server.sendLoggingMessage 无此能力声明时静默跳过；客户端未
  //  setLevel 时默认放行 info 级）——用于 WebMCP 工具变化的即时推送。
  const server = new McpServer(
    { name: 'chrome-agent-browser', version: '0.4.0' },
    { capabilities: { logging: {} } },
  );
  const loginFlow = createLogin({ credentials, audit }); // ab_login 流程（credentials 为 null 时由工具层先拦）

  // tabId → { browser, tab }：new/claim 时登记；未知 tabId 跨浏览器探测后缓存
  const tabRegistry = new Map();

  // ---- WebMCP 推送：onWebmcpTools 通知 → notifications/message（info 级一行） ----
  // 触达式订阅（连接可能在 server 构建后才连入）；同清单只推一次（按 tab 去重）。
  const webmcpWatched = new WeakSet();
  const webmcpLastSent = new Map(); // `${instanceId}:${tabId}` -> 清单拼接串（去重基线）
  const KIND_LABEL = { added: '新增', removed: '移除', changed: '变更' };
  function ensureWebmcpPush() {
    for (const conn of liveConns(connections)) {
      if (webmcpWatched.has(conn)) continue;
      webmcpWatched.add(conn);
      conn.on('webmcp', (p) => {
        if (!p || !Number.isInteger(p.tabId)) return;
        const names = Array.isArray(p.toolNames) ? p.toolNames.filter((n) => typeof n === 'string') : [];
        const key = `${conn.instanceId}:${p.tabId}`;
        const joined = names.join(',');
        if (webmcpLastSent.get(key) === joined) return; // 清单没变不重复打扰
        webmcpLastSent.set(key, joined);
        const kind = KIND_LABEL[p.kind] || '变更';
        const data = names.length
          ? `tab ${p.tabId} ${kind} WebMCP 工具: ${joined}`
          : `tab ${p.tabId} WebMCP 工具清单已清空`;
        server.sendLoggingMessage({ level: 'info', logger: 'webmcp', data })
          .catch(() => { /* 未连接/客户端不支持：收件箱 hint 仍在 */ });
      });
    }
  }

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

  /** 按可选 browserId 选浏览器：不给 = 默认（第一个连上的）。id 来自 ab_list_browsers。 */
  function pickBrowser(browserId) {
    if (browserId === undefined || browserId === null || browserId === '') {
      const list = api.browsers.list();
      if (!list.length) {
        const e = new Error('no browser connected（服务活着，但没有浏览器扩展连上来）。排查：① 浏览器开着吗、扩展加载了吗（chrome://extensions 无红色报错）② 本机跑过 npm run setup 吗（没跑过就没有通信清单，扩展永远连不上）③ 端口对得上吗（npm run doctor 一条命令体检）');
        e.code = -32000;
        throw e;
      }
      return api.browsers.getDefault();
    }
    const b = api.browsers.get(browserId);
    if (!b) { const e = new Error(`browser not found: ${browserId}（先跑 ab_list_browsers 看在线列表）`); e.code = -32002; throw e; }
    return b;
  }

  // ---- 0. ab_status（区分"服务活着没浏览器" vs "更深的问题"；来自实战场教训）----
  server.registerTool('ab_status', {
    title: '服务体检',
    description: '区分三种状态：服务正常且有浏览器在线 / 服务正常但没浏览器连入（浏览器侧断：查扩展加载与 npm run setup）/ 服务或前端模式异常。返回 {mode, port, uptimeSec, browsers, hint}。',
    inputSchema: {},
  }, guard(async () => {
    const browsers = api.browsers.list();
    const mode = serviceInfo?.mode ?? 'unknown';
    const port = serviceInfo?.port ?? null;
    const uptimeSec = serviceInfo?.startedAt ? Math.round((Date.now() - serviceInfo.startedAt) / 1000) : null;
    const hint = browsers.length
      ? `正常：${browsers.length} 台浏览器在线`
      : '服务进程活着，但没有任何浏览器扩展连入 → 在目标浏览器确认扩展已从本机项目目录加载（chrome://extensions），并跑一次 npm run setup / npm run doctor';
    return textResult({ mode, port, uptimeSec, browsers, hint });
  }));

  // ---- 0b. ab_visibility（围观开关：把浏览器窗口带到面前/收起）----
  const connFor = () => {
    const cs = typeof connections === 'function' ? connections() : [];
    if (!cs.length) { const e = new Error('no browser connected（先确认浏览器在线，ab_status 体检）'); e.code = -32000; throw e; }
    return cs[0];
  };
  server.registerTool('ab_visibility', {
    title: '显示/隐藏浏览器窗口',
    description: '控制浏览器窗口可见性。默认后台操作不抢焦点；用户想"围观"操作时调 set(true) 把窗口带到面前，结束再 set(false) 收起。action: get | set。',
    inputSchema: {
      action: z.enum(['get', 'set']).describe('get=查询当前可见性；set=设置'),
      visible: z.boolean().optional().describe('action=set 时必填：true 显示并聚焦 / false 最小化'),
    },
  }, guard(async ({ action, visible }) => {
    if (action === 'get') return textResult(await connFor().cmd('browser_visibility_get', {}));
    if (visible === undefined) throw new Error('action=set 需要 visible: true|false');
    await connFor().cmd('browser_visibility_set', { visible });
    return textResult({ ok: true, visible });
  }));

  // ---- 0c. ab_viewport（视口覆盖：get/set/reset，直连模式同 ab_visibility）----
  server.registerTool('ab_viewport', {
    title: '读取/设置视口尺寸',
    description: '读取或覆盖浏览器视口尺寸（对所有 agent 操控的标签页生效，之后新 attach 的页面同样应用）。action: get 返回 {viewport:{width,height}|null}（null=无覆盖）；action: set 需 width/height（像素，1..10000）；action: reset 清除覆盖恢复默认。',
    inputSchema: {
      action: z.enum(['get', 'set', 'reset']).describe('get=查询当前视口覆盖；set=设置；reset=清除覆盖'),
      width: z.number().int().positive().optional().describe('action=set 时必填：宽（像素）'),
      height: z.number().int().positive().optional().describe('action=set 时必填：高（像素）'),
    },
  }, guard(async ({ action, width, height }) => {
    if (action === 'get') {
      const r = await connFor().cmd('browser_viewport_get', {});
      return textResult({ viewport: r.viewport ?? null });
    }
    if (action === 'reset') {
      await connFor().cmd('browser_viewport_reset', {});
      return textResult({ ok: true, reset: true });
    }
    if (width === undefined || height === undefined) throw new Error('action=set 需要 width 与 height（正整数像素）');
    await connFor().cmd('browser_viewport_set', { width, height });
    return textResult({ ok: true, viewport: { width, height } });
  }));

  // ---- 1. ab_list_browsers ----
  server.registerTool('ab_list_browsers', {
    title: '列出浏览器',
    description: '列出当前连接到 service 的浏览器实例（可同时挂多个浏览器，如 Chrome + Arc）。返回 {browsers:[{id,family,name,type}]}；把 id 作为 browserId 传给 ab_new_tab/ab_open_tabs/ab_claim_tab 即可指定目标浏览器。',
    inputSchema: {},
  }, guard(async () => textResult({ browsers: api.browsers.list() })));

  // ---- 2. ab_open_tabs ----
  server.registerTool('ab_open_tabs', {
    title: '列出用户打开的标签页',
    description: '列出浏览器中用户当前打开的标签页（只读，不认领）。不给 browserId = 默认浏览器（第一个连上的）。返回 {tabs:[...]}。',
    inputSchema: { browserId: z.string().optional().describe('目标浏览器 id（ab_list_browsers 的 id，如 Arc；缺省=默认浏览器）') },
  }, guard(async ({ browserId }) => textResult({ tabs: await pickBrowser(browserId).user.openTabs() })));

  // ---- 3. ab_new_tab ----
  server.registerTool('ab_new_tab', {
    title: '新建标签页',
    description: '新建标签页（agent 会话租约自动登记）。不给 browserId = 默认浏览器。若给 url 先过 navigate 策略，被拦返回 {blocked,reason}。成功返回 {tabId}。',
    inputSchema: {
      url: z.string().min(1).optional().describe('初始 URL，可省略（about:blank）'),
      browserId: z.string().optional().describe('目标浏览器 id（ab_list_browsers 的 id，如 Arc；缺省=默认浏览器）'),
    },
  }, guard(async ({ url, browserId }) => {
    ensureWebmcpPush();
    if (url !== undefined) {
      const v = policyCheck({ kind: 'navigate', url });
      if (!v.allowed) return textResult({ blocked: true, reason: v.reason, code: v.code ?? 'POLICY_BLOCKED' });
    }
    const browser = pickBrowser(browserId);
    const tab = await browser.tabs.new(url !== undefined ? { url } : {});
    tabRegistry.set(tab.id, { browser, tab });
    const hint = api.webmcpHint(browser.browserId, tab.id);
    return textResult({ tabId: tab.id, ...(hint ? { webmcpHint: hint } : {}) });
  }));

  // ---- 4. ab_tab_info ----
  server.registerTool('ab_tab_info', {
    title: '标签页信息',
    description: '读取标签页当前 url/title。返回 {tabId,url,title}。',
    inputSchema: { tabId: z.number().int().describe('标签页 id（ab_new_tab/ab_claim_tab 返回）') },
  }, guard(async ({ tabId }) => {
    ensureWebmcpPush();
    const { browser } = await resolveTab(tabId);
    const ctx = await browser.user.getTabContext({ tabId }); // 只读 tab_info，绕过句柄缓存取最新（有申报工具时附 webmcpHint）
    return textResult({
      tabId, url: ctx.url, title: ctx.title,
      ...(ctx.webmcpHint ? { webmcpHint: ctx.webmcpHint } : {}),
    });
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
    ensureWebmcpPush();
    const v = policyCheck({ kind: 'navigate', url });
    if (!v.allowed) return textResult({ blocked: true, reason: v.reason, code: v.code ?? 'POLICY_BLOCKED' });
    const { browser, tab } = await resolveTab(tabId);
    await tab.goto(url); // api 层会再过一次同规则策略（幂等，无害）
    // 稍候一拍让换页的 onWebmcpTools 通知（旧清单清空/新页面申报）落进收件箱再读 hint
    await new Promise((r) => setTimeout(r, 25));
    const hint = api.webmcpHint(browser.browserId, tabId);
    return textResult({ ok: true, tabId, url, ...(hint ? { webmcpHint: hint } : {}) });
  }));

  // ---- 6. ab_screenshot（整页可视区；给 selector 则元素级） ----
  const zSelector = z.object({
    kind: z.enum(['css', 'role', 'text', 'label', 'testid', 'placeholder']).describe('定位方式（与 browser_eval 里 tab.playwright 的定位器同构）'),
    value: z.string().min(1).describe('定位值：css 选择器 / 角色 / 文本 / 标签 / data-testid / placeholder'),
    name: z.string().optional().describe('kind=role 时的可访问名过滤'),
    exact: z.boolean().optional().describe('文本是否全等匹配（默认包含）'),
  });
  server.registerTool('ab_screenshot', {
    title: '截图',
    description: '截取标签页可视区截图，返回 MCP image content（base64）+ 一行文本摘要。format: png（默认）| jpeg。给 selector 则做元素级截图（滚动到元素后按其矩形裁剪，PNG；找不到元素报错）。',
    inputSchema: {
      tabId: z.number().int(),
      format: z.enum(['png', 'jpeg']).optional().describe('默认 png（元素级截图固定 png）'),
      selector: zSelector.optional().describe('元素级截图的定位器描述对象，如 {kind:"css", value:"#out"}；缺省=整个可视区'),
    },
  }, guard(async ({ tabId, format, selector }) => {
    const { tab } = await resolveTab(tabId);
    if (selector !== undefined) {
      if (format === 'jpeg') throw new Error('元素级截图只支持 png（不要传 format=jpeg）');
      const bytes = await new Locator(tab, selector).screenshot(); // Buffer
      const data = bytes.toString('base64');
      return {
        content: [
          { type: 'text', text: `screenshot: tabId=${tabId} element selector=${JSON.stringify(selector)} bytes=${bytes.length}` },
          { type: 'image', data, mimeType: 'image/png' },
        ],
      };
    }
    const fmt = format === 'jpeg' ? 'jpeg' : 'png';
    const bytes = await tab.screenshot({ format: fmt }); // Uint8Array（规格 §9；api 层已解码）
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    return {
      content: [
        { type: 'text', text: `screenshot: tabId=${tabId} format=${fmt} bytes=${bytes.length}` },
        { type: 'image', data, mimeType: fmt === 'jpeg' ? 'image/jpeg' : 'image/png' },
      ],
    };
  }));

  // ---- 6b. ab_screencast（实时投屏取帧：网页变帧流，"看照片"升级"看直播"） ----
  server.registerTool('ab_screencast', {
    title: '实时投屏取帧',
    description: '把标签页当作实时画面：action=frames 取最新帧（MCP image content，JPEG）。首次调用自动开始投屏（lazy start，默认零开销），最多等首帧 3s。页面在加载/动画/滚动/变化时连续多次取帧即可"看直播"——每帧都是取帧瞬间的最新画面，不是同一张静态截图；limit 可取最近多帧对比变化（默认 1、上限 5）。看完不再需要时调 action=stop 停止投屏省资源（tab 关闭时自动停）。没有 start 动作——开始投屏这件事由首次取帧自动完成。',
    inputSchema: {
      action: z.enum(['frames', 'stop']).describe('frames=取最新帧（首次自动开始投屏）；stop=停止投屏省资源'),
      tabId: z.number().int().describe('标签页 id（ab_new_tab/ab_claim_tab 返回）'),
      limit: z.number().int().positive().max(5).optional().describe('action=frames 返回的帧数，默认 1（最新一帧）、最多 5（按时间正序，最新在末尾）'),
    },
  }, guard(async ({ action, tabId, limit }) => {
    const { tab } = await resolveTab(tabId);
    const sc = tab.capabilities.get('screencast');
    if (!sc) return textResult({ blocked: true, reason: 'browser has no screencast capability' });
    if (action === 'stop') {
      await sc.stop();
      return textResult({ ok: true, stopped: true, tabId });
    }
    const frames = await sc.frames(limit !== undefined ? { limit } : {});
    if (!frames.length) {
      return textResult({ tabId, frames: 0, note: '暂未收到帧（等首帧 3s 超时，或页面暂无渲染活动）；稍后重试 frames，或 action=stop 结束' });
    }
    const content = [{
      type: 'text',
      text: `screencast: tabId=${tabId} frames=${frames.length} ts=${frames.map((f) => f.ts).join(',')}`,
    }];
    for (const f of frames) content.push({ type: 'image', data: f.data, mimeType: 'image/jpeg' });
    return { content };
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
      browserId: z.string().optional().describe('目标浏览器 id（ab_list_browsers 的 id；缺省=默认浏览器）'),
    },
  }, guard(async ({ providerTabId, title, url, browserId }) => {
    const browser = pickBrowser(browserId);
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

  // ---- 11b. ab_webmcp（页面自声明 WebMCP 工具） ----
  server.registerTool('ab_webmcp', {
    title: 'WebMCP：发现/调用页面申报的工具',
    description: '调用网页按 WebMCP 标准自己申报的结构化工具（页面 JS API document.modelContext.registerTool）。页面申报的工具通常会通过提示自动出现（tab_info / ab_new_tab / ab_navigate 返回的 webmcpHint，以及运行中推送的 notifications/message 日志）；无提示再手动 action=list（返回 name/description/inputSchema/readOnly），action=invoke 调用。readOnly=true 的工具直接调用；readOnly=false（页面未标注的也算 false）首次会返回 {needConfirmation,description,token}——经 ab_confirm 批准后带 confirmationToken 重试同一调用即放行（页面声明的工具可能改站点状态，故非只读需确认）。旧版 Chrome 无 WebMCP 域时返回 code=-32011 的错误。',
    inputSchema: {
      action: z.enum(['list', 'invoke']).describe('list=列出页面申报的工具；invoke=调用一个工具'),
      tabId: z.number().int().describe('标签页 id（ab_new_tab/ab_claim_tab 返回）'),
      name: z.string().min(1).optional().describe('action=invoke 时必填：工具名（来自 webmcpHint 或 list 结果）'),
      args: z.record(z.any()).optional().describe('action=invoke 时的工具入参（按 inputSchema 构造）'),
      confirmationToken: z.string().optional().describe('ab_confirm 批准后的一次性令牌（非只读工具第二次调用时带）'),
    },
  }, guard(async ({ action, tabId, name, args, confirmationToken }) => {
    ensureWebmcpPush();
    const { tab } = await resolveTab(tabId);
    const webmcp = tab.capabilities.get('webmcp');
    if (!webmcp) return textResult({ blocked: true, reason: 'browser has no webmcp capability' });
    if (action === 'list') {
      const tools = await webmcp.list();
      return textResult({ tabId, tools });
    }
    if (!name) throw new Error('action=invoke 需要 name（先 action=list 查看页面申报的工具名）');
    try {
      const result = await webmcp.invoke(name, args ?? {}, confirmationToken ? { confirmationToken } : {});
      return textResult({ ok: true, tabId, name, result });
    } catch (err) {
      if (err && err.needsConfirmation) {
        return textResult({ needConfirmation: true, description: err.description, token: err.token });
      }
      throw err; // guard 统一转结构化错误（含 -32011 不支持等）
    }
  }));

  // ---- 11c. ab_read_urls（批量隐形阅读） ----
  server.registerTool('ab_read_urls', {
    title: '批量隐形读页',
    description: '批量隐形读页：后台开临时标签读完即关，不干扰用户当前屏幕。逐个 URL 过策略门（被拦的记 {url,blocked:true,reason}）→ 后台标签加载 → 读 title 与正文（innerText，截断 maxChars，默认 20000 字符）→ 关标签。返回 {pages:[...]}，与入参同序；单个失败不影响其余（记 {url,error}）。',
    inputSchema: {
      urls: z.array(z.string().min(1)).min(1).max(10).describe('要读的 URL 列表（1 到 10 个）'),
      maxChars: z.number().int().positive().optional().describe('每页正文截断长度，默认 20000 字符'),
      browserId: z.string().optional().describe('目标浏览器 id（ab_list_browsers 的 id，如 Arc；缺省=默认浏览器）'),
    },
  }, guard(async ({ urls, maxChars, browserId }) => {
    const browser = pickBrowser(browserId);
    const pages = await browser.tabs.content(maxChars !== undefined ? { urls, maxChars } : { urls });
    return textResult({ pages });
  }));

  // ---- 11d. ab_audit（审计日志查询：AI 的浏览器操作流水账） ----
  server.registerTool('ab_audit', {
    title: '审计日志查询',
    description: '查询 AI 对浏览器做过的操作流水账（本地审计日志：audit/ 目录 JSONL，只记有副作用的命令与人工确认事件，纯本地零网络）。回答「我刚才动了什么」「这个标签页被做过哪些操作」「过去一段开了/关了/导航了哪些页」用这个。可按 cmd（如 tab_create、tab_close、navigate_tab_url、locator_action、tab_cdp_call）、tabId、since（ISO 时间，只看其后）过滤；倒序返回（最新在前）{total, entries:[{ts,cmd,tabId,session?,paramsLite,redacted?}]}；limit 默认 50、上限 500（last 等价 limit）。敏感值已脱敏：fill/press 输入与对话框文本记 "[redacted]"、CDP 参数只记键名、WebMCP 调用只记工具名。审计默认开启，host-config.json 设 auditDisabled:true 或环境变量 CAB_AUDIT=off 可关闭（关闭时返回 {disabled:true}）。',
    inputSchema: {
      limit: z.number().int().positive().max(500).optional().describe('返回条数上限，默认 50、最大 500'),
      last: z.number().int().positive().optional().describe('只看最近 N 条（等价 limit，limit 优先）'),
      cmd: z.string().min(1).optional().describe('按命令名精确过滤，如 tab_create / navigate_tab_url / locator_action / policy_approve'),
      tabId: z.number().int().optional().describe('按标签页 id 过滤（ab_new_tab/ab_claim_tab 返回的 tabId；navigate 类/locator 类记录带它）'),
      since: z.string().min(1).optional().describe('只看该 ISO 时间之后的条目，如 2026-10-16T08:00:00Z'),
    },
  }, guard(async ({ limit, last, cmd, tabId, since }) => {
    if (!audit || typeof audit.query !== 'function') {
      return textResult({ error: 'audit not configured（本进程未装配审计模块）' }, true);
    }
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      throw new Error(`since 需为合法 ISO 时间字符串，收到: ${since}`);
    }
    return textResult(audit.query({ limit, last, cmd, tabId, since }));
  }));

  // ---- 11e. ab_login（全自动登录：凭据只在本机流转，绝不进模型上下文） ----
  server.registerTool('ab_login', {
    title: '自动登录',
    description: '对指定标签页全自动登录：从本机 macOS 钥匙串取出该站点凭据（页面 origin 必须与存储 origin 一致，仅容忍 www. 前缀差异），探测登录表单并填写用户名/密码/TOTP 后提交。入参只有 tabId——凭据由本地服务取出直发页面，绝不进入对话、日志或审计。提交后 3 秒内若跳到完全不同的域，结果标 suspicious:true（不拦截，如实报告供人工复核）。未存过凭据时返回一条设置指引（npm run credential -- set <origin>）。返回 {ok, origin, filled, submitted, suspicious?}。',
    inputSchema: {
      tabId: z.number().int().describe('标签页 id（ab_new_tab/ab_claim_tab 返回）'),
    },
  }, guard(async ({ tabId }) => {
    if (!credentials || credentials.supported !== true) {
      return textResult({ ok: false, reason: 'unsupported-platform', guidance: '当前仅支持 macOS 钥匙串（凭据仓依赖本机 security 命令）' });
    }
    const { browser, tab } = await resolveTab(tabId);
    return textResult(await loginFlow.login({ browser, tab, tabId }));
  }));

  // ---- 11f. ab_credentials（已存凭据站点清单；只列 origin，零秘密） ----
  server.registerTool('ab_credentials', {
    title: '已存凭据站点清单',
    description: '列出本机钥匙串里已存登录凭据的站点 origin 清单（只列 origin，不显示任何秘密）。存入/删除走本机命令：npm run credential -- set <origin> / remove <origin>。返回 {origins:[...]}。',
    inputSchema: {},
  }, guard(async () => {
    if (!credentials || credentials.supported !== true) {
      return textResult({ origins: [], reason: '当前仅支持 macOS 钥匙串' });
    }
    return textResult({ origins: await credentials.list() });
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
