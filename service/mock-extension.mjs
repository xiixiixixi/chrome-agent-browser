// service/mock-extension.mjs — 测试/自检用伪扩展
//
// 一个 ws 客户端，同时扮演「host（发 host/hello）+ 扩展（发 ext/hello、响应命令、上报事件）」，
// 按真实线缆协议与 service 通信。用于 test/service.test.mjs 与 service.mjs --selftest。
//
// 用法：
//   const mock = await startMockExtension({ port, instanceId, handlers: { tab_claim: () => ({__error:{code:-32003,message:'...'}}) } });
//   mock.calls                     // 收到的所有命令 [{method, params, id}]
//   mock.emitEvent('onPageEvent', {tabId, event:'updated', url, title})
//   mock.close()

import process from 'node:process';
import WebSocket from 'ws';
import { CDP_ALLOWLIST } from '../shared/protocol.mjs';

let nextMockTabId = 4100;

/** 命令默认应答表（handlers 可按方法名覆盖；返回 {__error:{code,message}} 则回错误）。 */
function defaultHandler(method, params, respond, fail) {
  switch (method) {
    case 'session_setup': case 'session_keepalive': case 'session_finalize':
    case 'name_session': case 'browser_status': case 'browser_visibility_get':
    case 'browser_visibility_set': case 'browser_viewport_set': case 'browser_viewport_reset':
    case 'navigate_tab_url': case 'navigate_tab_back': case 'navigate_tab_forward':
    case 'navigate_tab_reload': case 'tab_close': case 'tab_mark': case 'tab_ax_action':
    case 'tab_get_js_dialog': case 'tab_handle_js_dialog': case 'download_config_specs':
    case 'download_open':
      respond({});
      return;
    case 'browser_viewport_get':
      respond({ viewport: null }); // 无状态默认；set→get 一致性由测试用自定义 handlers 闭包模拟
      return;
    case 'tab_create':
      respond({ tabId: nextMockTabId++, url: params.url ?? 'about:blank' });
      return;
    case 'tab_claim':
      respond({ tabId: params.providerTabId });
      return;
    case 'tab_info':
      respond({ url: 'https://example.com/info', title: 'Mock Page' });
      return;
    case 'tab_eval':
      respond({ value: 42 });
      return;
    case 'tab_screenshot':
      respond({ dataBase64: 'bW9jay1zY3JlZW5zaG90' }); // 'mock-screenshot'
      return;
    case 'element_screenshot':
      respond({ dataBase64: 'bW9jay1lbGVtZW50' }); // 'mock-element'（真实 PNG 由测试覆盖）
      return;
    case 'tab_ax_get_state':
      respond({ ax: JSON.stringify({ role: 'root', children: [] }) });
      return;
    case 'tab_dev_logs':
      respond({ logs: [{ level: 'info', text: 'mock log' }] });
      return;
    case 'tab_list_agent_tabs':
      respond({ tabs: [] });
      return;
    case 'browser_open_tabs':
      respond({ tabs: [{ tabId: 9001, title: 'Existing tab', url: 'https://existing.example/', selected: true }] });
      return;
    case 'browser_history':
      respond({ entries: [] });
      return;
    case 'locator_count':
      respond({ count: 1 });
      return;
    case 'locator_action':
      respond({ ok: true, value: null });
      return;
    case 'tab_cdp_call':
      if (!CDP_ALLOWLIST.has(params.method)) { fail(-32004, `CDP method not allowed: ${params.method}`); return; }
      respond({ result: { mock: true, method: params.method } });
      return;
    case 'tab_cdp_events':
      respond({ events: [], cursor: 0 });
      return;
    case 'webmcp_list_tools':
      respond({
        tools: [
          { name: 'get_time', description: '读取当前时间（只读）', inputSchema: { type: 'object', properties: {} }, readOnly: true },
          { name: 'set_note', description: '写入便签（非只读）', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, readOnly: false },
        ],
      });
      return;
    case 'webmcp_invoke_tool':
      respond({ result: { invoked: params.name, args: params.args ?? {} } });
      return;
    default:
      fail(-32601, `mock does not support command: ${method}`);
  }
}

export async function startMockExtension({
  port,
  instanceId = 'mock-instance-1',
  family = 'chrome',
  browserVersion = '131.0.0.1',
  profileName = null,
  capabilities = ['capabilities/tab/cdp'],
  handlers = {},
} = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  let onMessage = () => {};
  ws.on('message', (raw) => { try { onMessage(JSON.parse(String(raw))); } catch { /* 忽略坏帧 */ } });

  // 阶段 1：host/hello 握手（等 service 回 {ok:true}）
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock: host/hello reply timeout')), 5000);
    onMessage = (msg) => {
      if (msg && msg.id === 1 && msg.result && msg.result.ok === true) { clearTimeout(timer); resolve(); }
    };
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'host/hello', params: { protocol: 1, hostVersion: 'mock', pid: process.pid } }));
  });

  // 阶段 2：ext/hello 注册通知
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'ext/hello',
    params: {
      instanceId, family, browserVersion, userAgent: 'mockUA', capabilities,
      ...(profileName ? { profileName } : {}),
    },
  }));

  // 阶段 3：作为命令服务端（记录一切入站命令）
  const calls = [];
  onMessage = (msg) => {
    if (!msg || typeof msg.method !== 'string' || msg.id === undefined) return; // 忽略服务端通知/未知帧
    calls.push({ method: msg.method, params: msg.params ?? {}, id: msg.id });
    const respond = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    const fail = (code, message) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }));
    (async () => {
      const custom = handlers[msg.method];
      if (custom) {
        const r = await custom(msg.params ?? {}, msg);
        if (r && r.__error) fail(r.__error.code, r.__error.message);
        else respond(r ?? {});
      } else {
        defaultHandler(msg.method, msg.params ?? {}, respond, fail);
      }
    })().catch((err) => fail(-32603, String((err && err.message) || err)));
  };

  return {
    ws,
    instanceId,
    calls,
    /** 直接上报一个事件通知（EV.*）。 */
    emitEvent(method, params) { ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })); },
    close() { try { ws.terminate(); } catch { /* 已关 */ } },
  };
}
