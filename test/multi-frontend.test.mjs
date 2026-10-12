// test/multi-frontend.test.mjs — 多实例（frontend 模式）测试
//
// 复用 mock-extension 起伪浏览器 + 真实 ConnectionManager/RemoteFrontend：
//   场景0：RemoteFrontend 全链路（hello 快照 → api.mjs 可用 → 浏览器断开 → browserClosed）
//   场景1：两个 frontend 并发 mcp/cmd，结果按各自 id 配对不串线
//   场景2：mcp/cmd 错误透传（伪扩展抛 -32003 → frontend 收到 code -32003）
//   场景3：无浏览器连接时 mcp/cmd → -32002
//   场景4：frontend 计数与 frontendCountChange 事件
//   场景5：进程级——两个 mcp-entry 实例共存、stdin EOF 宽限排水、无孤儿进程

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { ConnectionManager } from '../service/connection.mjs';
import { RemoteFrontend } from '../service/remote-frontend.mjs';
import { createAgentApi } from '../service/api.mjs';
import { loadPolicy } from '../service/policy.mjs';
import { startMockExtension } from '../service/mock-extension.mjs';
import { FRONTEND_HELLO, FRONTEND_CMD, PROTOCOL_VERSION } from '../shared/protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.join(HERE, '..', 'service', 'mcp-entry.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** frontend ws 客户端：连上即发 mcp/hello（必须是第一条请求），暴露 request()。 */
async function connectFrontend(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const client = {
    ws,
    hello: null,
    nextId: 1,
    pending: new Map(),
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = client.nextId++;
        const timer = setTimeout(() => { client.pending.delete(id); reject(new Error(`frontend request timeout: ${method}`)); }, 5_000);
        client.pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    },
    close() { try { ws.terminate(); } catch { /* 已关 */ } },
  };
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    const slot = client.pending.get(msg.id);
    if (!slot) return;
    client.pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) {
      const e = new Error(msg.error.message ?? 'rpc error');
      e.code = msg.error.code;
      slot.reject(e);
    } else slot.resolve(msg.result);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  client.hello = await client.request(FRONTEND_HELLO, { protocol: PROTOCOL_VERSION });
  return client;
}

/** 起一个最小 service 栈（只有 manager，无策略/无 api——本文件大部分场景够用）。 */
async function startManager(opts = {}) {
  const manager = new ConnectionManager({ port: 0, ...opts });
  await manager.start();
  return manager;
}

// ===========================================================================
// 场景0：RemoteFrontend 全链路（对齐 api.mjs 所需接口）
// ===========================================================================

test('场景0：RemoteFrontend 握手快照 / api.mjs 全链路 / 浏览器断开 → browserClosed', async () => {
  const manager = await startManager();
  const mock = await startMockExtension({ port: manager.port, instanceId: 'shared-1', family: 'chrome', profileName: 'Work' });
  const rf = new RemoteFrontend({ port: manager.port });
  try {
    const gotBrowser = once(rf, 'browser');
    await rf.start();
    await gotBrowser;

    // hello 快照：身份来自 service 侧浏览器的 ext/hello
    const conns = rf.liveConnections();
    assert.equal(conns.length, 1);
    assert.equal(conns[0].instanceId, 'shared-1');
    assert.equal(conns[0].family, 'chrome');
    assert.equal(conns[0].profileName, 'Work');
    assert.deepEqual(conns[0].capabilities, ['capabilities/tab/cdp']);

    // 直接对齐 api.mjs：包装层 + 命令走 mcp/cmd
    const policy = loadPolicy(null);
    const api = createAgentApi(() => rf.liveConnections(), { policy });
    const list = api.browsers.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'shared-1');
    const ctx = await api.browsers.getDefault().user.getTabContext({ tabId: 7 });
    assert.equal(ctx.url, 'https://example.com/info');
    assert.equal(ctx.title, 'Mock Page');
    const call = mock.calls.find((c) => c.method === 'tab_info');
    assert.deepEqual(call.params, { tabId: 7 });

    // 浏览器断开 → service 主动关 frontend → browserClosed → liveConnections 清空
    mock.close();
    await once(rf, 'browserClosed');
    assert.equal(rf.liveConnections().length, 0);
    await assert.rejects(
      async () => api.browsers.getDefault().user.getTabContext({ tabId: 7 }),
      /no browser connected/,
    );
  } finally {
    rf.stop();
    mock.close();
    await manager.stop();
  }
});

// ===========================================================================
// 场景1：两个 frontend 并发 mcp/cmd，结果按各自 id 配对不串线
// ===========================================================================

test('场景1：两个 frontend 并发 mcp/cmd，应答按 id 配对不串线', async () => {
  const manager = await startManager();
  const mock = await startMockExtension({
    port: manager.port,
    handlers: {
      // 故意乱序：tabId=1 的应答延迟 120ms，tabId=2 立即回 → 两条命令同时在途
      tab_info: async (params) => {
        if (params.tabId === 1) await sleep(120);
        return { tabId: params.tabId, url: `https://x/${params.tabId}`, title: `T${params.tabId}` };
      },
    },
  });
  let f1 = null;
  let f2 = null;
  try {
    f1 = await connectFrontend(manager.port);
    f2 = await connectFrontend(manager.port);
    // hello 应答形状
    assert.equal(f1.hello.ok, true);
    assert.equal(f1.hello.protocol, 1);
    assert.equal(f2.hello.ok, true);

    // frontend 不算浏览器连接
    assert.equal(manager.liveConnections().length, 1);

    const [r1, r2] = await Promise.all([
      f1.request(FRONTEND_CMD, { command: 'tab_info', params: { tabId: 1 } }),
      f2.request(FRONTEND_CMD, { command: 'tab_info', params: { tabId: 2 } }),
    ]);
    assert.deepEqual(r1, { tabId: 1, url: 'https://x/1', title: 'T1' });
    assert.deepEqual(r2, { tabId: 2, url: 'https://x/2', title: 'T2' });

    // 伪扩展确实收到两条命令，参数各自正确
    const infos = mock.calls.filter((c) => c.method === 'tab_info');
    assert.equal(infos.length, 2);
    assert.deepEqual(infos.map((c) => c.params.tabId).sort(), [1, 2]);
  } finally {
    if (f1) f1.close();
    if (f2) f2.close();
    mock.close();
    await manager.stop();
  }
});

// ===========================================================================
// 场景2：mcp/cmd 错误透传
// ===========================================================================

test('场景2：伪扩展抛 -32003 → frontend 收到 code -32003（错误原样透传）', async () => {
  const manager = await startManager();
  const mock = await startMockExtension({
    port: manager.port,
    handlers: { tab_claim: () => ({ __error: { code: -32003, message: 'lease conflict (test)' } }) },
  });
  let f1 = null;
  try {
    f1 = await connectFrontend(manager.port);
    await assert.rejects(
      f1.request(FRONTEND_CMD, { command: 'tab_claim', params: { providerTabId: 9 } }),
      (err) => err.code === -32003 && /lease conflict/.test(err.message),
    );
  } finally {
    if (f1) f1.close();
    mock.close();
    await manager.stop();
  }
});

// ===========================================================================
// 场景3：无浏览器连接时 mcp/cmd → -32002
// ===========================================================================

test('场景3：无浏览器连接时 mcp/cmd → code -32002（no browser connected）', async () => {
  const manager = await startManager();
  let f1 = null;
  try {
    f1 = await connectFrontend(manager.port); // hello 照常成功（浏览器可后连）
    assert.equal(f1.hello.ok, true);
    assert.deepEqual(f1.hello.browsers, []);
    await assert.rejects(
      f1.request(FRONTEND_CMD, { command: 'tab_info', params: { tabId: 1 } }),
      (err) => err.code === -32002 && /no browser connected/.test(err.message),
    );
    // 连接保持（错误不致命）：接上浏览器后同一连接可用
    const mock = await startMockExtension({ port: manager.port });
    try {
      const r = await f1.request(FRONTEND_CMD, { command: 'tab_info', params: { tabId: 1 } });
      assert.equal(r.title, 'Mock Page');
    } finally { mock.close(); }
  } finally {
    if (f1) f1.close();
    await manager.stop();
  }
});

// ===========================================================================
// 场景4：frontend 计数与 frontendCountChange
// ===========================================================================

test('场景4：frontendSockets 计数：2 连接 → 断 1 个 → 1，frontendCountChange 逐次触发', async () => {
  const manager = await startManager();
  const counts = [];
  manager.on('frontendCountChange', (n) => counts.push(n));
  let f1 = null;
  let f2 = null;
  try {
    f1 = await connectFrontend(manager.port);
    f2 = await connectFrontend(manager.port);
    assert.equal(manager.frontendSockets.size, 2);
    assert.deepEqual(counts, [1, 2]);

    f1.close();
    await once(manager, 'frontendCountChange');
    assert.equal(manager.frontendSockets.size, 1);
    assert.deepEqual(counts, [1, 2, 1]);
  } finally {
    if (f1) f1.close();
    if (f2) f2.close();
    await manager.stop();
  }
});

// ===========================================================================
// 场景5：进程级——两个 mcp-entry 实例共存 / stdin EOF 宽限排水 / 无孤儿
// ===========================================================================

/** 拿一个当前空闲的 TCP 端口（起即关，存在极小竞态窗口，失败时错误信息可读）。 */
async function freePort() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const port = await new Promise((resolve, reject) => {
    wss.once('listening', () => resolve(wss.address().port));
    wss.once('error', reject);
  });
  await new Promise((resolve) => wss.close(resolve));
  return port;
}

function waitUntil(predicate, { timeoutMs = 15_000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      let ok;
      try { ok = predicate(); } catch (err) { reject(err); return; }
      if (ok) { resolve(); return; }
      if (Date.now() - startedAt > timeoutMs) { reject(new Error('waitUntil timed out')); return; }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** 极简 MCP-over-stdio 客户端（换行分隔 JSON-RPC）。 */
function mcpStdio(child) {
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const slot = pending.get(msg.id);
      if (slot) { pending.delete(msg.id); clearTimeout(slot.timer); slot.resolve(msg); }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`stdio request timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { request, notify };
}

/** 等子进程退出（被信号杀死时 exitCode 为 null，须同时看 signalCode/已触发过的 exit）。 */
const exitOf = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(child.exitCode ?? `signal:${child.signalCode}`);
    return;
  }
  child.once('exit', (code, signal) => resolve(code ?? `signal:${signal}`));
});

test('场景5：第二个 mcp-entry 自动 frontend 模式；service stdin EOF 宽限排水；无孤儿', { timeout: 90_000 }, async () => {
  const port = await freePort();
  const spawnEntry = () => spawn(process.execPath, [MCP_ENTRY, '--port', String(port)], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // 第一个实例：service 模式
  const p1 = spawnEntry();
  let p1err = '';
  p1.stderr.on('data', (c) => { p1err += c.toString(); });
  let p2 = null;
  let p2err = '';
  try {
    await waitUntil(() => /MCP stdio ready/.test(p1err), { timeoutMs: 20_000 }); // 先等 service 就绪，避免抢端口竞态
    // 第二个实例：同端口 → 前端模式
    p2 = spawnEntry();
    p2.stderr.on('data', (c) => { p2err += c.toString(); });
    await waitUntil(() => /frontend mode: sharing service on port/.test(p2err), { timeoutMs: 20_000 });
    assert.match(p2err, new RegExp(`frontend mode: sharing service on port ${port}`));
    assert.doesNotMatch(p2err, /fatal/);

    // p2 走完整 MCP 握手 + 工具面
    const c2 = mcpStdio(p2);
    const init = await c2.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'multi-frontend-test', version: '0.0.1' },
    });
    assert.equal(init.result.serverInfo.name, 'chrome-agent-browser');
    c2.notify('notifications/initialized');
    const tools = await c2.request('tools/list', {});
    const names = tools.result.tools.map((t) => t.name);
    for (const n of ['ab_list_browsers', 'ab_new_tab', 'browser_eval']) assert.ok(names.includes(n), `缺少工具: ${n}`);
    const browsers = await c2.request('tools/call', { name: 'ab_list_browsers', arguments: {} });
    const parsed = JSON.parse(browsers.result.content.find((x) => x.type === 'text').text);
    assert.equal(parsed.browsers.length, 1);
    assert.equal(parsed.browsers[0].id, 'remote'); // 无浏览器连 service 时的占位标识

    // service 的 stdin EOF：有活跃 frontend（p2）→ 不退出，进入排水宽限
    p1.stdin.end();
    await waitUntil(() => /frontend connection\(s\) to drain/.test(p1err), { timeoutMs: 10_000 });
    await sleep(400);
    assert.ok(p1.exitCode === null, '排水期间 service 进程不应退出');
    // 排水期间 frontend 仍可用（service 的 MCP server 已关，但 WS 面继续服务）
    const tools2 = await c2.request('tools/list', {});
    assert.ok(tools2.result.tools.length >= 12);

    // frontend 退出 → service 排水完成 → 两个进程都干净退出（无孤儿）
    p2.stdin.end();
    assert.equal(await exitOf(p2), 0);
    assert.equal(await exitOf(p1), 0);
  } finally {
    if (p1.exitCode === null && p1.signalCode === null) p1.kill('SIGKILL');
    if (p2 && p2.exitCode === null && p2.signalCode === null) p2.kill('SIGKILL');
  }
});

test('场景5b：端口被非本服务程序占用 → 明确报错 exit 1（不挂死）', { timeout: 30_000 }, async () => {
  // 起一个「沉默的」ws 服务占住端口（不回 mcp/hello）
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const port = await new Promise((resolve, reject) => {
    wss.once('listening', () => resolve(wss.address().port));
    wss.once('error', reject);
  });
  wss.on('connection', () => { /* 沉默：不按本协议应答 */ });
  try {
    const child = spawn(process.execPath, [MCP_ENTRY, '--port', String(port)], {
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    const code = await exitOf(child);
    assert.equal(code, 1);
    assert.match(err, /端口 \d+ 被其他程序占用且不是本服务/);
    assert.match(err, /mcp\/hello timeout/);
  } finally {
    await new Promise((resolve) => wss.close(resolve));
  }
});

test('场景5c：service 进程被杀 → 前端进程报错清晰、正常退出（无孤儿）', { timeout: 60_000 }, async () => {
  const port = await freePort();
  const spawnEntry = (stdio) => spawn(process.execPath, [MCP_ENTRY, '--port', String(port)], {
    env: process.env,
    stdio,
  });

  // p1 的 stdin 用 pipe 并保持打开（'ignore' 会立刻 EOF 导致 service 退出）
  const p1 = spawnEntry(['pipe', 'ignore', 'pipe']);
  let p1err = '';
  p1.stderr.on('data', (c) => { p1err += c.toString(); });
  await waitUntil(() => /MCP stdio ready/.test(p1err), { timeoutMs: 20_000 }); // 先等 service 就绪，避免抢端口竞态

  const p2 = spawnEntry(['pipe', 'pipe', 'pipe']);
  let p2err = '';
  p2.stderr.on('data', (c) => { p2err += c.toString(); });
  try {
    await waitUntil(() => /frontend mode: sharing service on port/.test(p2err), { timeoutMs: 20_000 });

    const c2 = mcpStdio(p2);
    const init = await c2.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'multi-frontend-test', version: '0.0.1' },
    });
    assert.equal(init.result.serverInfo.name, 'chrome-agent-browser');
    c2.notify('notifications/initialized');

    // 杀掉 service（SIGKILL，最 harsh 的情况：无优雅关停）
    p1.kill('SIGKILL');
    await waitUntil(() => /service connection lost/.test(p2err), { timeoutMs: 10_000 });

    // 前端进程仍活着，浏览器类工具给出清晰错误（不是挂死/乱码）
    const res = await c2.request('tools/call', { name: 'ab_open_tabs', arguments: {} });
    assert.equal(res.result.isError, true);
    const parsed = JSON.parse(res.result.content.find((x) => x.type === 'text').text);
    assert.match(parsed.error, /no browser connected/);

    // 前端自己的 stdin EOF → 干净退出
    p2.stdin.end();
    assert.equal(await exitOf(p2), 0);
    await exitOf(p1); // 已被 SIGKILL，只确认收尸完成
  } finally {
    if (p1.exitCode === null && p1.signalCode === null) p1.kill('SIGKILL');
    if (p2.exitCode === null && p2.signalCode === null) p2.kill('SIGKILL');
  }
});


// ---- 后端死亡 → 前端接管（实战教训的回归测试）----
test('takeover：端口空闲时可接管；端口被占时返回 null', async () => {
  const { attemptServiceTakeover } = await import('../service/mcp-entry.mjs');
  const m1 = new ConnectionManager({ port: 0 });
  await m1.start();
  // 被占 → null
  assert.equal(await attemptServiceTakeover(m1.port), null);
  // 释放 → 接管成功，拿到能用的 manager
  const port = m1.port;
  await m1.stop();
  const m2 = await attemptServiceTakeover(port);
  assert.ok(m2, '端口释放后应接管成功');
  await m2.stop();
});

test('takeover 全路径：前端挂的服务死了 → 前端侧接管端口 → 浏览器可重连', async () => {
  const { attemptServiceTakeover } = await import('../service/mcp-entry.mjs');
  // service + 伪浏览器 + 前端
  const m1 = new ConnectionManager({ port: 0 });
  await m1.start();
  const mock = await startMockExtension({ port: m1.port });
  await once(m1, 'browser');
  const rf = new RemoteFrontend({ port: m1.port });
  await rf.start();
  assert.equal(rf.liveConnections().length, 1, '前端应能看到浏览器');

  // 模拟服务死亡
  const port = m1.port;
  mock.close();
  await m1.stop();

  // 前端恢复逻辑的核心一步：接管
  const m2 = await attemptServiceTakeover(port);
  assert.ok(m2, '应接管成功');
  // 浏览器宿主会自动重拨（真实场景），这里直接重连伪扩展验证新 service 可用
  const mock2 = await startMockExtension({ port, instanceId: 'mock-after-takeover' });
  await once(m2, 'browser');
  assert.equal(m2.liveConnections().length, 1);
  mock2.close();
  await m2.stop();
});
