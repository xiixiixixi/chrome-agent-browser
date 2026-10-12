// test/host-and-installer.test.mjs — host 帧编解码 / 安装器沙箱安装 / 发现诊断 的测试
//
// 安全约定：所有涉及「用户目录」的安装测试一律走 --home <临时目录>；
// 只有仓库内 host/（shim、host-config.json）会被真实写入，这是安装器的既定行为。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { encodeNativeFrame, NativeFrameReader, loadHostConfig, HostConfigError } from '../host/host.mjs';
import {
  computeExtensionId,
  parseArgs,
  manifestPathsForFamily,
  runInstall,
  NATIVE_HOST_NAME,
  REPO_ROOT,
} from '../installer/install.mjs';
import { resolveProfileDirectory, checkNativeHostManifest } from '../installer/discovery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_MJS = path.join(HERE, '..', 'host', 'host.mjs');
const INSTALL_MJS = path.join(HERE, '..', 'installer', 'install.mjs');

// 测试用固定 32 字符 a-p 扩展 ID（符合 Chrome ID 形状）。
const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

function tmpHome(prefix = 'ab-install-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 跑一个 node 脚本（CLI 级测试），返回 {code, stdout, stderr}。 */
function runNode(scriptPath, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [scriptPath, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function waitUntil(predicate, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      let satisfied;
      try {
        satisfied = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (satisfied) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('waitUntil timed out'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// ===========================================================================
// host：帧编解码与配置
// ===========================================================================

test('host: 原生帧编码为 4 字节小端长度 + 载荷，roundtrip 一致', () => {
  const json = JSON.stringify({ jsonrpc: '2.0', method: 'ext/hello', params: { instanceId: 'i-1' } });
  const frame = encodeNativeFrame(json);
  const payload = Buffer.from(json, 'utf8');

  assert.equal(frame.length, 4 + payload.length);
  // Chrome Native Messaging 是小端 uint32：小端读法必须等于载荷长度。
  assert.equal(frame.readUInt32LE(0), payload.length);
  // 大端读法会得到天文数字——反向佐证小端。
  assert.notEqual(frame.readUInt32BE(0), payload.length);
  assert.equal(frame.subarray(4).toString('utf8'), json);

  const reader = new NativeFrameReader();
  const { frames } = reader.push(frame);
  assert.equal(frames.length, 1);
  assert.deepStrictEqual(JSON.parse(frames[0].toString('utf8')), { jsonrpc: '2.0', method: 'ext/hello', params: { instanceId: 'i-1' } });
});

test('host: 帧读取器支持任意切片分块与一 chunk 多帧', () => {
  const reader = new NativeFrameReader();
  const frameA = encodeNativeFrame('{"a":1}');
  const frameB = encodeNativeFrame('{"b":2}');

  // 一 chunk 两帧
  let out = reader.push(Buffer.concat([frameA, frameB]));
  assert.deepEqual(out.frames.map((f) => f.toString('utf8')), ['{"a":1}', '{"b":2}']);

  // 逐 3 字节喂入一帧
  const reader2 = new NativeFrameReader();
  const single = encodeNativeFrame('{"chunked":true}');
  const collected = [];
  for (let i = 0; i < single.length; i += 3) {
    collected.push(...reader2.push(single.subarray(i, i + 3)).frames);
  }
  assert.equal(collected.length, 1);
  assert.equal(collected[0].toString('utf8'), '{"chunked":true}');
});

test('host: 超长帧被丢弃并上报 problem，进程不崩（读取器层面）', () => {
  const reader = new NativeFrameReader();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(2 * 1024 * 1024, 0);
  const { frames, problems } = reader.push(header);
  assert.equal(frames.length, 0);
  assert.equal(problems.length, 1);
  // 编码侧同样拒绝 >1MB 的帧
  assert.throws(() => encodeNativeFrame('x'.repeat(1024 * 1024 + 1)), /too large/);
});

test('host: 配置缺失/非法时报 HostConfigError（main 会转 exit 2）', () => {
  assert.throws(() => loadHostConfig({ AGENT_BROWSER_CONFIG: '/nonexistent/ab.json' }), HostConfigError);
  const tmp = tmpHome('ab-cfg-');
  const cfgPath = path.join(tmp, 'host-config.json');
  writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 2, serviceHost: '127.0.0.1', servicePort: 1 }));
  assert.throws(() => loadHostConfig({ AGENT_BROWSER_CONFIG: cfgPath }), /schemaVersion/);
  writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, serviceHost: '127.0.0.1', servicePort: 'x' }));
  assert.throws(() => loadHostConfig({ AGENT_BROWSER_CONFIG: cfgPath }), /servicePort/);
  writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, serviceHost: '127.0.0.1', servicePort: 7331 }));
  assert.deepEqual(loadHostConfig({ AGENT_BROWSER_CONFIG: cfgPath }), {
    serviceHost: '127.0.0.1',
    servicePort: 7331,
    configPath: cfgPath,
  });
  rmSync(tmp, { recursive: true, force: true });
});

test('host: 无配置启动 → stderr 日志 + exit 2', { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, [HOST_MJS], {
    env: { ...process.env, AGENT_BROWSER_CONFIG: '/nonexistent/ab.json' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 2);
  assert.match(stderr, /host config not found/);
});

// ===========================================================================
// host：端到端中继（真 ws 服务 + 子进程）
// ===========================================================================

test('host: 端到端——hello 握手 / 双向转发 / 坏帧丢弃 / 断线 exit 0', { timeout: 30_000 }, async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const port = wss.address().port;

  const tmp = tmpHome('ab-host-');
  const cfgPath = path.join(tmp, 'host-config.json');
  writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, serviceHost: '127.0.0.1', servicePort: port }));

  const child = spawn(process.execPath, [HOST_MJS], {
    env: { ...process.env, AGENT_BROWSER_CONFIG: cfgPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  // stdout 帧累积解析（复用被测代码的读取器）
  const stdoutFrames = [];
  const stdoutReader = new NativeFrameReader();
  child.stdout.on('data', (chunk) => {
    for (const frame of stdoutReader.push(chunk).frames) {
      stdoutFrames.push(JSON.parse(frame.toString('utf8')));
    }
  });

  try {
    // service 侧：等连接，收集消息
    const serverMessages = [];
    const ws = await new Promise((resolve) => wss.once('connection', (socket) => resolve(socket)));
    ws.on('message', (data) => serverMessages.push(JSON.parse(data.toString('utf8'))));

    // 1) 连上即发 host/hello
    await waitUntil(() => serverMessages.some((m) => m.method === 'host/hello'));
    const hello = serverMessages.find((m) => m.method === 'host/hello');
    assert.equal(hello.jsonrpc, '2.0');
    assert.equal(hello.id, 1);
    assert.equal(hello.params.protocol, 1);
    assert.equal(hello.params.pid, child.pid);
    assert.equal(typeof hello.params.hostVersion, 'string');

    // 2) service → 扩展：JSON-RPC 响应应出现在 stdout（且 stdout 只可能是帧）
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    await waitUntil(() => stdoutFrames.some((m) => m.id === 1 && m.result?.ok === true));

    // 3) 扩展 → service：合法帧转发；非法 JSON 帧丢弃不崩
    child.stdin.write(encodeNativeFrame(JSON.stringify({ jsonrpc: '2.0', method: 'ext/hello', params: { instanceId: 'inst-1' } })));
    child.stdin.write(encodeNativeFrame('{"jsonrpc":"2.0" BROKEN'));
    child.stdin.write(encodeNativeFrame(JSON.stringify({ jsonrpc: '2.0', method: 'ext/hello', params: { instanceId: 'inst-2' } })));
    await waitUntil(() => serverMessages.filter((m) => m.method === 'ext/hello').length === 2);
    assert.ok(!serverMessages.some((m) => m === null || m === undefined));
    assert.match(stderr, /dropping unparseable native frame/);

    // 4) service 断开 → 宿主优雅退出，exit 0
    ws.close(1000);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0);
  } finally {
    // 无论成败都清理，避免残留句柄挂死测试进程
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => wss.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// installer：纯函数
// ===========================================================================

test('installer: computeExtensionId 已知向量 + 稳定性 + 路径必须存在', () => {
  // 已知向量（SHA-256("/tmp/chrome-agent-browser-known-vector") 前 16 字节 hex → a-p 映射）
  assert.equal(computeExtensionId('/tmp/chrome-agent-browser-known-vector', { mustExist: false }), 'bieljbijnbdlnnbnbnhdkaahpbfjcopk');
  // 稳定性：多次计算一致
  const once = computeExtensionId(REPO_ROOT, { mustExist: false });
  const twice = computeExtensionId(REPO_ROOT, { mustExist: false });
  assert.equal(once, twice);
  assert.match(once, /^[a-p]{32}$/);
  // 路径必须真实存在（默认 mustExist）
  assert.throws(() => computeExtensionId('/nonexistent/extension-dir'), /does not exist/);
});

test('installer: parseArgs 默认值与校验', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.browser, 'chrome');
  assert.equal(defaults.port, 7331);
  assert.equal(defaults.dryRun, false);

  const full = parseArgs(['--browser', 'all', '--extension-id', ID_A, '--extension-id', ID_B, '--dry-run', '--home', '/tmp/x', '--port', '8000']);
  assert.equal(full.browser, 'all');
  assert.deepEqual(full.extensionIds, [ID_A, ID_B]);
  assert.equal(full.port, 8000);

  assert.throws(() => parseArgs(['--browser', 'netscape']));
  assert.throws(() => parseArgs(['--extension-id', 'not-an-id']));
  assert.throws(() => parseArgs(['--port', '99999']));
  assert.throws(() => parseArgs(['--wat']));
});

test('installer: Linux 清单路径尊重 XDG_CONFIG_HOME / CHROME_CONFIG_HOME（逻辑参考 installManifest.mjs）', () => {
  const home = '/home/u';
  // 无任何 XDG 环境 → ~/.config
  const plain = manifestPathsForFamily('chrome', { home, env: {}, platform: 'linux' });
  assert.equal(plain[0], path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`));
  assert.equal(plain.length, 5); // google-chrome/chromium/beta/unstable/for-testing

  // XDG_CONFIG_HOME 影响所有家族
  const xdg = manifestPathsForFamily('edge', { home, env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux' });
  assert.equal(xdg[0], path.join('/xdg', 'microsoft-edge', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`));

  // CHROME_CONFIG_HOME 只影响 chrome 家族
  const chromeCfg = manifestPathsForFamily('chrome', { home, env: { CHROME_CONFIG_HOME: '/chrome-cfg' }, platform: 'linux' });
  assert.ok(chromeCfg.every((p) => p.startsWith('/chrome-cfg/')));
  const edgeCfg = manifestPathsForFamily('edge', { home, env: { CHROME_CONFIG_HOME: '/chrome-cfg' }, platform: 'linux' });
  assert.ok(edgeCfg.every((p) => p.startsWith(path.join(home, '.config'))));
});

test('installer: Windows 清单走统一缓存目录 + 注册表命令（非 Windows 只打印）', async () => {
  const winPath = manifestPathsForFamily('chrome', { home: 'C:\\Users\\u', env: {}, platform: 'win32' });
  assert.equal(winPath.length, 1);
  assert.equal(
    winPath[0],
    ['C:', 'Users', 'u', 'AppData', 'Local', 'ChromeAgentBrowser', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`].join('\\'),
  );

  // dry-run + 模拟 win32：不执行 reg，但记录 registry-add 动作
  const tmp = tmpHome('ab-win-');
  const result = await runInstall(parseArgs(['--browser', 'chrome', '--extension-id', ID_A, '--home', tmp, '--dry-run']), {
    platform: 'win32',
    env: {},
  });
  assert.ok(result.actions.some((a) => a.action === 'registry-add' && a.path === 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.chromeagentbrowser.host'));
  assert.ok(!existsSync(path.join(tmp, 'AppData')));
  rmSync(tmp, { recursive: true, force: true });

  // 本机非 Windows：输出 registry-print 动作供用户复制
  const tmp2 = tmpHome('ab-win2-');
  const result2 = await runInstall(parseArgs(['--browser', 'chrome', '--extension-id', ID_A, '--home', tmp2, '--dry-run']), { env: {} });
  const printed = result2.actions.filter((a) => a.action === 'registry-print');
  assert.equal(printed.length, 1);
  assert.match(printed[0].command, /^reg add "?HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.chromeagentbrowser\.host"? \/ve \/t REG_SZ \/d .*com\.chromeagentbrowser\.host\.json \/f$/);
  rmSync(tmp2, { recursive: true, force: true });
});

// ===========================================================================
// installer：CLI 沙箱安装（--home <tmpdir>）
// ===========================================================================

test('installer: 沙箱安装 chrome 家族 → 清单/shim/host-config 全部就位', { timeout: 30_000 }, async () => {
  const home = tmpHome();
  const { code, stdout, stderr } = await runNode(INSTALL_MJS, ['--home', home, '--browser', 'chrome', '--extension-id', ID_A, '--port', '7456']);
  assert.equal(code, 0, `installer failed: ${stderr}\n${stdout}`);

  // 清单：路径 / 字段 / allowed_origins
  const manifestPaths = manifestPathsForFamily('chrome', { home });
  const manifestPath = manifestPaths[0];
  assert.ok(existsSync(manifestPath), `manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, 'com.chromeagentbrowser.host');
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.description, 'Chrome Agent Browser native host');
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID_A}/`]);

  // shim：清单 path 指向它，且带可执行位
  const shimPath = manifest.path;
  assert.equal(shimPath, path.join(REPO_ROOT, 'host', 'chrome-agent-browser-host'));
  assert.ok(existsSync(shimPath));
  assert.notEqual(statSync(shimPath).mode & 0o111, 0, 'shim must be executable');
  assert.match(readFileSync(shimPath, 'utf8'), /^#!\/bin\/sh\nexec node "/);
  assert.ok(readFileSync(shimPath, 'utf8').includes(path.join(REPO_ROOT, 'host', 'host.mjs')));

  // host-config：写进仓库 host/
  const hostConfig = JSON.parse(readFileSync(path.join(REPO_ROOT, 'host', 'host-config.json'), 'utf8'));
  assert.equal(hostConfig.schemaVersion, 1);
  assert.equal(hostConfig.serviceHost, '127.0.0.1');
  assert.equal(hostConfig.servicePort, 7456);

  rmSync(home, { recursive: true, force: true });
});

test('installer: 重复安装生成 .bak；--dry-run 不落盘', { timeout: 30_000 }, async () => {
  const home = tmpHome();
  const manifestPath = manifestPathsForFamily('chrome', { home })[0];

  const first = await runNode(INSTALL_MJS, ['--home', home, '--browser', 'chrome', '--extension-id', ID_A]);
  assert.equal(first.code, 0);
  assert.ok(!existsSync(`${manifestPath}.bak`), '首次安装不应有 .bak');

  const second = await runNode(INSTALL_MJS, ['--home', home, '--browser', 'chrome', '--extension-id', ID_B]);
  assert.equal(second.code, 0);
  assert.ok(existsSync(`${manifestPath}.bak`), '重复安装应生成 .bak');
  assert.deepEqual(JSON.parse(readFileSync(`${manifestPath}.bak`, 'utf8')).allowed_origins, [`chrome-extension://${ID_A}/`]);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).allowed_origins, [`chrome-extension://${ID_B}/`]);
  rmSync(home, { recursive: true, force: true });

  // dry-run：临时 home 里不应出现任何文件
  const home2 = tmpHome();
  const dry = await runNode(INSTALL_MJS, ['--home', home2, '--browser', 'chrome', '--extension-id', ID_A, '--dry-run']);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /WRITE-MANIFEST/);
  for (const p of manifestPathsForFamily('chrome', { home: home2 })) {
    assert.ok(!existsSync(p), `dry-run must not write: ${p}`);
  }
  assert.equal(readdirSync(home2).length, 0, 'dry-run must leave home untouched');
  rmSync(home2, { recursive: true, force: true });
});

test('installer: 拒绝覆盖他人清单（name 不是 com.chromeagentbrowser.host）', { timeout: 30_000 }, async () => {
  const home = tmpHome();
  const manifestPath = manifestPathsForFamily('chrome', { home })[0];
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  const foreign = JSON.stringify({ name: 'com.example.foreignhost', path: '/bin/false', allowed_origins: [] }, null, 2);
  writeFileSync(manifestPath, foreign);

  const { code, stdout, stderr } = await runNode(INSTALL_MJS, ['--home', home, '--browser', 'chrome', '--extension-id', ID_A]);
  assert.notEqual(code, 0, 'refusal must exit non-zero');
  assert.match(stdout, /REFUSED/);
  assert.ok(!existsSync(`${manifestPath}.bak`), 'foreign manifest must not be backed up or touched');
  assert.equal(readFileSync(manifestPath, 'utf8'), foreign, 'foreign manifest bytes unchanged');

  rmSync(home, { recursive: true, force: true });
});

test('installer: --compute-extension-id CLI 输出（路径必须存在）', { timeout: 15_000 }, async () => {
  const dir = tmpHome('ab-ext-');
  const ok = await runNode(INSTALL_MJS, ['--compute-extension-id', dir]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout.trim(), /^[a-p]{32}$/);
  assert.equal(ok.stdout.trim(), computeExtensionId(dir));

  const missing = await runNode(INSTALL_MJS, ['--compute-extension-id', '/nonexistent/ext-dir']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /does not exist/);
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// discovery：profile 挑选与清单诊断
// ===========================================================================

test('discovery: resolveProfileDirectory 按 last_used → last_active → 扫描 逐级回退', () => {
  // 1) Local State last_used 可用
  const root1 = tmpHome('ab-prof1-');
  mkdirSync(path.join(root1, 'Default'), { recursive: true });
  writeFileSync(path.join(root1, 'Default', 'Preferences'), '{}');
  writeFileSync(path.join(root1, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  assert.equal(resolveProfileDirectory(root1), 'Default');
  rmSync(root1, { recursive: true, force: true });

  // 2) last_used 指向不存在的 profile → last_active_profiles 里最新可用
  const root2 = tmpHome('ab-prof2-');
  for (const name of ['Profile 1', 'Profile 2']) {
    mkdirSync(path.join(root2, name), { recursive: true });
    writeFileSync(path.join(root2, name, 'Preferences'), '{}');
  }
  writeFileSync(path.join(root2, 'Local State'), JSON.stringify({
    profile: { last_used: 'Gone', last_active_profiles: ['Profile 1', 'Profile 2'] },
  }));
  assert.equal(resolveProfileDirectory(root2), 'Profile 2');
  rmSync(root2, { recursive: true, force: true });

  // 3) 没有 Local State → 扫描 Default / Profile N，取最新可用
  const root3 = tmpHome('ab-prof3-');
  for (const name of ['Default', 'Profile 3']) {
    mkdirSync(path.join(root3, name), { recursive: true });
    writeFileSync(path.join(root3, name, 'Preferences'), '{}');
  }
  assert.equal(resolveProfileDirectory(root3), 'Profile 3');
  rmSync(root3, { recursive: true, force: true });

  // 4) 什么都没有 → 抛错
  const root4 = tmpHome('ab-prof4-');
  assert.throws(() => resolveProfileDirectory(root4), /Preferences/);
  rmSync(root4, { recursive: true, force: true });
});

test('discovery: checkNativeHostManifest 校验已装清单 / 空目录', { timeout: 30_000 }, async () => {
  // 沙箱安装后 → ok，无 problems
  const home = tmpHome();
  const install = await runNode(INSTALL_MJS, ['--home', home, '--browser', 'chrome', '--extension-id', ID_A]);
  assert.equal(install.code, 0);
  const okResult = checkNativeHostManifest('chrome', { home });
  assert.equal(okResult.ok, true);
  assert.deepEqual(okResult.problems, []);

  // 空 home → ok=false 且给出问题清单
  const emptyHome = tmpHome('ab-empty-');
  const badResult = checkNativeHostManifest('chrome', { home: emptyHome });
  assert.equal(badResult.ok, false);
  assert.ok(badResult.problems.length >= 1);
  assert.match(badResult.problems[0], /no com\.chromeagentbrowser\.host\.json found/);

  rmSync(home, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
});
