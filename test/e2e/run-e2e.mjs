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

// 保护用户真实配置（顺序关键：必须在安装器跑之前读原值，安装器会重写它）
const hostConfigPath = join(ROOT, 'host', 'host-config.json');
const hostConfigBackup = existsSync(hostConfigPath) ? readFileSync(hostConfigPath, 'utf8') : null;

// E2E 沙箱 HOME：清单全部写进沙箱（真实浏览器目录零接触）；Chrome 实际读的是
// 下方 user-data-dir 里的那份副本（自定义 user-data-dir 时 Chromium 的查找位置）
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'ab-e2e-home-'));
const install = spawnSync('node', [join(ROOT, 'installer/install.mjs'), '--browser', 'chrome', '--extension-id', extId, '--port', String(port), '--home', SANDBOX_HOME], { encoding: 'utf8' });
assert.equal(install.status, 0, `安装器失败: ${install.stderr}${install.stdout}`);
const writtenManifests = (install.stdout.match(/^WRITE-MANIFEST .+$/gm) || []).map((l) => l.slice('WRITE-MANIFEST '.length).trim());
console.log(`[e2e] 安装器写入 ${writtenManifests.length} 份清单（沙箱 ${SANDBOX_HOME}）`);

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
const page2Html = readFileSync(join(ROOT, 'test/e2e/page2.html'), 'utf8');
const ytFixtureHtml = readFileSync(join(ROOT, 'test/e2e/youtube-fixture.html'), 'utf8');
// json3 字幕样例（编造）：两条有效行 + 一条空行（验证配方的空行过滤）；
// 真实 YouTube 不做网络验证（docs/recipes.md 已注明"真站效果请手动试"）
const captionsJson3 = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1800, segs: [{ utf8: '大家好，' }, { utf8: '欢迎来到字幕夹具' }] },
    { tStartMs: 2500, dDurationMs: 2000, segs: [{ utf8: '这是第二行样例字幕 second-sample-line' }] },
    { tStartMs: 5000, segs: [{ utf8: '' }] },
  ],
});
const httpPort = await freePort();
const httpServer = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/captions.json3') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(captionsJson3); return; }
  if (path === '/page2.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page2Html); return; }
  if (path === '/yt-fixture.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(ytFixtureHtml); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pageHtml);
});
await new Promise((r) => httpServer.listen(httpPort, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${httpPort}/`;
const page2Url = `http://127.0.0.1:${httpPort}/page2.html`;

// ---- 4. 启动 Chromium（加载扩展） ----
console.log(`[e2e] 启动: ${CHROME}\n        ${headed ? '(headed)' : '(headless=new)'} user-data-dir=${udd}`);
const chrome = spawn(CHROME, [
  ...(headed ? [] : ['--headless=new']),
  `--user-data-dir=${udd}`,
  `--load-extension=${EXT_DIR}`,
  `--disable-extensions-except=${EXT_DIR}`,
  // WebMCP 页面 JS API（document.modelContext）的实验开关；CDP 的 WebMCP 域无需 flag。
  // 探测实证：Chrome for Testing 156 上此开关是页面申报工具的唯一启用方式。
  '--enable-experimental-web-platform-features',
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
    await step('viewport：set 800x600 → get 一致 → reset 还原（直连命令）', async () => {
      const conn = manager.liveConnections()[0];
      await conn.cmd('browser_viewport_set', { width: 800, height: 600 });
      const got = await conn.cmd('browser_viewport_get', {});
      assert.deepEqual(got.viewport, { width: 800, height: 600 });
      await conn.cmd('browser_viewport_reset', {});
      const after = await conn.cmd('browser_viewport_get', {});
      assert.equal(after.viewport, null, 'reset 后应无覆盖');
    });
    await step('元素级截图：合法 PNG 且字节数小于全页截图', async () => {
      const full = await tab.screenshot();
      assert.ok(Buffer.isBuffer(full) && full.length > 100 && full[0] === 0x89 && full[1] === 0x50, `full len=${full && full.length}`);
      const elt = await tab.playwright.getByTestId('submit-btn').screenshot();
      assert.ok(Buffer.isBuffer(elt) && elt.length > 8 && elt[0] === 0x89 && elt[1] === 0x50, `element len=${elt && elt.length}`);
      assert.ok(elt.length < full.length, `元素截图（${elt.length}B）应小于全页（${full.length}B）`);
    });
    await step('批量隐形阅读：两个 URL 读回正文含关键词，临时标签读完即关', async () => {
      const pages = await browser.tabs.content({ urls: [pageUrl, page2Url] });
      assert.equal(pages.length, 2);
      assert.equal(pages[0].title, 'AB-E2E 测试页');
      assert.match(pages[0].text, /chrome-agent-browser e2e/, `第一页正文: ${pages[0].text.slice(0, 120)}`);
      assert.equal(pages[1].title, 'AB-E2E 第二页');
      assert.match(pages[1].text, /second-marker-9527/, `第二页正文: ${pages[1].text.slice(0, 120)}`);
      // 临时标签已关：第二页不应残留；第一页只剩原本就在的那个 tab
      const tabs = await browser.user.openTabs();
      assert.ok(!tabs.some((t) => (t.url || '').startsWith(page2Url)), JSON.stringify(tabs.map((t) => t.url)));
      assert.equal(tabs.filter((t) => (t.url || '').startsWith(pageUrl)).length, 1);
    });
    await step('YouTube 字幕配方：对离线夹具执行 recipes.md 的提取代码，产出样例字幕行', async () => {
      const recipes = readFileSync(join(ROOT, 'docs/recipes.md'), 'utf8');
      const m = recipes.match(/AB-RECIPE-YT-EXTRACT-START\s*-->\s*```js\s*\n([\s\S]*?)\n```/);
      assert.ok(m, 'recipes.md 应含可抽取的提取代码块（AB-RECIPE-YT-EXTRACT 标记）');
      const yt = await browser.tabs.new();
      try {
        await yt.goto(`http://127.0.0.1:${httpPort}/yt-fixture.html`);
        const r = await yt.eval(m[1]);
        assert.equal(r.ok, true, `提取应成功: ${JSON.stringify(r).slice(0, 300)}`);
        assert.equal(r.language, 'zh-Hans', '语言优先级应选中 zh 轨');
        assert.equal(r.lineCount, 2, `空行应被过滤: ${JSON.stringify(r.lines)}`);
        assert.equal(r.lines[0], '[00:00] 大家好，欢迎来到字幕夹具');
        assert.match(r.lines[1], /second-sample-line/);
        // 非视频页（无 ytInitialPlayerResponse）→ 返回明确原因
        const bad = await tab.eval(m[1]);
        assert.equal(bad.ok, false);
        assert.match(bad.reason, /非视频页/);
      } finally { await yt.close(); }
    });
    // 条件用例：WebMCP 依赖浏览器的实验 CDP 域与页面 JS API——任一缺失时打印 SKIP 原因并算通过
    let webmcpSkip = null; // 供后续推送式发现用例复用同一 SKIP 条件
    await step('WebMCP：页面工具发现与调用（不支持则 SKIP）', async () => {
      const webmcp = tab.capabilities.get('webmcp');
      let tools;
      try {
        tools = await webmcp.list();
      } catch (err) {
        if (err && err.code === ERR.WEBMCP_UNSUPPORTED) {
          webmcpSkip = `此 Chromium 无 WebMCP CDP 域（${err.message}；需更新版 Chrome / 实验开关）`;
          console.log(`        SKIP：${webmcpSkip}`);
          return;
        }
        throw err;
      }
      if (!Array.isArray(tools) || tools.length === 0) {
        webmcpSkip = 'WebMCP 域可用但页面未申报工具（页面 JS API 需 --enable-experimental-web-platform-features）';
        console.log(`        SKIP：${webmcpSkip}`);
        return;
      }
      const names = tools.map((t) => t.name);
      assert.ok(names.includes('ab_echo'), `应发现 ab_echo，实际: ${names.join(',')}`);
      assert.ok(tools.every((t) => typeof t.readOnly === 'boolean' && typeof t.description === 'string'));

      // 实测（Chrome for Testing 156）：页面注册时的 annotations 不会透传到 CDP，
      // toolsAdded 里 readOnly 恒 false——因此"只读"工具在本版本也走确认流。
      // 断言兼容两种现实：直通成功，或 needConfirmation → approve → 放行成功。
      let out;
      try {
        out = await webmcp.invoke('ab_echo', { msg: 'hi' });
      } catch (err) {
        if (!err || !err.needsConfirmation) throw err;
        assert.equal(policy.approve(err.token).ok, true);
        out = await webmcp.invoke('ab_echo', { msg: 'hi' }, { confirmationToken: err.token });
      }
      assert.deepEqual(out, { content: [{ type: 'text', text: 'echo:hi' }] });
    });
    // 推送式发现（v0.2.1）：上面的 list 使扩展 WebMCP.enable → toolsAdded，扩展随即把
    // 完整工具名快照经 onWebmcpTools 上报 → 服务收件箱 → tab_info 附带 webmcpHint。
    await step('WebMCP 推送式发现：tab_info 出现 webmcpHint 且含 ab_echo（不支持则 SKIP）', async () => {
      if (webmcpSkip) { console.log(`        SKIP：${webmcpSkip}`); return; }
      let ctx = null;
      for (let i = 0; i < 10 && !(ctx && ctx.webmcpHint); i++) {
        ctx = await browser.user.getTabContext({ tabId: tab.id }); // 通知经 host 中继异步落地，短轮询
        if (!ctx.webmcpHint) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(ctx && ctx.webmcpHint, `tab_info 应附带 webmcpHint: ${JSON.stringify(ctx)}`);
      assert.ok(ctx.webmcpHint.toolNames.includes('ab_echo'),
        `webmcpHint.toolNames 应含 ab_echo: ${JSON.stringify(ctx.webmcpHint)}`);
      assert.equal(ctx.webmcpHint.count, ctx.webmcpHint.toolNames.length);
    });
    // v0.2.2：attach 即启用——新标签页从未调过 webmcp.list，仅一次普通交互（eval 触发 attach）
    // 后，tab_info 也应出现 webmcpHint（证明"第一推动"不再依赖手动 list）
    await step('WebMCP 第一推动：全新标签页不 list 也有 webmcpHint（v0.2.2；不支持则 SKIP）', async () => {
      if (webmcpSkip) { console.log(`        SKIP：${webmcpSkip}`); return; }
      const fresh = await browser.tabs.new();
      try {
        await fresh.goto(pageUrl);
        await fresh.eval('1+1'); // 普通交互触发 attach → WebMCP.enable → toolsAdded → 通知
        let ctx = null;
        for (let i = 0; i < 15 && !(ctx && ctx.webmcpHint && ctx.webmcpHint.toolNames.includes('ab_echo')); i++) {
          ctx = await browser.user.getTabContext({ tabId: fresh.id });
          if (!ctx.webmcpHint) await new Promise((r) => setTimeout(r, 200));
        }
        assert.ok(ctx && ctx.webmcpHint && ctx.webmcpHint.toolNames.includes('ab_echo'),
          `全新未 list 标签页应有第一推动 hint: ${JSON.stringify(ctx)}`);
      } finally { await fresh.close(); }
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
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch { /* noop */ }
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
