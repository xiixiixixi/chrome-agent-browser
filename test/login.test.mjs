// test/login.test.mjs — ab_login / ab_credentials 单测（真实 WS + 伪扩展 + InMemoryTransport）
//
// 栈同 test/mcp.test.mjs，注入假凭据仓（不碰真钥匙串）。核心断言组：
//   - 防钓鱼第一锁：未存/不匹配 origin → 指引返回 + 零页面动作（无 login_detect/locator_action）
//   - 链路通：伪扩展确实收到带密码的 fill；同时工具响应文本与审计文件里都没有密码
//   - TOTP 分支：本地生成的 6 位码填进探测到的验证码框；探测不到则跳过并注明
//   - 防钓鱼第二锁：提交后跳完全不同的域 → suspicious:true + 审计 login_suspicious

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
import { totpCode } from '../service/totp.mjs';

const SEED_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC 向量种子（Base32）；码值由 totpCode 同源计算

/** 假凭据仓（录音式）。store: Map<origin, cred>；origin 匹配用真实 originsEquivalent 语义由调用方保证（list 精确串）。 */
function fakeCredentials(store = new Map()) {
  return {
    supported: true,
    calls: [],
    async set(o, c) { this.calls.push(['set', o, c]); store.set(o, c); return { ok: true, origin: o }; },
    async get(o) { this.calls.push(['get', o]); return store.has(o) ? { ...store.get(o) } : null; },
    async remove(o) { this.calls.push(['remove', o]); return store.delete(o) ? { ok: true } : { ok: false, reason: 'not-found' }; },
    async list() { this.calls.push(['list']); return [...store.keys()]; },
  };
}

/** 起 MCP 栈 + 伪扩展；opts.handlers 透传给伪扩展，opts.credentials 注入凭据仓。 */
async function startLoginStack({ handlers = {}, credentials = fakeCredentials() } = {}) {
  const auditDir = mkdtempSync(join(tmpdir(), 'ab-login-audit-'));
  const audit = createAudit({ dir: auditDir });
  const manager = new ConnectionManager({ port: 0, audit });
  await manager.start();
  const policy = loadPolicy(null, { audit });
  const api = createAgentApi(() => manager.liveConnections(), { policy });
  const server = buildMcpServer({ api, policy, connections: () => manager.liveConnections(), audit, credentials });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'login-test', version: '0.0.1' });
  await client.connect(clientTransport);
  const got = once(manager, 'browser');
  const mock = await startMockExtension({ port: manager.port, handlers });
  await got;

  async function callJson(name, args = {}) {
    const res = await client.callTool({ name, arguments: args });
    assert.ok(!res.isError, `${name} 不应报错: ${JSON.stringify(res.content)}`);
    return JSON.parse(res.content.find((c) => c.type === 'text').text);
  }
  async function close() {
    mock.close();
    await client.close();
    await server.close();
    await manager.stop();
  }
  /** 读本栈审计目录全部文本（断言明文不入档）。 */
  const auditText = () => readdirSync(auditDir).map((n) => readFileSync(join(auditDir, n), 'utf8')).join('\n');
  const auditEntries = () => auditText().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { audit, auditDir, manager, client, mock, credentials, callJson, close, auditText, auditEntries };
}

const SEL_USER = { kind: 'css', value: '#user' };
const SEL_PASS = { kind: 'css', value: '#pass' };
const SEL_SUBMIT = { kind: 'css', value: 'button[type="submit"]' };
const SEL_OTP = { kind: 'css', value: '#otp' };

test('ab_login 未存 origin：返回设置指引，零页面动作（无 login_detect / locator_action），不写审计', async () => {
  const s = await startLoginStack({
    credentials: fakeCredentials(new Map([['https://github.com', { username: 'u', password: 'p' }]])),
    handlers: { tab_info: () => ({ url: 'https://unknown.example/login', title: 'Sign in' }) },
  });
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    const r = await s.callJson('ab_login', { tabId });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-stored');
    assert.equal(r.origin, 'https://unknown.example/login');
    assert.match(r.guidance, /npm run credential -- set https:\/\/unknown\.example\/login/);
    assert.ok(!s.mock.calls.some((c) => c.method === 'login_detect'), '未存时不该探测表单');
    assert.ok(!s.mock.calls.some((c) => c.method === 'locator_action'), '未存时不该碰页面元素');
    assert.ok(!s.auditEntries().some((e) => e.cmd === 'ab_login'), '未发生动作不该有 ab_login 审计');
  } finally { await s.close(); }
});

test('ab_login 防钓鱼第一锁：页面对话框里的 lookalike 域名与存储 origin 不一致 → 拒绝且零动作', async () => {
  // 存的是 github.com，页面停在 githtb.example（典型钓鱼域名），绝不把 GitHub 凭据填进去
  const s = await startLoginStack({
    credentials: fakeCredentials(new Map([['https://github.com', { username: 'u', password: 'topsecret' }]])),
    handlers: { tab_info: () => ({ url: 'https://githtb.example/login', title: 'GitHub' }) },
  });
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    const r = await s.callJson('ab_login', { tabId });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-stored');
    assert.match(r.guidance, /npm run credential/);
    assert.ok(!s.mock.calls.some((c) => c.method === 'login_detect'));
    assert.ok(!s.mock.calls.some((c) => c.method === 'locator_action'));
  } finally { await s.close(); }
});

test('ab_login 正常路径：扩展确实收到带密码的 fill；响应与审计均无密码；www 前缀容忍', async () => {
  const PW = 's3cret-pw-9527';
  const s = await startLoginStack({
    credentials: fakeCredentials(new Map([['https://www.app.example', { username: 'alice', password: PW }]])),
    handlers: { tab_info: () => ({ url: 'https://app.example/login', title: 'Sign in' }) }, // 页面无 www.
  });
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    const r = await s.callJson('ab_login', { tabId });
    assert.equal(r.ok, true);
    assert.equal(r.origin, 'https://www.app.example', '匹配到已存 origin');
    assert.deepEqual(r.filled, ['username', 'password']);
    assert.equal(r.submitted, true);
    assert.equal(r.suspicious, undefined, '同站跳转（或未跳）不该 suspicious');

    // 链路通：扩展收到了正确值的 fill（用户名 + 密码）
    const fills = s.mock.calls.filter((c) => c.method === 'locator_action' && c.params.action === 'fill');
    assert.equal(fills.length, 2);
    assert.deepEqual(fills[0].params.selector, SEL_USER);
    assert.equal(fills[0].params.value, 'alice');
    assert.deepEqual(fills[1].params.selector, SEL_PASS);
    assert.equal(fills[1].params.value, PW, '密码必须原样直达页面');
    // 提交按钮被点
    assert.ok(s.mock.calls.some((c) => c.method === 'locator_action' && c.params.action === 'click'
      && JSON.stringify(c.params.selector) === JSON.stringify(SEL_SUBMIT)));

    // 响应文本无密码（callJson 已 JSON.parse；再对全文断言）
    const raw = await s.client.callTool({ name: 'ab_login', arguments: { tabId } });
    assert.ok(!JSON.stringify(raw).includes(PW), '工具响应不得含密码');

    // 审计：ab_login 一条（origin+filled 字段名）；全目录文本无密码
    const entries = s.auditEntries().filter((e) => e.cmd === 'ab_login');
    assert.equal(entries.length, 2, '两次调用各一条');
    assert.equal(entries[0].tabId, tabId);
    assert.deepEqual(entries[0].paramsLite.filled, ['username', 'password']);
    assert.equal(entries[0].paramsLite.origin, 'https://www.app.example');
    assert.ok(!s.auditText().includes(PW), '审计不得含密码明文');
  } finally { await s.close(); }
});

test('ab_login TOTP：本地生成 6 位码填进验证码框；种子存了但页面无验证码框 → 跳过并注明', async () => {
  // 分支一：探测到 one-time-code 框
  const s = await startLoginStack({
    credentials: fakeCredentials(new Map([['https://otp.example', { username: 'u', password: 'p', totp: SEED_B32 }]])),
    handlers: {
      tab_info: () => ({ url: 'https://otp.example/login', title: 't' }),
      login_detect: () => ({ found: true, username: SEL_USER, password: SEL_PASS, submit: SEL_SUBMIT, totp: SEL_OTP }),
    },
  });
  try {
    const before = totpCode(SEED_B32);
    const { tabId } = await s.callJson('ab_new_tab', {});
    const r = await s.callJson('ab_login', { tabId });
    const after = totpCode(SEED_B32);
    assert.equal(r.ok, true);
    assert.deepEqual(r.filled, ['username', 'password', 'totp']);
    const otpFill = s.mock.calls.find((c) => c.method === 'locator_action' && c.params.action === 'fill'
      && JSON.stringify(c.params.selector) === JSON.stringify(SEL_OTP));
    assert.ok(otpFill, '验证码框应被 fill');
    assert.ok([before, after].includes(otpFill.params.value), `码值应为当前窗口 TOTP（30s 边界容忍）: ${otpFill.params.value}`);
    assert.match(otpFill.params.value, /^\d{6}$/);
    assert.ok(!s.auditText().includes(SEED_B32), 'TOTP 种子不得入审计');
  } finally { await s.close(); }

  // 分支二：种子存了、页面没有验证码框 → 不填、注明跳过
  const s2 = await startLoginStack({
    credentials: fakeCredentials(new Map([['https://otp.example', { username: 'u', password: 'p', totp: SEED_B32 }]])),
    handlers: {
      tab_info: () => ({ url: 'https://otp.example/login', title: 't' }),
      login_detect: () => ({ found: true, username: SEL_USER, password: SEL_PASS, submit: null, totp: null }), // 无提交按钮 → 也免 3s 等待
    },
  });
  try {
    const { tabId } = await s2.callJson('ab_new_tab', {});
    const r = await s2.callJson('ab_login', { tabId });
    assert.equal(r.ok, true);
    assert.deepEqual(r.filled, ['username', 'password']);
    assert.equal(r.submitted, false);
    assert.equal(r.totp, 'totp-seed-stored-but-no-field');
    assert.equal(s2.mock.calls.filter((c) => c.method === 'locator_action' && c.params.action === 'click').length, 0);
  } finally { await s2.close(); }
});

test('ab_login 防钓鱼第二锁：提交后 3 秒内跳到完全不同的域 → suspicious:true + 审计 login_suspicious', async () => {
  let url = 'https://bank.example/login';
  const s = await startLoginStack({
    credentials: fakeCredentials(new Map([['https://bank.example', { username: 'u', password: 'p' }]])),
    handlers: {
      tab_info: () => ({ url, title: 't' }),
      locator_action: (p) => {
        if (p.action === 'click') url = 'https://evil.example/phish?tok=do-not-log'; // 提交后页面被劫走
        return { ok: true, value: null };
      },
    },
  });
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    const r = await s.callJson('ab_login', { tabId });
    assert.equal(r.ok, true, '不拦截：如实报告供人工复核');
    assert.equal(r.suspicious, true);
    assert.equal(r.landedAt, 'https://evil.example', '只记落点 origin，不记带查询串的完整 URL');
    const sus = s.auditEntries().filter((e) => e.cmd === 'login_suspicious');
    assert.equal(sus.length, 1);
    assert.deepEqual(sus[0].paramsLite, { from: 'https://bank.example', to: 'https://evil.example' });
    assert.ok(s.auditEntries().some((e) => e.cmd === 'ab_login'), '主事件照记');
    assert.ok(!s.auditText().includes('do-not-log'), '查询串不得入审计');
  } finally { await s.close(); }
});

test('ab_login 页面没有登录表单（无密码框）→ no-login-form；凭据仓竞态删除 → not-stored', async () => {
  const s = await startLoginStack({
    credentials: fakeCredentials(new Map([['https://x.example', { username: 'u', password: 'p' }]])),
    handlers: {
      tab_info: () => ({ url: 'https://x.example/home', title: 't' }),
      login_detect: () => ({ found: false, reason: 'no visible password input' }),
    },
  });
  try {
    const { tabId } = await s.callJson('ab_new_tab', {});
    const r = await s.callJson('ab_login', { tabId });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-login-form');
    assert.match(r.detail, /no visible password input/);
    assert.equal(s.mock.calls.filter((c) => c.method === 'locator_action').length, 0, '不该有填写动作');
  } finally { await s.close(); }

  // 竞态：list 之后、get 之前条目被删 → 按未存处理给指引
  const raceCred = {
    supported: true,
    async list() { return ['https://race.example']; },
    async get() { return null; },
    async set() { return { ok: true }; },
    async remove() { return { ok: true }; },
  };
  const s2 = await startLoginStack({
    credentials: raceCred,
    handlers: { tab_info: () => ({ url: 'https://race.example/login', title: 't' }) },
  });
  try {
    const { tabId } = await s2.callJson('ab_new_tab', {});
    const r = await s2.callJson('ab_login', { tabId });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-stored');
    assert.match(r.guidance, /npm run credential/);
  } finally { await s2.close(); }
});

test('ab_credentials：列出已存 origin 清单；凭据仓未装配/非 macOS 时诚实说明', async () => {
  const s = await startLoginStack({
    credentials: fakeCredentials(new Map([
      ['https://a.example', { username: 'u', password: 'p' }],
      ['http://127.0.0.1:9000', { username: 'u', password: 'p' }],
    ])),
  });
  try {
    const r = await s.callJson('ab_credentials', {});
    assert.deepEqual(r.origins, ['https://a.example', 'http://127.0.0.1:9000']);
    assert.ok(!JSON.stringify(r).includes('password'), '清单绝不包含秘密字段');
  } finally { await s.close(); }

  // 未装配凭据仓（buildMcpServer 不传 credentials）：ab_login/ab_credentials 都给明确说明
  const auditDir = mkdtempSync(join(tmpdir(), 'ab-login-audit-'));
  const manager = new ConnectionManager({ port: 0, audit: createAudit({ dir: auditDir }) });
  await manager.start();
  const policy = loadPolicy(null);
  const api = createAgentApi(() => manager.liveConnections(), { policy });
  const server = buildMcpServer({ api, policy, connections: () => manager.liveConnections() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  try {
    const res = await client.callTool({ name: 'ab_login', arguments: { tabId: 1 } });
    const parsed = JSON.parse(res.content.find((c) => c.type === 'text').text);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'unsupported-platform');
    assert.match(parsed.guidance, /仅支持 macOS/);
    const res2 = await client.callTool({ name: 'ab_credentials', arguments: {} });
    const parsed2 = JSON.parse(res2.content.find((c) => c.type === 'text').text);
    assert.deepEqual(parsed2.origins, []);
    assert.match(parsed2.reason, /仅支持 macOS/);
  } finally { await client.close(); await server.close(); await manager.stop(); }
});
