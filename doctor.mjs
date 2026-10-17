#!/usr/bin/env node
// doctor.mjs —— 一条命令体检：本机浏览器侧 ↔ 服务侧 的链路断点定位。
// 来自实战教训：服务进程退出后，MCP 工具只返回空列表，不报错，排查半小时。
//
// 用法：node doctor.mjs [--browser chrome|edge|brave|opera|vivaldi|arc|all]（默认检测已装的）
// 输出：每项 ✓/✗ + 修复建议；最后一行总结。

import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installedBrowsers, checkNativeHostManifest } from './installer/discovery.mjs';
import { FAMILY_NAMES } from './installer/install.mjs';
import { createCua, swiftcPath } from './service/cua.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const items = [];
const check = (name, fn) => {
  try { items.push([name, fn()]); } catch (err) { items.push([name, { ok: false, detail: err.message }]); }
};

/** 探测端口是否有人监听（能建立 TCP 即算有人听）。 */
function portListening(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

check('项目扩展目录 extension/ 存在', () => existsSync(path.join(ROOT, 'extension', 'manifest.json'))
  ? { ok: true, detail: 'extension/manifest.json' }
  : { ok: false, detail: 'extension/ 不完整：确认在项目根目录运行、仓库完整' });

let port = null;
check('host/host-config.json 存在', () => {
  const p = path.join(ROOT, 'host', 'host-config.json');
  if (!existsSync(p)) return { ok: false, detail: '没有这份配置说明本机没跑过 npm run setup（扩展的宿主进程不知道往哪拨号）→ 跑 chrome-agent-browser（npm 安装）或 npm run setup（源码）' };
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  port = cfg.servicePort;
  return { ok: true, detail: `端口 ${cfg.servicePort}` };
});

const families = (() => {
  const a = process.argv.indexOf('--browser');
  if (a > -1 && process.argv[a + 1] === 'all') return FAMILY_NAMES;
  if (a > -1) return [process.argv[a + 1]];
  const found = installedBrowsers().map((b) => b.family);
  return found.length ? [...new Set(found)] : ['chrome'];
})();

for (const f of families) {
  check(`浏览器 ${f} 的通信清单`, () => {
    const r = checkNativeHostManifest(f);
    if (r.ok) return { ok: true, detail: '已安装且指向本项目的宿主' };
    return { ok: false, detail: `${r.problems.join('; ')} → chrome-agent-browser -- --browser ${f}（源码：npm run setup -- --browser ${f}）` };
  });
}

const listening = port ? await portListening('127.0.0.1', port) : false;
if (port) {
  check(`端口 ${port} 有服务在听`, () => listening
    ? { ok: true, detail: '服务在线（MCP 客户端会话或独立服务进程）' }
    : { ok: false, detail: '当前没有服务进程。判断：你的 AI 客户端 MCP 会话正开着 → 这就是"空列表"的根因，重启会话（或 chrome-agent-browser-mcp / npm run start 手动起服务）；没开会话 → 此项正常（服务按需启动，无需常驻）' });
}

// ---- 屏幕操作（CUA）能力：helper 编译状态 + AX/屏幕录制授权探测 ----
// 可选功能：未编译不算失败（B/C 层如实标注并给指引）；编译过但授权缺失才算可修复的 ✗。
const cuaInfo = await (async () => {
  try {
    const cua = createCua({});
    try {
      return { status: await cua.status() };
    } finally {
      cua.stop(); // 结束可能拉起的常驻 helper 探测进程
    }
  } catch (err) {
    return { error: err.message };
  }
})();
if (cuaInfo.error) {
  check('屏幕操作助手（CUA）', () => ({ ok: false, detail: `探测失败: ${cuaInfo.error}` }));
} else if (!cuaInfo.status.supported) {
  check('屏幕操作助手（CUA）', () => ({ ok: true, detail: `非 macOS 平台（${cuaInfo.status.platform}），cua_* 工具族不可用` }));
} else {
  const st = cuaInfo.status;
  check('屏幕操作助手编译（host/cua-helper）', () => st.helperCompiled
    ? { ok: true, detail: `已编译（tier ${st.tier}：A=helper / B=osascript / C=无授权）` }
    : { ok: true, detail: st.swiftcAvailable
      ? '未编译（可选增强）。跑一次 npm run setup 自动编译；当前 B/C 层可用（osascript：元素读/点击/输入；无坐标点击）'
      : '未编译且本机无 swiftc（装 Xcode 或 xcode-select --install）。当前 B/C 层可用（osascript）' });
  check('CUA 系统授权（辅助功能/屏幕录制）', () => {
    if (st.tier === 'C') return { ok: false, detail: `辅助功能未授权 → 系统设置 → 隐私与安全性 → 辅助功能，勾选运行服务的终端/应用后重跑 doctor（当前仅窗口清单${st.helperCompiled ? '（CGWindowList）' : ''}与截图可用）` };
    const screen = st.screenGranted === true ? '已授权' : '未授权/未知（截图可能只剩桌面壁纸 → 屏幕录制里勾选同一项）';
    return { ok: true, detail: `辅助功能 ✓（tier ${st.tier}）；屏幕录制：${screen}` };
  });
}

console.log('chrome-agent-browser 体检报告');
for (const [name, r] of items) console.log(`${r.ok ? '✓' : '✗'} ${name}${r.detail ? ' —— ' + r.detail : ''}`);
const bad = items.filter(([, r]) => !r.ok).length;
console.log(bad ? `\n总结：${bad} 项异常，按上面每行的"→"建议修复。` : '\n总结：链路健康。若浏览器仍连不上，确认浏览器开着且扩展已从本机项目目录加载（chrome://extensions 无红色报错）。');
process.exit(bad ? 1 : 0);
