#!/usr/bin/env node
// test/e2e/probe.mjs —— 导航卡死诊断探针：起全链路后只做「建页→导航→逐秒观测 tab 状态」
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { ConnectionManager } from '../../service/connection.mjs';
import { createAgentApi } from '../../service/api.mjs';
import { loadPolicy } from '../../service/policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXT_DIR = join(ROOT, 'extension');
const CHROME = join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

const port = await freePort();
const compute = spawnSync('node', [join(ROOT, 'installer/install.mjs'), '--compute-extension-id', EXT_DIR], { encoding: 'utf8' });
const extId = (compute.stdout.match(/[a-p]{32}/) || [])[0];
const install = spawnSync('node', [join(ROOT, 'installer/install.mjs'), '--browser', 'chrome', '--extension-id', extId, '--port', String(port)], { encoding: 'utf8' });
const manifests = (install.stdout.match(/^WRITE-MANIFEST .+$/gm) || []).map((l) => l.slice(14).trim());

const udd = mkdtempSync(join(tmpdir(), 'ab-probe-'));
const manager = new ConnectionManager({ port });
await manager.start();
const policy = loadPolicy(null);
const api = createAgentApi(() => manager.liveConnections(), { policy });

const httpPort = await freePort();
const httpServer = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>probe</h1><script>window.__m="ok"</script>'); });
await new Promise((r) => httpServer.listen(httpPort, '127.0.0.1', r));

const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${udd}`, `--load-extension=${EXT_DIR}`, `--disable-extensions-except=${EXT_DIR}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', (d) => console.log('[chrome]', String(d).trim().slice(0, 300)));

try {
  await Promise.race([
    new Promise((res) => manager.once('browser', res)),
    new Promise((_, rej) => setTimeout(() => rej(new Error('30s 内扩展未连入')), 30000)),
  ]);
  console.log('[probe] 扩展已连入');
  const conn = manager.liveConnections()[0];
  const b = api.browsers.getDefault();
  const tab = await b.tabs.new();
  console.log('[probe] tab created id=', tab.id);

  // 触发导航（不等结果——15s 超时会 reject，观察用）
  const nav = conn.cmd('navigate_tab_url', { tabId: tab.id, url: `http://127.0.0.1:${httpPort}/` }).then((r) => console.log('[probe] navigate 返回:', JSON.stringify(r))).catch((e) => console.log('[probe] navigate 异常:', e.message));

  // 逐秒观测：原生 tabs 视角（openTabs 走 chrome.tabs.query）+ eval 视角
  for (let i = 1; i <= 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    let info = 'n/a', ev = 'n/a';
    try { info = JSON.stringify(await conn.cmd('tab_info', { tabId: tab.id })); } catch (e) { info = 'ERR ' + e.message; }
    try { const r = await conn.cmd('tab_eval', { tabId: tab.id, expression: 'location.href + " | marker=" + window.__m' }); ev = JSON.stringify(r.value); } catch (e) { ev = 'ERR ' + e.message; }
    console.log(`[probe t=${i}s] tab_info=${info} eval=${ev}`);
  }
  await nav;
} catch (err) {
  console.log('[probe] 主流程异常:', err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err);
} finally {
  try { chrome.kill('SIGKILL'); } catch {}
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  await manager.stop().catch(() => {});
  httpServer.close();
  try { rmSync(udd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Chrome 仍占用则留给系统清理 */ }
  for (const p of manifests) rmSync(p, { force: true });
}
