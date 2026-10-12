#!/usr/bin/env node
// setup.mjs —— 一条命令安装：自动算扩展 ID → 检测已装浏览器 → 落清单/配置 →
// 打开 Chrome 扩展页（路径已进剪贴板）→ 原地等待扩展回连验证 → 打印 MCP 配置。
//
// 用法：node setup.mjs [--dry-run] [--port N] [--timeout 秒] [--browser all|chrome|edge|brave|opera|vivaldi] [--home DIR]
// 唯一的手动步：在 Chrome 的「加载已解压的扩展程序」里选中 extension 目录。

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { computeExtensionId, parseArgs as parseInstallArgs, runInstall, FAMILY_NAMES } from './installer/install.mjs';
import { installedBrowsers } from './installer/discovery.mjs';
import { ConnectionManager } from './service/connection.mjs';

// setup.mjs 位于仓库根，REPO_ROOT 就是它所在目录（此前误用 '..' 多退一级）
const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(REPO_ROOT, 'extension');

const log = (s) => console.log(s);
const isMac = process.platform === 'darwin';

function parseArgs(argv) {
  const out = { dryRun: false, port: null, timeoutSec: 240, browser: null, home: null, noOpen: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${a}`); return v; };
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-open') out.noOpen = true;
    else if (a === '--port') out.port = Number(next());
    else if (a === '--timeout') out.timeoutSec = Number(next());
    else if (a === '--browser') out.browser = next();
    else if (a === '--home') out.home = path.resolve(next());
    else if (a === '--help' || a === '-h') { log('usage: node setup.mjs [--dry-run] [--port N] [--timeout 秒] [--browser all|chrome|…|vivaldi] [--home DIR]'); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1. 检测浏览器
  let families;
  if (args.browser === 'all') families = FAMILY_NAMES;
  else if (args.browser) families = [args.browser];
  else {
    const found = installedBrowsers().map((b) => b.family);
    families = found.length ? [...new Set(found)] : ['chrome'];
  }
  log('① 检测到浏览器：' + families.join(', '));

  // 2. 算扩展 ID（路径指纹——必须用最终路径算，这就是不能挪目录的原因）
  const extId = computeExtensionId(EXT_DIR);
  log(`② 本机扩展 ID：${extId}`);

  // 3. 端口：指定 > 上一轮 host-config 里的 > 空闲端口
  let port = args.port;
  if (!port) {
    try {
      const prev = JSON.parse((await import('node:fs')).readFileSync(path.join(REPO_ROOT, 'host', 'host-config.json'), 'utf8'));
      if (Number.isInteger(prev.servicePort)) port = prev.servicePort;
    } catch { /* 首次安装没有旧配置 */ }
  }
  if (!port) port = await freePort();

  // 4. 落清单 + shim + host-config（复用已测试的安装器）
  const installParsed = parseInstallArgs(['--browser', families[0], '--extension-id', extId, '--port', String(port), ...(args.home ? ['--home', args.home] : []), ...(args.dryRun ? ['--dry-run'] : [])]);
  for (const f of families) {
    installParsed.browser = f;
    await runInstall(installParsed);
  }
  log(`③ ${args.dryRun ? '[dry-run] 将写入' : '已写入'}原生宿主清单（${families.length} 个浏览器）+ 服务配置（端口 ${port}）`);
  if (args.dryRun) { log('dry-run 结束（未落盘、未启动验证）。'); return 0; }

  // 5. 助手：打开 Chrome 扩展页 + 扩展路径进剪贴板（macOS）
  log('');
  log('④ 下面是唯一的手动步骤：');
  log(`   在 Chrome 打开 chrome://extensions → 右上角打开「开发者模式」→`);
  log(`   「加载已解压的扩展程序」→ 选择目录：`);
  log(`     ${EXT_DIR}`);
  if (isMac && !args.noOpen) {
    try { spawnSync('pbcopy', { input: EXT_DIR, stdio: ['pipe', 'ignore', 'ignore'] }); log('   （目录路径已复制到剪贴板，可直接粘贴）'); } catch { /* 无剪贴板则跳过 */ }
    try { spawn('open', ['-a', 'Google Chrome', 'chrome://extensions/'], { stdio: 'ignore', detached: true }).unref(); } catch { /* 打不开就算了 */ }
  }

  // 6. 原地等待扩展回连（真验证，不是假装成功）
  log('');
  log(`⑤ 等待扩展连入验证（最长 ${args.timeoutSec} 秒，加载完扩展那一刻会自动打钩）…`);
  const manager = new ConnectionManager({ port });
  await manager.start();
  const deadline = Date.now() + args.timeoutSec * 1000;
  let ok = false;
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), deadline - Date.now());
      manager.once('browser', (c) => { clearTimeout(t); resolve(c); });
    });
    ok = true;
    log('   ✓ 全链路验证通过：扩展 → 原生宿主 → 服务，通信正常！');
  } catch {
    log('   ✗ 等待超时。常见原因：还没在 Chrome 里加载扩展 / 加载后又挪动了目录 / 加载的目录不是上面这个路径。');
    log('     完成后随时重跑 node setup.mjs 再验证一次。');
  } finally {
    await manager.stop().catch(() => {});
  }

  // 7. MCP 配置片段（端口已固化进 host-config，客户端命令无需带 --port）
  const entry = path.join(REPO_ROOT, 'service', 'mcp-entry.mjs');
  log('');
  log('⑥ 给 MCP 客户端的配置（复制即用）：');
  log('npm 安装用户（推荐）：');
  log(JSON.stringify({ mcpServers: { 'chrome-agent-browser': { command: 'chrome-agent-browser-mcp' } } }));
  log('源码（git clone）用户：');
  log(JSON.stringify({ mcpServers: { 'chrome-agent-browser': { command: 'node', args: [entry] } } }));
  log('');
  log(ok ? '安装完成 🎉 日常使用：MCP 客户端按上面的配置自动拉起服务即可。' : '安装文件已就位，完成第④步后即用。');
  log('卸载：chrome-agent-browser-uninstall（npm 安装）或 npm run uninstall（源码）');
  return ok ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(`[setup] 失败: ${e.message}`); process.exit(1); });
