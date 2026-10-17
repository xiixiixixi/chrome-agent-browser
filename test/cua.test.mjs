// test/cua.test.mjs — 屏幕操作（CUA，v0.5.1）测试：单元（注入 fake）+ Swift 助手自检。
//
// 覆盖：
//   - 无 helper 时的优雅降级（cua_status 报 tier：osascript 可用=B / AX 拒=C）
//   - 行协议拼装/解析：fake 助手（真子进程、单行 JSON、按 id 配对）；错误映射、坏行、进程死亡重启
//   - 降级链 A→B→C：helper 缺失走 osascript（脚本形状 + 输出解析）；osascript AX 拒 → 结构化错误
//   - 审计记录（cua_type 脱敏 [redacted]；xy 点击记坐标；按 cmd 查询）
//   - 确认门（cua_key cmd+q 拦截 → ab_confirm 批准 → 带 token 放行；普通键直行）
//   - cua_verify 证据组装（动作前证据 + 验证时后证据 + 防幻觉说明）
//   - MCP 工具族（9 个 cua_* 注册；cua_status / cua_screenshot / cua_key 经 InMemoryTransport）
//   - 幽魂光标（v0.5.1）：overlay-show 拼装/窗口中心近似/xyFallback 落点精化；失败不阻塞动作；
//     cuaOverlay 开关（false 零调用）；type/key 30s 提示窗口（假时钟）；叠加不入审计、不污染前证据
//   - Swift 助手自检：swiftc 可用则编译到临时目录跑 probe/windows/ax-tree（含 overlay 协议错误分支）；
//     编译失败/无 swiftc/非 macOS → SKIP（带原因，不算失败）；源码级 overlay 协议/窗口要件断言

import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ConnectionManager } from '../service/connection.mjs';
import { createAgentApi } from '../service/api.mjs';
import { Policy, loadPolicy } from '../service/policy.mjs';
import { createAudit } from '../service/audit.mjs';
import { startMockExtension } from '../service/mock-extension.mjs';
import { buildMcpServer } from '../service/mcp.mjs';
import {
  createCua, createHelperClient, compileHelper, swiftcPath, keyCombo, SWIFT_SRC_PATH,
} from '../service/cua.mjs';

const CUA_TOOLS = [
  'cua_status', 'cua_windows', 'cua_ax_tree', 'cua_screenshot', 'cua_click',
  'cua_type', 'cua_key', 'cua_app_focus', 'cua_verify',
];

// ---------- 测试夹具 ----------

/** 1x1 真 PNG：screencapture fake 写进输出文件用。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * fake 进程执行器：osascript 按脚本内容回 canned 应答；screencapture 往输出路径写真 PNG。
 * 全部调用记入 calls（{cmd, args, input}）。
 */
function fakeExec({ osaOut = {}, osaCode = 0 } = {}) {
  const calls = [];
  const runner = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    if (cmd === 'osascript') {
      const script = String(opts.input ?? '');
      if (osaCode !== 0) return { code: osaCode, stdout: '', stderr: osaOut.__error ?? 'execution error: not allowed assistive access (-1743)' };
      for (const [needle, out] of Object.entries(osaOut)) {
        if (needle !== '__error' && script.includes(needle)) return { code: 0, stdout: out, stderr: '' };
      }
      return { code: 0, stdout: osaOut.__default ?? '', stderr: '' };
    }
    if (cmd === 'screencapture') {
      const file = args[args.length - 1];
      writeFileSync(file, TINY_PNG);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  runner.calls = calls;
  return runner;
}

/** fake Swift 助手（真 node 子进程，行协议）：按命令表应答；请求原样追加进 log 文件。 */
function writeFakeHelper(dir, handlers, logFile) {
  const src = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const handlers = ${JSON.stringify(handlers)};
rl.on('line', (line) => {
  let req = null;
  try { req = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ id: -1, ok: false, error: 'bad json' }) + '\\n'); return; }
  try { appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(req) + '\\n'); } catch {}
  const h = handlers[req.cmd];
  if (!h) { process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: 'unknown-cmd: ' + req.cmd, code: 'unknown-cmd' }) + '\\n'); return; }
  if (h.__err) { const { __err, code } = h; process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: __err, ...(code ? { code } : {}) }) + '\\n'); return; }
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, ...h }) + '\\n');
});
`;
  const bin = join(dir, 'fake-cua-helper');
  writeFileSync(bin, src);
  chmodSync(bin, 0o755);
  return bin;
}

/** 读 fake helper 的请求日志（逐行 JSON）。 */
const readHelperLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** 临时目录 + 审计 + 策略。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cua-'));
  const audit = createAudit({ dir: join(dir, 'audit') });
  const policy = loadPolicy(null, { audit }); // 默认策略：confirmCuaKeys = [cmd+q, cmd+w]
  return { dir, audit, policy };
}

const FAKE_HELPERS = {
  probe: { axGranted: true, screenGranted: true, screen: { w: 1920, h: 1080 } },
  windows: { windows: [{ windowId: 42, ownerPid: 4321, ownerName: 'FakeApp', title: 'Fake Win', bounds: { x: 10, y: 20, w: 800, h: 600 }, onScreen: true }] },
  'ax-tree': { nodes: [{ depth: 0, role: 'AXWindow', title: 'Fake Win' }, { depth: 1, role: 'AXButton', title: 'OK' }], truncated: false },
  'element-click': { pressed: true },
  'xy-click': { x: 1, y: 2, targeted: true },
  type: { chars: 5 },
  key: { key: 'q', keyCode: 12, modifiers: ['cmd'] },
  'app-focus': { axRaised: true, appActivated: true },
  'overlay-show': {},
  'overlay-hide': {},
};

/** 组一套 tier-A cua（fake helper + fake exec）。 */
function tierAFixture() {
  const f = fixture();
  const logFile = join(f.dir, 'helper-log.jsonl');
  const bin = writeFakeHelper(f.dir, FAKE_HELPERS, logFile);
  const exec = fakeExec();
  const cua = createCua({ audit: f.audit, policy: f.policy, helperPath: bin, execRunner: exec });
  return { ...f, cua, bin, logFile, exec };
}

// ---------- 1. 无 helper 的优雅降级 ----------

test('cua_status 无 helper：osascript AX 可用 → tier B；osascript 被拒 → tier C（含指引）', async () => {
  const f = fixture();
  try {
    const execB = fakeExec({ osaOut: { frontmost: '4321\n' } });
    const cuaB = createCua({ audit: f.audit, policy: f.policy, helperPath: join(f.dir, 'nope'), execRunner: execB });
    const stB = await cuaB.status();
    assert.equal(stB.supported, true);
    assert.equal(stB.tier, 'B');
    assert.equal(stB.helperCompiled, false);
    assert.equal(stB.axGranted, true);
    assert.equal(stB.capabilities.axTree, true);
    assert.equal(stB.capabilities.xyClick, false, 'B 层无坐标点击');

    const execC = fakeExec({ osaCode: 1743, osaOut: { __error: 'execution error: Not authorized to send Apple events to System Events. (-1743)' } });
    const cuaC = createCua({ audit: f.audit, policy: f.policy, helperPath: join(f.dir, 'nope'), execRunner: execC });
    const stC = await cuaC.status();
    assert.equal(stC.tier, 'C');
    assert.equal(stC.axGranted, false);
    assert.equal(stC.capabilities.axTree, false);
    assert.equal(stC.capabilities.screenshot, true, 'C 层仍可尝试截图');
    assert.ok(stC.guidance.some((g) => g.includes('辅助功能')), '未授权指引人话可用');
    assert.ok(stC.guidance.some((g) => g.includes('setup')), '提示编译 A 层助手');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------- 2. 行协议：真子进程 fake 助手 ----------

test('helper 行协议：请求单行 JSON（id/cmd/参数）、响应按 id 配对；各命令参数形状正确', async () => {
  const t = tierAFixture();
  try {
    const st = await t.cua.status();
    assert.equal(st.tier, 'A');
    assert.deepEqual(st.axGranted, true);

    const wins = await t.cua.windows();
    assert.equal(wins.length, 1);
    assert.equal(wins[0].windowId, 42);
    assert.equal(wins[0].title, 'Fake Win', 'helper 已给标题时不做 osascript 回填');

    const tree = await t.cua.axTree({ pid: 4321 });
    assert.equal(tree.via, 'helper');
    assert.equal(tree.nodes.length, 2);
    assert.deepEqual(tree.nodes[1], { depth: 1, role: 'AXButton', title: 'OK' });

    const click = await t.cua.click({ pid: 4321, role: 'AXButton', title: 'OK' });
    assert.equal(click.pressed, true);

    const xy = await t.cua.click({ x: 100, y: 200, pid: 4321 });
    assert.equal(xy.mode, 'xy');
    assert.equal(xy.targeted, true);

    await t.cua.type({ text: 'hello', pid: 4321 });
    await t.cua.key({ key: 'q', modifiers: ['cmd'], pid: 4321, confirmationToken: 'irrelevant' }).catch(() => {}); // 拦截场景在确认门测试单独覆盖
    assert.ok(!readHelperLog(t.logFile).some((r) => r.cmd === 'key'), '未批准不出门');
    await t.cua.key({ key: 'a', modifiers: ['ctrl'], pid: 4321 }); // 非危险组合直行
    await t.cua.appFocus({ app: 'FakeApp' });

    const log = readHelperLog(t.logFile);
    const byCmd = Object.fromEntries(log.map((r) => [r.cmd, r]));
    assert.match(JSON.stringify(byCmd.probe), /"cmd":"probe"/);
    assert.equal(byCmd.windows.cmd, 'windows');
    assert.equal(byCmd['ax-tree'].pid, 4321);
    assert.ok(Number.isInteger(byCmd['ax-tree'].id), '请求必须带 id');
    assert.deepEqual({ pid: byCmd['element-click'].pid, role: byCmd['element-click'].role, title: byCmd['element-click'].title },
      { pid: 4321, role: 'AXButton', title: 'OK' });
    assert.deepEqual({ x: byCmd['xy-click'].x, y: byCmd['xy-click'].y, pid: byCmd['xy-click'].pid }, { x: 100, y: 200, pid: 4321 });
    assert.equal(byCmd.type.text, 'hello');
    assert.deepEqual({ key: byCmd.key.key, modifiers: byCmd.key.modifiers }, { key: 'a', modifiers: ['ctrl'] });
    assert.equal(byCmd['app-focus'].pid, 4321);
  } finally {
    t.cua.stop();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('helper 错误响应 → CuaError（code 透传）；status 不抛错、如实降级；未知命令 → unknown-cmd', async () => {
  const f = fixture();
  const logFile = join(f.dir, 'log');
  const bin = writeFakeHelper(f.dir, { probe: { __err: 'boom', code: 'not-granted' } }, logFile);
  const cua = createCua({ audit: f.audit, policy: f.policy, helperPath: bin, execRunner: fakeExec() });
  try {
    // status 吞掉 probe 失败：axGranted 未知 → 降级 tier C 并带 probeError（探测本身不能炸）
    const st = await cua.status();
    assert.equal(st.helperCompiled, true);
    assert.equal(st.axGranted, null);
    assert.match(st.probeError, /boom/);

    // 直连客户端：错误响应映射为 CuaError（code 透传）
    const client = createHelperClient(bin, { timeoutMs: 4000 });
    await assert.rejects(client.request('probe'), (err) => err.code === 'not-granted' && /boom/.test(err.message));
    await assert.rejects(client.request('no-such-cmd', {}), (err) => err.code === 'unknown-cmd');
    client.stop();
  } finally {
    cua.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('helper 进程死亡：在途请求报错；下一次请求自动重启进程', async () => {
  const f = fixture();
  const logFile = join(f.dir, 'log');
  const bin = writeFakeHelper(f.dir, FAKE_HELPERS, logFile);
  const client = createHelperClient(bin, { timeoutMs: 4000 });
  try {
    const first = await client.request('probe');
    assert.equal(first.ok, true);
    client.proc()?.kill('SIGKILL'); // 杀死底层进程，模拟崩溃
    for (let i = 0; i < 150 && client.proc(); i += 1) await new Promise((r) => setTimeout(r, 20)); // 等 exit 事件落地
    assert.equal(client.proc(), null, '死亡后句柄清空');
    const second = await client.request('probe'); // 自动重启
    assert.equal(second.ok, true);
    assert.ok(readHelperLog(logFile).length >= 2, '重启后继续服务');
  } finally {
    client.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('helper stop 后立即复用：旧进程迟到的 exit 事件不得误杀新进程（自检重编译场景）', async () => {
  const f = fixture();
  const logFile = join(f.dir, 'log');
  const bin = writeFakeHelper(f.dir, FAKE_HELPERS, logFile);
  const client = createHelperClient(bin, { timeoutMs: 4000 });
  try {
    assert.equal((await client.request('probe')).ok, true);
    client.stop(); // 杀旧进程，但不等其 exit 事件落地
    const second = await client.request('probe'); // 立即重用 → 应拉起新进程且不受旧 exit 波及
    assert.equal(second.ok, true);
    assert.notEqual(client.proc(), null, '新进程在役');
  } finally {
    client.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------- 3. 降级链 A→B→C（无 helper 时走 osascript） ----------

test('B 层 ax-tree/element-click/type/key/app_focus：osascript 脚本形状 + 输出解析', async () => {
  const f = fixture();
  const exec = fakeExec({
    osaOut: {
      'unix id of first application process whose name is "Notes"': '555\n',
      'whose unix id is 555': '0\tAXWindow\tUntitled\tsome text\t10,20,300,200\n1\tAXButton\tOK\t\t15,25,30,10\n',
      'unix id of first application process whose frontmost is true': '555\n',
      hunt: 'clicked',
      __default: '',
    },
  });
  const cua = createCua({ audit: f.audit, policy: f.policy, helperPath: join(f.dir, 'nope'), execRunner: exec });
  try {
    const tree = await cua.axTree({ app: 'Notes' });
    assert.equal(tree.via, 'osascript');
    assert.equal(tree.pid, 555);
    assert.deepEqual(tree.nodes[0], { depth: 0, role: 'AXWindow', title: 'Untitled', value: 'some text', bounds: { x: 10, y: 20, w: 300, h: 200 } });
    assert.deepEqual(tree.nodes[1], { depth: 1, role: 'AXButton', title: 'OK', bounds: { x: 15, y: 25, w: 30, h: 10 } });

    const click = await cua.click({ pid: 555, role: 'AXButton', title: 'OK' });
    assert.equal(click.via, 'osascript');
    const clickScript = exec.calls.filter((c) => c.cmd === 'osascript').map((c) => c.input).find((s) => s.includes('hunt'));
    assert.ok(clickScript.includes('unix id is 555'), '按 pid 定位进程');
    assert.ok(clickScript.includes('"AXButton"') && clickScript.includes('"OK"'));

    const typed = await cua.type({ text: 'hi 你好', app: 'Notes' });
    assert.equal(typed.chars, 5);
    const typeScript = exec.calls.map((c) => c.input).filter(Boolean).find((s) => s.includes('keystroke'));
    assert.ok(typeScript.includes('keystroke "hi 你好"'));
    assert.ok(typeScript.includes('set frontmost of application process "Notes" to true'), 'B 层输入前先置前台');

    const keyed = await cua.key({ key: 'return', modifiers: ['cmd'] });
    assert.equal(keyed.key, 'return');
    const keyScript = exec.calls.map((c) => c.input).filter(Boolean).find((s) => s.includes('key code'));
    assert.ok(keyScript.includes('key code 36 with command down'), '键码映射 + 修饰键后缀');

    const focus = await cua.appFocus({ app: 'Notes' });
    assert.equal(focus.via, 'osascript');
  } finally {
    cua.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('C 层（AX 被拒）：ax_tree/windows/click 报结构化 CAPABILITY_UNAVAILABLE；截图仍可用', async () => {
  const f = fixture();
  const exec = fakeExec({ osaCode: 1743, osaOut: { __error: 'execution error: osascript is not allowed assistive access. (-25211)' } });
  const cua = createCua({ audit: f.audit, policy: f.policy, helperPath: join(f.dir, 'nope'), execRunner: exec });
  try {
    await assert.rejects(cua.axTree({ pid: 1 }), (err) => err.code === 'CAPABILITY_UNAVAILABLE' && /辅助功能/.test(err.message));
    await assert.rejects(cua.windows(), (err) => err.code === 'CAPABILITY_UNAVAILABLE');
    await assert.rejects(cua.click({ pid: 1, role: 'AXButton' }), (err) => err.code === 'CAPABILITY_UNAVAILABLE');
    await assert.rejects(cua.click({ x: 1, y: 2 }), (err) => err.code === 'CAPABILITY_UNAVAILABLE');
    // 截图不依赖 AX：C 层仍可走 screencapture（fake 会写真 PNG）
    const shot = await cua.screenshot({ rect: { x: 0, y: 0, w: 10, h: 10 } });
    assert.equal(shot.mimeType, 'image/png');
    assert.ok(shot.bytes > 0);
  } finally {
    cua.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('B 层 xy 点击：明确报「需要 A 层助手」；type/key 走 osascript 直行', async () => {
  const f = fixture();
  const exec = fakeExec({ osaOut: { frontmost: '555\n', __default: '' } });
  const cua = createCua({ audit: f.audit, policy: f.policy, helperPath: join(f.dir, 'nope'), execRunner: exec });
  try {
    await assert.rejects(cua.click({ x: 10, y: 20 }), (err) => err.code === 'CAPABILITY_UNAVAILABLE' && /cua-helper/.test(err.message));
    assert.equal((await cua.type({ text: 'ok' })).ok, true);
    assert.equal((await cua.key({ key: 'tab' })).ok, true);
  } finally {
    cua.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------- 4. 审计记录 ----------

test('审计：cua_type 记 [redacted]+长度；xy-click 记坐标；元素点击记 role/title；可按 cmd 查询', async () => {
  const t = tierAFixture();
  try {
    await t.cua.click({ x: 111, y: 222, pid: 4321 });
    await t.cua.type({ text: 'secret-pw', pid: 4321 });
    await t.cua.click({ pid: 4321, role: 'AXButton', title: 'OK' });
    await t.cua.appFocus({ app: 'FakeApp' });

    const clicks = t.audit.query({ cmd: 'cua_click' }).entries;
    assert.equal(clicks.length, 2);
    assert.deepEqual({ x: clicks.find((e) => e.paramsLite.mode === 'xy').paramsLite.x, y: clicks.find((e) => e.paramsLite.mode === 'xy').paramsLite.y }, { x: 111, y: 222 });

    const types = t.audit.query({ cmd: 'cua_type' }).entries;
    assert.equal(types.length, 1);
    assert.equal(types[0].paramsLite.text, '[redacted]');
    assert.equal(types[0].paramsLite.chars, 'secret-pw'.length);
    assert.equal(types[0].redacted, true);

    const elem = clicks.find((e) => e.paramsLite.mode === 'element');
    assert.deepEqual({ role: elem.paramsLite.role, title: elem.paramsLite.title, pid: elem.paramsLite.pid }, { role: 'AXButton', title: 'OK', pid: 4321 });

    const focus = t.audit.query({ cmd: 'cua_app_focus' }).entries;
    assert.equal(focus.length, 1);
    assert.equal(focus[0].paramsLite.app, 'FakeApp');

    // 读类不入审计
    await t.cua.windows();
    await t.cua.status();
    await t.cua.verify({ windowId: 42 });
    assert.equal(t.audit.query({ cmd: 'cua_windows' }).total, 0);
    assert.equal(t.audit.query({ cmd: 'cua_status' }).total, 0);
  } finally {
    t.cua.stop();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// ---------- 5. 确认门（危险组合键） ----------

test('确认门：cmd+q 首次 needConfirmation（不执行）→ 批准 → 带 token 放行；cmd+w 同；普通键直行', async () => {
  const t = tierAFixture();
  try {
    // cmd+q：拦截（helper 不应收到 key 请求）
    let token = null;
    await assert.rejects(t.cua.key({ key: 'q', modifiers: ['cmd'], pid: 4321 }), (err) => {
      assert.equal(err.needsConfirmation, true);
      assert.match(err.description, /cmd\+q/);
      token = err.token;
      return true;
    });
    assert.ok(token);
    assert.ok(!readHelperLog(t.logFile).some((r) => r.cmd === 'key'), '未批准不得执行');

    // ab_confirm 批准 → 带原 token 重试放行（command 别名归一为 cmd，同一组合）
    assert.equal(t.policy.approve(token).ok, true);
    const done = await t.cua.key({ key: 'q', modifiers: ['command'], pid: 4321, confirmationToken: token });
    assert.equal(done.ok, true);
    assert.ok(readHelperLog(t.logFile).some((r) => r.cmd === 'key' && r.key === 'q'));

    // cmd+w 也在默认名单
    await assert.rejects(t.cua.key({ key: 'w', modifiers: ['cmd'] }), (err) => err.needsConfirmation === true);
    // 普通组合与单键直行
    assert.equal((await t.cua.key({ key: 'a', modifiers: ['ctrl'] })).ok, true);
    assert.equal((await t.cua.key({ key: 'enter' })).ok, true);
  } finally {
    t.cua.stop();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('keyCombo 归一：command/control/option 别名折叠、排序一致；策略 confirmCuaKeys 可配置', async () => {
  assert.equal(keyCombo('q', ['command']), 'cmd+q');
  assert.equal(keyCombo('q', ['shift', 'control']), 'ctrl+shift+q');
  assert.equal(keyCombo('W', []), 'w');

  const f = fixture();
  try {
    const policy = loadPolicy(null, { audit: f.audit });
    assert.deepEqual(policy.rules.confirmCuaKeys, ['cmd+q', 'cmd+w'], '默认名单');
    // 自定义：只拦 cmd+q
    const custom = new Policy({ confirmCuaKeys: ['cmd+q'] }, {});
    assert.equal(custom.check({ kind: 'cua_action', tool: 'cua_key', combo: 'cmd+w' }).allowed, true);
    assert.ok(custom.check({ kind: 'cua_action', tool: 'cua_key', combo: 'cmd+q' }).needConfirmation);
    // 非键动作一律放行
    assert.equal(policy.check({ kind: 'cua_action', tool: 'cua_click' }).allowed, true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------- 6. cua_verify 证据组装 ----------

test('cua_verify：动作前存证据（截图），验证时取后证据成对返回 + 防幻觉说明；截图不可用时降级 none', async () => {
  const t = tierAFixture();
  try {
    await t.cua.click({ pid: 4321, role: 'AXButton', title: 'OK' });
    // 元素模式：证据目标 = 该 pid 的窗口（helper 窗口 windowId=42）→ before 截图应带 -l42
    const beforeCall = t.exec.calls.find((c) => c.cmd === 'screencapture' && c.args.some((a) => a === '-l42'));
    assert.ok(beforeCall, '动作前按目标窗口取证');
    assert.ok(beforeCall.args.includes('-x'), '静默截图');

    const v = await t.cua.verify({ windowId: 42 });
    assert.equal(v.ok, true);
    assert.equal(v.action.tool, 'cua_click');
    assert.equal(v.action.pid, 4321);
    assert.equal(v.before.kind, 'screenshot');
    assert.equal(v.before.windowId, 42);
    assert.equal(v.after.kind, 'screenshot');
    assert.ok(v.note.includes('声称已点击不算数'), '防幻觉说明');

    // xy 模式：证据目标 = 坐标周边 480x320（点击点居中）
    await t.cua.click({ x: 500, y: 400, pid: 4321 });
    const rectCall = t.exec.calls.map((c) => c.args.join(' ')).filter((s) => s.includes('-R')).pop();
    assert.ok(/-R260,240,480,320/.test(rectCall), `xy 取证区域中心化: ${rectCall}`);
    const v2 = await t.cua.verify({});
    assert.equal(v2.before.kind, 'screenshot');
    assert.deepEqual(v2.before.rect, { x: 260, y: 240, w: 480, h: 320 });
  } finally {
    t.cua.stop();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('cua_verify：无上一动作时 action=null 仍可显式取证；screencapture 失败 → kind:none 不抛错', async () => {
  const f = fixture();
  const logFile = join(f.dir, 'log');
  const bin = writeFakeHelper(f.dir, FAKE_HELPERS, logFile);
  const exec = fakeExec();
  let failShot = false;
  const wrapped = async (cmd, args, opts) => {
    if (cmd === 'screencapture' && failShot) return { code: 1, stdout: '', stderr: 'could not create image' };
    return exec(cmd, args, opts);
  };
  const cua = createCua({ audit: f.audit, policy: f.policy, helperPath: bin, execRunner: wrapped });
  try {
    const v0 = await cua.verify({ rect: { x: 0, y: 0, w: 5, h: 5 } });
    assert.equal(v0.action, null);
    assert.equal(v0.before, null);
    assert.equal(v0.after.kind, 'screenshot');

    failShot = true;
    await cua.click({ pid: 4321, role: 'AXButton' }); // 取证失败不阻塞动作
    const v1 = await cua.verify({});
    assert.equal(v1.before.kind, 'none');
    assert.match(v1.before.reason, /截图失败/);
    assert.equal(v1.after.kind, 'none');
  } finally {
    cua.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------- 7. MCP 工具族 ----------

/** 起 MCP 栈（真 WS + 伪扩展）并注入 fake cua；policy 可外部传入（与 cua 实例共享同一份，确认门才对得上）。 */
async function startMcpStack(cua, policy) {
  const audit = createAudit({ dir: mkdtempSync(join(tmpdir(), 'ab-cua-mcp-')) });
  const manager = new ConnectionManager({ port: 0, audit });
  await manager.start();
  const pol = policy ?? loadPolicy(null, { audit });
  const api = createAgentApi(() => manager.liveConnections(), { policy: pol });
  const server = buildMcpServer({ api, policy: pol, connections: () => manager.liveConnections(), audit, cua });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'cua-test', version: '0' });
  await client.connect(ct);
  const got = once(manager, 'browser');
  const mock = await startMockExtension({ port: manager.port });
  await got;
  return {
    client, server, manager, mock, policy: pol,
    async close() { mock.close(); await client.close(); await server.close(); await manager.stop(); },
  };
}

test('MCP：9 个 cua_* 工具已注册；cua_status / cua_screenshot / cua_key 走完整 MCP 线缆', async () => {
  const t = tierAFixture();
  const s = await startMcpStack(t.cua, t.policy); // 共享同一 policy：ab_confirm 批准的 token 才能放行 cua_key
  try {
    const names = (await s.client.listTools()).tools.map((x) => x.name);
    for (const n of CUA_TOOLS) assert.ok(names.includes(n), `缺少工具: ${n}`);

    const st = JSON.parse((await s.client.callTool({ name: 'cua_status', arguments: {} }))
      .content.find((c) => c.type === 'text').text);
    assert.equal(st.tier, 'A');

    const shot = await s.client.callTool({ name: 'cua_screenshot', arguments: { windowId: 42 } });
    const img = shot.content.find((c) => c.type === 'image');
    assert.equal(img.mimeType, 'image/png');
    assert.ok(img.data.length > 10);
    assert.match(shot.content.find((c) => c.type === 'text').text, /windowId=42/);

    // cmd+q 确认流（经 MCP 面）
    const need = JSON.parse((await s.client.callTool({ name: 'cua_key', arguments: { key: 'q', modifiers: ['cmd'], pid: 4321 } }))
      .content.find((c) => c.type === 'text').text);
    assert.equal(need.needConfirmation, true);
    const conf = JSON.parse((await s.client.callTool({ name: 'ab_confirm', arguments: { token: need.token } }))
      .content.find((c) => c.type === 'text').text);
    assert.equal(conf.ok, true);
    const done = JSON.parse((await s.client.callTool({ name: 'cua_key', arguments: { key: 'q', modifiers: ['cmd'], pid: 4321, confirmationToken: need.token } }))
      .content.find((c) => c.type === 'text').text);
    assert.equal(done.ok, true);
  } finally {
    await s.close();
    t.cua.stop();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('MCP：cua_ax_tree/cua_click/cua_verify 串起「看→动→验」循环', async () => {
  const t = tierAFixture();
  const s = await startMcpStack(t.cua);
  try {
    const tree = JSON.parse((await s.client.callTool({ name: 'cua_ax_tree', arguments: { pid: 4321 } }))
      .content.find((c) => c.type === 'text').text);
    assert.equal(tree.nodes[1].title, 'OK');

    const click = JSON.parse((await s.client.callTool({ name: 'cua_click', arguments: { pid: 4321, role: 'AXButton', title: 'OK' } }))
      .content.find((c) => c.type === 'text').text);
    assert.equal(click.pressed, true);

    const v = JSON.parse((await s.client.callTool({ name: 'cua_verify', arguments: { windowId: 42 } }))
      .content.find((c) => c.type === 'text').text);
    assert.equal(v.before.kind, 'screenshot');
    assert.equal(v.after.kind, 'screenshot');
  } finally {
    await s.close();
    t.cua.stop();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// ---------- 8. Swift 助手自检（真编译；环境不支持则 SKIP） ----------

test('Swift 助手自检：编译到临时目录 → probe/windows/ax-tree（ax-tree 未授权时结构化 not-granted）', { timeout: 300_000 }, async (t2) => {
  if (process.platform !== 'darwin') { t2.skip('非 macOS：CUA 助手仅支持 macOS'); return; }
  if (!swiftcPath()) { t2.skip('本机无 swiftc（装 Xcode 或命令行工具后重跑）'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'ab-cua-swift-'));
  try {
    const out = join(dir, 'cua-helper-test');
    const r = compileHelper({ out });
    if (!r.compiled) { t2.skip(`swiftc 编译失败（不算测试失败）: ${r.reason?.slice(0, 200)}`); return; }

    const client = createHelperClient(out, { timeoutMs: 20_000 });
    try {
      const probe = await client.request('probe');
      assert.equal(probe.ok, true);
      assert.equal(typeof probe.axGranted, 'boolean');
      assert.equal(typeof probe.screenGranted, 'boolean');

      const wins = await client.request('windows');
      assert.equal(wins.ok, true);
      assert.ok(Array.isArray(wins.windows), '窗口清单是数组（通常无需授权）');

      // ax-tree：授权 → 节点数组；未授权 → 结构化 not-granted（两者都算过：不崩溃即符合契约）
      const pid = Number.parseInt(execSync('pgrep -x Finder').toString().split('\n')[0], 10);
      const tree = await client.request('ax-tree', { pid, maxDepth: 2 })
        .then((v) => ({ ok: true, v }))
        .catch((err) => ({ ok: false, err }));
      if (probe.axGranted) {
        assert.equal(tree.ok, true, `ax 授权时 ax-tree 应成功: ${tree.err?.message ?? ''}`);
        assert.ok(Array.isArray(tree.v.nodes));
      } else {
        assert.equal(tree.ok, false);
        assert.equal(tree.err.code, 'not-granted', '未授权 → 结构化 not-granted 而非崩溃');
        assert.match(tree.err.message, /辅助功能/);
      }

      // 未知键名：结构化错误
      const badKey = await client.request('key', { key: 'notakey' }).then((v) => v, (err) => err);
      assert.equal(badKey.code, 'unknown-key');

      // overlay 协议（不闪真窗口：坏参数走结构化错误分支；overlay-hide 幂等 ok）
      const badKind = await client.request('overlay-show', { x: 10, y: 10, kind: 'bogus' }).then((v) => v, (err) => err);
      assert.equal(badKind.code, 'bad-kind');
      const noXY = await client.request('overlay-show', { kind: 'arrow' }).then((v) => v, (err) => err);
      assert.equal(noXY.code, 'bad-args');
      const hidden = await client.request('overlay-hide');
      assert.equal(hidden.ok, true);
    } finally {
      client.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('swift 源码存在且 compileHelper 对缺失 SDK 的环境返回可读原因（不抛异常）', () => {
  assert.ok(existsSync(SWIFT_SRC_PATH), 'swift/cua-helper.swift 应随包分发');
  const r = compileHelper({ out: join(tmpdir(), `ab-cua-nope-${Date.now()}`) });
  assert.equal(typeof r.compiled, 'boolean');
  assert.ok(r.path, '返回结果带输出路径');
  if (!r.compiled) assert.ok(r.reason, '失败时必须带人话原因');
});

test('swift 源码实现 overlay 命令协议：点击穿透/不抢焦点/全屏可见/EOF 退出的窗口与线程模型要件', () => {
  const src = readFileSync(SWIFT_SRC_PATH, 'utf8');
  assert.match(src, /case "overlay-show"/, '分发 overlay-show');
  assert.match(src, /case "overlay-hide"/, '分发 overlay-hide');
  assert.match(src, /ignoresMouseEvents = true/, '叠加窗点击穿透');
  assert.match(src, /\.nonactivatingPanel/, '非激活面板（不抢焦点）');
  assert.match(src, /orderFrontRegardless/, '显示不 activate');
  assert.match(src, /\.canJoinAllSpaces, \.fullScreenAuxiliary/, '全屏应用上也显示');
  assert.match(src, /setActivationPolicy\(\.accessory\)/, '无 Dock 图标的附属应用');
  assert.match(src, /DispatchQueue\.main\.async \{ app\.terminate/, 'stdin EOF → 主线程 terminate 退出');
  assert.match(src, /srgbRed: 245 \/ 255, green: 158 \/ 255, blue: 11 \/ 255/, '琥珀色与扩展角标同色系（#f59e0b）');
});

// ---------- 9. 幽魂光标叠加（v0.5.1） ----------

test('overlay：点击前 fire-and-forget overlay-show(kind=click)；元素模式取窗口中心；type 在 30s 内于最近点击位置提示 arrow', async () => {
  const f = fixture();
  const logFile = join(f.dir, 'log');
  const bin = writeFakeHelper(f.dir, FAKE_HELPERS, logFile);
  let fakeNow = 1_000_000;
  const cua = createCua({ audit: f.audit, policy: f.policy, helperPath: bin, execRunner: fakeExec(), clock: () => fakeNow });
  try {
    // 坐标模式：叠加坐标 = 点击坐标
    await cua.click({ x: 100, y: 200, pid: 4321 });
    // 元素模式：叠加坐标 = 目标窗口（bounds 10,20,800,600）中心
    await cua.click({ pid: 4321, role: 'AXButton', title: 'OK' });
    // 30s 内 type：在最近点击位置（元素点击 pressed → 保持窗口中心）提示 arrow
    await cua.type({ text: 'hi', pid: 4321 });
    // 超出 30s 的 key：不提示
    fakeNow += 30_001;
    await cua.key({ key: 'a', modifiers: ['ctrl'], pid: 4321 });

    const overlays = readHelperLog(logFile).filter((r) => r.cmd === 'overlay-show');
    assert.equal(overlays.length, 3, '两次点击各一闪 + 一次输入提示');
    assert.deepEqual(
      overlays.map((o) => ({ x: o.x, y: o.y, kind: o.kind })),
      [
        { x: 100, y: 200, kind: 'click' },
        { x: 410, y: 320, kind: 'click' }, // (10+800/2, 20+600/2)
        { x: 410, y: 320, kind: 'arrow' },
      ],
    );
    const log = readHelperLog(logFile);
    assert.ok(log.some((r) => r.cmd === 'xy-click' && r.x === 100), '真实点击照常发出');
    assert.ok(log.some((r) => r.cmd === 'element-click'), '元素点击照常发出');
    assert.ok(log.some((r) => r.cmd === 'type'), '输入照常发出');
  } finally {
    cua.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('overlay：元素点击坐标兜底（xyFallback 带 at）时，输入提示精化到真实落点', async () => {
  const f = fixture();
  const logFile = join(f.dir, 'log');
  const bin = writeFakeHelper(f.dir, {
    ...FAKE_HELPERS,
    'element-click': { xyFallback: true, bounds: { x: 0, y: 0, w: 10, h: 10 }, at: [123, 456] },
  }, logFile);
  const cua = createCua({ audit: f.audit, policy: f.policy, helperPath: bin, execRunner: fakeExec() });
  try {
    await cua.click({ pid: 4321, role: 'AXButton' });
    await cua.type({ text: 'x', pid: 4321 });
    const overlays = readHelperLog(logFile).filter((r) => r.cmd === 'overlay-show');
    assert.deepEqual(
      overlays.map((o) => ({ x: o.x, y: o.y, kind: o.kind })),
      [{ x: 410, y: 320, kind: 'click' }, { x: 123, y: 456, kind: 'arrow' }], // 第二闪用 at 的真实落点
    );
  } finally {
    cua.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('overlay 失败不影响点击：helper 对 overlay-show 应答 ok:false，点击/输入仍照常发出', async () => {
  const f = fixture();
  const logFile = join(f.dir, 'log');
  const bin = writeFakeHelper(f.dir, {
    ...FAKE_HELPERS,
    'overlay-show': { __err: 'no window server', code: 'overlay-failed' },
  }, logFile);
  const cua = createCua({ audit: f.audit, policy: f.policy, helperPath: bin, execRunner: fakeExec() });
  try {
    const click = await cua.click({ x: 5, y: 6, pid: 4321 }); // fire-and-forget：拒绝不得冒泡
    assert.equal(click.ok, true);
    const typed = await cua.type({ text: 'hi', pid: 4321 }); // 输入提示失败同样吞掉
    assert.equal(typed.ok, true);
    const log = readHelperLog(logFile);
    assert.ok(log.some((r) => r.cmd === 'overlay-show'), '叠加调用确实发出过');
    assert.ok(log.some((r) => r.cmd === 'xy-click' && r.x === 5), '点击未被叠加失败阻塞');
    assert.ok(log.some((r) => r.cmd === 'type'), '输入未被叠加失败阻塞');
  } finally {
    cua.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('overlay 开关（policy cuaOverlay）：默认开；false 时零调用且 status 如实报告；overlayFlash 关闭时报 OVERLAY_DISABLED', async () => {
  const f = fixture();
  const logFile = join(f.dir, 'log');
  const bin = writeFakeHelper(f.dir, FAKE_HELPERS, logFile);
  const offPolicy = new Policy({ cuaOverlay: false }, {});
  const cua = createCua({ audit: f.audit, policy: offPolicy, helperPath: bin, execRunner: fakeExec() });
  try {
    const st = await cua.status();
    assert.deepEqual(st.overlay, { available: true, enabled: false });
    await cua.click({ x: 1, y: 2, pid: 4321 });
    await cua.click({ pid: 4321, role: 'AXButton' });
    await cua.type({ text: 'hi', pid: 4321 });
    await assert.rejects(cua.overlayFlash({ x: 1, y: 1 }), (err) => err.code === 'OVERLAY_DISABLED');
    assert.equal(readHelperLog(logFile).filter((r) => r.cmd === 'overlay-show').length, 0, '关闭后零叠加调用');

    const cuaOn = createCua({ audit: f.audit, policy: f.policy, helperPath: bin, execRunner: fakeExec() }); // loadPolicy 默认 cuaOverlay=true
    const stOn = await cuaOn.status();
    assert.deepEqual(stOn.overlay, { available: true, enabled: true });
    assert.deepEqual(stOn.screen, { w: 1920, h: 1080 }, 'probe 带主屏尺寸');
    await cuaOn.click({ x: 9, y: 9, pid: 4321 });
    assert.equal(readHelperLog(logFile).filter((r) => r.cmd === 'overlay-show').length, 1, '开启后恢复叠加');
    cuaOn.stop();

    // 无 helper（B/C 层）：overlay.available=false，click 不再发叠加请求
    const cuaB = createCua({ audit: f.audit, policy: f.policy, helperPath: join(f.dir, 'nope'), execRunner: fakeExec({ osaOut: { frontmost: '555\n', __default: '' } }) });
    const stB = await cuaB.status();
    assert.deepEqual(stB.overlay, { available: false, enabled: true });
    await cuaB.click({ pid: 555, role: 'AXButton' }); // B 层 osascript 路径：不抛叠加错
    cuaB.stop();
  } finally {
    cua.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('overlay 不入审计（纯可视化，不是动作）；前证据截图不被叠加污染（取证先于叠加）', async () => {
  const t = tierAFixture();
  try {
    await t.cua.click({ x: 111, y: 222, pid: 4321 });
    await t.cua.type({ text: 'hi', pid: 4321 });
    assert.equal(t.audit.query({ cmd: 'cua_click' }).entries.length, 1);
    assert.equal(t.audit.query({ cmd: 'cua_type' }).entries.length, 1);
    for (const cmd of ['cua_overlay', 'overlay_show', 'overlay']) {
      assert.equal(t.audit.query({ cmd }).total, 0, `${cmd} 不得入账`);
    }
    // 顺序契约：helper 日志里 overlay-show 必须晚于取证截图（截图在前，叠加才不会入镜）
    const log = readHelperLog(t.logFile);
    const overlayIdx = log.findIndex((r) => r.cmd === 'overlay-show');
    const xyIdx = log.findIndex((r) => r.cmd === 'xy-click');
    assert.ok(overlayIdx >= 0 && xyIdx >= 0 && overlayIdx < xyIdx, '叠加在点击注入之前、取证之后');
  } finally {
    t.cua.stop();
    rmSync(t.dir, { recursive: true, force: true });
  }
});
