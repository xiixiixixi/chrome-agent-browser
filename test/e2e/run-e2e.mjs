#!/usr/bin/env node
// test/e2e/run-e2e.mjs —— 端到端联测：真 Chromium(Chrome for Testing) + 真扩展 + 真宿主 + 真服务。
//
// 流程：起服务(随机端口) → 安装器写清单(带本仓库扩展的真实ID) → 无头 Chromium 加载扩展
//   → 扩展经原生宿主连回服务 → 用 Agent API 全链路操作真页面 → 断言 → 清理。
//
// 用法：node test/e2e/run-e2e.mjs [--headed]（默认 --headless=new）
// 红线：绝不动用户默认 Chrome；清单只写 com.chromeagentbrowser.host.json 且测试后删除；
//   Chromium 用 playwright 缓存里的 Chrome for Testing + 一次性 user-data-dir。

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';

import { ConnectionManager } from '../../service/connection.mjs';
import { createAgentApi } from '../../service/api.mjs';
import { loadPolicy } from '../../service/policy.mjs';
import { ERR } from '../../shared/protocol.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXT_DIR = join(ROOT, 'extension');
const CHROME = process.env.AB_E2E_CHROME ??
  join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const headed = process.argv.includes('--headed');
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push([name, null]); console.log(`PASS  ${name}`); }
  catch (err) { results.push([name, err]); console.log(`FAIL  ${name}: ${err.message}`); }
};

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

// ---- 1. 端口与安装 ----
const port = await freePort();
const compute = spawnSync('node', [join(ROOT, 'installer/install.mjs'), '--compute-extension-id', EXT_DIR], { encoding: 'utf8' });
assert.equal(compute.status, 0, `compute-extension-id 失败: ${compute.stderr}`);
const extId = (compute.stdout.match(/[a-p]{32}/) || [])[0];
assert.ok(extId, '无法解析扩展 ID');
console.log(`[e2e] 扩展 ID = ${extId}（来自路径哈希），服务端口 = ${port}`);

const install = spawnSync('node', [join(ROOT, 'installer/install.mjs'), '--browser', 'chrome', '--extension-id', extId, '--port', String(port)], { encoding: 'utf8' });
assert.equal(install.status, 0, `安装器失败: ${install.stderr}${install.stdout}`);
const writtenManifests = (install.stdout.match(/^WRITE-MANIFEST .+$/gm) || []).map((l) => l.slice('WRITE-MANIFEST '.length).trim());
console.log(`[e2e] 安装器写入 ${writtenManifests.length} 份清单`);

// 保护用户真实配置：安装器会重写 host/host-config.json，测试结束需还原
const hostConfigPath = join(ROOT, 'host', 'host-config.json');
const hostConfigBackup = existsSync(hostConfigPath) ? readFileSync(hostConfigPath, 'utf8') : null;

// ---- 2. 一次性浏览器环境 ----
const udd = mkdtempSync(join(tmpdir(), 'ab-e2e-'));
// 双保险：自定义 user-data-dir 下也放一份清单（Chromium 自定义目录时的查找位置）
mkdirSync(join(udd, 'NativeMessagingHosts'), { recursive: true });
const manifest = JSON.parse(readFileSync(writtenManifests[0], 'utf8'));
writeFileSync(join(udd, 'NativeMessagingHosts/com.chromeagentbrowser.host.json'), JSON.stringify(manifest, null, 2));

// ---- 3. 服务 + 测试页 ----
const manager = new ConnectionManager({ port });
await manager.start();
const policy = loadPolicy(null);
const api = createAgentApi(() => manager.liveConnections(), { policy });

const pageHtml = readFileSync(join(ROOT, 'test/e2e/page.html'), 'utf8');
const httpPort = await freePort();
const httpServer = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pageHtml); });
await new Promise((r) => httpServer.listen(httpPort, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${httpPort}/`;

// ---- 4. 启动 Chromium（加载扩展） ----
console.log(`[e2e] 启动: ${CHROME}\n        ${headed ? '(headed)' : '(headless=new)'} user-data-dir=${udd}`);
const chrome = spawn(CHROME, [
  ...(headed ? [] : ['--headless=new']),
  `--user-data-dir=${udd}`,
  `--load-extension=${EXT_DIR}`,
  `--disable-extensions-except=${EXT_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--noerrdialogs',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: true }); // detached+进程组杀：Chrome 是进程树，只杀主进程会留僵尸
chrome.stderr.on('data', (d) => { const s = String(d); if (/agentbrowser|ab\]/i.test(s)) console.log('[chrome]', s.trim().slice(0, 300)); });

let browserInfo = null;
try {
  // ---- 5. 等扩展注册（最多 30s） ----
  await step('扩展经原生宿主连入服务（ext/hello 注册）', async () => {
    const got = new Promise((res) => manager.once('browser', res));
    browserInfo = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('30s 内无浏览器注册')), 30000))]);
  });

  if (browserInfo) {
    await step('browsers.list() 显示 1 台 family=chrome 浏览器', async () => {
      const list = api.browsers.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].type, 'extension');
      assert.equal(list[0].family, 'chrome');
    });

    const browser = api.browsers.getDefault();
    let tab = null;
    await step('tabs.new() 创建 agent 标签页', async () => {
      tab = await browser.tabs.new();
      assert.equal(typeof tab.id, 'number');
    });
    await step('goto 测试页 + title 读取', async () => {
      await tab.goto(pageUrl);
      const t = await tab.title();
      assert.ok(t.includes('AB-E2E'), `title=${t}`);
    });
    await step('定位器真实交互：getByTestId.fill + getByRole.click → 页面状态改变', async () => {
      await tab.playwright.getByTestId('name-input').fill('张三');
      await tab.playwright.getByRole('button', { name: '提交' }).click();
      const out = await tab.eval('document.getElementById("out").textContent');
      assert.equal(out, 'clicked:张三');
    });
    await step('定位器语义：getByLabel / getByText 计数', async () => {
      const n1 = await tab.playwright.getByLabel('姓名').count();
      const n2 = await tab.playwright.getByText('点我').count();
      assert.ok(n1 >= 1, `label 命中 ${n1}`);
      assert.equal(n2, 1, `text 命中 ${n2}`);
    });
    await step('tab.eval 表达式求值', async () => {
      const v = await tab.eval('window.__e2eMarker');
      assert.equal(v, 'loaded');
    });
    await step('screenshot 返回 PNG 二进制', async () => {
      const buf = await tab.screenshot();
      assert.ok(Buffer.isBuffer(buf) && buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50, `len=${buf && buf.length}`);
    });
    await step('无障碍树读取非空且含可交互节点', async () => {
      const ax = await tab.ax.get();
      assert.ok(typeof ax === 'string' && ax.length > 50, `ax len=${ax && ax.length}`);
      assert.ok(/button|textbox/i.test(ax));
    });
    await step('CDP 白名单内调用成功（Page.getFrameTree）', async () => {
      const cdp = tab.capabilities.get('cdp');
      const r = await cdp.send('Page.getFrameTree');
      assert.ok(r && r.frameTree && r.frameTree.frame);
    });
    await step('CDP 白名单外拒绝（Page.crash → CDP_DENIED）', async () => {
      const cdp = tab.capabilities.get('cdp');
      await assert.rejects(cdp.send('Page.crash'), (e) => e.code === ERR.CDP_DENIED);
    });
    await step('策略门：chrome://settings 导航被拦（POLICY_BLOCKED）', async () => {
      await assert.rejects(tab.goto('chrome://settings/'), (e) => e.code === 'POLICY_BLOCKED');
    });
    await step('user.openTabs() 能看到本页', async () => {
      const tabs = await browser.user.openTabs();
      assert.ok(tabs.some((t) => (t.url || '').startsWith(pageUrl)), JSON.stringify(tabs.map((t) => t.url)));
    });
    await step('tab.close() 后标签页消失', async () => {
      await tab.close();
      const tabs = await browser.user.openTabs();
      assert.ok(!tabs.some((t) => (t.url || '').startsWith(pageUrl)));
    });
  }
} finally {
  // ---- 6. 清理（只删自己写的；杀整个 Chrome 进程组防僵尸） ----
  try { chrome.kill('SIGKILL'); } catch { /* noop */ }
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* noop */ }
  try { await once(chrome, 'exit').catch(() => {}); } catch { /* noop */ }
  await new Promise((r) => setTimeout(r, 1200)); // 等 Chrome 进程树真正退出，避免清单删除竞态
  await manager.stop().catch(() => {});
  httpServer.close();
  try { rmSync(udd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Chrome 仍占用则留给系统 */ }
  for (const p of writtenManifests) { try { rmSync(p, { force: true }); } catch { /* noop */ } }
  // 终扫：任何残留的 com.chromeagentbrowser.host 清单一律清掉（红线：真实浏览器目录不留痕）
  let leftover = 0;
  for (const p of writtenManifests) { try { if (existsSync(p)) { leftover++; rmSync(p, { force: true }); } } catch { /* noop */ } }
  if (leftover) console.log(`[e2e] 警告：清理竞态残留 ${leftover} 份清单，已终扫删除`);
  // 还原用户真实 host-config（安装器在测试中重写了端口）
  if (hostConfigBackup !== null) writeFileSync(hostConfigPath, hostConfigBackup);
  console.log(`[e2e] 清理完成（浏览器/服务/测试页/临时目录/${writtenManifests.length} 份清单）`);
}

const failed = results.filter(([, e]) => e);
console.log(failed.length ? `\nE2E FAIL（${failed.length}/${results.length}）` : `\nE2E PASS（${results.length}/${results.length}）`);
process.exit(failed.length ? 1 : 0);
