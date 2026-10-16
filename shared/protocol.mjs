// shared/protocol.mjs — single source of truth for the chrome-agent-browser wire protocol.
//
// Layers (see docs/PROTOCOL.md):
//   extension <--(Chrome Native Messaging, JSON per frame)--> native host
//   native host <--(WebSocket 127.0.0.1, JSON-RPC 2.0)--> service
//
// The host is a DUMB RELAY: it forwards JSON objects verbatim between the
// native-messaging port and the service WebSocket, plus one "host/hello".
// All intelligence lives in the extension and the service.
//
// the original for cross-reference.

export const PROTOCOL_VERSION = 1;

// ---- JSON-RPC methods (extension <-> service, relayed by host) ----

// Extension -> service notifications (events)
export const EV = {
  HELLO: 'ext/hello', // registration {instanceId, family, browserVersion, capabilities}
  BYE: 'ext/bye',
  PAGE_EVENT: 'onPageEvent', // {tabId, event, url?, title?}
  CDP_EVENT: 'onCDPEvent', // {tabId, method, params, source?}
  CDP_DETACH: 'onCDPDetach', // {tabId, reason}
  LEASE_CHANGE: 'onLeaseChange', // {tabId, lease|null}
  DOWNLOAD_CHANGE: 'onDownloadChange', // {downloadId, state, filename?}
  DIALOG: 'onJsDialog', // {tabId, dialog}
  BADGES: 'onBadgeChange', // {tabId, badge}
  // 页面申报的 WebMCP 工具发生变化（扩展在 WebMCP.enable 后收到 toolsAdded/toolsRemoved
  // 或主文档换页时上报）。toolNames 是该 tab 当前的完整工具名清单快照（非增量）。
  WEBMCP_TOOLS: 'onWebmcpTools', // {tabId, kind:'added'|'removed'|'changed', toolNames:[string]}
  // 实时投屏帧（v0.4.0）。扩展收到 Page.screencastFrame 已立即 ack，并按 250ms/tab 节流
  // （中间帧丢弃保最新）后转发；data 为 jpeg base64，metadata 只留关键字段摘要。
  SCREENCAST_FRAME: 'onScreencastFrame', // {tabId, data, ts, metadata}
};

// Service -> extension commands. Method name === command type (flat).
// Params validated in the extension with plain JS validators (no bundler deps).
export const COMMANDS = {
  // session lifecycle
  session_setup: { params: { sessionId: 'string', turnId: 'string' } },
  session_keepalive: { params: { sessionId: 'string' } },
  session_finalize: { params: { sessionId: 'string', keepTabIds: 'number[]' } },
  name_session: { params: { sessionId: 'string', name: 'string' } },

  // browser level
  browser_status: { params: {} },
  browser_visibility_get: { params: {} },
  browser_visibility_set: { params: { visible: 'boolean' } },
  browser_viewport_get: { params: {}, returns: { viewport: 'object?' } }, // {width,height}|null（null=无覆盖）
  browser_viewport_set: { params: { width: 'number', height: 'number' } },
  browser_viewport_reset: { params: {} },
  browser_history: { params: { limit: 'number?' } },
  browser_open_tabs: { params: {} },

  // tab lifecycle
  tab_create: { params: { url: 'string?', background: 'boolean?', windowId: 'number?' }, returns: { tabId: 'number', url: 'string' } },
  tab_claim: { params: { providerTabId: 'number', title: 'string?', url: 'string?' }, returns: { tabId: 'number' } },
  tab_close: { params: { tabId: 'number' } },
  tab_info: { params: { tabId: 'number' }, returns: { url: 'string', title: 'string' } },
  tab_mark: { params: { tabId: 'number', status: 'string' } }, // 'deliverable'|'handoff'|'default'
  tab_list_agent_tabs: { params: { sessionId: 'string' } },

  // navigation
  navigate_tab_url: { params: { tabId: 'number', url: 'string' } },
  navigate_tab_back: { params: { tabId: 'number' } },
  navigate_tab_forward: { params: { tabId: 'number' } },
  navigate_tab_reload: { params: { tabId: 'number' } },

  // inspection & interaction
  tab_eval: { params: { tabId: 'number', expression: 'string', returnByValue: 'boolean?' }, returns: { value: 'any' } },
  tab_screenshot: { params: { tabId: 'number', format: 'string?', quality: 'number?' }, returns: { dataBase64: 'string' } },
  tab_ax_get_state: { params: { tabId: 'number' }, returns: { ax: 'string' } },
  tab_ax_action: { params: { tabId: 'number', action: 'string', elementIndex: 'number', text: 'string?' } },
  tab_get_js_dialog: { params: { tabId: 'number' } },
  tab_handle_js_dialog: { params: { tabId: 'number', accept: 'boolean', promptText: 'string?' } },
  tab_dev_logs: { params: { tabId: 'number', limit: 'number?' } },
  tab_clipboard_write_text: { params: { tabId: 'number', text: 'string' } },

  // locator-style queries (implemented over Runtime.evaluate in extension)
  locator_count: { params: { tabId: 'number', selector: 'object' }, returns: { count: 'number' } },
  locator_action: { params: { tabId: 'number', selector: 'object', action: 'string', value: 'string?' }, returns: { ok: 'boolean', value: 'any' } },
  locator_snapshot: { params: { tabId: 'number' }, returns: { html: 'string' } },
  // 元素级截图：__abQuery 找第一个元素 → scrollIntoView → 按其 getBoundingClientRect 裁剪截图
  element_screenshot: { params: { tabId: 'number', selector: 'object' }, returns: { dataBase64: 'string' } },

  // raw CDP passthrough (scoped to attached tab)
  tab_cdp_call: { params: { tabId: 'number', method: 'string', params: 'object?' }, returns: { result: 'any' } },
  tab_cdp_events: { params: { tabId: 'number', afterSequence: 'number?', limit: 'number?' }, returns: { events: 'array', cursor: 'number' } },

  // 登录表单探测（ab_login 用；只读，不入审计白名单）：找可见密码框 + 同表单用户名
  // 输入框 + 提交按钮 + 可选 one-time-code 框，各返回 {kind:'css', value} 定位器描述。
  // returns: {found:true, username?, password, submit?, totp?} | {found:false, reason}
  login_detect: { params: { tabId: 'number' }, returns: { found: 'boolean' } },

  // WebMCP: tools declared by the page itself (discovered via CDP WebMCP domain)
  // returns.tools: [{name, description, inputSchema, readOnly}]
  webmcp_list_tools: { params: { tabId: 'number' }, returns: { tools: 'array' } },
  webmcp_invoke_tool: { params: { tabId: 'number', name: 'string', args: 'object?' }, returns: { result: 'any' } },

  // 实时投屏（v0.4.0，ab_screencast 用；帧经 onScreencastFrame 通知上行，不走命令）
  // start：ensureAttached → Page.startScreencast{format:'jpeg', quality 默认 60,
  //   maxWidth 默认 1280, maxHeight 默认 800, everyNthFrame 默认 1}，并登记该 tab 投屏中。
  // stop：Page.stopScreencast + 除名（幂等；tab 关闭/租约清理/finalize 时扩展自动 stop）。
  screencast_start: { params: { tabId: 'number', everyNthFrame: 'number?', quality: 'number?', maxWidth: 'number?', maxHeight: 'number?' }, returns: { ok: 'boolean' } },
  screencast_stop: { params: { tabId: 'number' }, returns: { ok: 'boolean' } },

  // downloads (approval-gated in service)
  download_config_specs: { params: {} },
  download_open: { params: { downloadId: 'number' } },
};

// CDP methods the extension is allowed to pass through via tab_cdp_call.
export const CDP_ALLOWLIST = new Set([
  'Page.enable', 'Page.disable', 'Page.navigate', 'Page.reload', 'Page.stopLoading',
  'Page.captureScreenshot', 'Page.printToPDF', 'Page.getFrameTree', 'Page.getResourceTree',
  'Page.getResourceContent', 'Page.getNavigationHistory', 'Page.navigateToHistoryEntry',
  'Page.handleJavaScriptDialog', 'Page.setLifecycleEventsEnabled', 'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument', 'Page.setInterceptFileChooserDialog', 'Page.setDownloadBehavior',
  'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck',
  'Runtime.enable', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.getProperties',
  'Runtime.releaseObject', 'Runtime.discardConsoleEntries', 'Runtime.addBinding', 'Runtime.removeBinding',
  'DOM.enable', 'DOM.getDocument', 'DOM.describeNode', 'DOM.getBoxModel', 'DOM.getContentQuads',
  'DOM.getNodeForLocation', 'DOM.resolveNode', 'DOM.scrollIntoViewIfNeeded', 'DOM.setFileInputFiles',
  'DOM.getFrameOwner', 'DOMSnapshot.captureSnapshot',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.synthesizeScrollGesture', 'Input.dispatchDragEvent',
  'Network.enable', 'Network.disable', 'Network.getCookies', 'Network.getAllCookies', 'Network.setCookie',
  'Network.setCookies', 'Network.deleteCookies', 'Network.setExtraHTTPHeaders', 'Network.setCacheDisabled',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setFocusEmulationEnabled',
  'Accessibility.enable', 'Accessibility.disable', 'Accessibility.getFullAXTree',
  'Target.getTargets', 'Target.getTargetInfo', 'Target.setAutoAttach', 'Target.closeTarget',
  'Fetch.enable', 'Fetch.disable', 'Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.fulfillRequest',
  // WebMCP (page-declared tools; experimental CDP domain, Chrome ~156+)
  'WebMCP.enable', 'WebMCP.disable', 'WebMCP.invokeTool', 'WebMCP.cancelInvocation',
]);

// JSON-RPC error codes
export const ERR = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, INTERNAL: -32603,
  // app codes <= -32000
  UNSUPPORTED_COMMAND: -32001,
  TAB_NOT_FOUND: -32002,
  LEASE_CONFLICT: -32003,   // tab owned by another session
  CDP_DENIED: -32004,       // method not in allowlist
  NOT_ATTACHED: -32005,
  NAVIGATION_BLOCKED: -32006,
  POLICY_BLOCKED: -32007,   // confirmation/safety gate
  WEBMCP_UNSUPPORTED: -32011, // browser has no WebMCP CDP domain (needs newer Chrome / experimental flag)
};

// ---- 多实例共用（frontend 模式，v1）----
//
// 第二个 mcp-entry 进程发现端口被既有 service 占用（EADDRINUSE）时，以「前端」身份
// 连上既有 service 共用浏览器（README 的多实例承诺）。线缆约定：
//   frontend -> service（必须是该连接的第一条请求）:
//     {jsonrpc:"2.0", id:N, method:"mcp/hello"} → 回 {ok:true, protocol:1}
//   frontend -> service（命令代理）:
//     {jsonrpc:"2.0", id:N, method:"mcp/cmd", params:{command, params}}
//     → service 取第一个活跃浏览器连接执行，结果/错误原样回传（保留错误 code）；
//       无浏览器连接时回 {code:-32002, message:"no browser connected"}。
// 事件通知（page/lease 等）v1 不向前端转发（前端只用请求-响应）。
export const FRONTEND_HELLO = 'mcp/hello';
export const FRONTEND_CMD = 'mcp/cmd';

// Lease record shape (persisted in chrome.storage.session):
// { tabId, sessionId, turnId, instanceId, origin: 'agent'|'user',
//   claimedAt: epochMs, state: 'active'|'finalized' }
