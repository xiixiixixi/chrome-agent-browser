// test/verify.test.mjs —— verify.mjs 纯逻辑单测（魔数识别 / 浏览器窗口挑选 / 记分卡统计）。
// 真机流程本身由 npm run verify 在真浏览器上验收，不在单测里造假跑。

import test from 'node:test';
import assert from 'node:assert/strict';
import { imageKind, pickBrowserWindow, summarize } from '../verify.mjs';

test('imageKind：PNG/JPEG 魔数识别，其余 null', () => {
  assert.equal(imageKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'png');
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(imageKind(Buffer.from([0x47, 0x49, 0x46, 0x38])), null); // GIF 不认
  assert.equal(imageKind(Buffer.from([0x89, 0x50])), null); // 太短
  assert.equal(imageKind(Buffer.alloc(0)), null);
  assert.equal(imageKind(null), null);
});

test('pickBrowserWindow：按 family 提示词匹配 ownerName，优先在屏窗口', () => {
  const wins = [
    { ownerName: 'Terminal', onScreen: true, bounds: { x: 0, y: 0, w: 800, h: 600 } },
    { ownerName: 'Google Chrome', onScreen: false, bounds: { x: 0, y: 0, w: 1200, h: 800 } },
    { ownerName: 'Google Chrome', onScreen: true, bounds: { x: 10, y: 10, w: 1280, h: 900 }, windowId: 42 },
  ];
  assert.equal(pickBrowserWindow(wins, 'chrome').windowId, 42); // 同名里挑在屏那个
  assert.equal(pickBrowserWindow([wins[0]], 'chrome'), null); // 没有匹配 → null
  assert.equal(pickBrowserWindow(wins, 'arc'), null); // 提示词 Arc，清单里没有
  assert.equal(pickBrowserWindow(wins, 'unknown-family'), null); // 未知 family
  assert.equal(pickBrowserWindow([], 'chrome'), null);
  assert.equal(pickBrowserWindow(null, 'chrome'), null); // 坏输入不炸
});

test('pickBrowserWindow：各 family 的提示词都能命中对应应用名', () => {
  const names = { chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave Browser', opera: 'Opera', vivaldi: 'Vivaldi', arc: 'Arc' };
  for (const [family, appName] of Object.entries(names)) {
    const hit = pickBrowserWindow([{ ownerName: appName, onScreen: true }], family);
    assert.ok(hit, `${family} 应命中 ${appName}`);
  }
});

test('summarize：PASS/FAIL/SKIP 三态计数', () => {
  const rows = [
    { status: 'PASS' }, { status: 'PASS' }, { status: 'SKIP' }, { status: 'FAIL' },
  ];
  assert.deepEqual(summarize(rows), { total: 4, pass: 2, fail: 1, skip: 1 });
  assert.deepEqual(summarize([]), { total: 0, pass: 0, fail: 0, skip: 0 });
  assert.deepEqual(summarize(null), { total: 0, pass: 0, fail: 0, skip: 0 });
});
