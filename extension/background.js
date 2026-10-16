// chrome-agent-browser/extension/background.js
// MV3 service worker，单文件（no import / no bundler / no third-party libs / ES2020）。
// 角色：扩展 <--(Chrome Native Messaging)--> host（哑中继）<--(WS)--> service。
// 命令目录 / 事件 / 错误码 / CDP 白名单的唯一事实来源是 shared/protocol.mjs，
// 本文件按红线要求"硬拷贝"这些常量（扩展无法 import 仓库内模块）。
//
// SW（service worker）会被 Chrome 随时杀掉，因此关键状态全部落盘：
//   chrome.storage.local  : ab_instanceId（实例身份，跨浏览器会话稳定）
//   chrome.storage.session: ab_leases（租约表）/ ab_session（当前会话）/ ab_viewport（视口覆盖）
// 内存缓存（CDP 事件环 / 控制台日志环 / 对话框 / AX 节点表）是易失的，
// SW 重启后由后续事件自然重建——它们只是"最近事件"的缓存，不是权威状态。

'use strict';

// =====================================================================
// 【0. 常量与工具】 constants & utilities
// =====================================================================

const PROTOCOL_VERSION = 1;
const HOST_NAME = 'com.chromeagentbrowser.host'; // native messaging 宿主名（安装器写入的清单一致）
const ALARM_RECONNECT = 'ab-reconnect';
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]; // 重连退避，30s 封顶
const REQ_TIMEOUT_MS = 20000;   // 出站 JSON-RPC 请求超时
const CAPABILITIES = ['cdp', 'screenshot', 'ax', 'locator', 'history', 'downloads', 'dialogs', 'viewport', 'webmcp'];
const LEASE_KEY = 'ab_leases';      // chrome.storage.session
const SESSION_KEY = 'ab_session';   // chrome.storage.session
const VIEWPORT_KEY = 'ab_viewport'; // chrome.storage.session
const BADGE_COLOR = '#f59e0b';      // agent 持有标签页的角标颜色（amber）
const MAX_CDP_EVENTS = 500;         // 每 tab CDP 事件环容量
const MAX_DEV_LOGS = 200;           // 每 tab 控制台日志环容量
const SNAPSHOT_MAX = 200 * 1024;    // locator_snapshot 截断 200KB
const WEBMCP_LIST_WAIT_MS = 2000;   // WebMCP.enable 后等 toolsAdded 事件的上限
const WEBMCP_INVOKE_WAIT_MS = 12000;// 等页面工具 execute 完成的上限（须低于 service 命令 15s 超时）

// JSON-RPC 错误码（拷贝自 shared/protocol.mjs ERR）
const ERR = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, INTERNAL: -32603,
  UNSUPPORTED_COMMAND: -32001,
  TAB_NOT_FOUND: -32002,
  LEASE_CONFLICT: -32003,
  CDP_DENIED: -32004,
  NOT_ATTACHED: -32005,
  NAVIGATION_BLOCKED: -32006,
  POLICY_BLOCKED: -32007,
  WEBMCP_UNSUPPORTED: -32011,
};

// 事件名（拷贝自 shared/protocol.mjs EV；扩展只发通知，无 id）
const EV = {
  HELLO: 'ext/hello',
  BYE: 'ext/bye',
  PAGE: 'onPageEvent',
  CDP: 'onCDPEvent',
  CDP_DETACH: 'onCDPDetach',
  LEASE: 'onLeaseChange',
  DOWNLOAD: 'onDownloadChange',
  DIALOG: 'onJsDialog',
  BADGES: 'onBadgeChange',
  WEBMCP_TOOLS: 'onWebmcpTools', // v0.2.1 推送式发现（曾因硬拷贝漏加此行导致静默丢事件——见 test/sync.test.mjs）
};

// CDP 白名单（硬拷贝 shared/protocol.mjs CDP_ALLOWLIST；tab_cdp_call 默认拒绝）
const CDP_ALLOWLIST = new Set([
  'Page.enable', 'Page.disable', 'Page.navigate', 'Page.reload', 'Page.stopLoading',
  'Page.captureScreenshot', 'Page.printToPDF', 'Page.getFrameTree', 'Page.getResourceTree',
  'Page.getResourceContent', 'Page.getNavigationHistory', 'Page.navigateToHistoryEntry',
  'Page.handleJavaScriptDialog', 'Page.setLifecycleEventsEnabled', 'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument', 'Page.setInterceptFileChooserDialog', 'Page.setDownloadBehavior',
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
  'WebMCP.enable', 'WebMCP.disable', 'WebMCP.invokeTool', 'WebMCP.cancelInvocation',
]);

// 运行态（易失；权威数据在 chrome.storage，见文件头注释）
const st = {
  port: null,               // 当前 runtime.Port
  connState: 'disconnected',// connected | reconnecting | disconnected
  reconnectAttempt: 0,      // 0 = 上次连接成功后尚未失败
  nextReqId: 1,             // 出站请求自增 id
  pending: new Map(),       // id -> {resolve, reject, timer, method} 挂起请求表
  attached: new Set(),      // 已通过 chrome.debugger.attach 持有的 tabId
  injected: new Set(),      // 已 addScriptToEvaluateOnNewDocument 注入定位器的 tabId
  viewport: null,           // {width, height} 当前视口覆盖（null = 无）
  session: null,            // {sessionId, turnId, name} 最近一次 session_setup
  leases: {},               // {tabId: lease} 与 chrome.storage.session 同步的镜像
  instanceId: '',           // 缓存的实例 id
  cdpRings: new Map(),      // tabId -> {seq, items:[{seq,method,params,ts}]}
  logRings: new Map(),      // tabId -> [{ts,level,text}]
  dialogs: new Map(),       // tabId -> Page.javascriptDialogOpening params
  axNodes: new Map(),       // tabId -> [{idx, backendDOMNodeId}]
  webmcpTools: new Map(),        // tabId -> Map(name -> CDP WebMCP.Tool)
  webmcpAddedWaiters: new Map(), // tabId -> [resolve]（等 toolsAdded 的命令挂起处）
  webmcpInvokeWaiters: new Map(),// invocationId -> resolve(params)（等 toolResponded）
};

function log(...args) { try { console.log('[ab]', ...args); } catch (e) { /* noop */ } }
function errMsg(e) { return (e && e.message) ? e.message : String(e); }
// 构造带 JSON-RPC code 的错误对象（处理器里 throw，统一在 dispatch 处转 error 响应）
function abErr(code, message, data) {
  const e = new Error(message);
  e.code = code;
  if (data !== undefined) e.data = data;
  return e;
}
// JSON 安全序列化（用于把参数内嵌进页面表达式）
function J(v) { return JSON.stringify(v); }

// =====================================================================
// 【1. 传输层】 native messaging transport + reconnect state machine
// =====================================================================

function setConnState(s) { st.connState = s; log('transport:', s); }

// 立即尝试建立 native messaging 连接；失败路径由 onDisconnect 驱动退避
function connectTransport() {
  if (st.port) return;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    log('connectNative threw:', errMsg(e));
    scheduleReconnect();
    return;
  }
  st.port = port;
  port.onMessage.addListener(onFrame);
  port.onDisconnect.addListener(() => onPortClosed(port));
  st.reconnectAttempt = 0; // 连接建立成功，退避计数清零
  chrome.alarms.clear(ALARM_RECONNECT).catch(() => {});
  setConnState('connected');
  sendHello(); // 每次连上都重新注册（service 重启后也要重新认识我们）
}

// 断线：拒绝所有挂起请求；首次断开立即重试，之后按退避表用 chrome.alarms 重试
function onPortClosed(port) {
  if (st.port !== port) return; // 过期端口的事件，忽略
  const lastErr = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
  st.port = null;
  rejectAllPending('native transport disconnected' + (lastErr ? ': ' + lastErr : ''));
  setConnState('disconnected');
  if (st.reconnectAttempt === 0) {
    st.reconnectAttempt = 1;
    connectTransport(); // 立即重试一次（spec：chrome.alarms + 立即重试）
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  st.reconnectAttempt += 1;
  // 下标钳制到 0：首次同步失败时 attempt-2 = -1 会取到 undefined（when=NaN 闹钟建不起来，
  // 重连链死亡）——2026-10-13 真 Chrome 实测复现修复
  const delay = BACKOFF_MS[Math.max(0, Math.min(st.reconnectAttempt - 2, BACKOFF_MS.length - 1))];
  setConnState('reconnecting');
  chrome.alarms.create(ALARM_RECONNECT, { when: Date.now() + delay });
  log('reconnect in', delay, 'ms (attempt', st.reconnectAttempt, ')');
}

// 入站帧路由：有 method → 命令/通知分发；有 id 无 method → 挂起请求配对
function onFrame(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.method === 'string') { handleInbound(msg); return; }
  if (msg.id !== undefined) {
    const p = st.pending.get(msg.id);
    if (!p) { log('unmatched response id', msg.id); return; }
    st.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const e = new Error(msg.error.message || 'rpc error');
      e.code = msg.error.code; e.data = msg.error.data;
      p.reject(e);
    } else {
      p.resolve(msg.result);
    }
  }
}

// 出站请求：{jsonrpc,id,method,params}，20s 超时；断线即拒
function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!st.port) { reject(new Error('native transport disconnected')); return; }
    const id = st.nextReqId++;
    const timer = setTimeout(() => {
      st.pending.delete(id);
      reject(new Error('request timeout: ' + method));
    }, REQ_TIMEOUT_MS);
    st.pending.set(id, { resolve, reject, timer, method });
    postFrame({ jsonrpc: '2.0', id, method, params: params || {} });
  });
}

// 出站通知（事件上报）：无 id，尽力而为
function sendNotification(method, params) {
  postFrame({ jsonrpc: '2.0', method, params: params || {} });
}

function postFrame(obj) {
  if (!st.port) return;
  try { st.port.postMessage(obj); } catch (e) { log('postMessage failed:', errMsg(e)); }
}

function rejectAllPending(reason) {
  for (const [, p] of st.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
  st.pending.clear();
}

// =====================================================================
// 【2. 注册】 ext/hello —— 连上即发，携带实例身份与能力
// =====================================================================

async function getInstanceId() {
  if (st.instanceId) return st.instanceId;
  const got = await chrome.storage.local.get('ab_instanceId');
  let v = got && got.ab_instanceId;
  if (!v) {
    v = crypto.randomUUID();
    await chrome.storage.local.set({ ab_instanceId: v });
  }
  st.instanceId = v;
  return v;
}

// 浏览器家族：按 UA 中的家族标记判断（Edge/Opera/Brave/Vivaldi 都带 Chrome/ 标记，需先判家族）
function detectFamily() {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('OPR/')) return 'opera';
  if (ua.includes('Brave/')) return 'brave';
  if (ua.includes('Vivaldi/')) return 'vivaldi';
  return 'chrome';
}

function detectBrowserVersion() {
  const m = navigator.userAgent.match(/Chrome\/([\d.]+)/);
  return m ? m[1] : '';
}

async function sendHello() {
  try {
    sendNotification(EV.HELLO, {
      instanceId: await getInstanceId(),
      family: detectFamily(),
      browserVersion: detectBrowserVersion(),
      userAgent: navigator.userAgent,
      capabilities: CAPABILITIES.slice(),
      protocol: PROTOCOL_VERSION,
    });
  } catch (e) { log('sendHello failed:', errMsg(e)); }
}

// =====================================================================
// 【5. 租约】 lease registry —— chrome.storage.session 持久化，扩展是权威
// =====================================================================

async function persistLeases() {
  try { await chrome.storage.session.set({ [LEASE_KEY]: st.leases }); }
  catch (e) { log('persistLeases failed:', errMsg(e)); }
}

function broadcastLease(tabId, lease) {
  sendNotification(EV.LEASE, { tabId, lease: lease || null });
}

async function setBadge(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    await chrome.action.setBadgeText({ tabId, text: '●' });
  } catch (e) { /* tab 可能已关闭，忽略 */ }
}

async function clearBadge(tabId) {
  try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) { /* 忽略 */ }
}

function sessionIdOf() { return st.session ? st.session.sessionId : 'adhoc'; }

// 登记租约；若被其他 active 会话持有 → LEASE_CONFLICT(-32003)
async function acquireLease(tabId, origin) {
  const existing = st.leases[String(tabId)];
  if (existing && existing.state === 'active' && existing.sessionId !== sessionIdOf()) {
    throw abErr(ERR.LEASE_CONFLICT, 'tab ' + tabId + ' is leased by session ' + existing.sessionId);
  }
  const lease = {
    tabId, sessionId: sessionIdOf(), turnId: st.session ? st.session.turnId : '',
    instanceId: st.instanceId || (await getInstanceId()), origin,
    claimedAt: Date.now(), state: 'active', status: 'default',
  };
  st.leases[String(tabId)] = lease;
  await persistLeases();
  await setBadge(tabId);
  broadcastLease(tabId, lease);
  return lease;
}

async function dropLease(tabId) {
  const key = String(tabId);
  if (!(key in st.leases)) return;
  delete st.leases[key];
  await persistLeases();
  await clearBadge(tabId);
  broadcastLease(tabId, null);
}

// =====================================================================
// 【6. attach 管理】 chrome.debugger 生命周期 + CDP 辅助
// =====================================================================

// 原始 sendCommand 包装：把 chrome.debugger 错误转成带 code 的异常
async function cdpSend(tabId, method, params) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params || {});
  } catch (e) {
    throw abErr(ERR.INTERNAL, 'CDP ' + method + ' failed: ' + errMsg(e));
  }
}

// 幂等 attach：已持有直接返回；attach 失败分两种——
//  1) "Another debugger ..."：可能是本扩展 SW 被杀后残留的 attach（attachment 属于扩展而非 SW 实例），
//     用一条轻量命令验证所有权（他方持有时我们的 sendCommand 会失败）；
//  2) 其他原因（tab 不存在 / 权限）：NOT_ATTACHED(-32005) 带原因。
async function ensureAttached(tabId) {
  if (st.attached.has(tabId)) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch (e) { throw abErr(ERR.TAB_NOT_FOUND, 'no tab ' + tabId); }
  if (tab.status === 'unloaded') { /* 仍可 attach，忽略 */ }
  let attachedNow = true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const msg = errMsg(e);
    if (!/another debugger|already attached/i.test(msg)) {
      throw abErr(ERR.NOT_ATTACHED, 'attach failed: ' + msg);
    }
    try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'); }
    catch (e2) { throw abErr(ERR.NOT_ATTACHED, 'debugger held by another client: ' + msg); }
    attachedNow = false; // 复用本扩展残留的 attach（无需重新 init 域，但仍确保基础域开启）
  }
  st.attached.add(tabId);
  try {
    await cdpSend(tabId, 'Page.enable', {});
    await cdpSend(tabId, 'Runtime.enable', {});
    await cdpSend(tabId, 'DOM.enable', {});
    if (st.viewport) await applyViewport(tabId); // 新 attach 应用当前视口
    // 附身即启用 WebMCP（v0.2.2）：不等首次 list——toolsAdded 从 attach 起就有第一推动。
    // 尽力而为：旧 Chrome 无此域时静默忽略（list 命令仍会给出明确 -32011 提示）。
    try { await cdpSend(tabId, 'WebMCP.enable', {}); } catch (e) { /* 不支持则跳过 */ }
  } catch (e) {
    if (attachedNow) { try { await chrome.debugger.detach({ tabId }); } catch (e2) { /* 忽略 */ } }
    st.attached.delete(tabId);
    throw abErr(ERR.NOT_ATTACHED, 'attach init failed: ' + errMsg(e));
  }
}

async function detachTab(tabId) {
  if (!st.attached.has(tabId)) return;
  st.attached.delete(tabId);
  st.injected.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (e) { /* 已断开则忽略 */ }
}

async function applyViewport(tabId) {
  if (!st.viewport) return;
  await cdpSend(tabId, 'Emulation.setDeviceMetricsOverride', {
    width: st.viewport.width, height: st.viewport.height,
    deviceScaleFactor: 1, mobile: false,
  });
}

// =====================================================================
// 定位器运行时（注入页面的脚本，字符串常量）
// 提供 window.__abQuery(selectorDesc) -> Element[] 与 window.__abAct(el, action, value)
// 匹配语义参照 Playwright：text 大小写不敏感包含（exact 则 trim 后全等）；role 支持隐式角色映射
// =====================================================================

const LOCATOR_RUNTIME = `
(function () {
  if (window.__abReady) { return; }
  window.__abReady = true;
  var IMPLICIT = {
    nav: 'navigation', main: 'main', aside: 'complementary', header: 'banner',
    footer: 'contentinfo', form: 'form', ul: 'list', ol: 'list', li: 'listitem',
    table: 'table', img: 'image', details: 'group', dialog: 'dialog',
    search: 'search', meter: 'meter', progress: 'progressbar',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading'
  };
  var INPUT_BUTTON = { button: 1, submit: 1, reset: 1, image: 1 };
  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r) { return String(r).trim().split(/\\s+/)[0].toLowerCase(); }
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input') {
      var ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (INPUT_BUTTON[ty]) { return 'button'; }
      if (ty === 'checkbox') { return 'checkbox'; }
      if (ty === 'radio') { return 'radio'; }
      if (ty === 'range') { return 'slider'; }
      if (ty === 'number') { return 'spinbutton'; }
      if (ty === 'search') { return 'searchbox'; }
      return 'textbox';
    }
    if (tag === 'a') { return el.getAttribute('href') != null ? 'link' : null; }
    if (tag === 'button') { return 'button'; }
    if (tag === 'select') { return 'combobox'; }
    if (tag === 'textarea') { return 'textbox'; }
    return IMPLICIT[tag] || null;
  }
  function ownText(el) {
    var s = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) { s += n.nodeValue; }
    }
    return s;
  }
  function visibleText(el) {
    var t = el.innerText;
    return (typeof t === 'string' && t) ? t : ownText(el);
  }
  function labelOf(el) {
    var al = el.getAttribute('aria-label');
    if (al != null && al !== '') { return al; }
    var id = el.id;
    if (id) {
      var labels = document.querySelectorAll('label[for]');
      for (var i = 0; i < labels.length; i++) {
        if (labels[i].getAttribute('for') === id) { return visibleText(labels[i]); }
      }
    }
    var anc = el.closest ? el.closest('label') : null;
    if (anc) { return visibleText(anc); }
    return null;
  }
  function nameOf(el) {
    var al = el.getAttribute('aria-label');
    if (al != null && al !== '') { return al; }
    var lb = labelOf(el);
    if (lb) { return lb; }
    return visibleText(el);
  }
  function textMatch(actual, want, exact) {
    if (actual == null) { return false; }
    var w = String(want == null ? '' : want).trim().toLowerCase();
    if (w === '') { return false; }
    var a = String(actual).trim().toLowerCase();
    return exact ? a === w : a.indexOf(w) !== -1;
  }
  var SKIP = { script: 1, style: 1, noscript: 1, template: 1 };
  window.__abQuery = function (sel) {
    var out = [];
    try {
      if (!sel || typeof sel !== 'object') { return out; }
      var kind = sel.kind, v = sel.value, exact = !!sel.exact;
      if (kind === 'css') {
        return Array.prototype.slice.call(document.querySelectorAll(String(v == null ? '' : v)));
      }
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (SKIP[tag]) { continue; }
        if (kind === 'testid') {
          if (el.getAttribute('data-testid') === String(v)) { out.push(el); }
        } else if (kind === 'placeholder') {
          var ph = el.getAttribute('placeholder');
          if (ph != null && textMatch(ph, v, exact)) { out.push(el); }
        } else if (kind === 'text') {
          if (!textMatch(visibleText(el), v, exact)) { continue; }
          var inner = false;
          for (var c = 0; c < el.children.length; c++) {
            if (textMatch(visibleText(el.children[c]), v, exact)) { inner = true; break; }
          }
          if (!inner) { out.push(el); }
        } else if (kind === 'label') {
          var lb = labelOf(el);
          if (textMatch(lb, v, exact)) { out.push(el); }
        } else if (kind === 'role') {
          var r = roleOf(el);
          if (r && r === String(v).toLowerCase()) {
            if (sel.name == null || textMatch(nameOf(el), sel.name, exact)) { out.push(el); }
          }
        }
      }
    } catch (e) { return out; }
    return out;
  };
  function fire(el, type, Ctor, opts) {
    var ev;
    try {
      ev = new Ctor(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: window }, opts || {}));
    } catch (e) {
      ev = document.createEvent('HTMLEvents');
      ev.initEvent(type, true, true);
    }
    try { el.dispatchEvent(ev); } catch (e) { }
  }
  function setValue(el, val) {
    var s = val == null ? '' : String(val);
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) { d.set.call(el, s); } else { el.value = s; }
  }
  window.__abAct = function (el, action, value) {
    switch (action) {
      case 'click':
        if (el.scrollIntoView) { try { el.scrollIntoView({ block: 'center' }); } catch (e) { } }
        fire(el, 'pointerdown', window.PointerEvent || MouseEvent);
        fire(el, 'mousedown', MouseEvent);
        fire(el, 'pointerup', window.PointerEvent || MouseEvent);
        fire(el, 'mouseup', MouseEvent);
        el.click();
        return { clicked: true };
      case 'fill':
        el.focus();
        setValue(el, value);
        fire(el, 'input', window.InputEvent || Event);
        fire(el, 'change', Event);
        return { filled: value == null ? '' : String(value) };
      case 'press':
        var k = { key: String(value == null ? '' : value), code: String(value == null ? '' : value) };
        fire(el, 'keydown', KeyboardEvent, k);
        fire(el, 'keypress', KeyboardEvent, k);
        fire(el, 'keyup', KeyboardEvent, k);
        return { pressed: String(value == null ? '' : value) };
      case 'hover':
        fire(el, 'mouseover', MouseEvent);
        fire(el, 'mouseenter', MouseEvent, { bubbles: false });
        fire(el, 'mousemove', MouseEvent);
        return { hovered: true };
      case 'focus':
        el.focus();
        return { focused: true };
      case 'check':
      case 'uncheck':
        if ('checked' in el) {
          el.checked = action === 'check';
          fire(el, 'input', window.InputEvent || Event);
          fire(el, 'change', Event);
        }
        return { checked: !!el.checked };
      case 'select':
        setValue(el, value);
        fire(el, 'change', Event);
        return { selected: value == null ? '' : String(value) };
      default:
      case 'read':
        return {
          text: String(visibleText(el)).trim(),
          value: ('value' in el) ? el.value : null,
          visible: !!(el.offsetParent || el.getClientRects().length)
        };
    }
  };
})();
`;

// 确保定位器在当前文档可用：新文档靠 addScriptToEvaluateOnNewDocument（一次），
// 当前文档靠每次 Runtime.evaluate 幂等补注入（运行时自带 __abReady 守卫）
async function ensureLocatorRuntime(tabId) {
  if (!st.injected.has(tabId)) {
    await cdpSend(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: LOCATOR_RUNTIME });
    st.injected.add(tabId);
  }
  await cdpSend(tabId, 'Runtime.evaluate', { expression: LOCATOR_RUNTIME, returnByValue: true });
}

// =====================================================================
// 【3. 命令注册表】 command registry —— 实现 shared/protocol.mjs COMMANDS 全部命令
// =====================================================================

// 类型检查器：'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'，支持 '[]' 数组与 '?' 可选
function checkPrim(t, v) {
  switch (t) {
    case 'string': return typeof v === 'string' ? null : 'must be string';
    case 'number': return (typeof v === 'number' && Number.isFinite(v)) ? null : 'must be number';
    case 'boolean': return typeof v === 'boolean' ? null : 'must be boolean';
    case 'object': return (v && typeof v === 'object' && !Array.isArray(v)) ? null : 'must be object';
    case 'array': return Array.isArray(v) ? null : 'must be array';
    default: return null; // 'any'
  }
}

// 返回 null 表示校验通过；返回字符串为错误描述（→ -32602）
function validateParams(spec, params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return 'params must be an object';
  }
  for (const key of Object.keys(spec)) {
    const type = spec[key];
    const optional = type.endsWith('?');
    const base = optional ? type.slice(0, -1) : type;
    const v = params[key];
    if (v === undefined || v === null) {
      if (optional) continue;
      return key + ' is required';
    }
    if (base.endsWith('[]')) {
      const prim = base.slice(0, -2);
      if (!Array.isArray(v)) return key + ' must be ' + base;
      for (const item of v) {
        const e = checkPrim(prim, item);
        if (e) return key + ' item ' + e;
      }
    } else {
      const e = checkPrim(base, v);
      if (e) return key + ' ' + e;
    }
  }
  return null;
}

// ---- 会话生命周期 ----

async function cmdSessionSetup(p) {
  st.session = { sessionId: p.sessionId, turnId: p.turnId, name: '' };
  try { await chrome.storage.session.set({ [SESSION_KEY]: st.session }); } catch (e) { log(errMsg(e)); }
  return { ok: true };
}

async function cmdSessionKeepalive() {
  return { ok: true };
}

async function cmdNameSession(p) {
  if (st.session && st.session.sessionId === p.sessionId) {
    st.session.name = p.name;
    try { await chrome.storage.session.set({ [SESSION_KEY]: st.session }); } catch (e) { log(errMsg(e)); }
  }
  return { ok: true };
}

// finalize：本会话所有 active 租约置 finalized（含保留页）；关闭其中 origin=agent 且不在 keepTabIds 的标签页
async function cmdSessionFinalize(p) {
  const keep = new Set(p.keepTabIds || []);
  const mine = Object.values(st.leases).filter((l) => l.sessionId === p.sessionId);
  const toClose = [];
  for (const lease of mine) {
    if (lease.state !== 'active') continue;
    lease.state = 'finalized';
    await clearBadge(lease.tabId);
    broadcastLease(lease.tabId, lease);
    if (lease.origin === 'agent' && !keep.has(lease.tabId)) toClose.push(lease.tabId);
  }
  await persistLeases();
  for (const tabId of toClose) {
    try { await detachTab(tabId); } catch (e) { /* 忽略 */ }
    try { await chrome.tabs.remove(tabId); } catch (e) { /* 已关闭则忽略 */ }
  }
  if (st.session && st.session.sessionId === p.sessionId) {
    st.session = null;
    try { await chrome.storage.session.remove(SESSION_KEY); } catch (e) { log(errMsg(e)); }
  }
  return { ok: true, closedTabIds: toClose };
}

// ---- 浏览器级 ----

async function cmdBrowserStatus() {
  return {
    connected: st.connState === 'connected',
    instanceId: await getInstanceId(),
    family: detectFamily(),
    browserVersion: detectBrowserVersion(),
    agentTabIds: Object.values(st.leases)
      .filter((l) => l.origin === 'agent' && l.state === 'active')
      .map((l) => l.tabId),
    version: PROTOCOL_VERSION,
  };
}

async function cmdVisibilityGet() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: false });
  return { visible: wins.some((w) => w.focused) };
}

async function cmdVisibilitySet(p) {
  if (p.visible) {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: false });
    if (!wins.length) throw abErr(ERR.INTERNAL, 'no normal window to focus');
    const target = wins.find((w) => w.focused) || wins[wins.length - 1];
    await chrome.windows.update(target.id, { focused: true });
  } else {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: false });
    for (const w of wins) await chrome.windows.update(w.id, { state: 'minimized' });
  }
  return { ok: true };
}

async function cmdViewportGet() {
  return { viewport: st.viewport || null };
}

async function cmdViewportSet(p) {
  if (!(p.width > 0 && p.height > 0 && p.width <= 10000 && p.height <= 10000)) {
    throw abErr(ERR.INVALID_PARAMS, 'width/height must be in (0, 10000]');
  }
  st.viewport = { width: Math.round(p.width), height: Math.round(p.height) };
  try { await chrome.storage.session.set({ [VIEWPORT_KEY]: st.viewport }); } catch (e) { log(errMsg(e)); }
  for (const tabId of st.attached) {
    try { await applyViewport(tabId); } catch (e) { log('viewport apply failed', tabId, errMsg(e)); }
  }
  return { ok: true, appliedTo: st.attached.size };
}

async function cmdViewportReset() {
  st.viewport = null;
  try { await chrome.storage.session.remove(VIEWPORT_KEY); } catch (e) { log(errMsg(e)); }
  for (const tabId of st.attached) {
    try { await cdpSend(tabId, 'Emulation.clearDeviceMetricsOverride', {}); } catch (e) { /* 忽略 */ }
  }
  return { ok: true };
}

async function cmdBrowserHistory(p) {
  const items = await chrome.history.search({ text: '', maxResults: p.limit || 50 });
  return {
    items: items.map((it) => ({ url: it.url || '', title: it.title || '', lastVisitedTs: it.lastVisitTime || 0 })),
  };
}

async function cmdBrowserOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const rows = tabs.map((t) => ({
    tabId: t.id, title: t.title || '', url: t.pendingUrl || t.url || '',
    active: !!t.active, windowId: t.windowId, lastAccessed: t.lastAccessed || 0,
  }));
  rows.sort((a, b) => b.lastAccessed - a.lastAccessed);
  return { tabs: rows };
}

// ---- 标签页生命周期 ----

// 加入/创建 "Agent" 标签组（优先同窗口已有的同名组；失败不影响主流程）
async function addToAgentGroup(tabId, windowId) {
  try {
    const groups = await chrome.tabGroups.query({ title: 'Agent' });
    const same = groups.find((g) => g.windowId === windowId);
    const groupId = await chrome.tabs.group(
      same ? { tabIds: [tabId], groupId: same.id } : { tabIds: [tabId], createProperties: { windowId } }
    );
    if (!same) await chrome.tabGroups.update(groupId, { title: 'Agent', color: 'grey' });
  } catch (e) { log('agent group failed:', errMsg(e)); }
}

async function cmdTabCreate(p) {
  const tab = await chrome.tabs.create({
    url: p.url || 'about:blank',
    active: !p.background,
    windowId: p.windowId,
  });
  await acquireLease(tab.id, 'agent');
  await addToAgentGroup(tab.id, tab.windowId);
  return { tabId: tab.id, url: tab.pendingUrl || tab.url || p.url || 'about:blank' };
}

// 认领已有标签页：title/url 传了就必须与现值完全一致（防 tabId 复用错认）
async function cmdTabClaim(p) {
  let tab;
  try { tab = await chrome.tabs.get(p.providerTabId); }
  catch (e) { throw abErr(ERR.TAB_NOT_FOUND, 'no tab ' + p.providerTabId); }
  const curUrl = tab.pendingUrl || tab.url || '';
  if (p.title !== undefined && p.title !== null && p.title !== (tab.title || '')) {
    throw abErr(ERR.TAB_NOT_FOUND, 'title mismatch (tabId reuse?): expected ' + J(p.title) + ' got ' + J(tab.title));
  }
  if (p.url !== undefined && p.url !== null && p.url !== curUrl) {
    throw abErr(ERR.TAB_NOT_FOUND, 'url mismatch (tabId reuse?): expected ' + J(p.url) + ' got ' + J(curUrl));
  }
  await acquireLease(tab.id, 'agent'); // 冲突 → -32003；不动标签组
  return { tabId: tab.id };
}

async function cmdTabClose(p) {
  try { await chrome.tabs.remove(p.tabId); }
  catch (e) { throw abErr(ERR.TAB_NOT_FOUND, 'cannot close tab ' + p.tabId + ': ' + errMsg(e)); }
  return { ok: true };
}

async function cmdTabInfo(p) {
  let tab;
  try { tab = await chrome.tabs.get(p.tabId); }
  catch (e) { throw abErr(ERR.TAB_NOT_FOUND, 'no tab ' + p.tabId); }
  return { url: tab.pendingUrl || tab.url || '', title: tab.title || '' };
}

async function cmdTabMark(p) {
  const allowed = ['deliverable', 'handoff', 'default'];
  if (!allowed.includes(p.status)) throw abErr(ERR.INVALID_PARAMS, 'status must be one of ' + allowed.join('|'));
  const lease = st.leases[String(p.tabId)];
  if (!lease) throw abErr(ERR.TAB_NOT_FOUND, 'tab ' + p.tabId + ' has no lease');
  lease.status = p.status;
  await persistLeases();
  broadcastLease(p.tabId, lease);
  return { ok: true };
}

async function cmdTabListAgentTabs(p) {
  const rows = [];
  for (const lease of Object.values(st.leases)) {
    if (lease.sessionId !== p.sessionId) continue;
    let info = { url: '', title: '' };
    try { const t = await chrome.tabs.get(lease.tabId); info = { url: t.pendingUrl || t.url || '', title: t.title || '' }; }
    catch (e) { /* 已关闭 */ }
    rows.push({ tabId: lease.tabId, status: lease.status || 'default', state: lease.state, ...info });
  }
  return { tabs: rows };
}

// ---- 导航 ----

async function cmdNavigateUrl(p) {
  try { await chrome.tabs.update(p.tabId, { url: p.url }); }
  catch (e) {
    const msg = errMsg(e);
    if (/no tab|cannot find|Invalid tab/i.test(msg)) throw abErr(ERR.TAB_NOT_FOUND, msg);
    throw abErr(ERR.NAVIGATION_BLOCKED, msg);
  }
  // 必须等加载完成再返回，否则调用方的 eval/定位器会跑在旧文档（about:blank）上
  const t = await waitTabComplete(p.tabId);
  return { ok: true, url: t.url, title: t.title };
}

// 轮询等待标签页 status=complete（chrome.tabs.update 的回调只代表导航已发起）
async function waitTabComplete(tabId, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); }
    catch (e) { throw abErr(ERR.TAB_NOT_FOUND, 'no tab ' + tabId); }
    if (tab.status === 'complete' || Date.now() - t0 > timeoutMs) return { url: tab.url, title: tab.title };
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function navAction(p, fn, label) {
  try { await fn(p.tabId); }
  catch (e) {
    const msg = errMsg(e);
    if (/no tab|cannot find|Invalid tab/i.test(msg)) throw abErr(ERR.TAB_NOT_FOUND, 'no tab ' + p.tabId);
    throw abErr(ERR.INTERNAL, label + ' failed: ' + msg);
  }
  const t = await waitTabComplete(p.tabId);
  return { ok: true, url: t.url, title: t.title };
}

// ---- 检查与交互 ----

async function cmdTabEval(p) {
  await ensureAttached(p.tabId);
  const r = await cdpSend(p.tabId, 'Runtime.evaluate', {
    expression: p.expression,
    returnByValue: p.returnByValue === false ? false : true,
    awaitPromise: true,
  });
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluation threw';
    return { value: { __error: String(msg) } };
  }
  const res = (r && r.result) || {};
  let value;
  if ('value' in res) value = res.value;
  else if (res.description !== undefined) value = res.description;
  else value = null;
  return { value: value === undefined ? null : value };
}

async function cmdTabScreenshot(p) {
  const format = p.format || 'png';
  if (format !== 'png' && format !== 'jpeg') throw abErr(ERR.INVALID_PARAMS, 'format must be png|jpeg');
  await ensureAttached(p.tabId);
  const shotParams = { format };
  if (format === 'jpeg' && typeof p.quality === 'number') {
    shotParams.quality = Math.max(0, Math.min(100, Math.round(p.quality)));
  }
  const r = await cdpSend(p.tabId, 'Page.captureScreenshot', shotParams);
  if (!r || !r.data) throw abErr(ERR.INTERNAL, 'empty screenshot');
  return { dataBase64: r.data };
}

// 元素级截图：定位器找第一个元素 → scrollIntoView → 取 getBoundingClientRect →
// Page.captureScreenshot 带 clip 裁剪。找不到元素按 TAB_NOT_FOUND 风格报错（与定位器一致）。
async function cmdElementScreenshot(p) {
  await ensureAttached(p.tabId);
  await ensureLocatorRuntime(p.tabId);
  const expr = '(function(){try{'
    + 'var els=window.__abQuery(' + J(p.selector) + ');'
    + 'if(!els.length){return {ok:false,value:{__error:"no matching element"}};}'
    + 'var el=els[0];'
    + 'if(el.scrollIntoView){try{el.scrollIntoView({block:"center"});}catch(e){}}'
    + 'var r=el.getBoundingClientRect();'
    + 'return {ok:true,value:{x:r.left,y:r.top,width:r.width,height:r.height}};'
    + '}catch(e){return {ok:false,value:{__error:String(e&&e.message||e)}};}})()';
  const r = await cdpSend(p.tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r && r.exceptionDetails) {
    throw abErr(ERR.INTERNAL, 'element query threw: ' + (r.exceptionDetails.text || ''));
  }
  const out = r && r.result && r.result.value;
  if (!out || !out.ok) {
    const why = out && out.value && out.value.__error;
    throw abErr(ERR.TAB_NOT_FOUND, 'element_screenshot: ' + (why || 'no matching element'));
  }
  const rect = out.value;
  if (!(rect.width > 0 && rect.height > 0)) {
    throw abErr(ERR.INTERNAL, 'element has no visible box (width/height <= 0)');
  }
  // scrollIntoView 后等一拍让渲染落定再截（clip 坐标取的是滚动后的视口系位置）
  await new Promise((res) => setTimeout(res, 120));
  const shot = await cdpSend(p.tabId, 'Page.captureScreenshot', {
    format: 'png',
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  if (!shot || !shot.data) throw abErr(ERR.INTERNAL, 'empty element screenshot');
  return { dataBase64: shot.data };
}

// AX 树里值得展示的角色（可交互 + 文本类）
const AX_KEEP_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox',
  'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem', 'statictext', 'heading', 'alert', 'dialog',
]);

async function cmdTabAxGetState(p) {
  await ensureAttached(p.tabId);
  await cdpSend(p.tabId, 'Accessibility.enable', {});
  const r = await cdpSend(p.tabId, 'Accessibility.getFullAXTree', {});
  const nodes = (r && r.nodes) || [];
  const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));
  // 深度：沿 parentId 上溯，带 memo；环/坏链由 64 层守卫兜底
  const depth = new Map();
  for (const n of nodes) {
    let d = 0, cur = n, guard = 0;
    while (cur.parentId != null && guard++ < 64) {
      const parent = nodeById.get(cur.parentId);
      if (!parent) break;
      if (depth.has(parent.nodeId)) { d += depth.get(parent.nodeId) + 1; break; }
      d += 1; cur = parent;
    }
    depth.set(n.nodeId, d);
  }
  const lines = [];
  const axNodes = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const d = depth.get(n.nodeId) || 0;
    if (d > 12) continue; // 深度上限 12
    const role = String((n.role && n.role.value) || 'unknown');
    const name = String((n.name && n.name.value) || '');
    const keep = name !== '' || AX_KEEP_ROLES.has(role);
    if (!keep) continue;
    const states = [];
    for (const prop of (n.properties || [])) {
      if (prop.value && prop.value.type === 'boolean' && prop.value.value === true) states.push(prop.name + '=true');
    }
    const idx = axNodes.length;
    axNodes.push({ idx, backendDOMNodeId: n.backendDOMNodeId || 0 });
    let line = '  '.repeat(d) + idx + ': ' + role + (name ? ' "' + name.slice(0, 300) + '"' : '')
      + (states.length ? ' [' + states.join(', ') + ']' : '');
    if (line.length > 400) line = line.slice(0, 400) + '…';
    lines.push(line);
    if (lines.length >= 800) { lines.push('…(truncated at 800 lines)'); break; }
  }
  st.axNodes.set(p.tabId, axNodes); // 供 tab_ax_action 用 elementIndex 反查
  return { ax: lines.join('\n') };
}

async function cmdTabAxAction(p) {
  await ensureAttached(p.tabId);
  if (!st.axNodes.has(p.tabId)) await cmdTabAxGetState({ tabId: p.tabId }); // 无缓存则先取一次
  const node = (st.axNodes.get(p.tabId) || []).find((n) => n.idx === p.elementIndex);
  if (!node || !node.backendDOMNodeId) {
    throw abErr(ERR.INVALID_PARAMS, 'bad elementIndex ' + p.elementIndex + ' (refresh with tab_ax_get_state)');
  }
  const be = node.backendDOMNodeId;
  if (p.action === 'click') {
    const r = await cdpSend(p.tabId, 'DOM.getBoxModel', { backendNodeId: be });
    const q = (r && r.model && r.model.content) || [];
    if (q.length < 8) throw abErr(ERR.INTERNAL, 'node has no box model (not rendered?)');
    let x = 0, y = 0;
    for (let i = 0; i < 8; i += 2) { x += q[i]; y += q[i + 1]; }
    const cx = Math.round(x / 4), cy = Math.round(y / 4); // 四角平均 = 中心
    await cdpSend(p.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await cdpSend(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    return { ok: true };
  }
  if (p.action === 'focus') {
    // Tab 键聚焦不可靠：用节点对象直接调 el.focus()
    const r = await cdpSend(p.tabId, 'DOM.resolveNode', { backendNodeId: be });
    const objectId = r && r.object && r.object.objectId;
    if (!objectId) throw abErr(ERR.INTERNAL, 'cannot resolve node to object');
    await cdpSend(p.tabId, 'Runtime.callFunctionOn', {
      objectId, functionDeclaration: 'function(){ this.focus(); }', returnByValue: true,
    });
    if (p.text) await cdpSend(p.tabId, 'Input.insertText', { text: p.text });
    return { ok: true };
  }
  if (p.action === 'scroll') {
    // scrollIntoViewIfNeeded 需要 nodeId（AX 树给的是 backendDOMNodeId，先 describeNode 换取）
    const r = await cdpSend(p.tabId, 'DOM.describeNode', { backendNodeId: be });
    const nodeId = r && r.node && r.node.nodeId;
    if (!nodeId) throw abErr(ERR.INTERNAL, 'cannot describe node');
    await cdpSend(p.tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId });
    return { ok: true };
  }
  throw abErr(ERR.INVALID_PARAMS, 'action must be click|focus|scroll');
}

async function cmdTabGetJsDialog(p) {
  return { dialog: st.dialogs.get(p.tabId) || null };
}

async function cmdTabHandleJsDialog(p) {
  await ensureAttached(p.tabId);
  const params = { accept: p.accept };
  if (p.promptText !== undefined && p.promptText !== null) params.promptText = p.promptText;
  await cdpSend(p.tabId, 'Page.handleJavaScriptDialog', params);
  st.dialogs.delete(p.tabId); // 处理完清缓存
  return { ok: true };
}

async function cmdTabDevLogs(p) {
  const ring = st.logRings.get(p.tabId) || [];
  const limit = p.limit || 50;
  return { logs: ring.slice(-limit) };
}

// service worker 无 DOM 剪贴板；诚实返回失败而不是假装成功（README 已注明替代方案）
async function cmdTabClipboardWriteText() {
  return { ok: false, reason: 'use locator fill' };
}

// ---- 定位器命令（在页面内执行 __abQuery / __abAct） ----

async function cmdLocatorCount(p) {
  await ensureAttached(p.tabId);
  await ensureLocatorRuntime(p.tabId);
  const r = await cdpSend(p.tabId, 'Runtime.evaluate', {
    expression: 'window.__abQuery(' + J(p.selector) + ').length',
    returnByValue: true,
  });
  if (r && r.exceptionDetails) throw abErr(ERR.INTERNAL, 'locator query threw: ' + (r.exceptionDetails.text || ''));
  return { count: (r && r.result && typeof r.result.value === 'number') ? r.result.value : 0 };
}

async function cmdLocatorAction(p) {
  await ensureAttached(p.tabId);
  await ensureLocatorRuntime(p.tabId);
  const expr = '(function(){try{'
    + 'var els=window.__abQuery(' + J(p.selector) + ');'
    + 'if(!els.length){return {ok:false,value:{__error:"no matching element"}};}'
    + 'var r=window.__abAct(els[0],' + J(p.action) + ',' + (p.value === undefined || p.value === null ? 'undefined' : J(p.value)) + ');'
    + 'return {ok:true,value:(r===undefined?null:r)};'
    + '}catch(e){return {ok:false,value:{__error:String(e&&e.message||e)}};}})()';
  const r = await cdpSend(p.tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r && r.exceptionDetails) {
    return { ok: false, value: { __error: r.exceptionDetails.text || 'action threw' } };
  }
  const out = (r && r.result && r.result.value) || { ok: false, value: { __error: 'no result' } };
  return out;
}

async function cmdLocatorSnapshot(p) {
  await ensureAttached(p.tabId);
  const r = await cdpSend(p.tabId, 'Runtime.evaluate', {
    expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
    returnByValue: true,
  });
  let html = (r && r.result && typeof r.result.value === 'string') ? r.result.value : '';
  if (html.length > SNAPSHOT_MAX) html = html.slice(0, SNAPSHOT_MAX) + '…(truncated at 200KB)';
  return { html };
}

// ---- CDP 直通 ----

async function cmdTabCdpCall(p) {
  if (!CDP_ALLOWLIST.has(p.method)) {
    throw abErr(ERR.CDP_DENIED, 'CDP method not allowlisted: ' + p.method);
  }
  await ensureAttached(p.tabId);
  const result = await cdpSend(p.tabId, p.method, p.params || {});
  return { result: result === undefined ? null : result };
}

async function cmdTabCdpEvents(p) {
  const ring = st.cdpRings.get(p.tabId);
  if (!ring) return { events: [], cursor: p.afterSequence || 0 };
  const after = p.afterSequence || 0;
  const limit = p.limit || 50;
  const events = ring.items.filter((it) => it.seq > after).slice(0, limit);
  const cursor = events.length ? events[events.length - 1].seq : after;
  // 游标之后有事件被环形逐出 → 说明读取太慢，标记 truncated
  const truncated = after > 0 && ring.items.length > 0 && ring.items[0].seq > after + 1;
  const out = { events, cursor };
  if (truncated) out.truncated = true;
  return out;
}

// ---- WebMCP（页面自声明工具，经 CDP WebMCP 实验域发现与调用）----
//
// 探测实证（Chrome for Testing 156）：域方法 WebMCP.enable / disable / invokeTool /
// cancelInvocation；发现靠事件——enable 会补发一条 toolsAdded（含全部当前工具），
// 之后增量 toolsAdded / toolsRemoved；invokeTool 立即回 invocationId，真正的结果在
// toolResponded 事件（status: Completed|Canceled|Error，output 为页面 execute 的返回值）。
// 旧版 Chrome 无此域 → chrome.debugger 报 "wasn't found" → 统一转 WEBMCP_UNSUPPORTED(-32011)。

// 仅识别"域/方法不存在"类报错（如 "'WebMCP.enable' wasn't found"）；
// 注意不能匹配 "Tool not found"（那是要调的工具不存在，不是浏览器不支持）
function isWebmcpUnsupportedErr(e) {
  const m = errMsg(e);
  if (!/webmcp/i.test(m)) return false;
  return /wasn.t found|was not found|unknown (method|command|domain)|no longer supported|unsupported/i.test(m);
}

async function webmcpSend(tabId, method, params) {
  try {
    return await cdpSend(tabId, method, params || {});
  } catch (e) {
    if (isWebmcpUnsupportedErr(e)) {
      throw abErr(ERR.WEBMCP_UNSUPPORTED, '此浏览器不支持 WebMCP（需要更新版 Chrome / 实验开关）');
    }
    throw e;
  }
}

// 工具缓存维护（由 chrome.debugger.onEvent 里的 WebMCP.* 分支调用）
function webmcpMergeTools(tabId, params) {
  let m = st.webmcpTools.get(tabId);
  if (!m) { m = new Map(); st.webmcpTools.set(tabId, m); }
  for (const t of ((params && params.tools) || [])) {
    if (t && typeof t.name === 'string') m.set(t.name, t);
  }
  const ws = st.webmcpAddedWaiters.get(tabId);
  if (ws) {
    st.webmcpAddedWaiters.delete(tabId);
    for (const w of ws) { try { w(); } catch (e) { /* 忽略 */ } }
  }
}

function webmcpRemoveTools(tabId, params) {
  const m = st.webmcpTools.get(tabId);
  if (!m) return;
  for (const t of ((params && params.tools) || [])) {
    if (t && typeof t.name === 'string') m.delete(t.name);
  }
}

// 工具清单变化上报：把该 tab 的完整工具名快照推给 service（尽力而为，不等待）。
// service 侧用它维护轻量收件箱，让 tab_info / 导航返回能附带 webmcpHint（推送式发现）。
function webmcpNotifyTools(tabId, kind) {
  const m = st.webmcpTools.get(tabId);
  sendNotification(EV.WEBMCP_TOOLS, { tabId, kind, toolNames: m ? [...m.keys()] : [] });
}

// 确保 WebMCP 域已启用且缓存就绪：enable → 等 toolsAdded（至多 WEBMCP_LIST_WAIT_MS）。
// 返回该 tab 的工具 Map（无事件 = 页面没申报工具，或页面 JS API 未启用）。
async function webmcpRefresh(tabId) {
  await ensureAttached(tabId);
  let settle = null;
  const wait = new Promise((r) => { settle = r; });
  let arr = st.webmcpAddedWaiters.get(tabId);
  if (!arr) { arr = []; st.webmcpAddedWaiters.set(tabId, arr); }
  arr.push(settle);
  try {
    await webmcpSend(tabId, 'WebMCP.enable', {});
    await Promise.race([wait, new Promise((r) => setTimeout(r, WEBMCP_LIST_WAIT_MS))]);
  } finally {
    const i = arr.indexOf(settle);
    if (i !== -1) arr.splice(i, 1);
    if (!arr.length) st.webmcpAddedWaiters.delete(tabId);
  }
  return st.webmcpTools.get(tabId) || new Map();
}

async function cmdWebmcpListTools(p) {
  const tools = await webmcpRefresh(p.tabId);
  const out = [];
  for (const t of tools.values()) {
    out.push({
      name: String(t.name || ''),
      description: String(t.description || ''),
      ...(t.inputSchema && typeof t.inputSchema === 'object' ? { inputSchema: t.inputSchema } : {}),
      readOnly: !!(t.annotations && t.annotations.readOnly), // 声明里没标就 false（保守）
    });
  }
  if (!out.length) {
    // 空列表时给一条可操作诊断：页面 API 是否启用（document.modelContext）
    try {
      const r = await cdpSend(p.tabId, 'Runtime.evaluate', {
        expression: '(typeof document !== "undefined") && !!document.modelContext',
        returnByValue: true,
      });
      if (!(r && r.result && r.result.value === true)) {
        return { tools: out, hint: '页面未申报任何 WebMCP 工具；此浏览器的 WebMCP 页面 API 未启用（需实验开关 --enable-experimental-web-platform-features 或更新版 Chrome），或当前页面确实没有申报' };
      }
    } catch (e) { /* 诊断失败不影响主结果 */ }
  }
  return { tools: out };
}

async function cmdWebmcpInvokeTool(p) {
  await ensureAttached(p.tabId);
  let tool = null;
  const cached = st.webmcpTools.get(p.tabId);
  if (cached) tool = cached.get(p.name);
  if (!tool) {
    tool = (await webmcpRefresh(p.tabId)).get(p.name); // SW 重启/首次调用缓存缺失 → 刷新
  }
  if (!tool) {
    throw abErr(ERR.INVALID_PARAMS, 'WebMCP tool not found: ' + p.name + '（先 webmcp_list_tools 刷新页面申报）');
  }
  // invokeTool 必须给工具所属 frame；缓存缺 frameId 时回退主 frame
  let frameId = tool.frameId || null;
  if (!frameId) {
    const ft = await cdpSend(p.tabId, 'Page.getFrameTree', {});
    frameId = ft && ft.frameTree && ft.frameTree.frame && ft.frameTree.frame.id;
  }
  const inv = await webmcpSend(p.tabId, 'WebMCP.invokeTool', {
    frameId, toolName: p.name, input: p.args || {},
  });
  const invocationId = inv && inv.invocationId;
  if (!invocationId) throw abErr(ERR.INTERNAL, 'WebMCP.invokeTool 未返回 invocationId');
  // 结果异步到达（WebMCP.toolResponded 事件），等待上限须低于 service 的 15s 命令超时
  const resp = await new Promise((resolve) => {
    st.webmcpInvokeWaiters.set(String(invocationId), resolve);
    setTimeout(() => {
      if (st.webmcpInvokeWaiters.delete(String(invocationId))) resolve(null);
    }, WEBMCP_INVOKE_WAIT_MS);
  });
  if (!resp) {
    try { await webmcpSend(p.tabId, 'WebMCP.cancelInvocation', { invocationId }); } catch (e) { /* 已结束则忽略 */ }
    throw abErr(ERR.INTERNAL, 'WebMCP 工具 ' + WEBMCP_INVOKE_WAIT_MS + 'ms 内未响应: ' + p.name);
  }
  if (resp.status === 'Completed') {
    return { result: resp.output === undefined ? null : resp.output };
  }
  const detail = resp.errorText
    || (resp.exception && (resp.exception.description || resp.exception.value))
    || resp.status || 'error';
  throw abErr(ERR.INTERNAL, 'WebMCP 工具 ' + p.name + ' 失败: ' + String(detail));
}

// ---- 下载 ----

async function cmdDownloadConfigSpecs() {
  return { maxItems: 10 };
}

async function cmdDownloadOpen(p) {
  try {
    await chrome.downloads.open(p.downloadId); // 需要 optional "downloads.open" 权限；失败如实报错
  } catch (e) {
    throw abErr(ERR.INTERNAL, 'downloads.open failed (needs optional downloads.open permission): ' + errMsg(e));
  }
  return { ok: true };
}

// 命令表：spec 拷贝自 shared/protocol.mjs COMMANDS；method 名 === 命令名
const REGISTRY = {
  session_setup: { spec: { sessionId: 'string', turnId: 'string' }, fn: cmdSessionSetup },
  session_keepalive: { spec: { sessionId: 'string' }, fn: cmdSessionKeepalive },
  session_finalize: { spec: { sessionId: 'string', keepTabIds: 'number[]' }, fn: cmdSessionFinalize },
  name_session: { spec: { sessionId: 'string', name: 'string' }, fn: cmdNameSession },

  browser_status: { spec: {}, fn: cmdBrowserStatus },
  browser_visibility_get: { spec: {}, fn: cmdVisibilityGet },
  browser_visibility_set: { spec: { visible: 'boolean' }, fn: cmdVisibilitySet },
  browser_viewport_get: { spec: {}, fn: cmdViewportGet },
  browser_viewport_set: { spec: { width: 'number', height: 'number' }, fn: cmdViewportSet },
  browser_viewport_reset: { spec: {}, fn: cmdViewportReset },
  browser_history: { spec: { limit: 'number?' }, fn: cmdBrowserHistory },
  browser_open_tabs: { spec: {}, fn: cmdBrowserOpenTabs },

  tab_create: { spec: { url: 'string?', background: 'boolean?', windowId: 'number?' }, fn: cmdTabCreate },
  tab_claim: { spec: { providerTabId: 'number', title: 'string?', url: 'string?' }, fn: cmdTabClaim },
  tab_close: { spec: { tabId: 'number' }, fn: cmdTabClose },
  tab_info: { spec: { tabId: 'number' }, fn: cmdTabInfo },
  tab_mark: { spec: { tabId: 'number', status: 'string' }, fn: cmdTabMark },
  tab_list_agent_tabs: { spec: { sessionId: 'string' }, fn: cmdTabListAgentTabs },

  navigate_tab_url: { spec: { tabId: 'number', url: 'string' }, fn: cmdNavigateUrl },
  navigate_tab_back: { spec: { tabId: 'number' }, fn: (p) => navAction(p, (id) => chrome.tabs.goBack(id), 'goBack') },
  navigate_tab_forward: { spec: { tabId: 'number' }, fn: (p) => navAction(p, (id) => chrome.tabs.goForward(id), 'goForward') },
  navigate_tab_reload: { spec: { tabId: 'number' }, fn: (p) => navAction(p, (id) => chrome.tabs.reload(id), 'reload') },

  tab_eval: { spec: { tabId: 'number', expression: 'string', returnByValue: 'boolean?' }, fn: cmdTabEval },
  tab_screenshot: { spec: { tabId: 'number', format: 'string?', quality: 'number?' }, fn: cmdTabScreenshot },
  tab_ax_get_state: { spec: { tabId: 'number' }, fn: cmdTabAxGetState },
  tab_ax_action: { spec: { tabId: 'number', action: 'string', elementIndex: 'number', text: 'string?' }, fn: cmdTabAxAction },
  tab_get_js_dialog: { spec: { tabId: 'number' }, fn: cmdTabGetJsDialog },
  tab_handle_js_dialog: { spec: { tabId: 'number', accept: 'boolean', promptText: 'string?' }, fn: cmdTabHandleJsDialog },
  tab_dev_logs: { spec: { tabId: 'number', limit: 'number?' }, fn: cmdTabDevLogs },
  tab_clipboard_write_text: { spec: { tabId: 'number', text: 'string' }, fn: cmdTabClipboardWriteText },

  locator_count: { spec: { tabId: 'number', selector: 'object' }, fn: cmdLocatorCount },
  locator_action: { spec: { tabId: 'number', selector: 'object', action: 'string', value: 'string?' }, fn: cmdLocatorAction },
  locator_snapshot: { spec: { tabId: 'number' }, fn: cmdLocatorSnapshot },
  element_screenshot: { spec: { tabId: 'number', selector: 'object' }, fn: cmdElementScreenshot },

  tab_cdp_call: { spec: { tabId: 'number', method: 'string', params: 'object?' }, fn: cmdTabCdpCall },
  tab_cdp_events: { spec: { tabId: 'number', afterSequence: 'number?', limit: 'number?' }, fn: cmdTabCdpEvents },

  webmcp_list_tools: { spec: { tabId: 'number' }, fn: cmdWebmcpListTools },
  webmcp_invoke_tool: { spec: { tabId: 'number', name: 'string', args: 'object?' }, fn: cmdWebmcpInvokeTool },

  download_config_specs: { spec: {}, fn: cmdDownloadConfigSpecs },
  download_open: { spec: { downloadId: 'number' }, fn: cmdDownloadOpen },
};

// 入站请求/通知分发：请求回 result|error；通知（无 id）只执行不回包
async function handleInbound(msg) {
  const id = msg.id;
  try {
    await readyPromise; // 等状态从 storage 恢复完毕（SW 冷启动竞态）
    if (msg.method === 'session_expire' && id === undefined) {
      st.session = null; // service 通知会话过期：清当前会话（不关标签页）
      chrome.storage.session.remove(SESSION_KEY).catch(() => {});
      return;
    }
    const entry = REGISTRY[msg.method];
    if (!entry) {
      if (id === undefined) return; // 未知通知：忽略（不能回错误）
      throw abErr(ERR.METHOD_NOT_FOUND, 'unknown method: ' + msg.method);
    }
    const verr = validateParams(entry.spec, msg.params || {});
    if (verr) throw abErr(ERR.INVALID_PARAMS, msg.method + ': ' + verr);
    const result = await entry.fn(msg.params || {});
    if (id !== undefined) postFrame({ jsonrpc: '2.0', id, result: result === undefined ? { ok: true } : result });
  } catch (e) {
    log('command error', msg.method, errMsg(e));
    if (id !== undefined) {
      const code = (e && typeof e.code === 'number') ? e.code : ERR.INTERNAL;
      const error = { code, message: errMsg(e) };
      if (e && e.data !== undefined) error.data = e.data;
      postFrame({ jsonrpc: '2.0', id, error });
    }
  }
}

// =====================================================================
// 【4. 事件桥】 chrome 事件 → 协议通知（onPageEvent/onCDPEvent/...）
// =====================================================================

// tabs.onUpdated：url/title 变化或加载完成 → onPageEvent{event:'changed'}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== 'complete') return;
  const params = { tabId, event: 'changed' };
  if (changeInfo.url) params.url = changeInfo.url;
  if (changeInfo.title) params.title = changeInfo.title;
  sendNotification(EV.PAGE, params);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  sendNotification(EV.PAGE, { tabId: activeInfo.tabId, event: 'activated', windowId: activeInfo.windowId });
});

// 标签页关闭：清理租约/attach/缓存，上报 removed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  st.attached.delete(tabId);
  st.injected.delete(tabId);
  st.cdpRings.delete(tabId);
  st.logRings.delete(tabId);
  st.dialogs.delete(tabId);
  st.axNodes.delete(tabId);
  st.webmcpTools.delete(tabId);
  await dropLease(tabId); // 广播 onLeaseChange{tabId, lease:null}
  sendNotification(EV.PAGE, { tabId, event: 'removed' });
});

// CDP 事件：先供内部消费（对话框/控制台日志/事件环），再转发 onCDPEvent
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  if (tabId === undefined) return;
  if (method === 'Page.javascriptDialogOpening') {
    st.dialogs.set(tabId, params || {});
    sendNotification(EV.DIALOG, { tabId, dialog: params || {} });
  } else if (method === 'Page.javascriptDialogClosed') {
    st.dialogs.delete(tabId); // 对话框已消失（accept/dismiss/页面卸载）
  } else if (method === 'Runtime.consoleAPICalled') {
    pushDevLog(tabId, (params && params.type) || 'log', argsToText(params && params.args));
  } else if (method === 'Runtime.exceptionThrown') {
    pushDevLog(tabId, 'error', exceptionToText(params && params.exceptionDetails));
  }
  // WebMCP：工具增删缓存 + 命令等待器唤醒（toolsAdded/toolsRemoved/toolResponded）
  //   缓存变化后顺手上报 onWebmcpTools（完整工具名快照），service 侧做推送式发现提示。
  if (method === 'WebMCP.toolsAdded') {
    webmcpMergeTools(tabId, params);
    webmcpNotifyTools(tabId, 'added');
  } else if (method === 'WebMCP.toolsRemoved') {
    webmcpRemoveTools(tabId, params);
    webmcpNotifyTools(tabId, 'removed');
  } else if (method === 'WebMCP.toolResponded') {
    const key = String((params && params.invocationId) || '');
    const w = st.webmcpInvokeWaiters.get(key);
    if (w) {
      st.webmcpInvokeWaiters.delete(key);
      try { w(params || {}); } catch (e) { /* 忽略 */ }
    }
  } else if (method === 'Page.frameNavigated' && params && params.frame && !params.frame.parentId) {
    st.webmcpTools.delete(tabId); // 主文档换页：旧文档申报的工具全部失效
    webmcpNotifyTools(tabId, 'changed'); // 旧工具清单已清空（快照=[]）
  }
  pushCdpEvent(tabId, method, params);
  sendNotification(EV.CDP, { tabId, method, params: params || {} });
});

// 用户打开 DevTools 或其他客户端抢走 debugger → 同步状态并上报
chrome.debugger.onDetach.addListener(async (source, reason) => {
  const tabId = source && source.tabId;
  if (tabId === undefined) return;
  st.attached.delete(tabId);
  st.injected.delete(tabId);
  sendNotification(EV.CDP_DETACH, { tabId, reason: reason || 'unknown' });
});

chrome.downloads.onChanged.addListener(async (delta) => {
  const params = { downloadId: delta.id, state: delta.state ? delta.state.current : undefined };
  if (delta.state && delta.state.current === 'complete') {
    try {
      const found = await chrome.downloads.search({ id: delta.id });
      if (found && found[0] && found[0].filename) params.filename = found[0].filename;
    } catch (e) { /* 忽略 */ }
  }
  sendNotification(EV.DOWNLOAD, params);
});

// ---- 事件环与日志环辅助 ----

function ringFor(map, tabId, init) {
  let r = map.get(tabId);
  if (!r) { r = init(); map.set(tabId, r); }
  return r;
}

function pushCdpEvent(tabId, method, params) {
  const ring = ringFor(st.cdpRings, tabId, () => ({ seq: 0, items: [] }));
  ring.seq += 1;
  ring.items.push({ seq: ring.seq, method, params: params || {}, ts: Date.now() });
  if (ring.items.length > MAX_CDP_EVENTS) ring.items.splice(0, ring.items.length - MAX_CDP_EVENTS);
}

function pushDevLog(tabId, level, text) {
  const ring = ringFor(st.logRings, tabId, () => []);
  ring.push({ ts: Date.now(), level: String(level), text: String(text).slice(0, 2000) });
  if (ring.length > MAX_DEV_LOGS) ring.splice(0, ring.length - MAX_DEV_LOGS);
}

// Runtime.consoleAPICalled 的 args（RemoteObject[]）→ 可读文本
function argsToText(args) {
  if (!Array.isArray(args)) return '';
  return args.map((a) => {
    if (!a) return '';
    if (a.value !== undefined) {
      if (typeof a.value === 'object') { try { return JSON.stringify(a.value); } catch (e) { return String(a.value); } }
      return String(a.value);
    }
    return a.description || a.type || '';
  }).join(' ');
}

// Runtime.exceptionThrown 的 exceptionDetails → 可读文本
function exceptionToText(d) {
  if (!d) return '';
  const ex = d.exception || {};
  const head = ex.description || (ex.value !== undefined ? String(ex.value) : '') || d.text || 'exception';
  const where = d.url ? (' @ ' + d.url + ':' + ((d.lineNumber || 0) + 1)) : '';
  return head + where;
}

// =====================================================================
// 启动：恢复持久化状态 → 连接传输层（listeners 已在上面同步注册）
// =====================================================================

async function initState() {
  try {
    await getInstanceId(); // 确保实例身份存在并缓存
    const sess = await chrome.storage.session.get([LEASE_KEY, SESSION_KEY, VIEWPORT_KEY]);
    if (sess && sess[LEASE_KEY] && typeof sess[LEASE_KEY] === 'object') st.leases = sess[LEASE_KEY];
    if (sess && sess[SESSION_KEY]) st.session = sess[SESSION_KEY];
    if (sess && sess[VIEWPORT_KEY]) st.viewport = sess[VIEWPORT_KEY];
    log('state restored: leases=' + Object.keys(st.leases).length +
      ' session=' + (st.session ? st.session.sessionId : 'none') +
      ' viewport=' + (st.viewport ? st.viewport.width + 'x' + st.viewport.height : 'none'));
  } catch (e) {
    log('initState failed:', errMsg(e));
  }
}

const readyPromise = initState();

// 重连闹钟：SW 可能被杀，闹钟是重试的持久载体
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_RECONNECT) return;
  if (st.port) return; // 已连上（竞态保护）
  connectTransport();
});

connectTransport(); // SW 启动立即尝试连接
