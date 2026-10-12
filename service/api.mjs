// service/api.mjs — Agent API 层（对照规格书 §9 的务实子集，命名保持一致）
//
// createAgentApi(getConnections, {policy}) → { browsers }
//   browsers.list()/get(id)/getDefault()
//   browser.{browserId, family, tabs, user, history, nameSession, capabilities}
//   tab.{id, goto, back, forward, reload, close, url, title, screenshot, eval,
//        ax, playwright, capabilities, markDeliverable, markHandoff, dev}
//
// 约定：
//   - 命令走 connection.cmd（命令目录见 shared/protocol.mjs COMMANDS）。
//   - page 事件（onPageEvent）更新 tab 缓存 url/title；event==='removed' 判 tab 失效。
//   - onWebmcpTools 通知进全局收件箱；user.getTabContext 有申报工具时附 webmcpHint，
//     并导出 api.webmcpHint(browserId, tabId) 供 MCP 面（ab_new_tab/ab_navigate）引用。
//   - tab 关闭（本地 close 或 removed 事件）后所有方法抛错（code=ERR.TAB_NOT_FOUND）。
//   - ERR.LEASE_CONFLICT 转成清晰 Error，.code 保留。
//   - CDP：服务端持 CDP_ALLOWLIST 副本先拒（默认拒绝），再过 policy.confirmCdp 确认门。

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ERR, CDP_ALLOWLIST } from '../shared/protocol.mjs';
import { createPlaywright } from './locator.mjs';

// ---- zod 入参校验（只校验关键参数，宽松不动业务字段） ----
const zNewTab = z.object({
  url: z.string().min(1).optional(),
  background: z.boolean().optional(),
  windowId: z.number().int().optional(),
}).strict();
const zClaim = z.object({
  providerTabId: z.number().int().optional(),
  tabId: z.number().int().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
}).strict();
const zScreenshot = z.object({ format: z.string().optional(), quality: z.number().optional() }).strict();

/** 策略判决 → JS Error（needConfirmation 时附带 token/description 供 approve 后重试）。 */
function policyError(verdict) {
  if (verdict.needConfirmation) {
    const e = new Error(`confirmation required: ${verdict.description}`);
    e.code = ERR.POLICY_BLOCKED;
    e.needsConfirmation = true;
    e.token = verdict.token;
    e.description = verdict.description;
    return e;
  }
  const e = new Error(verdict.reason ?? 'blocked by policy');
  e.code = verdict.code ?? 'POLICY_BLOCKED';
  if (e.code === 'POLICY_BLOCKED') e.jsonRpcCode = ERR.POLICY_BLOCKED;
  return e;
}

/** 线缆错误 → 清晰 JS Error（LEASE_CONFLICT/TAB_NOT_FOUND），.code 保留。 */
function mapRpcError(err, prefix = '') {
  if (err && err.code === ERR.LEASE_CONFLICT) {
    const e = new Error(`${prefix}tab is owned by another browser session (lease conflict)`);
    e.code = ERR.LEASE_CONFLICT;
    e.data = err.data;
    return e;
  }
  if (err && err.code === ERR.TAB_NOT_FOUND && prefix) {
    const e = new Error(`${prefix}${err.message}`);
    e.code = ERR.TAB_NOT_FOUND;
    e.data = err.data;
    return e;
  }
  return err;
}

export function createAgentApi(getConnections, { policy = null } = {}) {
  const wrapped = new Map(); // conn -> browser 包装（避免重复订阅 page 事件）

  // ---- WebMCP 推送收件箱（v0.2.1：推送式发现）----
  // 扩展在页面申报的工具增删/换页时上报 onWebmcpTools {tabId, kind, toolNames}（完整快照）。
  // 这里按 `${instanceId}:${tabId}` 保留最近一次清单 + 时间戳；tab_info / 导航 / 开标签
  // 的返回在有条目时附带 `webmcpHint:{toolNames,count}`，模型因此无需先手动 list 就能
  // 看到页面有哪些工具（手动 list 仍是权威路径，见 mcp 面 ab_webmcp）。
  const webmcpInbox = new Map(); // key -> {toolNames:[string], kind, updatedAt}
  const webmcpWatched = new WeakSet(); // 已订阅 onWebmcpTools 的连接

  function webmcpInboxKey(instanceId, tabId) { return `${instanceId}:${tabId}`; }

  /** 连接的 onWebmcpTools 通知 → 收件箱快照更新（幂等，重复订阅由 WeakSet 挡）。 */
  function watchWebmcp(conn) {
    if (!conn || webmcpWatched.has(conn)) return;
    webmcpWatched.add(conn);
    conn.on('webmcp', (p) => {
      if (!p || !Number.isInteger(p.tabId)) return;
      const names = Array.isArray(p.toolNames) ? p.toolNames.filter((n) => typeof n === 'string') : [];
      webmcpInbox.set(webmcpInboxKey(conn.instanceId, p.tabId), {
        toolNames: names, kind: String(p.kind || 'changed'), updatedAt: Date.now(),
      });
    });
  }

  function liveConns() {
    return getConnections().filter((c) => c.instanceId && !c.isClosed);
  }

  /** 触达式订阅：每次读 hint 前把当前活跃连接都挂上监听（连接晚于首次读取时补挂）。 */
  function watchAllWebmcp() {
    for (const c of liveConns()) watchWebmcp(c);
  }

  /**
   * 读取某 tab 的推送式发现提示。
   * @returns {{toolNames:string[], count:number}|null} 无申报（或从未收到通知）时 null。
   */
  function webmcpHint(browserId, tabId) {
    watchAllWebmcp();
    if (!Number.isInteger(tabId)) return null;
    const snap = webmcpInbox.get(webmcpInboxKey(browserId, tabId));
    if (!snap || snap.toolNames.length === 0) return null;
    return { toolNames: [...snap.toolNames], count: snap.toolNames.length };
  }

  /** 写入快照（webmcp.list() 成功后回填，防通知丢失时收件箱仍可感知）。 */
  function recordWebmcpTools(instanceId, tabId, tools) {
    const names = (Array.isArray(tools) ? tools : [])
      .filter((t) => t && typeof t.name === 'string').map((t) => t.name);
    webmcpInbox.set(webmcpInboxKey(instanceId, tabId), {
      toolNames: names, kind: 'changed', updatedAt: Date.now(),
    });
  }

  const browsers = {
    list() {
      return liveConns().map((c) => ({
        id: c.instanceId,
        family: c.family,
        name: c.profileName || `${c.family}${c.browserVersion ? ` ${c.browserVersion}` : ''}`,
        ...(c.profileName ? { profileName: c.profileName } : {}),
        type: 'extension',
      }));
    },
    get(id) {
      const conn = liveConns().find((c) => c.instanceId === id);
      if (!conn) throw new Error(`browser not found: ${id}`);
      return wrapBrowser(conn);
    },
    getDefault() {
      const cs = liveConns();
      if (!cs.length) throw new Error('no browser connected');
      return wrapBrowser(cs[0]);
    },
  };

  function wrapBrowser(conn) {
    if (wrapped.has(conn)) return wrapped.get(conn);
    const state = { sessionId: null, turnId: null, tabCount: 0, pageCache: new Map(), tabs: new Map(), webmcpCache: new Map() };
    watchWebmcp(conn); // 工具变化通知进收件箱（webmcpHint 的数据源）

    // page 事件 → tab 缓存 {url,title,removed}
    conn.on('page', (p) => {
      if (p.tabId === undefined) return;
      const c = state.pageCache.get(p.tabId) ?? {};
      if (p.url !== undefined) c.url = p.url;
      if (p.title !== undefined) c.title = p.title;
      if (p.event === 'removed') c.removed = true;
      state.pageCache.set(p.tabId, c);
    });

    async function ensureSession() {
      if (state.sessionId) return;
      state.sessionId = randomUUID();
      state.turnId = randomUUID();
      try {
        await conn.cmd('session_setup', { sessionId: state.sessionId, turnId: state.turnId });
      } catch (err) { throw mapRpcError(err); }
    }

    function checkPolicy(input, opts) {
      if (!policy) return;
      const v = policy.check(input, opts);
      if (!v.allowed) throw policyError(v);
    }

    // ---- tab 句柄 ----
    function createTab(tabId) {
      let closed = false;
      const cache = () => state.pageCache.get(tabId) ?? {};
      const alive = () => {
        if (closed || cache().removed) {
          const e = new Error(`tab ${tabId} is closed`);
          e.code = ERR.TAB_NOT_FOUND;
          throw e;
        }
      };
      const call = async (method, params) => {
        alive();
        try { return await conn.cmd(method, params); }
        catch (err) { throw mapRpcError(err, `tab ${tabId}: `); }
      };
      async function info() {
        const r = await call('tab_info', { tabId });
        const c = state.pageCache.get(tabId) ?? {};
        if (r.url !== undefined) c.url = r.url;
        if (r.title !== undefined) c.title = r.title;
        state.pageCache.set(tabId, c);
        return r;
      }

      const tab = {
        id: tabId,
        get _closed() { return closed || cache().removed === true; },

        async goto(url) {
          z.string().min(1).parse(url);
          checkPolicy({ kind: 'navigate', url }); // 策略先于一切（chrome:// 等被拦）
          await call('navigate_tab_url', { tabId, url });
          const c = state.pageCache.get(tabId) ?? {};
          c.url = url;
          delete c.removed;
          state.pageCache.set(tabId, c);
        },
        back: () => call('navigate_tab_back', { tabId }),
        forward: () => call('navigate_tab_forward', { tabId }),
        reload: () => call('navigate_tab_reload', { tabId }),
        async close() {
          alive();
          try { await conn.cmd('tab_close', { tabId }); }
          finally { closed = true; }
        },
        async url() { alive(); return cache().url !== undefined ? cache().url : (await info()).url; },
        async title() { alive(); return cache().title !== undefined ? cache().title : (await info()).title; },
        async screenshot(opts = {}) {
          const { format, quality } = zScreenshot.parse(opts);
          const r = await call('tab_screenshot', { tabId, ...(format !== undefined ? { format } : {}), ...(quality !== undefined ? { quality } : {}) });
          // 规格书 §9：screenshot(): Promise<Uint8Array> —— 解码 base64（Buffer 是 Uint8Array 子类）
          return Buffer.from(r.dataBase64, 'base64');
        },
        async eval(expression) {
          z.string().min(1).parse(expression);
          const r = await call('tab_eval', { tabId, expression, returnByValue: true });
          return r.value;
        },
        ax: {
          get: async () => (await call('tab_ax_get_state', { tabId })).ax,
          write: null, // 占位，下面赋值（write = 同 get）
        },
        playwright: createPlaywright(null), // 占位，下面回填 tab 引用
        capabilities: {
          list: () => ['cdp', 'webmcp'],
          get: (id) => {
            if (id !== 'cdp' && id !== 'webmcp') return null;
            if (id === 'cdp') {
              return {
                async send(method, params = {}, opts = {}) {
                  z.string().min(1).parse(method);
                  if (typeof params !== 'object' || params === null) throw new TypeError('params must be an object');
                  if (!CDP_ALLOWLIST.has(method)) { // 服务端预检：默认拒绝
                    const e = new Error(`CDP method not allowed: ${method}`);
                    e.code = ERR.CDP_DENIED;
                    throw e;
                  }
                  checkPolicy({ kind: 'cdp', method }, { confirmationToken: opts.confirmationToken });
                  const r = await call('tab_cdp_call', { tabId, method, params });
                  return r.result;
                },
                async readEvents({ afterSequence, limit } = {}) {
                  const r = await call('tab_cdp_events', {
                    tabId,
                    ...(afterSequence !== undefined ? { afterSequence } : {}),
                    ...(limit !== undefined ? { limit } : {}),
                  });
                  return { events: r.events ?? [], cursor: r.cursor ?? 0 };
                },
              };
            }
            // 'webmcp'：页面自声明工具的发现与受控调用（发现只读；调用过策略门）
            return {
              /** 列出页面申报的工具：[{name, description, inputSchema?, readOnly}]。 */
              async list() {
                const r = await call('webmcp_list_tools', { tabId });
                state.webmcpCache.set(tabId, new Map((r.tools ?? []).filter((t) => t && typeof t.name === 'string').map((t) => [t.name, t])));
                recordWebmcpTools(conn.instanceId, tabId, r.tools); // 收件箱回填（防通知丢失）
                return r.tools ?? [];
              },
              /**
               * 调用页面工具。readOnly 工具直通；非 readOnly（含未知工具，保守）过
               * policy 的 webmcp_invoke 确认门——首次抛 needsConfirmation（带 token），
               * approve 后带 opts.confirmationToken 重试放行。
               */
              async invoke(name, args = {}, opts = {}) {
                z.string().min(1).parse(name);
                if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new TypeError('args must be an object');
                let meta = state.webmcpCache.get(tabId)?.get(name);
                if (!meta) { await this.list(); meta = state.webmcpCache.get(tabId)?.get(name); } // 缓存缺失（list 未调过）→ 先刷新
                const readOnly = !!(meta && meta.readOnly);
                checkPolicy({
                  kind: 'webmcp_invoke', name,
                  description: (meta && meta.description) || '',
                  readOnly,
                }, { confirmationToken: opts.confirmationToken });
                const r = await call('webmcp_invoke_tool', { tabId, name, ...(Object.keys(args).length ? { args } : {}) });
                return r.result;
              },
            };
          },
        },
        markDeliverable: () => call('tab_mark', { tabId, status: 'deliverable' }),
        markHandoff: () => call('tab_mark', { tabId, status: 'handoff' }),
        dev: { logs: async () => (await call('tab_dev_logs', { tabId })).logs ?? [] },
        _locator: async (method, selector, extra) => call(method, { tabId, selector, ...extra }),
      };
      tab.ax.write = tab.ax.get; // write = 同 get（子集约定）
      tab.playwright = createPlaywright(tab);
      return tab;
    }

    function makeTab(tabId, initial = {}) {
      const prior = state.tabs.get(tabId);
      if (prior && !prior._closed) return prior;
      const c = state.pageCache.get(tabId) ?? {};
      if (initial.url !== undefined) c.url = initial.url;
      if (initial.title !== undefined) c.title = initial.title;
      state.pageCache.set(tabId, c);
      const t = createTab(tabId);
      state.tabs.set(tabId, t);
      return t;
    }

    const browser = {
      browserId: conn.instanceId,
      family: conn.family,
      tabs: {
        async new(opts = {}) {
          const p = zNewTab.parse(opts);
          checkPolicy({ kind: 'tab_create', sessionTabs: state.tabCount });
          await ensureSession();
          const params = {};
          for (const k of ['url', 'background', 'windowId']) if (p[k] !== undefined) params[k] = p[k];
          let r;
          try { r = await conn.cmd('tab_create', params); }
          catch (err) { throw mapRpcError(err, 'tabs.new: '); }
          state.tabCount += 1;
          return makeTab(r.tabId, { url: r.url });
        },
        get(id) {
          if (!Number.isInteger(id)) throw new TypeError('tabs.get(id) requires a tab id number');
          const t = state.tabs.get(id);
          if (t && !t._closed) return t;
          return makeTab(id);
        },
        async list() {
          await ensureSession();
          let r;
          try { r = await conn.cmd('tab_list_agent_tabs', { sessionId: state.sessionId }); }
          catch (err) { throw mapRpcError(err, 'tabs.list: '); }
          const rows = Array.isArray(r) ? r : (r.tabs ?? []);
          return rows.map((row) => (row && row.tabId !== undefined ? makeTab(row.tabId, row) : row));
        },
        async selected() {
          let r;
          try { r = await conn.cmd('browser_open_tabs', {}); }
          catch (err) { throw mapRpcError(err, 'tabs.selected: '); }
          const rows = Array.isArray(r) ? r : (r.tabs ?? []);
          const sel = rows.find((row) => row && (row.selected === true || row.active === true) && row.tabId !== undefined);
          return sel ? makeTab(sel.tabId, sel) : null;
        },
      },
      user: {
        async openTabs() {
          const r = await conn.cmd('browser_open_tabs', {});
          return Array.isArray(r) ? r : (r.tabs ?? []);
        },
        async claimTab(tabInfo = {}) {
          const p = zClaim.parse(tabInfo);
          const providerTabId = p.providerTabId ?? p.tabId;
          if (!Number.isInteger(providerTabId)) throw new TypeError('claimTab requires providerTabId/tabId number');
          await ensureSession();
          const params = { providerTabId };
          if (p.title !== undefined) params.title = p.title;
          if (p.url !== undefined) params.url = p.url;
          let r;
          try { r = await conn.cmd('tab_claim', params); }
          catch (err) { throw mapRpcError(err, 'claimTab: '); }
          state.tabCount += 1;
          return makeTab(r.tabId, { url: p.url, title: p.title });
        },
        /** 读上下文不认领（tab_info 只读）；有已申报 WebMCP 工具时附 webmcpHint。 */
        async getTabContext(tabInfo = {}) {
          const p = zClaim.parse(tabInfo);
          const tabId = p.tabId ?? p.providerTabId;
          if (!Number.isInteger(tabId)) throw new TypeError('getTabContext requires tabId number');
          watchWebmcp(conn);
          let r;
          try { r = await conn.cmd('tab_info', { tabId }); }
          catch (err) { throw mapRpcError(err, 'getTabContext: '); }
          const hint = webmcpHint(conn.instanceId, tabId);
          return hint ? { ...r, webmcpHint: hint } : r;
        },
      },
      async history({ limit } = {}) {
        const params = limit !== undefined ? { limit } : {};
        try { return await conn.cmd('browser_history', params); }
        catch (err) { throw mapRpcError(err, 'history: '); }
      },
      async nameSession(name) {
        z.string().min(1).parse(name);
        await ensureSession();
        try { return await conn.cmd('name_session', { sessionId: state.sessionId, name }); }
        catch (err) { throw mapRpcError(err, 'nameSession: '); }
      },
      capabilities: {
        list: () => [...conn.capabilities],
        get: (id) => (conn.capabilities.includes(id) ? { id } : null),
      },
      _state: state,
    };
    wrapped.set(conn, browser);
    return browser;
  }

  return { browsers, webmcpHint };
}
