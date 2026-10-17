#!/usr/bin/env node
// uninstall.mjs —— 干净卸载：删五家族目录里的 com.chromeagentbrowser.host 清单（只删自己的，
//
// 用法：node uninstall.mjs [--dry-run] [--home DIR]

import { rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { NATIVE_HOST_NAME, manifestPathsForFamily, FAMILY_NAMES } from './installer/install.mjs';

// uninstall.mjs 位于仓库根，REPO_ROOT 就是它所在目录
const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

const dryRun = process.argv.includes('--dry-run');
const homeIdx = process.argv.indexOf('--home');
const home = homeIdx > -1 ? path.resolve(process.argv[homeIdx + 1]) : os.homedir();

let removed = 0;
for (const family of FAMILY_NAMES) {
  for (const p of manifestPathsForFamily(family, { home })) {
    if (!existsSync(p)) continue;
    // 安全检查：只删我们自己名字的清单
    let name = '';
    try { name = JSON.parse(readFileSync(p, 'utf8')).name; } catch { /* 解析失败按非我们的处理 */ }
    if (name !== NATIVE_HOST_NAME) { console.log(`跳过（不是我们的文件）：${p}`); continue; }
    console.log(`${dryRun ? '[dry-run] 将删除' : '已删除'} ${p}`);
    if (!dryRun) { rmSync(p, { force: true }); }
    removed += 1;
  }
}
for (const f of ['chrome-agent-browser-host', 'chrome-agent-browser-host.cmd', 'host-config.json', 'cua-helper']) {
  const p = path.join(REPO_ROOT, 'host', f);
  if (existsSync(p)) { console.log(`${dryRun ? '[dry-run] 将删除' : '已删除'} ${p}`); if (!dryRun) rmSync(p, { force: true }); }
}
console.log(dryRun ? `[uninstall] dry-run 结束，共 ${removed} 份清单待删。` : `[uninstall] 完成，共删 ${removed} 份清单。`);
console.log('Chrome 一侧：chrome://extensions → 移除「Chrome Agent Browser」即彻底干净。');
