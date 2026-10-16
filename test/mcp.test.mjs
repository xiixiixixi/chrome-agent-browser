// test/mcp.test.mjs — MCP 面测试（真实 WS + 伪扩展 + InMemoryTransport，不需要真浏览器）
//
// 起法与 test/service.test.mjs 相同（manager + policy + api），再叠一层：
// buildMcpServer → InMemoryTransport ↔ MCP Client（官方 SDK），走完整 tools/list 与 tools/call 线缆。

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConnectionManager } from '../service/connection.mjs';
import { createAgentApi } from '../service/api.mjs';
import { loadPolicy } from '../service/policy.mjs';
import { createAudit } from '../service/audit.mjs';
import { startMockExtension } from '../service/mock-extension.mjs';
import { buildMcpServer } from '../service/mcp.mjs';

// 1x1 真 PNG（base64 以 iVBOR 开头），覆盖 mock 默认的假截图应答
const REAL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==';
// 另一个 1x1 真 PNG（透明），用于区分元素级截图与整页截图的应答
const ELEMENT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const ALL_TOOLS = [
  'ab_list_browsers', 'ab_status', 'ab_visibility', 'ab_viewport', 'ab_open_tabs', 'ab_new_tab', 'ab_tab_info', 'ab_navigate',
  'ab_screenshot', 'ab_screencast', 'ab_ax_state', 'ab_claim_tab', 'ab_cdp', 'ab_download_open', 'ab_read_urls',
  'ab_confirm', 'ab_webmcp', 'ab_audit', 'ab_login', 'ab_credentials', 'browser_eval',
];

/** 起 MCP 栈：service 组装（同 service.test.mjs，简化）+ MCP server/client 对连 + 伪扩展。 */
async function startMcpStack(mockOpts = {}) {
  const audit = createAudit({ dir: mkdtempSync(join(tmpdir(), 'ab-mcp-audit-')) }); // 审计目录 = 独立临时目录
  const manager = new ConnectionManager({ port: 0, audit });
  await manager.start();
  const policy = loadPolicy(null, { audit }); // 默认策略：拦 chrome://settings/*、download_open 需确认、Fetch.enable 需确认
  const api = createAgentApi(() => manager.liveConnections(), { policy });

  const server = buildMcpServer({ api, policy, connections: () => manager.liveConnections(), audit });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-test', version: '0.0.1' });
  await client.connect(clientTransport);

  // 伪扩展：截图返回真 PNG，download_open 给空应答（mock 默认表无此命令），其余走默认
  const got = once(manager, 'browser');
  const mock = await startMockExtension({
    port: manager.port,
    handlers: {
      tab_screenshot: () => ({ dataBase64: REAL_PNG_B64 }),
      download_open: () => ({}),
    },
    ...mockOpts,
  });
  await got;

  /** tools/call → 原始 MCP 结果（含 content/isError）。 */
  async function call(name, args = {}) { return client.callTool({ name, arguments: args }); }
  /** tools/call → 断言非错误并解析首个 text content 为 JSON。 */
  async function callJson(name, args = {}) {
    const res = await client.callTool({ name, arguments: args });
    assert.ok(!res.isError, `${name} 不应报错: ${JSON.stringify(res.content)}`);
    const text = res.content.find((c) => c.type === 'text');
    assert.ok(text, `${name} 应有 text content`);
    return JSON.parse(text.text);
  }

  async function close() {
    mock.close();
    await client.close();
    await server.close();
    await manager.stop();
  }
  return { manager, policy, api, audit, server, client, mock, call, callJson, close };
}

test('tools/list 包含全部工具（ab_* + browser_eval）', async () => {
  const s = await startMcpStack();
  try {
    const res = await s.client.listTools();
    const names = res.tools.map((t) => t.name);
    for (const n of ALL_TOOLS) assert.ok(names.includes(n), `缺少工具: ${n}`);
    assert.equal(names.length, ALL_TOOLS.length);
  } finally { await s.close(); }
});

test('ab_webmcp：list → 只读 invoke 直通 → 非只读确认流（ab_confirm 放行）', async () => {
  const s = await startMcpStack();
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    // list：页面申报的两个工具（mock 默认应答）
    const list = await s.callJson('ab_webmcp', { action: 'list', tabId });
    assert.equal(list.tabId, tabId);
    assert.equal(list.tools.length, 2);
    assert.deepEqual(list.tools.map((t) => [t.name, t.readOnly]), [['get_time', true], ['set_note', false]]);
    assert.ok(s.mock.calls.some((c) => c.method === 'webmcp_list_tools' && c.params.tabId === tabId));

    // 只读工具直通
    const ro = await s.callJson('ab_webmcp', { action: 'invoke', tabId, name: 'get_time' });
    assert.equal(ro.ok, true);
    assert.deepEqual(ro.result, { invoked: 'get_time', args: {} });

    // 非只读工具：首次 needConfirmation（命令不出门）
    const need = await s.callJson('ab_webmcp', { action: 'invoke', tabId, name: 'set_note', args: { text: 'hi' } });
    assert.equal(need.needConfirmation, true);
    assert.match(need.description, /set_note/);
    assert.ok(!s.mock.calls.some((c) => c.method === 'webmcp_invoke_tool' && c.params.name === 'set_note'));

    // ab_confirm → 带 token 重试放行
    const conf = await s.callJson('ab_confirm', { token: need.token });
    assert.equal(conf.ok, true);
    const done = await s.callJson('ab_webmcp', { action: 'invoke', tabId, name: 'set_note', args: { text: 'hi' }, confirmationToken: need.token });
    assert.equal(done.ok, true);
    assert.deepEqual(done.result, { invoked: 'set_note', args: { text: 'hi' } });
    assert.ok(s.mock.calls.some((c) => c.method === 'webmcp_invoke_tool' && c.params.name === 'set_note'));
  } finally { await s.close(); }
});

test('ab_webmcp：不支持 WebMCP 的浏览器返回 -32011 结构化错误', async () => {
  const s = await startMcpStack({
    handlers: {
      webmcp_list_tools: () => ({ __error: { code: -32011, message: '此浏览器不支持 WebMCP（需要更新版 Chrome / 实验开关）' } }),
    },
  });
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    const res = await s.call('ab_webmcp', { action: 'list', tabId });
    assert.equal(res.isError, true);
    const parsed = JSON.parse(res.content.find((c) => c.type === 'text').text);
    assert.equal(parsed.code, -32011);
    assert.match(parsed.error, /WebMCP/);
  } finally { await s.close(); }
});

test('onWebmcpTools 推送式发现：ab_tab_info 附 webmcpHint + notifications/message 即时推送 + 去重 + ab_webmcp list 不受影响', async () => {
  const s = await startMcpStack();
  try {
    // 客户端订阅 notifications/message（SDK 客户端默认不特殊处理，手动挂监听）
    const logs = [];
    s.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { logs.push(n.params); });

    const { tabId } = await s.callJson('ab_new_tab', {});
    const info0 = await s.callJson('ab_tab_info', { tabId });
    assert.equal(info0.webmcpHint, undefined, '无通知时不应凭空出现 hint');

    // 伪扩展上报工具新增（完整清单快照）→ 收件箱 + 日志推送
    s.mock.emitEvent('onWebmcpTools', { tabId, kind: 'added', toolNames: ['ab_echo', 'get_time'] });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('2s 内未收到 notifications/message')), 2000);
      const poll = () => { if (logs.length) { clearTimeout(t); res(); } else setTimeout(poll, 20); };
      poll();
    });
    assert.equal(logs[0].level, 'info');
    assert.equal(logs[0].logger, 'webmcp');
    assert.match(logs[0].data, new RegExp(`tab ${tabId} 新增 WebMCP 工具: ab_echo,get_time`));

    const info = await s.callJson('ab_tab_info', { tabId });
    assert.deepEqual(info.webmcpHint, { toolNames: ['ab_echo', 'get_time'], count: 2 });

    // 相同清单再推一条 → 去重（不重复打扰）
    s.mock.emitEvent('onWebmcpTools', { tabId, kind: 'added', toolNames: ['ab_echo', 'get_time'] });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(logs.length, 1, '同清单应去重，不重复推送');

    // ab_webmcp list 仍是权威路径，不受推送影响（mock 默认两个工具）
    const list = await s.callJson('ab_webmcp', { action: 'list', tabId });
    assert.equal(list.tools.length, 2);
    assert.deepEqual(list.tools.map((t) => t.name), ['get_time', 'set_note']);
    // list 成功回填收件箱 → hint 刷新为 list 结果
    const info2 = await s.callJson('ab_tab_info', { tabId });
    assert.deepEqual(info2.webmcpHint, { toolNames: ['get_time', 'set_note'], count: 2 });
  } finally { await s.close(); }
});

test('ab_list_browsers / ab_open_tabs / ab_claim_tab 基本面', async () => {
  const s = await startMcpStack();
  try {
    const list = await s.callJson('ab_list_browsers');
    assert.equal(list.browsers.length, 1);
    assert.equal(list.browsers[0].id, 'mock-instance-1');
    assert.equal(list.browsers[0].type, 'extension');

    const open = await s.callJson('ab_open_tabs');
    assert.equal(open.tabs[0].tabId, 9001);
    assert.equal(open.tabs[0].url, 'https://existing.example/');

    const claim = await s.callJson('ab_claim_tab', { providerTabId: 9001, title: 'Existing tab', url: 'https://existing.example/' });
    assert.equal(typeof claim.tabId, 'number');
    const claimCall = s.mock.calls.find((c) => c.method === 'tab_claim');
    assert.deepEqual(claimCall.params, { providerTabId: 9001, title: 'Existing tab', url: 'https://existing.example/' });
  } finally { await s.close(); }
});

test('ab_new_tab → ab_navigate 拦截/放行 → ab_screenshot → ab_ax_state → ab_tab_info', async () => {
  const s = await startMcpStack();
  try {
    // 新建标签页
    const created = await s.callJson('ab_new_tab', { url: 'https://start.example/' });
    assert.equal(typeof created.tabId, 'number');
    const { tabId } = created;
    assert.ok(s.mock.calls.some((c) => c.method === 'tab_create' && c.params.url === 'https://start.example/'));

    // 策略拦截 chrome://settings（命令不应到达扩展）
    const blocked = await s.callJson('ab_navigate', { tabId, url: 'chrome://settings/passwords' });
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason, /blocked by policy/);
    assert.ok(!s.mock.calls.some((c) => c.method === 'navigate_tab_url' && c.params.url.startsWith('chrome://settings')));

    // 正常页放行
    const okNav = await s.callJson('ab_navigate', { tabId, url: 'https://normal.example/' });
    assert.equal(okNav.ok, true);
    assert.ok(s.mock.calls.some((c) => c.method === 'navigate_tab_url' && c.params.url === 'https://normal.example/'));

    // 截图：MCP image content，base64 以 iVBOR（PNG）开头
    const shot = await s.call('ab_screenshot', { tabId });
    const img = shot.content.find((c) => c.type === 'image');
    assert.ok(img, 'ab_screenshot 应返回 image content');
    assert.equal(img.mimeType, 'image/png');
    assert.ok(img.data.startsWith('iVBOR'), `PNG base64 应以 iVBOR 开头，实际: ${img.data.slice(0, 8)}`);
    assert.equal(img.data, REAL_PNG_B64);
    const summary = shot.content.find((c) => c.type === 'text');
    assert.match(summary.text, /screenshot/);

    // 无障碍树文本非空
    const ax = await s.callJson('ab_ax_state', { tabId });
    assert.equal(typeof ax.ax, 'string');
    assert.ok(ax.ax.length > 0);

    // 标签页信息
    const info = await s.callJson('ab_tab_info', { tabId });
    assert.equal(info.tabId, tabId);
    assert.equal(info.title, 'Mock Page');
    assert.equal(info.url, 'https://example.com/info');
  } finally { await s.close(); }
});

test('browser_eval：agent REPL 开标签→读标题→关标签，output 有内容且无 error', async () => {
  const s = await startMcpStack();
  try {
    const code = 'const b = await agent.browsers.getDefault(); const t = await b.tabs.new(); nodeRepl.write(await t.title()); await t.close();';
    const r = await s.callJson('browser_eval', { code });
    assert.equal(r.error, undefined);
    assert.ok(r.output.length > 0, 'output 不应为空');
    assert.match(r.output, /Mock Page/);
    // REPL 里开的标签确实走了线缆
    assert.ok(s.mock.calls.some((c) => c.method === 'tab_info'));
    assert.ok(s.mock.calls.some((c) => c.method === 'tab_close'));
  } finally { await s.close(); }
});

test('browser_eval：console 收集 / 未捕获异常返回 error+stack', async () => {
  const s = await startMcpStack();
  try {
    const r1 = await s.callJson('browser_eval', { code: 'console.log("hi", {a:1}); nodeRepl.write(1+1);' });
    assert.match(r1.output, /hi \{"a":1\}/);
    assert.match(r1.output, /2/);
    assert.equal(r1.result, null); // 无返回值 → null

    const r2 = await s.callJson('browser_eval', { code: 'return 41 + 1;' });
    assert.equal(r2.result, 42); // async 函数体 return → result

    const err = await s.call('browser_eval', { code: 'throw new Error("boom");' });
    assert.equal(err.isError, true);
    const parsed = JSON.parse(err.content.find((c) => c.type === 'text').text);
    assert.match(parsed.error, /boom/);
    assert.ok(parsed.stack);
  } finally { await s.close(); }
});

test('ab_cdp：白名单外直接 blocked（命令不到扩展）', async () => {
  const s = await startMcpStack();
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    const r = await s.callJson('ab_cdp', { tabId, method: 'Browser.setWindowBounds', params: {} });
    assert.equal(r.blocked, true);
    assert.match(r.reason, /allowlist/);
    assert.equal(r.code, 'CDP_DENIED');
    assert.ok(!s.mock.calls.some((c) => c.method === 'tab_cdp_call'));
  } finally { await s.close(); }
});

test('ab_cdp confirmCdp：需确认 → ab_confirm → 带 token 重试放行', async () => {
  const s = await startMcpStack();
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    // Fetch.enable 在白名单内且在 confirmCdp 名单内 → 首次需确认
    const need = await s.callJson('ab_cdp', { tabId, method: 'Fetch.enable' });
    assert.equal(need.needConfirmation, true);
    assert.ok(need.token);
    assert.match(need.description, /Fetch.enable/);
    assert.ok(!s.mock.calls.some((c) => c.method === 'tab_cdp_call' && c.params.method === 'Fetch.enable'));

    const conf = await s.callJson('ab_confirm', { token: need.token });
    assert.equal(conf.ok, true);

    const pass = await s.callJson('ab_cdp', { tabId, method: 'Fetch.enable', confirmationToken: need.token });
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.result, { mock: true, method: 'Fetch.enable' });
  } finally { await s.close(); }
});

test('ab_download_open：需确认 → ab_confirm → 带 token 重试放行（命令到达扩展）', async () => {
  const s = await startMcpStack();
  try {
    const need = await s.callJson('ab_download_open', { downloadId: 7 });
    assert.equal(need.needConfirmation, true);
    assert.ok(need.token);
    assert.match(need.description, /downloadId=7/);
    assert.ok(!s.mock.calls.some((c) => c.method === 'download_open'));

    const conf = await s.callJson('ab_confirm', { token: need.token });
    assert.equal(conf.ok, true);

    const done = await s.callJson('ab_download_open', { downloadId: 7, confirmationToken: need.token });
    assert.equal(done.ok, true);
    assert.ok(s.mock.calls.some((c) => c.method === 'download_open' && c.params.downloadId === 7));
  } finally { await s.close(); }
});

test('无浏览器连接时工具返回结构化错误（isError + error 文本）', async () => {
  // 不连伪扩展：MCP 栈照常起，但 browsers 为空
  const manager = new ConnectionManager({ port: 0 });
  await manager.start();
  const policy = loadPolicy(null);
  const api = createAgentApi(() => manager.liveConnections(), { policy });
  const server = buildMcpServer({ api, policy, connections: () => manager.liveConnections() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-test-empty', version: '0.0.1' });
  await client.connect(clientTransport);
  try {
    const res = await client.callTool({ name: 'ab_open_tabs', arguments: {} });
    assert.equal(res.isError, true);
    const parsed = JSON.parse(res.content.find((c) => c.type === 'text').text);
    assert.match(parsed.error, /no browser connected/);
  } finally {
    await client.close();
    await server.close();
    await manager.stop();
  }
});


// ---- 多浏览器路由（Chrome + Arc 同在线）----
test('多浏览器：两台在线；browserId 指定 Arc 不串台；缺省走默认（第一台）；未知 id 报清晰错误', async () => {
  const s = await startMcpStack();
  try {
    // 第二台浏览器（模拟 Arc）
    const arcMock = await startMockExtension({ port: s.manager.port, instanceId: 'mock-arc-1' });
    await once(s.manager, 'browser');

    const list = s.api.browsers.list();
    assert.equal(list.length, 2, `应有两台在线: ${JSON.stringify(list)}`);
    const arcId = list.find((b) => b.id === 'mock-arc-1')?.id;
    assert.ok(arcId, 'Arc 实例应在线');

    // 指定 Arc：tab_create 应发到 arcMock
    await s.callJson('ab_new_tab', { url: 'https://arc.example/', browserId: arcId });
    assert.ok(arcMock.calls.some((c) => c.method === 'tab_create' && c.params.url === 'https://arc.example/'),
      'tab_create 应到达 Arc 连接');
    assert.ok(!s.mock.calls.some((c) => c.method === 'tab_create' && c.params.url === 'https://arc.example/'),
      '不应串到第一台');

    // 缺省：走默认浏览器（第一台）
    await s.callJson('ab_new_tab', { url: 'https://default.example/' });
    assert.ok(s.mock.calls.some((c) => c.method === 'tab_create' && c.params.url === 'https://default.example/'),
      '缺省应到第一台');

    // 未知 browserId：清晰报错
    const r3 = await s.call('ab_new_tab', { browserId: 'no-such' });
    assert.ok(JSON.stringify(r3).includes('browser not found'), JSON.stringify(r3).slice(0, 200));

    arcMock.close();
  } finally {
    await s.close();
  }
});

test('ab_status：有浏览器时返回在线列表与提示', async () => {
  const s = await startMcpStack();
  try {
    const r = await s.callJson('ab_status', {});
    assert.equal(r.mode, 'unknown'); // 测试直连 buildMcpServer 未传 serviceInfo
    assert.ok(Array.isArray(r.browsers) && r.browsers.length === 1);
    assert.ok(r.hint.includes('正常'));
  } finally { await s.close(); }
});

test('无浏览器时 ab_new_tab 报带排查指引的错误', async () => {
  const manager = new (await import('../service/connection.mjs')).ConnectionManager({ port: 0 });
  await manager.start();
  const policy = loadPolicy(null);
  const api = createAgentApi(() => manager.liveConnections(), { policy });
  const server = buildMcpServer({ api, policy, connections: () => manager.liveConnections() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  const res = await client.callTool({ name: 'ab_new_tab', arguments: {} });
  assert.ok(res.isError);
  assert.ok(JSON.stringify(res).includes('no browser connected'));
  assert.ok(JSON.stringify(res).includes('doctor'), '错误里应指向 doctor 排查');
  await client.close(); await server.close(); await manager.stop();
});

test('ab_visibility：get/set 走到浏览器连接', async () => {
  const s = await startMcpStack({ handlers: { browser_visibility_get: () => ({ visible: false }), browser_visibility_set: () => ({}) } });
  try {
    const r1 = await s.callJson('ab_visibility', { action: 'get' });
    assert.equal(r1.visible, false);
    const r2 = await s.callJson('ab_visibility', { action: 'set', visible: true });
    assert.equal(r2.ok, true);
    assert.ok(s.mock.calls.some((c) => c.method === 'browser_visibility_set' && c.params.visible === true), '命令应到达扩展');
  } finally { await s.close(); }
});

test('ab_viewport：get/set/reset 直连浏览器连接（同 ab_visibility 模式）', async () => {
  let vp = null; // 闭包状态：set 写入 / get 读出 / reset 清空（真实现位于扩展）
  const s = await startMcpStack({
    handlers: {
      browser_viewport_get: () => ({ viewport: vp }),
      browser_viewport_set: (p) => { vp = { width: p.width, height: p.height }; return {}; },
      browser_viewport_reset: () => { vp = null; return {}; },
    },
  });
  try {
    const g0 = await s.callJson('ab_viewport', { action: 'get' });
    assert.deepEqual(g0.viewport, null, '初始无覆盖');
    const set = await s.callJson('ab_viewport', { action: 'set', width: 800, height: 600 });
    assert.equal(set.ok, true);
    assert.deepEqual(set.viewport, { width: 800, height: 600 });
    assert.ok(s.mock.calls.some((c) => c.method === 'browser_viewport_set' && c.params.width === 800 && c.params.height === 600),
      '命令应到达扩展');
    const g1 = await s.callJson('ab_viewport', { action: 'get' });
    assert.deepEqual(g1.viewport, { width: 800, height: 600 }, 'set 后 get 一致');
    const rs = await s.callJson('ab_viewport', { action: 'reset' });
    assert.equal(rs.ok, true);
    const g2 = await s.callJson('ab_viewport', { action: 'get' });
    assert.deepEqual(g2.viewport, null, 'reset 后恢复无覆盖');
  } finally { await s.close(); }
});

test('ab_screenshot selector：元素级截图走 element_screenshot，selector 原样到达扩展', async () => {
  const s = await startMcpStack({
    handlers: {
      tab_screenshot: () => ({ dataBase64: REAL_PNG_B64 }),
      element_screenshot: () => ({ dataBase64: ELEMENT_PNG_B64 }),
    },
  });
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    const shot = await s.call('ab_screenshot', { tabId, selector: { kind: 'css', value: '#out' } });
    const img = shot.content.find((c) => c.type === 'image');
    assert.equal(img.mimeType, 'image/png');
    assert.equal(img.data, ELEMENT_PNG_B64);
    const call = s.mock.calls.find((c) => c.method === 'element_screenshot');
    assert.ok(call, 'element_screenshot 命令应到达扩展');
    assert.equal(call.params.tabId, tabId);
    assert.deepEqual(call.params.selector, { kind: 'css', value: '#out' });
    assert.ok(!s.mock.calls.some((c) => c.method === 'tab_screenshot'), '元素级不应再走整页截图');
    // 不给 selector 仍走整页 tab_screenshot
    const full = await s.call('ab_screenshot', { tabId });
    assert.equal(full.content.find((c) => c.type === 'image').data, REAL_PNG_B64);
  } finally { await s.close(); }
});

test('ab_read_urls：三个 URL 走完 开→读→关 全流程；被 policy 拦的 URL 返回 blocked 且一个命令都不发', async () => {
  const tabUrl = new Map(); // tabId -> url（navigate 时记录；eval 应答据此生成正文）
  const s = await startMcpStack({
    handlers: {
      navigate_tab_url: (p) => { tabUrl.set(p.tabId, p.url); return {}; },
      tab_eval: (p) => ({ value: { title: `Title of ${tabUrl.get(p.tabId)}`, text: `body-text of ${tabUrl.get(p.tabId)}` } }),
    },
  });
  try {
    const r = await s.callJson('ab_read_urls', {
      urls: ['https://a.example/', 'chrome://settings/passwords', 'https://b.example/', 'https://c.example/'],
    });
    assert.equal(r.pages.length, 4, '结果与入参同序同长');
    const [a, blocked, b, c] = r.pages;
    assert.equal(a.url, 'https://a.example/');
    assert.equal(a.title, 'Title of https://a.example/');
    assert.match(a.text, /body-text of https:\/\/a\.example\//);
    assert.equal(blocked.url, 'chrome://settings/passwords');
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason, /blocked by policy/);
    assert.equal(b.title, 'Title of https://b.example/');
    assert.equal(c.title, 'Title of https://c.example/');
    // 开→读→关 各恰好 3 次（被拦 URL 不产生任何命令）
    for (const m of ['tab_create', 'navigate_tab_url', 'tab_eval', 'tab_close']) {
      assert.equal(s.mock.calls.filter((x) => x.method === m).length, 3, `${m} 应恰好 3 次`);
    }
    assert.ok(!s.mock.calls.some((x) => x.method === 'navigate_tab_url' && (x.params.url || '').startsWith('chrome://')),
      '被拦 URL 不应出门');
    // 后台标签：tab_create 必带 background:true（不干扰用户当前屏幕）
    assert.ok(s.mock.calls.filter((x) => x.method === 'tab_create').every((x) => x.params.background === true));
  } finally { await s.close(); }
});

test('ab_read_urls：maxChars 截断正文并标记 truncated；不给则默认 20000 不截断', async () => {
  const s = await startMcpStack({
    handlers: { tab_eval: () => ({ value: { title: 'T', text: 'x'.repeat(500) } }) },
  });
  try {
    const r = await s.callJson('ab_read_urls', { urls: ['https://long.example/'], maxChars: 50 });
    assert.equal(r.pages[0].text.length, 50);
    assert.equal(r.pages[0].truncated, true);
    const r2 = await s.callJson('ab_read_urls', { urls: ['https://long.example/'] });
    assert.equal(r2.pages[0].text.length, 500);
    assert.equal(r2.pages[0].truncated, undefined);
  } finally { await s.close(); }
});

test('ab_audit：查询到本会话的副作用命令留痕（倒序、cmd 过滤、tabId 过滤）', async () => {
  const s = await startMcpStack();
  try {
    const { tabId } = await s.callJson('ab_new_tab', { url: 'https://audit-mcp.example/' });
    await s.callJson('ab_navigate', { tabId, url: 'https://audit-mcp.example/page2' });
    await s.callJson('ab_tab_info', { tabId }); // 读命令：不留痕

    const r = await s.callJson('ab_audit', { limit: 10 });
    assert.ok(r.total >= 2);
    const cmds = r.entries.map((e) => e.cmd);
    assert.ok(cmds.includes('tab_create'));
    assert.ok(cmds.includes('navigate_tab_url'));
    assert.equal(r.entries[0].cmd, 'navigate_tab_url', '最新在前');
    assert.ok(r.entries.every((e) => e.ts && typeof e.cmd === 'string'));

    const only = await s.callJson('ab_audit', { cmd: 'tab_create' });
    assert.equal(only.total, 1);
    assert.equal(only.entries[0].paramsLite.url, 'https://audit-mcp.example/');

    const byTab = await s.callJson('ab_audit', { tabId });
    assert.ok(byTab.total >= 1);
    assert.ok(byTab.entries.every((e) => e.tabId === tabId));
  } finally { await s.close(); }
});

test('ab_audit：批准动作后 policy_approve 也入流水', async () => {
  const s = await startMcpStack();
  try {
    const need = await s.callJson('ab_download_open', { downloadId: 9 });
    assert.equal(need.needConfirmation, true);
    const conf = await s.callJson('ab_confirm', { token: need.token });
    assert.equal(conf.ok, true);
    const r = await s.callJson('ab_audit', { cmd: 'policy_approve' });
    assert.equal(r.total, 1);
    assert.match(r.entries[0].paramsLite.description, /downloadId=9/);
  } finally { await s.close(); }
});
