// test/screencast.test.mjs — 实时投屏（v0.4.0）服务侧测试：真实 WS + 伪扩展。
//
// 覆盖：
//   - onScreencastFrame 事件 → 每 tab 环形缓存（超 20 帧丢最旧）
//   - frames() 按 sinceTs 过滤 / limit 取最新 N 帧（时间正序）
//   - lazy start 触发条件：无缓存且未投屏才自动 screencast_start（已有缓存或已投屏不再发）
//   - stop()：screencast_stop 到达扩展 + 本地缓存清空
//   - tab removed 事件 → 缓存与投屏状态清理
//   - MCP 面 ab_screencast：frames 返回 image content（jpeg）+ 时间戳文本行；stop 结构化结果
//
// 扩展侧节流/ack/生命周期（真 Page.screencastFrame）由 E2E 覆盖。

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ConnectionManager } from '../service/connection.mjs';
import { createAgentApi } from '../service/api.mjs';
import { loadPolicy } from '../service/policy.mjs';
import { createAudit } from '../service/audit.mjs';
import { startMockExtension } from '../service/mock-extension.mjs';
import { buildMcpServer } from '../service/mcp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 最小合法 JPEG 帧（ff d8 ff 开头 + EOI），base64 以 /9j/ 开头，避免依赖真图。 */
const jpegFrame = (n) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x41, 0x42, n & 0xff, 0xff, 0xd9]).toString('base64');

/** 起 service + api + 伪扩展。 */
async function startStack(mockOpts = {}) {
  const audit = createAudit({ dir: mkdtempSync(join(tmpdir(), 'ab-sc-audit-')) });
  const manager = new ConnectionManager({ port: 0, audit });
  await manager.start();
  const policy = loadPolicy(null, { audit });
  const api = createAgentApi(() => manager.liveConnections(), { policy });
  const got = once(manager, 'browser');
  const mock = await startMockExtension({ port: manager.port, ...mockOpts });
  await got;
  return { manager, policy, api, audit, mock };
}

/** 新开一个 tab（走 api，句柄/事件订阅齐全）。 */
async function newTab(api) {
  return (await (await api.browsers.getDefault()).tabs.new({}));
}

/** 等 screencast_start 命令到达伪扩展后补发一帧（模拟浏览器首帧）。 */
async function startThenEmitFirstFrame(mock, tabId, n) {
  for (let i = 0; i < 150; i++) {
    if (mock.calls.some((c) => c.method === 'screencast_start' && c.params.tabId === tabId)) {
      await sleep(50);
      mock.emitEvent('onScreencastFrame', { tabId, data: jpegFrame(n), ts: Date.now() });
      return true;
    }
    await sleep(20);
  }
  return false;
}

test('帧事件入环形缓存：超 20 帧丢最旧；frames 取最新且时间正序；capabilities 含 screencast', async () => {
  const s = await startStack();
  try {
    const tab = await newTab(s.api);
    const sc = tab.capabilities.get('screencast');
    assert.ok(sc, 'screencast 能力应可获取');
    assert.deepEqual(tab.capabilities.list(), ['cdp', 'webmcp', 'screencast']);
    for (let i = 1; i <= 25; i++) {
      s.mock.emitEvent('onScreencastFrame', { tabId: tab.id, data: jpegFrame(i), ts: 1000 + i, metadata: { deviceWidth: 1280 } });
    }
    await sleep(80); // 通知经 WS 异步落地
    const frames = await sc.frames({ limit: 20 });
    assert.equal(frames.length, 20, '环形缓存容量 20');
    assert.equal(frames[0].ts, 1006, '最旧的 5 帧被逐出（保留 ts=1006..1025）');
    assert.equal(frames[frames.length - 1].ts, 1025, '最新在末尾');
    assert.ok(frames.every((f, i, a) => i === 0 || a[i - 1].ts <= f.ts), '时间正序');
    const top3 = await sc.frames({ limit: 3 });
    assert.deepEqual(top3.map((f) => f.ts), [1023, 1024, 1025], 'limit 截最新 N 帧');
    assert.ok(!s.mock.calls.some((c) => c.method === 'screencast_start'), '已有缓存时 frames 不 lazy start');
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('frames 按 sinceTs 过滤：只取其之后的帧；晚于全部帧则空', async () => {
  const s = await startStack();
  try {
    const tab = await newTab(s.api);
    for (const ts of [2000, 2010, 2020]) {
      s.mock.emitEvent('onScreencastFrame', { tabId: tab.id, data: jpegFrame(ts), ts });
    }
    await sleep(80);
    const sc = tab.capabilities.get('screencast');
    const after = await sc.frames({ sinceTs: 2010 });
    assert.deepEqual(after.map((f) => f.ts), [2020], '严格大于 sinceTs');
    const none = await sc.frames({ sinceTs: 2020 });
    assert.equal(none.length, 0);
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('lazy start：无缓存且未投屏 → 首次 frames 自动 screencast_start 并等首帧；stop 后再取帧会再次 start', async () => {
  const s = await startStack();
  try {
    const tab = await newTab(s.api);
    const sc = tab.capabilities.get('screencast');
    const emitting = startThenEmitFirstFrame(s.mock, tab.id, 1); // start 到达后 50ms 补发首帧
    const frames = await sc.frames({});
    assert.ok(await emitting, 'screencast_start 应已到达伪扩展');
    assert.equal(frames.length, 1, 'lazy start 后应等到首帧');
    assert.ok(frames[0].data.startsWith('/9j/'), 'jpeg base64（ff d8 → /9j/）');
    assert.equal(s.mock.calls.filter((c) => c.method === 'screencast_start').length, 1, '恰好一次 lazy start');

    // 已有缓存：再次 frames 不再发 screencast_start
    await sc.frames({});
    assert.equal(s.mock.calls.filter((c) => c.method === 'screencast_start').length, 1);

    // stop 清缓存 + 除名 → 再取帧触发第二次 lazy start（并等到新首帧，不空转 3s）
    await sc.stop();
    s.mock.calls.length = 0;
    const emitting2 = startThenEmitFirstFrame(s.mock, tab.id, 2);
    const f2 = await sc.frames({});
    assert.ok(await emitting2, '第二次 screencast_start 应到达');
    assert.equal(f2.length, 1);
    assert.equal(s.mock.calls.filter((c) => c.method === 'screencast_start').length, 1);
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('已投屏但无帧：frames 不 lazy start、立即返回空（无 3s 等待）', async () => {
  const s = await startStack();
  try {
    const tab = await newTab(s.api);
    const sc = tab.capabilities.get('screencast');
    await sc.start();
    const t0 = Date.now();
    const frames = await sc.frames({});
    assert.equal(frames.length, 0);
    assert.ok(Date.now() - t0 < 500, '已投屏无缓存不应触发 lazy 等待');
    assert.equal(s.mock.calls.filter((c) => c.method === 'screencast_start').length, 1, '不重复 start');
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('start 可选参数透传；stop：screencast_stop 到达扩展 + 本地帧缓存清空', async () => {
  const s = await startStack();
  try {
    const tab = await newTab(s.api);
    const sc = tab.capabilities.get('screencast');
    await sc.start({ quality: 40, maxWidth: 640, maxHeight: 480, everyNthFrame: 2 });
    const startCall = s.mock.calls.find((c) => c.method === 'screencast_start');
    assert.deepEqual(startCall.params, { tabId: tab.id, quality: 40, maxWidth: 640, maxHeight: 480, everyNthFrame: 2 });
    s.mock.emitEvent('onScreencastFrame', { tabId: tab.id, data: jpegFrame(9), ts: Date.now() });
    await sleep(80);
    assert.equal((await sc.frames({})).length, 1, '投屏中有帧');

    await sc.stop();
    assert.ok(s.mock.calls.some((c) => c.method === 'screencast_stop' && c.params.tabId === tab.id), 'stop 命令到达扩展');
    // 缓存已清：补发一帧后只应看到这一帧（旧的 ts 已被清掉），且不触发 lazy start
    s.mock.emitEvent('onScreencastFrame', { tabId: tab.id, data: jpegFrame(10), ts: Date.now() });
    await sleep(80);
    const after = await sc.frames({ limit: 5 });
    assert.equal(after.length, 1, 'stop 后旧缓存被清，只剩新帧');
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('tab removed 事件 → 帧缓存清理；removed 后补发的帧照常入缓存（服务端不丢事件）', async () => {
  const s = await startStack();
  try {
    const tab = await newTab(s.api);
    const sc = tab.capabilities.get('screencast');
    await sc.start();
    for (const ts of [5000, 5010]) {
      s.mock.emitEvent('onScreencastFrame', { tabId: tab.id, data: jpegFrame(ts), ts });
    }
    await sleep(80);
    assert.equal((await sc.frames({ limit: 5 })).length, 2);

    s.mock.emitEvent('onPageEvent', { tabId: tab.id, event: 'removed' });
    await sleep(80);
    // removed 清了缓存：补发一帧后 frames 只看到它；ring 非空也不会 lazy start
    s.mock.emitEvent('onScreencastFrame', { tabId: tab.id, data: jpegFrame(9999), ts: Date.now() });
    await sleep(80);
    const after = await sc.frames({ limit: 5 });
    assert.equal(after.length, 1, 'removed 后旧缓存被清，只剩 removed 后补发的一帧');
    assert.equal(s.mock.calls.filter((c) => c.method === 'screencast_start').length, 1, 'removed 未触发重复 start');
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('MCP ab_screencast：frames 返回 image content（jpeg）+ 时间戳文本行；stop 结构化结果；limit 默认 1', async () => {
  const s = await startStack();
  const server = buildMcpServer({ api: s.api, policy: s.policy, audit: s.audit, connections: () => s.manager.liveConnections() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'sc-test', version: '0' });
  await client.connect(ct);
  try {
    const { tabId } = JSON.parse((await client.callTool({ name: 'ab_new_tab', arguments: {} }))
      .content.find((c) => c.type === 'text').text);

    // 先投屏并备好 3 帧（绕开 lazy 等待，让断言稳定）
    await client.callTool({
      name: 'browser_eval',
      arguments: { code: `await (await agent.browsers.getDefault()).tabs.get(${tabId}).capabilities.get('screencast').start();` },
    });
    for (const ts of [3000, 3010, 3020]) {
      s.mock.emitEvent('onScreencastFrame', { tabId, data: jpegFrame(ts), ts });
    }
    await sleep(80);

    const res = await client.callTool({ name: 'ab_screencast', arguments: { action: 'frames', tabId, limit: 2 } });
    assert.ok(!res.isError, JSON.stringify(res.content).slice(0, 200));
    const text = res.content.find((c) => c.type === 'text');
    assert.match(text.text, new RegExp(`screencast: tabId=${tabId} frames=2 ts=3010,3020`), '时间戳文本行');
    const images = res.content.filter((c) => c.type === 'image');
    assert.equal(images.length, 2);
    assert.ok(images.every((i) => i.mimeType === 'image/jpeg'));
    assert.ok(images.every((i) => i.data.startsWith('/9j/')), 'jpeg base64 魔数');

    // limit 默认 1（最新一帧）
    const one = await client.callTool({ name: 'ab_screencast', arguments: { action: 'frames', tabId } });
    const oneImages = one.content.filter((c) => c.type === 'image');
    assert.equal(oneImages.length, 1);
    assert.match(one.content.find((c) => c.type === 'text').text, /frames=1 ts=3020/);

    // stop：结构化结果 + 命令到达扩展
    const stop = await client.callTool({ name: 'ab_screencast', arguments: { action: 'stop', tabId } });
    assert.ok(!stop.isError);
    const stopJson = JSON.parse(stop.content.find((c) => c.type === 'text').text);
    assert.deepEqual(stopJson, { ok: true, stopped: true, tabId });
    assert.ok(s.mock.calls.some((c) => c.method === 'screencast_stop' && c.params.tabId === tabId));
  } finally {
    await client.close();
    await server.close();
    s.mock.close();
    await s.manager.stop();
  }
});

test('MCP ab_screencast：无帧时返回提示而非报错；limit>5 被入参校验拒绝', async () => {
  const s = await startStack();
  const server = buildMcpServer({ api: s.api, policy: s.policy, connections: () => s.manager.liveConnections() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'sc-test-2', version: '0' });
  await client.connect(ct);
  try {
    const { tabId } = JSON.parse((await client.callTool({ name: 'ab_new_tab', arguments: {} }))
      .content.find((c) => c.type === 'text').text);
    // 已投屏但无帧 → 空提示
    await client.callTool({
      name: 'browser_eval',
      arguments: { code: `await (await agent.browsers.getDefault()).tabs.get(${tabId}).capabilities.get('screencast').start();` },
    });
    const res = await client.callTool({ name: 'ab_screencast', arguments: { action: 'frames', tabId } });
    assert.ok(!res.isError);
    const r = JSON.parse(res.content.find((c) => c.type === 'text').text);
    assert.equal(r.frames, 0);
    assert.match(r.note, /未收到帧/);

    // limit=6：zod 校验拒绝（SDK 以异常或 isError 两种形式暴露，都算拒绝）
    let threw = false;
    let res6 = null;
    try { res6 = await client.callTool({ name: 'ab_screencast', arguments: { action: 'frames', tabId, limit: 6 } }); }
    catch { threw = true; }
    assert.ok(threw || res6.isError === true, 'limit>5 应被拒绝');
  } finally {
    await client.close();
    await server.close();
    s.mock.close();
    await s.manager.stop();
  }
});
