// test/audit.test.mjs — 审计日志测试（本地留痕 + 查询 + 轮转/过期清理/关闭开关）
//
// 记录点在 connection.cmd() 咽喉（真实 WS + 伪扩展走完整线缆），关闭开关与文件管理
// 直接对 createAudit 实例测。

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionManager } from '../service/connection.mjs';
import { createAgentApi } from '../service/api.mjs';
import { loadPolicy } from '../service/policy.mjs';
import { createAudit, AUDITED_COMMANDS } from '../service/audit.mjs';
import { startMockExtension } from '../service/mock-extension.mjs';

const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const tmpAuditDir = () => mkdtempSync(join(tmpdir(), 'ab-audit-'));

/** 起 service 栈（随机端口 + 默认策略 + 审计目录 = 独立临时目录）。 */
async function startStack(auditOpts = {}) {
  const dir = auditOpts.dir ?? tmpAuditDir();
  const audit = createAudit({ dir, ...auditOpts });
  const manager = new ConnectionManager({ port: 0, audit });
  await manager.start();
  const policy = loadPolicy(null, { audit });
  const api = createAgentApi(() => manager.liveConnections(), { policy });
  const got = once(manager, 'browser');
  const mock = await startMockExtension({ port: manager.port });
  await got;
  return { audit, dir, manager, policy, api, mock };
}

/** 读出 dir 下全部审计条目（文件名+行序 = 时间序）；坏行直接炸（测试要求行行可解析）。 */
function readEntries(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^audit-\d{8}\.jsonl/.test(name)) continue;
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      const s = line.trim();
      if (s) out.push(JSON.parse(s));
    }
  }
  return out;
}

/** 拼接目录下全部审计文本（用于"明文不入档"断言）。 */
function readAllText(dir) {
  return readdirSync(dir).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n');
}

test('副作用命令留痕：字段齐全、每行 JSON 可解析、ts 为 ISO 毫秒', async () => {
  const s = await startStack();
  try {
    const b = s.api.browsers.getDefault();
    const tab = await b.tabs.new({ url: 'https://audit.example/start', background: true });
    await tab.goto('https://audit.example/next');
    await tab.close();
    const entries = readEntries(s.dir); // 内部逐行 JSON.parse
    assert.deepEqual(entries.map((e) => e.cmd), ['tab_create', 'navigate_tab_url', 'tab_close']);
    for (const e of entries) {
      assert.ok(ISO_MS_RE.test(e.ts), `ts 应为 ISO 毫秒串: ${e.ts}`);
      assert.equal(typeof e.cmd, 'string');
      assert.ok(e.paramsLite && typeof e.paramsLite === 'object');
    }
    const create = entries[0];
    assert.equal(create.paramsLite.url, 'https://audit.example/start');
    assert.equal(create.paramsLite.background, true);
    const nav = entries[1];
    assert.equal(nav.tabId, tab.id); // 出站参数里的 tabId 提到条目顶层
    assert.equal(nav.paramsLite.url, 'https://audit.example/next');
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('读命令一概不记（tab_info/screenshot/ax/locator_count/element_screenshot/webmcp_list/open_tabs/history）', async () => {
  const s = await startStack();
  try {
    const b = s.api.browsers.getDefault();
    const tab = await b.tabs.new({});
    await tab.title();                                    // tab_info
    await tab.screenshot();                               // tab_screenshot
    await tab.ax.get();                                   // tab_ax_get_state
    await tab.playwright.css('div').count();              // locator_count
    await tab.playwright.css('#out').screenshot();        // element_screenshot（只读，不记）
    await tab.capabilities.get('webmcp').list();          // webmcp_list_tools
    await b.user.openTabs();                              // browser_open_tabs
    await b.history({});                                  // browser_history
    const entries = readEntries(s.dir);
    assert.deepEqual(entries.map((e) => e.cmd), ['tab_create'], '只应留下 tab_create 一条');
    assert.ok(entries.every((e) => AUDITED_COMMANDS.has(e.cmd)));
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('locator_action 脱敏：fill/press 的 value 记 [redacted] 且 redacted:true；click 无 value 不标记', async () => {
  const s = await startStack();
  try {
    const tab = await s.api.browsers.getDefault().tabs.new({});
    await tab.playwright.css('#pw').fill('hunter2-secret');
    await tab.playwright.getByRole('button', { name: 'Go' }).click();
    const entries = readEntries(s.dir).filter((e) => e.cmd === 'locator_action');
    const fillE = entries.find((e) => e.paramsLite.action === 'fill');
    assert.equal(fillE.paramsLite.value, '[redacted]');
    assert.equal(fillE.redacted, true);
    assert.deepEqual(fillE.paramsLite.selector, { kind: 'css', value: '#pw' }); // selector 摘要
    const clickE = entries.find((e) => e.paramsLite.action === 'click');
    assert.equal('value' in clickE.paramsLite, false);
    assert.equal(clickE.redacted, undefined);
    assert.ok(!readAllText(s.dir).includes('hunter2-secret'), '输入明文不得入档');
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('tab_cdp_call 脱敏：params 只记键名列表（paramKeys），值不入档', async () => {
  const s = await startStack();
  try {
    const tab = await s.api.browsers.getDefault().tabs.new({});
    const cdp = tab.capabilities.get('cdp');
    await cdp.send('Runtime.evaluate', { expression: '1+1', silent: true });
    const e = readEntries(s.dir).find((x) => x.cmd === 'tab_cdp_call');
    assert.ok(e);
    assert.equal(e.tabId, tab.id);
    assert.equal(e.paramsLite.method, 'Runtime.evaluate');
    assert.deepEqual(e.paramsLite.paramKeys, ['expression', 'silent']);
    assert.ok(!JSON.stringify(e).includes('1+1'), 'CDP 参数值不得入档');
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('webmcp_invoke_tool 只记工具名；download_open 只记 downloadId；dialog 的 promptText 脱敏', async () => {
  const s = await startStack();
  try {
    const tab = await s.api.browsers.getDefault().tabs.new({});
    await tab.capabilities.get('webmcp').invoke('get_time', { secretArg: 'x' }); // 只读工具直通
    const conn = s.manager.liveConnections()[0];
    await conn.cmd('tab_handle_js_dialog', { tabId: tab.id, accept: true, promptText: 'sekrit-answer' });
    await conn.cmd('download_open', { downloadId: 42 });
    const entries = readEntries(s.dir);
    const wm = entries.find((e) => e.cmd === 'webmcp_invoke_tool');
    assert.equal(wm.tabId, tab.id);
    assert.equal(wm.paramsLite.name, 'get_time');
    assert.ok(!JSON.stringify(wm).includes('secretArg'), '工具入参不得入档');
    const dlg = entries.find((e) => e.cmd === 'tab_handle_js_dialog');
    assert.deepEqual(dlg.paramsLite, { accept: true, promptText: '[redacted]' });
    assert.equal(dlg.redacted, true);
    const dl = entries.find((e) => e.cmd === 'download_open');
    assert.deepEqual(dl.paramsLite, { downloadId: 42 });
    assert.equal('tabId' in dl, false); // download_open 出站参数无 tabId
    assert.ok(!readAllText(s.dir).includes('sekrit-answer'), '对话框文本不得入档');
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('session_finalize：sessionId 记到顶层 session，keepTabIds 只记数量', async () => {
  const s = await startStack();
  try {
    await s.api.browsers.getDefault().tabs.new({});
    await s.manager.liveConnections()[0].cmd('session_finalize', { sessionId: 's-1', keepTabIds: [11, 22] });
    const e = readEntries(s.dir).find((x) => x.cmd === 'session_finalize');
    assert.ok(e);
    assert.equal(e.session, 's-1');
    assert.deepEqual(e.paramsLite, { keepTabCount: 2 });
  } finally { s.mock.close(); await s.manager.stop(); }
});

test('policy.approve 成功留痕 policy_approve（description 摘要）；失败批准不留痕', () => {
  const dir = tmpAuditDir();
  const audit = createAudit({ dir });
  const policy = loadPolicy(null, { audit });
  const v = policy.check({ kind: 'download_open', downloadId: 7 });
  assert.equal(v.needConfirmation, true);
  assert.equal(policy.approve(v.token).ok, true);
  const entries = readEntries(dir);
  const ap = entries.find((e) => e.cmd === 'policy_approve');
  assert.ok(ap);
  assert.ok(ISO_MS_RE.test(ap.ts));
  assert.match(ap.paramsLite.description, /downloadId=7/);
  assert.equal(policy.approve('no-such-token').ok, false);
  assert.equal(readEntries(dir).filter((e) => e.cmd === 'policy_approve').length, 1);
});

test('查询：倒序（最新在前）+ cmd/tabId/since/limit/last 过滤；坏 since 报错', () => {
  const dir = tmpAuditDir();
  const audit = createAudit({ dir });
  audit.record('tab_close', { tabId: 1 });
  audit.record('navigate_tab_reload', { tabId: 1 });
  audit.record('tab_close', { tabId: 2 });

  const all = audit.query({});
  assert.equal(all.total, 3);
  assert.deepEqual(all.entries.map((e) => [e.cmd, e.tabId]), [['tab_close', 2], ['navigate_tab_reload', 1], ['tab_close', 1]]);

  assert.deepEqual(audit.query({ cmd: 'tab_close' }).entries.map((e) => e.tabId), [2, 1]);
  assert.equal(audit.query({ tabId: 1 }).total, 2);
  const lim = audit.query({ cmd: 'tab_close', limit: 1 });
  assert.equal(lim.total, 2, 'total 计全部匹配条数，不受 limit 影响');
  assert.equal(lim.entries.length, 1);
  assert.equal(audit.query({ last: 2 }).entries.length, 2, 'last 等价 limit');
  assert.equal(audit.query({ limit: 9999 }).entries.length, 3, 'limit 超上限钳到 500，不放大');
  assert.equal(audit.query({ since: new Date(Date.now() + 60_000).toISOString() }).total, 0, 'since 未来时刻应全滤掉');
  assert.throws(() => audit.query({ since: 'not-a-date' }), /ISO/);
});

test('轮转：单文件超上限轮转成 .1（保留一代），查询跨文件可用且仍倒序', () => {
  const dir = tmpAuditDir();
  const audit = createAudit({ dir, maxFileBytes: 300 }); // 每行约 80B → 约 4 行一轮转
  for (let i = 0; i < 10; i++) audit.record('tab_close', { tabId: i });
  assert.ok(readdirSync(dir).some((n) => n.endsWith('.jsonl.1')), '应产生轮转档 .1');
  const q = audit.query({});
  assert.ok(q.total >= 2 && q.total < 10, `单代轮转应有截断，实际 total=${q.total}`);
  assert.equal(q.entries[0].tabId, 9, '最新在前');
  const ids = q.entries.map((e) => e.tabId);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), '倒序排列');
});

test('过期清理：mtime 早于保留期的文件删除，新文件保留；只动 audit-* 命名的文件', () => {
  const dir = tmpAuditDir();
  const audit = createAudit({ dir });
  audit.record('tab_close', { tabId: 1 });
  const stale = join(dir, 'audit-20200101.jsonl');
  writeFileSync(stale, '{"ts":"2020-01-01T00:00:00.000Z","cmd":"tab_close","tabId":0,"paramsLite":{}}\n');
  const other = join(dir, 'notes.txt'); // 非审计命名：不许碰
  writeFileSync(other, 'keep me');
  const old = Date.now() / 1000 - 20 * 86_400; // 20 天前（秒，utimes 用秒）
  utimesSync(stale, old, old);
  createAudit({ dir }); // 新实例构造时清理
  assert.equal(existsSync(stale), false, '过期文件应被清理');
  assert.ok(existsSync(other), '非审计文件不得误删');
  assert.ok(readdirSync(dir).some((n) => /^audit-\d{8}\.jsonl$/.test(n)), '当日新文件应保留');
  rmSync(dir, { recursive: true, force: true });
});

test('关闭开关：disabled:true 时不落盘，查询返回 {disabled:true}', () => {
  const dir = tmpAuditDir();
  const audit = createAudit({ dir, disabled: true });
  audit.record('tab_close', { tabId: 1 });
  audit.recordApprove('desc');
  assert.deepEqual(audit.query({}), { disabled: true });
  assert.deepEqual(readdirSync(dir), [], '目录应为空（一条都不落盘）');
});

test('关闭开关：环境变量 CAB_AUDIT=off 生效，默认（无配置）开启', () => {
  process.env.CAB_AUDIT = 'off';
  try {
    assert.equal(createAudit({ dir: tmpAuditDir() }).disabled, true);
  } finally { delete process.env.CAB_AUDIT; }
  assert.equal(createAudit({ dir: tmpAuditDir() }).disabled, false);
});

test('关闭开关：host-config.json 的 auditDisabled:true 生效', () => {
  const cfg = join(tmpdir(), `ab-audit-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cfg, JSON.stringify({ auditDisabled: true }));
  assert.equal(createAudit({ dir: tmpAuditDir(), configPath: cfg }).disabled, true);
  writeFileSync(cfg, JSON.stringify({ servicePort: 7331 })); // 无该字段 → 默认开启
  assert.equal(createAudit({ dir: tmpAuditDir(), configPath: cfg }).disabled, false);
  rmSync(cfg, { force: true });
});

test('审计失败不影响主流程：目录被占成只读文件时 record 静默吞错', () => {
  const blocker = join(tmpdir(), `ab-audit-block-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(blocker, 'not a dir'); // 同名文件挡住 mkdirSync
  const audit = createAudit({ dir: blocker, configPath: join(blocker, 'none.json') });
  assert.doesNotThrow(() => audit.record('tab_close', { tabId: 1 }));
  assert.equal(existsSync(blocker), true); // 原文件原样
  rmSync(blocker, { force: true });
});
