// test/service.test.mjs — service 层测试（真实 WS + 伪扩展，不需要真浏览器）
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ConnectionManager } from '../service/connection.mjs';
import { createAgentApi } from '../service/api.mjs';
import { loadPolicy, Policy, wildcardMatch } from '../service/policy.mjs';
import { startMockExtension } from '../service/mock-extension.mjs';
import { ERR, EV } from '../shared/protocol.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起 service 栈：随机端口 + 默认策略 + Agent API。 */
async function startStack(managerOpts = {}, policyFile = null) {
  const manager = new ConnectionManager({ port: 0, ...managerOpts });
  await manager.start();
  const policy = loadPolicy(policyFile);
  const api = createAgentApi(() => manager.liveConnections(), { policy });
  return { manager, policy, api };
}

/** 连上伪扩展并等注册完成（'browser' 事件先订阅，防竞态）。 */
async function connectMock(manager, opts = {}) {
  const got = once(manager, 'browser');
  const mock = await startMockExtension({ port: manager.port, ...opts });
  await got;
  return mock;
}

test('browsers.list/getDefault 看到伪浏览器', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager);
  try {
    const list = api.browsers.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'mock-instance-1');
    assert.equal(list[0].family, 'chrome');
    assert.equal(list[0].type, 'extension');
    const b = api.browsers.getDefault();
    assert.equal(b.browserId, 'mock-instance-1');
    assert.equal(b.family, 'chrome');
    assert.equal(api.browsers.get('mock-instance-1').browserId, 'mock-instance-1');
    assert.throws(() => api.browsers.get('nope'));
    assert.deepEqual(b.capabilities.list(), ['capabilities/tab/cdp']);
  } finally { mock.close(); await manager.stop(); }
});

test('tabs.new 参数正确透传 + 句柄缓存 url', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager);
  try {
    const b = api.browsers.getDefault();
    const tab = await b.tabs.new({ url: 'https://example.com/start', background: true });
    assert.equal(typeof tab.id, 'number');
    const call = mock.calls.find((c) => c.method === 'tab_create');
    assert.deepEqual(call.params, { url: 'https://example.com/start', background: true });
    assert.equal(await tab.url(), 'https://example.com/start'); // 来自返回值缓存
    // session_setup 应在首个 tab 命令前发出
    assert.ok(mock.calls.some((c) => c.method === 'session_setup' && c.params.sessionId));
  } finally { mock.close(); await manager.stop(); }
});

test('locator 链式 nth/first/and 序列化正确', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager);
  try {
    const tab = await api.browsers.getDefault().tabs.new({});
    const pw = tab.playwright;

    await pw.getByRole('button', { name: 'Submit' }).nth(2).click();
    let call = mock.calls.filter((c) => c.method === 'locator_action').at(-1);
    assert.equal(call.params.tabId, tab.id);
    assert.equal(call.params.action, 'click');
    assert.deepEqual(call.params.selector, { kind: 'role', value: 'button', name: 'Submit', nth: 2 });

    await pw.css('div.a > b').first().fill('hello');
    call = mock.calls.filter((c) => c.method === 'locator_action').at(-1);
    assert.equal(call.params.action, 'fill');
    assert.equal(call.params.value, 'hello');
    assert.deepEqual(call.params.selector, { kind: 'css', value: 'div.a > b', first: true });

    await pw.getByText('Hi', { exact: true }).and(pw.getByTestId('x-1')).count();
    call = mock.calls.filter((c) => c.method === 'locator_count').at(-1);
    assert.deepEqual(call.params.selector, {
      kind: 'and',
      value: [{ kind: 'text', value: 'Hi', exact: true }, { kind: 'testid', value: 'x-1' }],
    });

    assert.equal(await pw.getByPlaceholder('Search').count(), 1);
    assert.equal(await pw.getByLabel('Name').textContent(), null); // mock 默认 value:null
    assert.throws(() => pw.css('li').nth(-1), /non-negative/); // 同步参数校验
  } finally { mock.close(); await manager.stop(); }
});

test('lease 冲突错误码透传（ERR.LEASE_CONFLICT）', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager, {
    handlers: { tab_claim: () => ({ __error: { code: ERR.LEASE_CONFLICT, message: 'Tab 55 is already part of browser session other' } }) },
  });
  try {
    const b = api.browsers.getDefault();
    await assert.rejects(
      b.user.claimTab({ tabId: 55, title: 't', url: 'https://x.example/' }),
      (err) => err.code === ERR.LEASE_CONFLICT && /another browser session/.test(err.message),
    );
  } finally { mock.close(); await manager.stop(); }
});

test('CDP 非白名单方法被服务端预检拒绝（不到扩展）', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager);
  try {
    const tab = await api.browsers.getDefault().tabs.new({});
    const cdp = tab.capabilities.get('cdp');
    await assert.rejects(cdp.send('Page.crash'), (err) => err.code === ERR.CDP_DENIED);
    await assert.rejects(cdp.send('Browser.setWindowBounds'), (err) => err.code === ERR.CDP_DENIED);
    assert.ok(!mock.calls.some((c) => c.method === 'tab_cdp_call')); // 服务端先拒，未到扩展
    // 白名单方法正常透传
    const r = await cdp.send('Runtime.evaluate', { expression: '1+1' });
    assert.deepEqual(r, { mock: true, method: 'Runtime.evaluate' });
    assert.deepEqual(await cdp.readEvents({ afterSequence: 0, limit: 10 }), { events: [], cursor: 0 });
  } finally { mock.close(); await manager.stop(); }
});

test('CDP confirmCdp：需确认 → approve → 带 token 放行', async () => {
  const { manager, api, policy } = await startStack();
  const mock = await connectMock(manager);
  try {
    const tab = await api.browsers.getDefault().tabs.new({});
    const cdp = tab.capabilities.get('cdp');
    // Fetch.enable 在白名单内且在 confirmCdp 内 → 需确认
    let token;
    await assert.rejects(cdp.send('Fetch.enable', {}), (err) => {
      assert.equal(err.needsConfirmation, true);
      token = err.token;
      return true;
    });
    assert.ok(!mock.calls.some((c) => c.method === 'tab_cdp_call' && c.params.method === 'Fetch.enable'));
    assert.equal(policy.approve(token).ok, true);
    const r = await cdp.send('Fetch.enable', {}, { confirmationToken: token });
    assert.deepEqual(r, { mock: true, method: 'Fetch.enable' });
  } finally { mock.close(); await manager.stop(); }
});

test('policy：navigate 拦截 / download_open 确认 / approve 放行', async () => {
  const { manager, api, policy } = await startStack();
  const mock = await connectMock(manager);
  try {
    const tab = await api.browsers.getDefault().tabs.new({});

    await assert.rejects(tab.goto('chrome://settings/passwords'), (err) => err.code === 'POLICY_BLOCKED');
    await assert.rejects(tab.goto('chrome://settings'), (err) => err.code === 'POLICY_BLOCKED'); // 裸前缀也拦
    await assert.rejects(tab.goto('about:blank'), (err) => err.code === 'POLICY_BLOCKED');
    assert.ok(!mock.calls.some((c) => c.method === 'navigate_tab_url'));
    await tab.goto('https://ok.example/'); // 正常导航放行
    assert.ok(mock.calls.some((c) => c.method === 'navigate_tab_url' && c.params.url === 'https://ok.example/'));

    const v1 = policy.check({ kind: 'download_open', downloadId: 7 });
    assert.equal(v1.needConfirmation, true);
    assert.match(v1.description, /downloadId=7/);
    assert.ok(v1.token);
    assert.equal(policy.approve(v1.token).ok, true);
    const v2 = policy.check({ kind: 'download_open', downloadId: 7 }, { confirmationToken: v1.token });
    assert.deepEqual(v2, { allowed: true });
    // 未批准的 token 不放行（仍是 needConfirmation）
    const v3 = policy.check({ kind: 'download_open', downloadId: 8 });
    assert.equal(v3.needConfirmation, true);
    assert.equal(policy.check({ kind: 'download_open', downloadId: 8 }, { confirmationToken: v3.token }).needConfirmation, true);
    // 未知 token / 未知 kind fail-closed
    assert.equal(policy.check({ kind: 'download_open' }, { confirmationToken: 'deadbeef' }).needConfirmation, true);
    assert.equal(policy.check({ kind: 'weird' }).allowed, false);

    // 通配匹配单元
    assert.equal(wildcardMatch('chrome://extensions/*', 'chrome://extensions/abc'), true);
    assert.equal(wildcardMatch('about:*', 'about:blank'), true);
    assert.equal(wildcardMatch('about:*', 'https://about.com/'), false);
  } finally { mock.close(); await manager.stop(); }
});

test('policy：maxTabsPerSession 超限抛 LIMIT', async () => {
  const manager = new ConnectionManager({ port: 0 });
  await manager.start();
  const policy = new Policy({ maxTabsPerSession: 1 });
  const api = createAgentApi(() => manager.liveConnections(), { policy });
  const mock = await connectMock(manager);
  try {
    const b = api.browsers.getDefault();
    await b.tabs.new({ url: 'https://a.example/' });
    await assert.rejects(b.tabs.new({ url: 'https://b.example/' }), (err) => err.code === 'LIMIT');
  } finally { mock.close(); await manager.stop(); }
});

test('page 事件更新 tab 缓存；tab 关闭/移除后所有方法抛错', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager);
  try {
    const tab = await api.browsers.getDefault().tabs.new({});
    mock.emitEvent(EV.PAGE_EVENT, { tabId: tab.id, event: 'updated', url: 'https://example.com/next', title: 'Next' });
    await sleep(80);
    assert.equal(await tab.url(), 'https://example.com/next');
    assert.equal(await tab.title(), 'Next');
    assert.equal(await tab.eval('document.title'), 42); // mock 默认值，参数透传
    assert.deepEqual(mock.calls.find((c) => c.method === 'tab_eval').params, {
      tabId: tab.id, expression: 'document.title', returnByValue: true,
    });

    const t2 = await api.browsers.getDefault().tabs.new({}); // 另一个 tab：主动 close
    await t2.close();
    await assert.rejects(t2.url(), (err) => err.code === ERR.TAB_NOT_FOUND);
    await assert.rejects(t2.goto('https://x.example/'), (err) => err.code === ERR.TAB_NOT_FOUND);

    mock.emitEvent(EV.PAGE_EVENT, { tabId: tab.id, event: 'removed' }); // 事件判死
    await sleep(80);
    await assert.rejects(tab.reload(), (err) => err.code === ERR.TAB_NOT_FOUND);
  } finally { mock.close(); await manager.stop(); }
});

test('webmcp capability：list 透传 / 只读直通 / 非只读过确认门（approve 后放行）', async () => {
  const { manager, api, policy } = await startStack();
  const mock = await connectMock(manager);
  try {
    const tab = await api.browsers.getDefault().tabs.new({});
    assert.deepEqual(tab.capabilities.list(), ['cdp', 'webmcp', 'screencast']);
    assert.equal(tab.capabilities.get('nope'), null);
    const webmcp = tab.capabilities.get('webmcp');

    const tools = await webmcp.list();
    assert.equal(tools.length, 2);
    assert.deepEqual(mock.calls.find((c) => c.method === 'webmcp_list_tools').params, { tabId: tab.id });
    assert.deepEqual(tools.map((t) => [t.name, t.readOnly]), [['get_time', true], ['set_note', false]]);

    // 只读工具：直通，命令直达扩展
    const r1 = await webmcp.invoke('get_time', {});
    assert.deepEqual(r1, { invoked: 'get_time', args: {} });

    // 非只读工具：首次被拦（needsConfirmation，命令不出门）
    let token = null;
    await assert.rejects(webmcp.invoke('set_note', { text: 'hi' }), (err) => {
      assert.equal(err.needsConfirmation, true);
      assert.match(err.description, /set_note/);
      token = err.token;
      return true;
    });
    assert.ok(!mock.calls.some((c) => c.method === 'webmcp_invoke_tool' && c.params.name === 'set_note'));

    // approve → 带 token 重试放行
    assert.equal(policy.approve(token).ok, true);
    const r2 = await webmcp.invoke('set_note', { text: 'hi' }, { confirmationToken: token });
    assert.deepEqual(r2, { invoked: 'set_note', args: { text: 'hi' } });
    assert.deepEqual(mock.calls.filter((c) => c.method === 'webmcp_invoke_tool').at(-1).params, {
      tabId: tab.id, name: 'set_note', args: { text: 'hi' },
    });
  } finally { mock.close(); await manager.stop(); }
});

test('webmcp：不支持的浏览器（-32011）错误码透传到 api 层', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager, {
    handlers: {
      webmcp_list_tools: () => ({ __error: { code: ERR.WEBMCP_UNSUPPORTED, message: '此浏览器不支持 WebMCP（需要更新版 Chrome / 实验开关）' } }),
    },
  });
  try {
    const tab = await api.browsers.getDefault().tabs.new({});
    await assert.rejects(
      tab.capabilities.get('webmcp').list(),
      (err) => err.code === ERR.WEBMCP_UNSUPPORTED && /WebMCP/.test(err.message),
    );
  } finally { mock.close(); await manager.stop(); }
});

test('onWebmcpTools 推送：收件箱快照 → getTabContext 附 webmcpHint；清单清空后 hint 消失', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager);
  try {
    const b = api.browsers.getDefault();
    const tab = await b.tabs.new({});
    // 无通知时：不附 hint（不能凭空提示）
    let ctx = await b.user.getTabContext({ tabId: tab.id });
    assert.equal(ctx.webmcpHint, undefined);

    // tab 创建后伪扩展上报一条工具变化通知（完整清单快照）
    mock.emitEvent(EV.WEBMCP_TOOLS, { tabId: tab.id, kind: 'added', toolNames: ['ab_echo', 'get_time'] });
    await sleep(80); // WS 通知异步落地
    ctx = await b.user.getTabContext({ tabId: tab.id });
    assert.deepEqual(ctx.webmcpHint, { toolNames: ['ab_echo', 'get_time'], count: 2 });

    // api.webmcpHint 同源可查；未知 tab 返回 null
    assert.deepEqual(api.webmcpHint(b.browserId, tab.id), { toolNames: ['ab_echo', 'get_time'], count: 2 });
    assert.equal(api.webmcpHint(b.browserId, 999999), null);

    // 清单清空（换页）→ hint 不再附带
    mock.emitEvent(EV.WEBMCP_TOOLS, { tabId: tab.id, kind: 'changed', toolNames: [] });
    await sleep(80);
    ctx = await b.user.getTabContext({ tabId: tab.id });
    assert.equal(ctx.webmcpHint, undefined);
  } finally { mock.close(); await manager.stop(); }
});

test('webmcp.list() 成功后回填收件箱（通知丢失也能出 hint）', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager);
  try {
    const b = api.browsers.getDefault();
    const tab = await b.tabs.new({});
    await tab.capabilities.get('webmcp').list(); // mock 默认两个工具
    const ctx = await b.user.getTabContext({ tabId: tab.id });
    assert.deepEqual(ctx.webmcpHint, { toolNames: ['get_time', 'set_note'], count: 2 });
  } finally { mock.close(); await manager.stop(); }
});

test('断连保留镜像租约，同 instanceId 重连恢复', async () => {
  const { manager, api } = await startStack();
  const mock = await connectMock(manager);
  mock.emitEvent(EV.LEASE_CHANGE, { tabId: 5, lease: { tabId: 5, sessionId: 's1', state: 'active' } });
  await sleep(80);
  mock.close();
  await once(manager, 'browserClosed');
  assert.equal(api.browsers.list().length, 0);

  const mock2 = await connectMock(manager); // 同 instanceId 重连
  try {
    const conn = manager.get('mock-instance-1');
    assert.equal(conn.restored, true);
    assert.deepEqual(conn.leases.get(5), { tabId: 5, sessionId: 's1', state: 'active' }); // 镜像恢复
  } finally { mock2.close(); await manager.stop(); }
});

test('心跳超时判死（短心跳注入）', async () => {
  const manager = new ConnectionManager({
    port: 0,
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 60,
    heartbeatMaxFailures: 2,
  });
  await manager.start();
  // 心跳不响应 → 连续失败 → 判死
  const mock = await connectMock(manager, { handlers: { browser_status: () => new Promise(() => {}) } });
  try {
    await Promise.race([
      once(manager, 'browserClosed'),
      sleep(5000).then(() => { throw new Error('心跳判死超时（5s 内未触发 browserClosed）'); }),
    ]);
    assert.equal(manager.liveConnections().length, 0);
  } finally { mock.close(); await manager.stop(); }
});

test('心跳正常响应时不误杀', async () => {
  const manager = new ConnectionManager({
    port: 0,
    heartbeatIntervalMs: 40,
    heartbeatTimeoutMs: 500,
    heartbeatMaxFailures: 2,
  });
  await manager.start();
  const mock = await connectMock(manager); // 默认响应 browser_status
  try {
    await sleep(250);
    assert.equal(manager.liveConnections().length, 1);
    const browserStatusCalls = mock.calls.filter((c) => c.method === 'browser_status').length;
    assert.ok(browserStatusCalls >= 3, `应发出多次心跳，实际 ${browserStatusCalls}`);
  } finally { mock.close(); await manager.stop(); }
});
