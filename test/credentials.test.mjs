// test/credentials.test.mjs — 凭据仓单测（假执行器）+ CLI 命令拼装 + origin 语义
//
// 钥匙串真机路径由 E2E 覆盖；这里用可注入的假 exec 断言 security 命令拼装、
// JSON 解析、错误分支，以及 dump-keychain 文本解析和 www/端口/协议匹配语义。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCredentials, parseOrigins, parseOrigin, originsEquivalent, sameSite, KEYCHAIN_SERVICE,
} from '../service/credentials.mjs';
import { runCli } from '../credential.mjs';

/** 假执行器：记录调用，按脚本应答。script: [{args 前缀或精确数组, code, stdout, stderr}] */
function fakeExec(script = []) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push({ cmd, args });
    for (const s of script) {
      const m = s.match ? s.match : (a) => JSON.stringify(a) === JSON.stringify(s.args);
      if (m(args)) return { code: s.code ?? 0, stdout: s.stdout ?? '', stderr: s.stderr ?? '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` };
  };
  return { exec, calls };
}

const NOT_FOUND_ERR = {
  match: (a) => a[0] === 'find-generic-password' || a[0] === 'delete-generic-password',
  code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
};

test('set：拼装 add-generic-password -U（服务名/账号/JSON 值），totp 省略时不入 JSON', async () => {
  const f = fakeExec([{ match: (a) => a[0] === 'add-generic-password', code: 0 }]);
  const c = createCredentials({ exec: f.exec });
  await c.set('https://github.com', { username: 'alice', password: 'pw-1' });
  await c.set('http://127.0.0.1:8080', { username: 'bob', password: 'pw-2', totp: ' GEZDGNBV ' });
  assert.equal(f.calls.length, 2);
  const [cmd1, args1] = [f.calls[0].cmd, f.calls[0].args];
  assert.equal(cmd1, 'security');
  assert.deepEqual(args1.slice(0, 4), ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE]);
  assert.equal(args1[4], '-a');
  assert.equal(args1[5], 'https://github.com');
  assert.equal(args1[6], '-w');
  assert.deepEqual(JSON.parse(args1[7]), { username: 'alice', password: 'pw-1' });
  const second = JSON.parse(f.calls[1].args[7]);
  assert.deepEqual(second, { username: 'bob', password: 'pw-2', totp: 'GEZDGNBV' }, 'totp 去空格后入库');
});

test('set 校验：空用户名/空密码/坏 origin/坏 totp 拒绝且零命令出站', async () => {
  const f = fakeExec([]);
  const c = createCredentials({ exec: f.exec });
  await assert.rejects(c.set('https://ok.example', { username: '', password: 'p' }), /username/);
  await assert.rejects(c.set('https://ok.example', { username: 'u', password: '' }), /password/);
  await assert.rejects(c.set('not a url', { username: 'u', password: 'p' }), /origin/);
  await assert.rejects(c.set('ftp://x.example', { username: 'u', password: 'p' }), /origin/);
  await assert.rejects(c.set('https://ok.example', { username: 'u', password: 'p', totp: '  ' }), /totp/);
  assert.equal(f.calls.length, 0, '校验失败不应碰钥匙串');
});

test('get：find -s -a -w 拼装；JSON 解析出凭据；未存返回 null', async () => {
  const f = fakeExec([
    { match: (a) => a[0] === 'find-generic-password' && a.includes('https://a.example'), stdout: '{"username":"u1","password":"p1"}\n' },
    { match: (a) => a[0] === 'find-generic-password' && a.includes('https://b.example'), stdout: '{"username":"u2","password":"p2","totp":"MFRG"}\n' },
    NOT_FOUND_ERR,
  ]);
  const c = createCredentials({ exec: f.exec });
  assert.deepEqual(await c.get('https://a.example'), { username: 'u1', password: 'p1' });
  assert.deepEqual(await c.get('https://b.example'), { username: 'u2', password: 'p2', totp: 'MFRG' });
  assert.equal(await c.get('https://none.example'), null);
  assert.deepEqual(f.calls[0].args, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'https://a.example', '-w']);
});

test('get 错误分支：坏 JSON / 缺字段 抛清晰错误；security 其他失败原样抛', async () => {
  const has = (a, s) => a.some((x) => String(x).includes(s));
  const f = fakeExec([
    { match: (a) => a[0] === 'find-generic-password' && has(a, 'https://bad1.example'), stdout: 'not-json' },
    { match: (a) => a[0] === 'find-generic-password' && has(a, 'https://bad2.example'), stdout: '{"username":"u"}' },
    { match: (a) => a[0] === 'find-generic-password' && has(a, 'https://bad3.example'), code: 45, stderr: 'keychain locked' },
  ]);
  const c = createCredentials({ exec: f.exec });
  await assert.rejects(c.get('https://bad1.example'), /JSON/);
  await assert.rejects(c.get('https://bad2.example'), /username\/password/);
  await assert.rejects(c.get('https://bad3.example'), /keychain locked/);
});

test('remove：delete 拼装；成功 {ok:true}；未存 {ok:false,reason:not-found}', async () => {
  const f = fakeExec([
    { match: (a) => a[0] === 'delete-generic-password' && a.includes('https://a.example'), code: 0 },
    NOT_FOUND_ERR,
  ]);
  const c = createCredentials({ exec: f.exec });
  assert.deepEqual(await c.remove('https://a.example'), { ok: true });
  assert.deepEqual(f.calls[0].args, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'https://a.example']);
  assert.deepEqual(await c.remove('https://none.example'), { ok: false, reason: 'not-found' });
});

test('list：解析 dump-keychain 文本（命名键与十六进制键双格式、去重、忽略非本服务条目）', async () => {
  const dump = [
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'class: "genp"',
    'attributes:',
    '    0x00000007 <blob>="chrome-agent-browser"',
    '    "acct"<blob>="https://a.example"',
    '    "svce"<blob>="chrome-agent-browser"',
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'class: "genp"',
    'attributes:',
    '    0x00000007 <blob>="chrome-agent-browser"',
    '    0x00000008 <blob>=<NULL>',
    '    "acct"<blob>="http://127.0.0.1:9000"',
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'class: "genp"',
    'attributes:',
    '    "acct"<blob>="https://other-service.example"',
    '    "svce"<blob>="something-else"',
    'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
    'class: "inet"',
    'attributes:',
    '    "svce"<blob>="chrome-agent-browser"',
    '    "acct"<blob>="https://not-a-password-item.example"',
  ].join('\n');
  assert.deepEqual(parseOrigins(dump), ['http://127.0.0.1:9000', 'https://a.example']);

  const f = fakeExec([{ match: (a) => a[0] === 'dump-keychain', stdout: dump }]);
  assert.deepEqual(await createCredentials({ exec: f.exec }).list(), ['http://127.0.0.1:9000', 'https://a.example']);
  assert.deepEqual(f.calls[0].args, ['dump-keychain']);
  const f2 = fakeExec([{ match: (a) => a[0] === 'dump-keychain', code: 1, stderr: 'boom' }]);
  assert.deepEqual(await createCredentials({ exec: f2.exec }).list(), [], 'dump 失败按空清单');
});

test('非 macOS：supported=false；set/get/remove 抛"仅支持 macOS"；list 返回 []', async () => {
  const f = fakeExec([]);
  const c = createCredentials({ exec: f.exec, platform: 'linux' });
  assert.equal(c.supported, false);
  await assert.rejects(c.set('https://a.example', { username: 'u', password: 'p' }), /仅支持 macOS/);
  await assert.rejects(c.get('https://a.example'), /仅支持 macOS/);
  await assert.rejects(c.remove('https://a.example'), /仅支持 macOS/);
  assert.deepEqual(await c.list(), []);
  assert.equal(f.calls.length, 0);
});

test('origin 语义：www 容忍、协议/端口敏感（防钓鱼第一锁基准）', () => {
  assert.equal(originsEquivalent('https://github.com', 'https://www.github.com/login'), true);
  assert.equal(originsEquivalent('https://www.example.com', 'https://example.com/'), true);
  assert.equal(originsEquivalent('https://example.com', 'http://example.com'), false, '协议不同不算同一站');
  assert.equal(originsEquivalent('http://127.0.0.1:7331', 'http://127.0.0.1:7332'), false, '端口不同不算同一站');
  assert.equal(originsEquivalent('https://github.com', 'https://githtb.com'), false, '近似域名不算');
  assert.equal(originsEquivalent('https://evil.example', 'https://evil.example.attacker.com'), false, '后缀拼接近似不算');
  assert.equal(originsEquivalent('https://a.example', 'not-a-url'), false);
  assert.equal(parseOrigin('chrome://settings'), null);
  assert.equal(parseOrigin('about:blank'), null);
  assert.equal(parseOrigin('https://EXAMPLE.com/X').key, 'https://example.com');
});

test('sameSite（防钓鱼第二锁基准）：子域/https 升级同站；完全不同域不同站', () => {
  assert.equal(sameSite('https://bank.example/login', 'https://bank.example/home'), true);
  assert.equal(sameSite('https://bank.example/login', 'https://www.bank.example/home'), true);
  assert.equal(sameSite('https://accounts.example.com/login', 'https://example.com/'), true, '子域跳主域');
  assert.equal(sameSite('http://bank.example/login', 'https://bank.example/auth'), true, 'https 升级不算跳域');
  assert.equal(sameSite('https://bank.example/login', 'https://evil.example/phish'), false);
  assert.equal(sameSite('https://bank.example/login', 'about:blank'), true, '解析不了不定罪');
});

// ---- CLI（credential.mjs）命令拼装与错误处理（注入 io + 录音式凭据仓） ----

function recordingCredentials(overrides = {}) {
  const calls = [];
  return {
    supported: true,
    calls,
    async set(origin, cred) { calls.push(['set', origin, cred]); return { ok: true, origin }; },
    async list() { calls.push(['list']); return ['https://a.example', 'https://b.example']; },
    async remove(origin) { calls.push(['remove', origin]); return overrides.notFound ? { ok: false, reason: 'not-found' } : { ok: true }; },
  };
}

test('CLI set：问答顺序/静默标记正确，trim 后入库；空用户名/密码拦截', async () => {
  const asked = [];
  const answers = ['alice', 'pw-9', ''];
  const io = {
    print: () => {},
    ask: async (prompt, { silent }) => { asked.push([prompt, silent]); return answers[asked.length - 1] ?? ''; },
  };
  const cred = recordingCredentials();
  const code = await runCli(['set', 'https://x.example'], { credentials: cred, io });
  assert.equal(code, 0);
  assert.equal(cred.calls.length, 1);
  assert.deepEqual(cred.calls[0], ['set', 'https://x.example', { username: 'alice', password: 'pw-9' }]);
  assert.deepEqual(asked.map(([, s]) => s), [false, true, true], '用户名回显，密码与种子静默');

  const io2 = { print: () => {}, ask: async () => '' };
  assert.equal(await runCli(['set', 'https://x.example'], { credentials: recordingCredentials(), io: io2 }), 1, '空用户名退出 1');
  const io3 = {
    print: () => {},
    ask: async (p) => (p.includes('用户名') ? 'u' : ''),
  };
  assert.equal(await runCli(['set', 'https://x.example'], { credentials: recordingCredentials(), io: io3 }), 1, '空密码退出 1');
  assert.equal(await runCli(['set'], { credentials: recordingCredentials(), io: { print: () => {}, ask: async () => '' } }), 1, '缺 origin 退出 1');
});

test('CLI set：带 TOTP 种子的拼装；set 抛错时退出 1', async () => {
  const cred = recordingCredentials();
  const io = {
    print: () => {},
    ask: async (p) => (p.includes('用户名') ? 'bob' : p.includes('密码') ? 'pw' : ' GEZDGNBV '),
  };
  assert.equal(await runCli(['set', 'http://127.0.0.1:9000'], { credentials: cred, io }), 0);
  assert.deepEqual(cred.calls[0][2], { username: 'bob', password: 'pw', totp: 'GEZDGNBV' });

  const bad = { ...recordingCredentials(), set: async () => { throw new Error('钥匙串写入失败: boom'); } };
  const printed = [];
  assert.equal(await runCli(['set', 'https://x.example'], { credentials: bad, io: { print: (s) => printed.push(s), ask: async (p) => (p.includes('用户名') ? 'u' : 'p') } }), 1);
  assert.ok(printed.some((s) => /boom/.test(s)));
});

test('CLI list / remove / help / 空参 / 非 macOS', async () => {
  const printed = [];
  const io = { print: (s) => printed.push(s), ask: async () => { throw new Error('不应提问'); } };
  const cred = recordingCredentials();
  assert.equal(await runCli(['list'], { credentials: cred, io }), 0);
  assert.ok(printed.some((s) => /https:\/\/a\.example/.test(s)));
  assert.equal(cred.calls[0][0], 'list');

  assert.equal(await runCli(['remove', 'https://a.example'], { credentials: cred, io }), 0);
  assert.deepEqual(cred.calls[1], ['remove', 'https://a.example']);

  const notFoundCred = recordingCredentials({ notFound: true });
  assert.equal(await runCli(['remove', 'https://gone.example'], { credentials: notFoundCred, io }), 1);

  assert.equal(await runCli([], { credentials: cred, io }), 1, '空参打印用法退出 1');
  assert.ok(printed.some((s) => /用法/.test(s)));
  assert.equal(await runCli(['--help'], { credentials: cred, io }), 0);

  const linux = { supported: false };
  const p2 = [];
  assert.equal(await runCli(['list'], { credentials: linux, io: { print: (s) => p2.push(s) } }), 1);
  assert.ok(p2.some((s) => /仅支持 macOS/.test(s)));
});
