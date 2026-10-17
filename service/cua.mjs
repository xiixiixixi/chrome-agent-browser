// service/cua.mjs — 屏幕操作（CUA：Computer Use Agent）工具族
//
// 设计思想（借鉴业界桌面操控栈的通行分层，纯自研实现）：
//   1. 分层注入：元素级 AX 动作优先（语义正确、可验证），坐标级合成事件兜底
//      （AX press 失败时取元素 bounds 中心点击）；
//   2. AX 优先：读界面先取无障碍树（结构化、省 token），截图只做视觉核对；
//   3. 物理验证：每个动作执行前自动留一份「前证据」，cua_verify 再取「后证据」，
//      两份证据一起返回——声称已点击不算数，必须以证据核对；
//   4. 能力探测：三层能力逐级探测、优雅降级，cua_status 如实报告当前到哪层。
//
// 三层执行体（tier）：
//   A（编译版，最强）：host/cua-helper（swift/cua-helper.swift 由 setup 用 swiftc 编译，
//     行协议 JSON）。windows=CGWindowList、AX 遍历、element-click（AXPress+坐标兜底）、
//     xy-click（有 pid → 定向投递不动真实光标；无 pid → 全局）、type/key、app-focus。
//   B（零编译兜底）：osascript + System Events——ax-tree / element-click / type / key /
//     app-focus / windows 全走 AppleScript（较慢；无 xy 定向能力）。
//   C（无任何授权）：仅 windows（helper 编译过时走 CGWindowList，无需授权）与截图
//     （screencapture 子进程，需屏幕录制授权，未授权时报明确指引）。
//   tier 判定：helper 编译 + AX 已授权 → A；未编译 + AX 已授权 → B；AX 未授权 → C；
//   非 macOS → unsupported。
//
// 安全模型（与仓库其余部分一致）：
//   - 所有动作过审计（audit.recordCua：tool + 目标摘要；type 值脱敏 [redacted]）；
//   - 策略门（policy kind 'cua_action'）：默认 cua_key 的 cmd+q / cmd+w（退程序/关窗）
//     需人工确认令牌，其余直行；confirmCuaKeys 可在 policy-defaults.json 配置；
//   - 物理验证：动作存「前证据」，cua_verify 取「后证据」成对返回；
//   - 幽魂光标（v0.5.1）：点击前在目标位置 fire-and-forget 闪现琥珀色 AI 专属光标
//     （A 层 helper 的 overlay-show；叠加窗点击穿透、不抢焦点、真鼠标不动），
//     type/key 在最近一次点击 30 秒内于原地显示箭头提示「在原地输入」；
//     叠加失败绝不影响真实动作，本身不记账（只是可视化，不是动作）；
//     policy-defaults.json 的 cuaOverlay:false 可整体关闭（关闭后零调用）；
//   - 授权引导（v0.5.3）：requestPermissions() 走系统标准申请（弹对话框+把负责进程注册
//     进设置列表，等用户拨开关），status() 带回 responsibleProcess（设置里要勾选的名字）
//     与 permissionGuide（人话指引；v0.5.4 起为 {text, card}——card=有无悬浮引导卡片能力）
//     ——引导编排见 service/cua-guide.mjs（cua-selftest 互动引导 / setup 非交互指引）；
//   - 引导卡片（v0.5.4）：showPermissionCard/hidePermissionCard/openPrivacyPane——
//     申请权限的同时弹「可拖进系统设置列表」的悬浮卡片（A 层 helper 的窗口能力，
//     卡片图标句柄拖出的就是负责进程的 .app bundle），并自动打开对应设置面板；
//   - 无 pid 的全局点击会移动真实光标（工具描述如实声明）；
//   - 永不做锁屏/解锁/绕过认证类功能。

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { missingPermissions, permissionGuideText } from './cua-guide.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SWIFT_SRC_PATH = join(ROOT, 'swift', 'cua-helper.swift');
export const HELPER_PATH = join(ROOT, 'host', 'cua-helper');

const HELPER_TIMEOUT_MS = 15_000; // ax-tree 大树也要在 15s 内回来
const OSA_TIMEOUT_MS = 15_000;
const SHOT_TIMEOUT_MS = 15_000;
const TYPE_MAX_CHARS = 4000;
const OVERLAY_HINT_MS = 30_000; // type/key 在最近一次点击位置显示箭头提示的窗口期

/** B 层（osascript）键码映射，与 Swift 端 KEY_CODES 一致（ANSI 布局）。 */
const KEY_CODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '9': 25, '7': 26, '8': 28, '0': 29,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

const MOD_ALIASES = { command: 'cmd', control: 'ctrl', option: 'alt' };
const OSA_MODS = { cmd: 'command down', ctrl: 'control down', alt: 'option down', shift: 'shift down' };

const AX_GUIDANCE = '系统设置 → 隐私与安全性 → 辅助功能 → 勾选运行本服务的终端/应用（改完重跑 cua_status）';
const SCREEN_GUIDANCE = '系统设置 → 隐私与安全性 → 屏幕录制 → 勾选同一项（未授权时截图可能只剩桌面壁纸）';

/** 引导卡片合法 kind（与 helper 的 show/hide-permission-card 一一对应）。 */
const CARD_KINDS = ['accessibility', 'screen'];

/** 系统设置隐私面板 URL（open 子进程直开对应 section）。 */
const PRIVACY_PANE_URL = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

// ---------- 小工具 ----------

class CuaError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const isMac = () => process.platform === 'darwin';
const isoNow = () => new Date().toISOString();

/** AppleScript 字符串字面量转义（仅反斜杠与双引号）。 */
function osaQuote(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

/** 修饰键归一：command→cmd / control→ctrl / option→alt，小写、去重、按字母排序。 */
function normModifiers(mods) {
  const list = Array.isArray(mods) ? mods : [];
  const out = [];
  for (const m of list) {
    const k = String(m ?? '').toLowerCase();
    if (!k) continue;
    const norm = MOD_ALIASES[k] ?? k;
    if (!['cmd', 'ctrl', 'alt', 'shift'].includes(norm)) throw new CuaError(`不支持的修饰键: ${m}（cmd/ctrl/alt/shift）`, 'BAD_MODIFIER');
    if (!out.includes(norm)) out.push(norm);
  }
  return out.sort();
}

/** 组合键串（策略门用）：["cmd"],"q" → "cmd+q"。 */
export function keyCombo(key, modifiers) { return [...normModifiers(modifiers), String(key ?? '').toLowerCase()].join('+'); }

// ---------- 进程执行（可注入，测试用） ----------

/** 真实 execRunner：spawn 收集 stdout/stderr；超时杀进程；不抛异常（spawn 失败记 stderr）。 */
async function realExec(cmd, args, { input, timeoutMs = 15_000 } = {}) {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolveP({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
    }, timeoutMs);
    child.stdout?.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolveP({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      if (done && code === null) { resolveP({ code: -1, stdout, stderr: stderr || 'timeout' }); return; }
      if (done) return;
      done = true; clearTimeout(timer);
      resolveP({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin?.on('error', () => { /* EPIPE：目标已退出 */ });
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

/** 执行 osascript（脚本经 stdin 传入，避免 shell 引用地狱）；非 0 退出抛 CuaError（识别 AX 未授权）。 */
async function osa(execRunner, script, timeoutMs = OSA_TIMEOUT_MS) {
  const r = await execRunner('osascript', ['-'], { input: script, timeoutMs });
  if (r.code === 0) return r.stdout;
  const errText = `${r.stderr}\n${r.stdout}`.trim();
  // -1743=Not authorized to send Apple events；-25211=kAXErrorAPIDisabled（AX 被拒的两种常见面目）
  if (/,-1743\)|-1743|-25211|not allowed|assistive/i.test(errText)) {
    throw new CuaError(`辅助功能（AX）未授权：${AX_GUIDANCE}`, 'AX_NOT_GRANTED');
  }
  throw new CuaError(`osascript 执行失败: ${errText.slice(0, 300) || `exit ${r.code}`}`, 'OSA_FAILED');
}

// ---------- Swift 助手客户端（行协议：一行 JSON 请求 / 一行 JSON 响应，按 id 配对） ----------

/**
 * 创建常驻助手客户端：懒起进程、按 id 配对响应、进程死亡自动重启（下次请求时）。
 * @param {string} binPath 助手二进制路径
 * @param {{timeoutMs?: number}} [opts]
 */
export function createHelperClient(binPath, { timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  let child = null;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}

  function failAll(reason) {
    for (const rec of pending.values()) {
      clearTimeout(rec.timer);
      rec.reject(new CuaError(reason, 'HELPER_DEAD'));
    }
    pending.clear();
  }

  function spawnHelper() {
    const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    child = proc;
    proc.stdin?.on('error', () => { /* EPIPE：助手已死，在途请求由 exit 兜底 */ });
    let buf = '';
    proc.stdout?.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // 坏行丢弃（协议要求单行 JSON）
        const rec = pending.get(msg.id);
        if (!rec) continue;
        pending.delete(msg.id);
        clearTimeout(rec.timer);
        if (msg.ok === true) rec.resolve(msg);
        else rec.reject(new CuaError(msg.error ?? 'helper error', msg.code));
      }
    });
    // 旧实例的 exit/error 不得波及已重启的新实例（stop → 立即重用时的事件竞态）
    proc.on('exit', () => {
      if (child !== proc) return;
      child = null;
      failAll(`cua-helper exited unexpectedly (${binPath})`);
    });
    proc.on('error', (err) => {
      if (child !== proc) return;
      child = null;
      failAll(`cua-helper 启动失败: ${err.message}`);
    });
  }

  return {
    binPath,
    /** 当前助手子进程句柄（测试用；可能为 null）。 */
    proc: () => child,
    /** 发一行请求，等对应 id 的响应。 */
    request(cmd, params = {}) {
      if (!child) spawnHelper();
      const id = nextId++;
      return new Promise((resolveP, rejectP) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectP(new CuaError(`cua-helper 响应超时（${timeoutMs}ms，cmd=${cmd}）`, 'HELPER_TIMEOUT'));
        }, timeoutMs);
        pending.set(id, { resolve: resolveP, reject: rejectP, timer });
        try {
          child.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`, (err) => {
            if (err) {
              pending.delete(id);
              clearTimeout(timer);
              rejectP(new CuaError(`写入 cua-helper 失败: ${err.message}`, 'HELPER_DEAD'));
            }
          });
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          rejectP(new CuaError(`写入 cua-helper 失败: ${err.message}`, 'HELPER_DEAD'));
        }
      });
    },
    /** 结束助手进程（MCP 会话退出时调用；无进程则空操作）。在途请求立即报 HELPER_DEAD。 */
    stop() {
      if (!child) return;
      const proc = child;
      child = null;
      try { proc.kill(); } catch { /* 已退出 */ }
      failAll('cua-helper stopped');
    },
  };
}

// ---------- 编译（setup / 自检 / doctor 用，同步） ----------

let swiftcMemo = undefined; // 进程级缓存：status 每次动作探测都会问，别反复 spawn

/** 探测 swiftc：优先 PATH 里的 swiftc（xcrun 垫片，自带 SDK 上下文），回退 xcrun -f swiftc；不可用返回 null。 */
export function swiftcPath() {
  if (swiftcMemo !== undefined) return swiftcMemo;
  swiftcMemo = (() => {
    if (!isMac()) return null;
    try {
      const r = spawnSync('swiftc', ['--version'], { encoding: 'utf8', timeout: 10_000 });
      if (r.status === 0) return 'swiftc';
    } catch { /* PATH 里没有 */ }
    try {
      const r = spawnSync('xcrun', ['-f', 'swiftc'], { encoding: 'utf8', timeout: 10_000 });
      if (r.status === 0 && r.stdout) return r.stdout.trim();
    } catch { /* xcrun 不存在 */ }
    return null;
  })();
  return swiftcMemo;
}

/** xcrun 解析 SDK 路径（给绝对路径的 swiftc 补 SDKROOT 用；失败返回 null）。 */
function sdkRoot() {
  try {
    const r = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8', timeout: 10_000 });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch { /* 无 xcrun */ }
  return null;
}

/**
 * 编译 Swift 助手（默认输出 host/cua-helper；测试可用 out 指到临时目录）。
 * 失败不算致命（B 层兜底），返回状态由调用方展示。
 * @param {{log?: Function, out?: string}} [opts]
 * @returns {{compiled: boolean, swiftc: boolean, skipped?: boolean, reason?: string, path: string}}
 */
export function compileHelper({ log = () => {}, out } = {}) {
  const outPath = typeof out === 'string' && out ? out : HELPER_PATH;
  if (!isMac()) return { compiled: false, swiftc: false, skipped: true, path: outPath, reason: '屏幕操作助手仅支持 macOS' };
  const swiftc = swiftcPath();
  if (!swiftc) return { compiled: false, swiftc: false, path: outPath, reason: '本机没有 swiftc（装 Xcode 或 xcode-select --install 命令行工具）' };
  if (!existsSync(SWIFT_SRC_PATH)) return { compiled: false, swiftc: true, path: outPath, reason: `源码缺失: ${SWIFT_SRC_PATH}` };
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    log(`编译 ${SWIFT_SRC_PATH} → ${outPath} …`);
    // 经 xcrun 解析出的绝对路径 swiftc 需要显式 SDKROOT 才找得到标准库（实测坑）
    const env = { ...process.env };
    if (!env.SDKROOT) {
      const sdk = sdkRoot();
      if (sdk) env.SDKROOT = sdk;
    }
    const r = spawnSync(swiftc, ['-O', SWIFT_SRC_PATH, '-o', outPath], { encoding: 'utf8', timeout: 300_000, env });
    if (r.status !== 0) {
      return { compiled: false, swiftc: true, path: outPath, reason: `swiftc 退出码 ${r.status}: ${(r.stderr || '').slice(0, 400)}` };
    }
    chmodSync(outPath, 0o755);
    return { compiled: true, swiftc: true, path: outPath };
  } catch (err) {
    return { compiled: false, swiftc: true, path: outPath, reason: err.message };
  }
}

// ---------- AppleScript（B 层）脚本构造 ----------

/** B 层窗口清单：每行 ownerName \t pid \t title \t x,y,w,h。 */
function osaWindowsScript() {
  return `
on run
	set out to ""
	tell application "System Events"
		repeat with p in (every application process whose background only is false)
			set pn to ""
			set puid to 0
			try
				set pn to name of p
				set puid to unix id of p
			end try
			repeat with w in (every window of p)
				set wt to ""
				try
					set wt to name of w
				end try
				set px to 0
				set py to 0
				set sw to 0
				set sh to 0
				try
					set {px, py} to position of w
					set {sw, sh} to size of w
				end try
				set out to out & pn & tab & (puid as string) & tab & wt & tab & (px as string) & "," & (py as string) & "," & (sw as string) & "," & (sh as string) & linefeed
			end repeat
		end repeat
	end tell
	return out
end run`;
}

/** B 层 AX 树：深度优先，每行 depth \t role \t title \t value \t x,y,w,h；限额 nodeCap/maxDepth。
 *  处理器用到 System Events 术语（UI elements/role/…），必须包 using terms from 才能在
 *  tell 块外编译（AppleScript 术语按编译期上下文解析）。 */
function osaAxTreeScript(pid, maxDepth, nodeCap) {
  return `
global nodeCount

on txt(x)
	if x is missing value then return ""
	try
		return x as text
	on error
		return ""
	end try
end txt

using terms from application "System Events"
	on walk(e, depth, maxDepth, nodeCap)
		set out to ""
		if depth > maxDepth or nodeCount ≥ nodeCap then return out
		set r to ""
		set t to ""
		set v to ""
		set b to ""
		try
			set r to my txt(role of e)
		end try
		try
			set t to my txt(name of e)
		end try
		try
			set vv to value of e
			if class of vv is text then set v to my txt(vv)
			if class of vv is integer or class of vv is real then set v to (vv as string)
		end try
		try
			set {px, py} to position of e
			set {sw, sh} to size of e
			set b to (px as string) & "," & (py as string) & "," & (sw as string) & "," & (sh as string)
		end try
		set out to (depth as string) & tab & r & tab & t & tab & v & tab & b & linefeed
		set nodeCount to nodeCount + 1
		try
			repeat with k in UI elements of e
				if nodeCount ≥ nodeCap then exit repeat
				set out to out & my walk(k, depth + 1, maxDepth, nodeCap)
			end repeat
		end try
		return out
	end walk
end using terms from

on run
	set nodeCount to 0
	set out to ""
	tell application "System Events"
		tell (first application process whose unix id is ${Number(pid)})
			repeat with w in (every window)
				set out to out & my walk(w, 0, ${maxDepth}, ${nodeCap})
			end repeat
		end tell
	end tell
	return out
end run`;
}

/** B 层元素点击：递归找 role（+title）匹配元素并 click；找不到报错。 */
function osaElementClickScript(pid, role, title) {
  return `
using terms from application "System Events"
	on hunt(els, roleWanted, titleWanted)
		repeat with e in els
			try
				if role of e is roleWanted then
					if titleWanted is "" then
						return contents of e
					else
						if (name of e) is titleWanted then return contents of e
					end if
				end if
			end try
			try
				set found to my hunt(UI elements of e, roleWanted, titleWanted)
				if found is not missing value then return found
			end try
		end repeat
		return missing value
	end hunt
end using terms from

on run
	tell application "System Events"
		tell (first application process whose unix id is ${Number(pid)})
			set hit to my hunt(UI elements, ${osaQuote(role)}, ${osaQuote(title ?? '')})
			if hit is missing value then error "element not found: role=" & ${osaQuote(role)} & " title=" & ${osaQuote(title ?? '')}
			click hit
		end tell
	end tell
	return "clicked"
end run`;
}

/** B 层取进程 unix id（按名 / 前台）。 */
const osaPidByName = (app) => `tell application "System Events" to get unix id of first application process whose name is ${osaQuote(app)}`;
const osaFrontmostPid = () => 'tell application "System Events" to get unix id of first application process whose frontmost is true';

/** B 层输入：可选先置前台，再 keystroke / key code。 */
function osaTypeScript(text, app) {
  const focus = app ? `set frontmost of application process ${osaQuote(app)} to true\n\t\tdelay 0.3\n\t\t` : '';
  return `on run
	tell application "System Events"
		${focus}keystroke ${osaQuote(text)}
	end tell
end run`;
}

function osaKeyScript(keyCode, mods, app) {
  const withMods = mods.length ? ` with ${mods.map((m) => OSA_MODS[m]).join(', ')}` : '';
  const focus = app ? `set frontmost of application process ${osaQuote(app)} to true\n\t\tdelay 0.3\n\t\t` : '';
  return `on run
	tell application "System Events"
		${focus}key code ${keyCode}${withMods}
	end tell
end run`;
}

const osaAppFocusScript = (app) => `tell application "System Events" to set frontmost of application process ${osaQuote(app)} to true`;

// ---------- CUA 上下文 ----------

/**
 * 创建 CUA 执行上下文（懒探测：构造零开销，首次使用才 spawn）。
 * @param {object} [opts]
 *   audit       —— service/audit.mjs 实例（动作留痕；缺省不留）
 *   policy      —— service/policy.mjs 实例（cua_key 确认门 + cuaOverlay 叠加开关；缺省直行）
 *   helperPath  —— 助手二进制路径（默认 host/cua-helper；测试指向 fake）
 *   execRunner  —— 进程执行器（默认真实 spawn；测试注入 fake）
 *   clock       —— 时钟函数（默认 Date.now；测试注入假时钟验证 30s 提示窗口）
 */
export function createCua(opts = {}) {
  const { audit = null, policy = null } = opts;
  const execRunner = typeof opts.execRunner === 'function' ? opts.execRunner : realExec;
  const clock = typeof opts.clock === 'function' ? opts.clock : Date.now;
  const helperPath = typeof opts.helperPath === 'string' && opts.helperPath ? opts.helperPath : HELPER_PATH;
  let helperClient = null;
  let lastEvidence = null; // {action, before, ts}：动作前证据（cua_verify 取后证据配对）
  let lastClick = null; // {x, y, atMs}：最近一次点击位置（type/key 的箭头提示用）

  const helperCompiled = () => {
    try { return existsSync(helperPath); } catch { return false; }
  };

  /** 取助手客户端；未编译返回 null。 */
  function helper() {
    if (!helperCompiled()) return null;
    if (!helperClient) helperClient = createHelperClient(helperPath);
    return helperClient;
  }

  function requireMac() {
    if (!isMac()) throw new CuaError('屏幕操作（CUA）仅支持 macOS', 'UNSUPPORTED_PLATFORM');
  }

  // ---- 幽魂光标叠加（纯可视化：fire-and-forget，失败/关闭/无 helper 都零影响） ----

  /** 叠加开关（policy-defaults.json 的 cuaOverlay，默认开）。 */
  function overlayEnabled() { return policy ? policy.rules.cuaOverlay !== false : true; }

  /** 在 (x,y) 闪一次叠加（kind: 'arrow'|'click'）。绝不被 await，失败自吞。 */
  function overlayShow(x, y, kind) {
    if (!overlayEnabled()) return;
    const h = helper();
    if (!h) return; // B/C 层无叠加能力：跳过（不影响任何动作）
    h.request('overlay-show', { x, y, kind }).catch(() => { /* 叠加失败绝不影响真实动作 */ });
  }

  /** type/key 前的「在原地输入」提示：30 秒内点击过 → 在最近点击位置闪 arrow。 */
  function overlayTypingHint() {
    if (!lastClick || clock() - lastClick.atMs > OVERLAY_HINT_MS) return;
    overlayShow(lastClick.x, lastClick.y, 'arrow');
  }

  // ---- 探测 ----

  /** osascript 探测 AX：System Events 可用 → true；未授权 → false；其他失败 → null。 */
  async function probeAxViaOsa() {
    try {
      await osa(execRunner, osaFrontmostPid(), 5000);
      return true;
    } catch (err) {
      if (err.code === 'AX_NOT_GRANTED') return false;
      return null; // osascript 缺失/损坏等，未知
    }
  }

  /** 助手 probe；未编译/失败返回 null（失败带 reason 由 status 展示）。 */
  async function probeViaHelper() {
    const h = helper();
    if (!h) return null;
    try {
      const r = await h.request('probe');
      return {
        axGranted: r.axGranted === true,
        screenGranted: r.screenGranted === true,
        ...(r.screen?.w && r.screen?.h ? { screen: { w: r.screen.w, h: r.screen.h } } : {}), // 主屏尺寸（自检定位叠加用）
        ...(typeof r.responsibleProcess === 'string' && r.responsibleProcess ? { responsibleProcess: r.responsibleProcess } : {}), // 设置里要勾选的宿主 App 名
      };
    } catch (err) {
      return { axGranted: null, screenGranted: null, reason: err.message };
    }
  }

  /**
   * 能力矩阵与层级。tier：A（helper+AX）/ B（osascript+AX）/ C（无 AX）/ unsupported。
   */
  async function status() {
    if (!isMac()) {
      return {
        supported: false, tier: 'unsupported', platform: process.platform,
        helperCompiled: false, swiftcAvailable: false,
        axGranted: null, screenGranted: null, screen: null,
        responsibleProcess: null, permissionGuide: null,
        overlay: { available: false, enabled: overlayEnabled() },
        capabilities: emptyCaps(), guidance: ['屏幕操作（CUA）仅支持 macOS，本平台不可用'],
      };
    }
    const compiled = helperCompiled();
    let axGranted = null;
    let screenGranted = null;
    let screen = null;
    let responsibleProcess = null;
    let probeReason = null;
    if (compiled) {
      const p = await probeViaHelper();
      axGranted = p?.axGranted ?? null;
      screenGranted = p?.screenGranted ?? null;
      screen = p?.screen ?? null;
      responsibleProcess = p?.responsibleProcess ?? null;
      probeReason = p?.reason ?? null;
    } else {
      axGranted = await probeAxViaOsa();
      screenGranted = null; // 无 helper 时无法可靠预检屏幕录制授权（截图按需试）
    }
    const tier = axGranted === true ? (compiled ? 'A' : 'B') : 'C';
    const missing = missingPermissions({ axGranted, screenGranted });
    const guideText = missing.ax || missing.screen ? permissionGuideText({ responsibleProcess, ...missing }) : null;
    const guidance = [];
    if (tier === 'C') guidance.push(`辅助功能未授权（或未知）：${AX_GUIDANCE}`);
    if (!compiled) guidance.push('未编译 A 层助手 host/cua-helper：跑一次 npm run setup 自动编译（需 swiftc）；无 swiftc 时以 B 层（osascript）运行，无坐标点击能力');
    if (screenGranted !== true) guidance.push(`屏幕录制未授权或未知：${SCREEN_GUIDANCE}`);
    return {
      supported: true,
      tier,
      platform: 'darwin',
      helperCompiled: compiled,
      swiftcAvailable: swiftcPath() !== null,
      axGranted,
      screenGranted,
      responsibleProcess, // TCC 记账的宿主 App 名（设置列表里要勾选的就是它；B/C 层无 helper 时为 null）
      // 人话授权指引（v0.5.4 起为对象）：text=两步说明；card=有无悬浮引导卡片能力（仅 A 层 helper 有窗口）
      permissionGuide: guideText ? { text: guideText, card: compiled } : null,
      ...(screen ? { screen } : {}),
      overlay: { available: compiled, enabled: overlayEnabled() }, // 幽魂光标：仅 A 层（helper 叠加窗）
      ...(probeReason ? { probeError: probeReason } : {}),
      capabilities: capsFor(tier, compiled),
      guidance,
    };
  }

  /**
   * 向系统申请辅助功能与屏幕录制权限（v0.5.3）：helper 弹标准系统对话框，并把负责进程
   * （宿主终端/应用）注册进设置列表（未勾选）；立即返回，不阻塞等用户操作。
   * 用户在系统设置勾选后经 status()/probe 复测生效。引导编排见 service/cua-guide.mjs。
   */
  async function requestPermissions() {
    requireMac();
    const h = helper();
    if (!h) throw new CuaError('权限申请需要 A 层助手 host/cua-helper（先跑 npm run setup 编译）', 'CAPABILITY_UNAVAILABLE');
    const r = await h.request('request-permissions');
    return {
      axGranted: r.axGranted === true,
      axRequested: r.axRequested === true,
      screenGranted: r.screenGranted === true,
      screenRequested: r.screenRequested === true,
      responsibleProcess: typeof r.responsibleProcess === 'string' && r.responsibleProcess ? r.responsibleProcess : null,
    };
  }

  /**
   * 显示权限引导悬浮卡片（v0.5.4，A 层）：申请权限的同时在系统设置旁边浮一张可拖拽
   * 的琥珀卡片——卡片图标句柄拖出的就是负责进程的 .app bundle，可直接放进设置列表；
   * durationSec 秒后自动淡出（默认由引导层给 120）。失败安全：引导层吞错降级为纯文字。
   */
  async function showPermissionCard({ kind, appName, durationSec } = {}) {
    requireMac();
    const k = String(kind ?? '');
    if (!CARD_KINDS.includes(k)) throw new CuaError('kind 需为 accessibility 或 screen', 'BAD_ARGS');
    const h = helper();
    if (!h) throw new CuaError('引导卡片需要 A 层助手 host/cua-helper（先跑 npm run setup 编译）', 'CAPABILITY_UNAVAILABLE');
    const r = await h.request('show-permission-card', {
      kind: k,
      appName: typeof appName === 'string' && appName ? appName : '',
      ...(Number.isInteger(durationSec) ? { durationSec } : {}),
    });
    return {
      kind: k,
      ok: true,
      ...(r.frame ? { frame: r.frame } : {}),
      dragFrom: typeof r.dragFrom === 'string' && r.dragFrom ? r.dragFrom : null, // 拖拽句柄 promise 的 .app 路径（找不到时 null）
    };
  }

  /** 隐藏对应引导卡片（幂等；引导结束/权限到手时收卡）。 */
  async function hidePermissionCard(kind) {
    requireMac();
    const k = String(kind ?? '');
    if (!CARD_KINDS.includes(k)) throw new CuaError('kind 需为 accessibility 或 screen', 'BAD_ARGS');
    const h = helper();
    if (!h) throw new CuaError('引导卡片需要 A 层助手 host/cua-helper（先跑 npm run setup 编译）', 'CAPABILITY_UNAVAILABLE');
    await h.request('hide-permission-card', { kind: k });
    return { kind: k, hidden: true };
  }

  /**
   * 直接打开系统设置的对应隐私面板（accessibility / screen）。配合 requestPermissions：
   * 弹完系统对话框后把面板开到正确 section，省掉用户自己找路径。
   */
  async function openPrivacyPane(kind = 'accessibility') {
    requireMac();
    const k = CARD_KINDS.includes(kind) ? kind : 'accessibility';
    const r = await execRunner('open', [PRIVACY_PANE_URL[k]], { timeoutMs: 5000 });
    if (r.code !== 0) throw new CuaError(`打开系统设置面板失败（open exit ${r.code}${r.stderr ? `: ${String(r.stderr).slice(0, 120)}` : ''}）`, 'OPEN_PANE_FAILED');
    return { ok: true, pane: k };
  }

  const CAP_KEYS = ['windows', 'axTree', 'elementClick', 'xyClick', 'type', 'key', 'appFocus', 'screenshot'];
  function emptyCaps() { return Object.fromEntries(CAP_KEYS.map((k) => [k, false])); }
  function capsFor(tier, compiled) {
    if (tier === 'A') return Object.fromEntries(CAP_KEYS.map((k) => [k, true]));
    if (tier === 'B') return { windows: true, axTree: true, elementClick: true, xyClick: false, type: true, key: true, appFocus: true, screenshot: true };
    // C：windows 仅在 helper 编译过时可用（CGWindowList 无需授权）；截图需屏幕录制授权
    return { ...emptyCaps(), windows: compiled, screenshot: true };
  }

  /** 当前必须具备某能力，否则抛带指引的错误。 */
  async function requireCap(name) {
    const st = await status();
    if (st.capabilities[name]) return st;
    const need = { A: 'A 层（编译 host/cua-helper 且授予辅助功能）', B: 'B 层（osascript + 辅助功能授权）' };
    const reason = st.tier === 'C'
      ? `辅助功能未授权（${st.guidance[0] ?? AX_GUIDANCE}）`
      : `当前 ${st.tier} 层不具备 ${name}（需要 ${st.tier === 'B' ? need.A : need.B}）`;
    throw new CuaError(`${name} 在当前能力层不可用：${reason}`, 'CAPABILITY_UNAVAILABLE');
  }

  // ---- pid 解析 ----

  async function pidByName(app) {
    const name = String(app ?? '').trim();
    if (!name) throw new CuaError('需要 app（应用名）或 pid', 'BAD_TARGET');
    try {
      const out = await osa(execRunner, osaPidByName(name));
      const pid = Number.parseInt(out.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (err) {
      if (err.code === 'AX_NOT_GRANTED') throw err;
      // osascript 按名找不到（或非 AX 环境）→ helper 窗口清单兜底
    }
    const h = helper();
    if (h) {
      const r = await h.request('windows');
      const hit = (r.windows ?? []).find((w) => (w.ownerName ?? '') === name);
      if (hit) return hit.ownerPid;
    }
    throw new CuaError(`未找到应用进程: ${name}（先用 cua_windows 看实际窗口/进程名）`, 'APP_NOT_FOUND');
  }

  async function frontmostPid() {
    const out = await osa(execRunner, osaFrontmostPid());
    const pid = Number.parseInt(out.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) throw new CuaError('无法确定前台应用（osascript 未返回 unix id）', 'NO_FRONTMOST');
    return pid;
  }

  async function resolvePid({ pid, app }) {
    if (Number.isInteger(pid) && pid > 0) return pid;
    if (app) return pidByName(app);
    return frontmostPid();
  }

  // ---- 读类 ----

  /** 窗口清单（A：CGWindowList；B：System Events；C+helper：CGWindowList）。 */
  async function windows() {
    requireMac();
    const h = helper();
    if (h) {
      const r = await h.request('windows');
      const wins = r.windows ?? [];
      return enrichTitles(wins); // CGWindowList 的标题受屏幕录制授权限制，空时用 System Events 补
    }
    await requireCap('windows');
    return osaWindows();
  }

  /** B 层窗口清单：解析 System Events 输出（每行 owner \t pid \t title \t x,y,w,h）。 */
  async function osaWindows() {
    const out = await osa(execRunner, osaWindowsScript());
    return out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [owner, pidStr, title, bounds] = line.split('\t');
      const nums = (bounds ?? '').split(',').map((n) => Number(n) || 0);
      return {
        windowId: null, // System Events 拿不到 CGWindowID：B 层截图请用 rect
        ownerPid: Number.parseInt(pidStr, 10) || 0,
        ownerName: owner ?? '',
        title: title ?? '',
        bounds: { x: nums[0] ?? 0, y: nums[1] ?? 0, w: nums[2] ?? 0, h: nums[3] ?? 0 },
        onScreen: true,
      };
    });
  }

  /**
   * helper 窗口标题补全：macOS 对 CGWindowList 的 kCGWindowName 按屏幕录制授权裁剪
   * （授权归属不完全可控，常见全空）。全空时用 System Events 的标题回填——按
   * ownerPid + 位置就近匹配（两套 API 的坐标存在 1~2px 系统差，容差 4px）；失败
   * 原样返回（标题空着也如实）。
   */
  async function enrichTitles(helperWins) {
    if (!helperWins.length || helperWins.some((w) => typeof w.title === 'string' && w.title)) return helperWins;
    try {
      const osaWins = (await osaWindows()).filter((w) => w.title);
      if (!osaWins.length) return helperWins;
      return helperWins.map((w) => {
        const x = w.bounds?.x ?? 0;
        const y = w.bounds?.y ?? 0;
        // 同 pid 内位置最近且在容差内的 System Events 窗口
        let best = null;
        let bestDist = Infinity;
        for (const o of osaWins) {
          if (o.ownerPid !== w.ownerPid) continue;
          const dist = Math.abs(o.bounds.x - x) + Math.abs(o.bounds.y - y);
          if (dist < bestDist) { bestDist = dist; best = o; }
        }
        // 容差外但该 pid 在两边都只有一个窗口 → 按唯一性认领
        const osaOfPid = osaWins.filter((o) => o.ownerPid === w.ownerPid);
        const helperOfPid = helperWins.filter((h2) => h2.ownerPid === w.ownerPid);
        if (best && (bestDist <= 8 || (osaOfPid.length === 1 && helperOfPid.length === 1))) return { ...w, title: best.title };
        return w;
      });
    } catch {
      return helperWins; // AX 不可用等：保持 helper 原样（标题为空）
    }
  }

  /** 界面元素清单（AI 找「按钮叫什么」用）。A：AX 遍历（快）；B：osascript（慢、同形状）。 */
  async function axTree({ app, pid, maxDepth } = {}) {
    requireMac();
    await requireCap('axTree');
    const depth = Math.max(1, Math.min(Number.isInteger(maxDepth) ? maxDepth : 12, 12));
    const targetPid = await resolvePid({ pid, app });
    const h = helper();
    if (h) {
      const r = await h.request('ax-tree', { pid: targetPid, maxDepth: depth });
      return { pid: targetPid, nodes: r.nodes ?? [], truncated: r.truncated === true, via: 'helper' };
    }
    const out = await osa(execRunner, osaAxTreeScript(targetPid, depth, 1500));
    const nodes = out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [d, role, title, value, bounds] = line.split('\t');
      const nums = (bounds ?? '').split(',').map((n) => Number(n) || 0);
      const node = { depth: Number.parseInt(d, 10) || 0, role: role ?? '' };
      if (title) node.title = title.slice(0, 120);
      if (value) node.value = value.slice(0, 120);
      if (nums.length === 4 && (nums[2] > 0 || nums[3] > 0)) node.bounds = { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
      return node;
    });
    return { pid: targetPid, nodes, truncated: nodes.length >= 1500, via: 'osascript' };
  }

  /**
   * 截图（三层通用：screencapture 子进程）。
   * @param {{windowId?: number, rect?: {x:number,y:number,w:number,h:number}, format?: 'png'|'jpeg'}} spec
   * @returns {{dataBase64: string, bytes: number, mimeType: string, windowId?: number, rect?: object}}
   */
  async function screenshot({ windowId, rect, format = 'png' } = {}) {
    requireMac();
    const fmt = format === 'jpeg' ? 'jpeg' : 'png';
    const args = ['-x'];
    if (windowId !== undefined) {
      if (!Number.isInteger(windowId) || windowId <= 0) throw new CuaError('windowId 需为正整数（cua_windows 返回的 windowId）', 'BAD_ARGS');
      args.push(`-l${windowId}`);
    } else if (rect) {
      const { x, y, w, h } = rect ?? {};
      for (const [name, v] of [['x', x], ['y', y], ['w', w], ['h', h]]) {
        if (!Number.isFinite(v) || v < 0) throw new CuaError(`rect.${name} 需为非负数字`, 'BAD_ARGS');
      }
      args.push(`-R${x},${y},${w},${h}`);
    }
    const file = join(os.tmpdir(), `cua-shot-${process.pid}-${Date.now()}.${fmt === 'jpeg' ? 'jpg' : 'png'}`);
    args.push(file);
    const r = await execRunner('screencapture', args, { timeoutMs: SHOT_TIMEOUT_MS });
    let data = null;
    try {
      if (r.code === 0) data = readFileSync(file);
    } catch { /* 读不到按失败处理 */ }
    finally { try { rmSync(file, { force: true }); } catch { /* 清理失败无碍 */ } }
    if (!data || data.length === 0) {
      throw new CuaError(`截图失败（screencapture exit ${r.code}${r.stderr ? `: ${String(r.stderr).slice(0, 200)}` : ''}）。若已能列出窗口但截不到：${SCREEN_GUIDANCE}`, 'SCREEN_CAPTURE_FAILED');
    }
    return {
      dataBase64: data.toString('base64'),
      bytes: data.length,
      mimeType: fmt === 'jpeg' ? 'image/jpeg' : 'image/png',
      ...(windowId !== undefined ? { windowId } : {}),
      ...(rect ? { rect } : {}),
    };
  }

  // ---- 证据（物理验证） ----

  /** 动作前证据：目标区域截图（JPEG 控制体积）；失败降级为 none（不阻塞动作）。 */
  async function snapshotEvidence(target) {
    try {
      const spec = target?.windowId
        ? { windowId: target.windowId, format: 'jpeg' }
        : target?.rect ? { rect: target.rect, format: 'jpeg' } : { format: 'jpeg' };
      const shot = await screenshot(spec);
      return { kind: 'screenshot', takenAt: isoNow(), dataBase64: shot.dataBase64, bytes: shot.bytes, ...(target?.windowId ? { windowId: target.windowId } : {}), ...(target?.rect ? { rect: target.rect } : {}) };
    } catch (err) {
      return { kind: 'none', takenAt: isoNow(), reason: String(err.message ?? err) };
    }
  }

  /**
   * 找 pid 的屏上窗口对应的证据目标（A 层有 windowId；B 层退化为窗口 rect）。
   * 附 overlayPos（窗口 bounds 中心）：元素点击的幽魂光标近似位置（AX press 无坐标语义）。
   */
  async function evidenceTargetForPid(pid) {
    try {
      const list = await windows();
      const win = list.find((w) => w.ownerPid === pid && w.onScreen) ?? list.find((w) => w.ownerPid === pid);
      if (!win) return null;
      const hasBounds = win.bounds && (win.bounds.w > 0 || win.bounds.h > 0);
      let target = null;
      if (win.windowId) target = { windowId: win.windowId };
      else if (hasBounds) target = { rect: win.bounds };
      if (!target) return null;
      if (hasBounds) target.overlayPos = { x: win.bounds.x + win.bounds.w / 2, y: win.bounds.y + win.bounds.h / 2 };
      return target;
    } catch { /* 窗口清单拿不到 → 全屏证据 */ }
    return null;
  }

  function recordAction(action, before) { lastEvidence = { action, before, ts: isoNow() }; }

  // ---- 动作类 ----

  /**
   * 点击。元素模式 {app?|pid, role, title?}：AX press 优先（A 层失败自动坐标兜底）；
   * 坐标模式 {x, y, pid?}：仅 A 层；有 pid 定向投递（不动真实光标），无 pid 全局（会动）。
   */
  async function click({ app, pid, role, title, x, y } = {}) {
    requireMac();
    const xyMode = x !== undefined || y !== undefined;
    if (xyMode) {
      await requireCap('xyClick');
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CuaError('坐标点击需要 x/y（数字，屏幕像素）', 'BAD_ARGS');
      const h = helper();
      if (!h) throw new CuaError('坐标点击需要 A 层助手 host/cua-helper（npm run setup 编译）', 'CAPABILITY_UNAVAILABLE');
      const target = { rect: { x: Math.max(0, x - 240), y: Math.max(0, y - 160), w: 480, h: 320 } };
      const before = await snapshotEvidence(target);
      audit?.recordCua({ tool: 'click', mode: 'xy', pid, x, y });
      recordAction({ tool: 'cua_click', mode: 'xy', x, y, pid }, before);
      overlayShow(x, y, 'click'); // 幽魂光标：注入前闪现（前证据已取完，不污染物理验证）
      lastClick = { x, y, atMs: clock() };
      const r = await h.request('xy-click', { x, y, ...(pid ? { pid } : {}) });
      return { ok: true, mode: 'xy', x, y, targeted: r.targeted === true, ...(r.note ? { note: r.note } : {}) };
    }

    // 元素模式（AX 优先）
    await requireCap('elementClick');
    if (!role) throw new CuaError('元素点击需要 role（配合 title，来自 cua_ax_tree）', 'BAD_ARGS');
    const targetPid = await resolvePid({ pid, app });
    const beforeTarget = await evidenceTargetForPid(targetPid);
    const before = await snapshotEvidence(beforeTarget);
    audit?.recordCua({ tool: 'click', mode: 'element', app, pid: targetPid, role, title });
    recordAction({ tool: 'cua_click', mode: 'element', app, pid: targetPid, role, title }, before);
    // 幽魂光标：元素模式取目标窗口中心近似（AX press 无坐标语义），坐标兜底应答后精化到真实落点
    if (beforeTarget?.overlayPos) {
      overlayShow(beforeTarget.overlayPos.x, beforeTarget.overlayPos.y, 'click');
      lastClick = { ...beforeTarget.overlayPos, atMs: clock() };
    } else {
      lastClick = null; // 位置未知时不给 type/key 提示陈旧坐标
    }
    const h = helper();
    if (h) {
      const r = await h.request('element-click', { pid: targetPid, role, ...(title ? { title } : {}) });
      if (Array.isArray(r.at) && Number.isFinite(r.at[0]) && Number.isFinite(r.at[1])) {
        lastClick = { x: r.at[0], y: r.at[1], atMs: clock() }; // xyFallback 的真实落点
      }
      return {
        ok: true, mode: 'element', pid: targetPid, role,
        ...(r.pressed ? { pressed: true } : { xyFallback: true, bounds: r.bounds, at: r.at }),
      };
    }
    await osa(execRunner, osaElementClickScript(targetPid, role, title ?? ''));
    return { ok: true, mode: 'element', pid: targetPid, role, pressed: true, via: 'osascript' };
  }

  /** 输入文本（进前台/目标应用；A 层可定向 pid）。text 脱敏入审计。 */
  async function type({ text, app, pid } = {}) {
    requireMac();
    await requireCap('type');
    if (typeof text !== 'string' || !text.length) throw new CuaError('type 需要 text（非空字符串）', 'BAD_ARGS');
    if (text.length > TYPE_MAX_CHARS) throw new CuaError(`text 过长（>${TYPE_MAX_CHARS} 字符），请分段输入`, 'TEXT_TOO_LONG');
    const targetPid = pid ?? (app ? await pidByName(app) : null);
    const beforeTarget = await evidenceTargetForPid(targetPid ?? (await frontmostPid().catch(() => null) ?? 0));
    const before = await snapshotEvidence(beforeTarget);
    audit?.recordCua({ tool: 'type', pid: targetPid, app, text });
    recordAction({ tool: 'cua_type', app, pid: targetPid, chars: text.length }, before);
    overlayTypingHint(); // 30 秒内点击过 → 在最近点击位置闪 arrow（提示「在原地输入」）
    const h = helper();
    if (h) {
      const r = await h.request('type', { text, ...(targetPid ? { pid: targetPid } : {}) });
      return { ok: true, chars: r.chars ?? text.length, ...(targetPid ? { pid: targetPid } : {}) };
    }
    await osa(execRunner, osaTypeScript(text, app ?? null));
    return { ok: true, chars: text.length, via: 'osascript' };
  }

  /**
   * 按键/组合键。危险组合（默认 cmd+q / cmd+w）过确认门：抛
   * {needsConfirmation, description, token}，批准后带 confirmationToken 重试。
   */
  async function key({ key: keyName, modifiers, app, pid, confirmationToken } = {}) {
    requireMac();
    await requireCap('key');
    if (!keyName) throw new CuaError('key 需要键名（enter/tab/escape/a…；修饰键走 modifiers）', 'BAD_ARGS');
    const lowered = String(keyName).toLowerCase();
    if (!(lowered in KEY_CODES)) {
      throw new CuaError(`不支持的键名: ${keyName}（字母/数字/enter/tab/escape/space/delete/方向键/home/end/pageup/pagedown/f1-f12）`, 'UNKNOWN_KEY');
    }
    const mods = normModifiers(modifiers);
    if (policy) {
      const v = policy.check({ kind: 'cua_action', tool: 'cua_key', combo: keyCombo(lowered, mods) }, confirmationToken ? { confirmationToken } : {});
      if (v.needConfirmation) {
        const err = new CuaError(v.description, 'POLICY_BLOCKED');
        err.needsConfirmation = true;
        err.description = v.description;
        err.token = v.token;
        throw err;
      }
      if (!v.allowed) throw new CuaError(v.reason ?? 'policy blocked', v.code ?? 'POLICY_BLOCKED');
    }
    const targetPid = pid ?? (app ? await pidByName(app) : null);
    const beforeTarget = await evidenceTargetForPid(targetPid ?? (await frontmostPid().catch(() => null) ?? 0));
    const before = await snapshotEvidence(beforeTarget);
    audit?.recordCua({ tool: 'key', key: lowered, modifiers: mods, pid: targetPid, app });
    recordAction({ tool: 'cua_key', key: lowered, modifiers: mods, pid: targetPid }, before);
    overlayTypingHint(); // 同 type：30 秒窗口内的原地输入提示
    const h = helper();
    if (h) {
      const r = await h.request('key', { key: lowered, modifiers: mods, ...(targetPid ? { pid: targetPid } : {}) });
      return { ok: true, key: lowered, keyCode: r.keyCode, ...(mods.length ? { modifiers: mods } : {}), ...(targetPid ? { pid: targetPid } : {}) };
    }
    await osa(execRunner, osaKeyScript(KEY_CODES[lowered], mods, app ?? null));
    return { ok: true, key: lowered, ...(mods.length ? { modifiers: mods } : {}), via: 'osascript' };
  }

  /** 把应用带到前台（AX raise + activate / System Events frontmost）。 */
  async function appFocus({ app } = {}) {
    requireMac();
    await requireCap('appFocus');
    if (!app) throw new CuaError('app_focus 需要 app（应用名，cua_windows 的 ownerName）', 'BAD_ARGS');
    const pid = await pidByName(app);
    const beforeTarget = await evidenceTargetForPid(pid);
    const before = await snapshotEvidence(beforeTarget);
    audit?.recordCua({ tool: 'app_focus', app, pid });
    recordAction({ tool: 'cua_app_focus', app, pid }, before);
    const h = helper();
    if (h) {
      const r = await h.request('app-focus', { pid });
      return { ok: true, app, pid, axRaised: r.axRaised === true, appActivated: r.appActivated === true };
    }
    await osa(execRunner, osaAppFocusScript(app));
    return { ok: true, app, pid, via: 'osascript' };
  }

  /**
   * 物理验证：动作执行后取「后证据」，与上一动作的「前证据」成对返回。
   * 声称已点击不算数——调用方（模型/人）必须核对两份证据确认界面真的变了。
   */
  async function verify({ x, y, windowId } = {}) {
    requireMac();
    const last = lastEvidence;
    let target = null;
    if (Number.isInteger(windowId) && windowId > 0) target = { windowId };
    else if (Number.isFinite(x) && Number.isFinite(y)) target = { rect: { x: Math.max(0, x - 240), y: Math.max(0, y - 160), w: 480, h: 320 } };
    else if (last?.action?.pid) target = await evidenceTargetForPid(last.action.pid);
    else if (last?.action?.mode === 'xy' && Number.isFinite(last.action.x)) {
      target = { rect: { x: Math.max(0, last.action.x - 240), y: Math.max(0, last.action.y - 160), w: 480, h: 320 } };
    }
    const after = await snapshotEvidence(target);
    return {
      ok: true,
      note: '声称已点击不算数：请对比 before/after 两份截图证据，确认界面真的发生了预期变化；未变化说明动作没生效（元素不存在/层级遮挡/授权不足），应重取 ax_tree 再决策。',
      action: last?.action ?? null,
      before: last?.before ?? null,
      after,
      verifiedAt: isoNow(),
    };
  }

  /**
   * 幽魂光标试闪（cua-selftest/调试用）：在给定坐标闪一次叠加后自动淡出。
   * 只读可视化——不动任何应用、不记账；遵循 cuaOverlay 开关。
   */
  async function overlayFlash({ x, y, kind = 'arrow', durationMs } = {}) {
    requireMac();
    if (!overlayEnabled()) throw new CuaError('幽魂光标叠加已被 policy 关闭（cuaOverlay=false）', 'OVERLAY_DISABLED');
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CuaError('试闪需要 x/y（数字，屏幕坐标）', 'BAD_ARGS');
    const h = helper();
    if (!h) throw new CuaError('幽魂光标叠加需要 A 层助手 host/cua-helper（npm run setup 编译）', 'CAPABILITY_UNAVAILABLE');
    return h.request('overlay-show', { x, y, kind, ...(Number.isInteger(durationMs) ? { durationMs } : {}) });
  }

  return {
    status,
    requestPermissions,
    showPermissionCard,
    hidePermissionCard,
    openPrivacyPane,
    windows,
    axTree,
    screenshot,
    click,
    type,
    key,
    appFocus,
    verify,
    overlayFlash,
    /** 结束常驻助手进程（会话退出时调用）。 */
    stop() { helperClient?.stop(); },
  };
}

// ---------- MCP 工具注册（9 个 cua_* 工具；文本结果风格与 mcp.mjs 一致） ----------

function textResult(payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const content = [{ type: 'text', text }];
  return isError ? { content, isError: true } : { content };
}

function errPayload(err) {
  const p = { error: String((err && err.message) || err) };
  if (err && err.code !== undefined) p.code = err.code;
  return p;
}

/**
 * 在 MCP 服务器上注册 cua_* 工具族。
 * @param {object} server McpServer 实例
 * @param {{cua: object}} opts cua = createCua() 的返回值
 */
export function registerCuaTools(server, { cua }) {
  const guard = (fn) => async (args) => {
    try { return await fn(args); } catch (err) { return textResult(errPayload(err), true); }
  };

  server.registerTool('cua_status', {
    title: '屏幕操作能力体检',
    description: '探测屏幕操作（CUA）当前能力层并给授权指引。返回 {tier, axGranted, screenGranted, responsibleProcess, permissionGuide, helperCompiled, swiftcAvailable, overlay, capabilities, guidance}：tier A=编译版助手（最强，坐标可定向投递）/ B=osascript 兜底（无坐标点击）/ C=无授权（仅窗口清单与截图）/ unsupported=非 macOS；responsibleProcess=系统设置里要勾选的终端/应用名，permissionGuide=人话授权指引（v0.5.4 起 {text, card}：text=两步说明，card=有无悬浮引导卡片——申请权限时屏幕上会浮一张可拖进系统设置列表的琥珀卡片）；overlay={available, enabled} 报告幽魂光标叠加（AI 动手位置的琥珀色提示，policy-defaults.json 的 cuaOverlay 可关）。缺权限时首次使用会自动引导授权：npm run cua-selftest（互动引导）或 npm run setup（非交互）会自动向系统申请并一步步带你勾选。首次使用 cua_* 前先跑这个。',
    inputSchema: {},
  }, guard(async () => textResult(await cua.status())));

  server.registerTool('cua_windows', {
    title: '列出可交互窗口',
    description: '列出当前屏幕上的窗口（ownerName/ownerPid/title/bounds/onScreen/windowId）。只读；用于确定目标应用与窗口（windowId 供 cua_screenshot 精确截窗）。标题来自系统窗口表、为空时用无障碍接口回填；个别仍为空属系统隐私裁剪（如实返回）。',
    inputSchema: {},
  }, guard(async () => textResult({ windows: await cua.windows() })));

  server.registerTool('cua_ax_tree', {
    title: '读界面元素清单（无障碍树）',
    description: '读取目标应用的无障碍树（AI 找「按钮叫什么」用）：节点 {depth, role, title?, value?, bounds?, actions?}。给 app（应用名）或 pid；都不给=前台应用。限额：深度 12、每层 80、总 1500 节点、文本截断 120 字符。配合 cua_click 的 role/title 精确点击，比看截图猜坐标可靠。',
    inputSchema: {
      app: z.string().optional().describe('目标应用名（cua_windows 的 ownerName）'),
      pid: z.number().int().optional().describe('目标进程 id（优先于 app）'),
      maxDepth: z.number().int().optional().describe('遍历深度上限（1..12，默认 12）'),
    },
  }, guard(async ({ app, pid, maxDepth }) => textResult(await cua.axTree({ app, pid, maxDepth }))));

  server.registerTool('cua_screenshot', {
    title: '屏幕/窗口截图',
    description: '截取屏幕画面返回 PNG（可选 jpeg）：不给参数=全屏；windowId=指定窗口；rect={x,y,w,h}=指定区域。经本机 screencapture 执行，需屏幕录制授权（未授权时报指引，或只截到桌面壁纸）。视觉核对用；找元素优先 cua_ax_tree。',
    inputSchema: {
      windowId: z.number().int().optional().describe('窗口 id（cua_windows 返回；仅 A/C 层有值）'),
      rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe('区域 {x,y,w,h}（屏幕像素）'),
      format: z.enum(['png', 'jpeg']).optional().describe('默认 png'),
    },
  }, guard(async ({ windowId, rect, format }) => {
    const shot = await cua.screenshot({ ...(windowId !== undefined ? { windowId } : {}), ...(rect !== undefined ? { rect } : {}), ...(format !== undefined ? { format } : {}) });
    return {
      content: [
        { type: 'text', text: `screenshot: ${shot.mimeType} bytes=${shot.bytes}${shot.windowId !== undefined ? ` windowId=${shot.windowId}` : ''}${shot.rect ? ` rect=${JSON.stringify(shot.rect)}` : ''}` },
        { type: 'image', data: shot.dataBase64, mimeType: shot.mimeType },
      ],
    };
  }));

  server.registerTool('cua_click', {
    title: '点击（元素优先，坐标兜底）',
    description: '两种模式：① 元素 {app|pid, role, title?}——AX 元素动作优先（语义正确），A 层失败自动取元素中心坐标兜底；role/title 来自 cua_ax_tree。② 坐标 {x, y, pid?}——仅 A 层；给 pid 定向投递（不动真实光标），不给 pid 全局投递（会移动真实光标，慎用）。动作会自动留「前证据」，配合 cua_verify 物理验证；点击位置闪现幽魂光标提示（叠加窗，policy 的 cuaOverlay 可关）。全审计。',
    inputSchema: {
      app: z.string().optional().describe('元素模式：目标应用名'),
      pid: z.number().int().optional().describe('目标进程 id（元素/坐标模式均可，坐标模式=定向投递）'),
      role: z.string().optional().describe('元素模式：AX 角色（如 AXButton）'),
      title: z.string().optional().describe('元素模式：元素标题（精确匹配，同角色多个时用它区分）'),
      x: z.number().optional().describe('坐标模式：屏幕 x（像素）'),
      y: z.number().optional().describe('坐标模式：屏幕 y（像素）'),
    },
  }, guard(async (args) => textResult(await cua.click(args))));

  server.registerTool('cua_type', {
    title: '输入文本',
    description: '向目标应用输入文本（给 app/pid 时 A 层定向投递、B 层先置前台；都不给=当前前台应用）。≤4000 字符。值脱敏入审计（记 [redacted] 与长度）。',
    inputSchema: {
      text: z.string().min(1).describe('要输入的文本（≤4000 字符，更长请分段）'),
      app: z.string().optional().describe('目标应用名（可选）'),
      pid: z.number().int().optional().describe('目标进程 id（可选，优先于 app）'),
    },
  }, guard(async (args) => textResult(await cua.type(args))));

  server.registerTool('cua_key', {
    title: '按键/组合键（危险键需确认）',
    description: '按一个键或组合键（key=键名，modifiers=[cmd|ctrl|alt|shift]）。默认 cmd+q（退程序）/ cmd+w（关窗）需人工确认：首次返回 {needConfirmation,token}，ab_confirm 批准后带 confirmationToken 重试（名单可在 policy-defaults.json 的 confirmCuaKeys 配置）。给 app/pid 时 A 层定向投递。',
    inputSchema: {
      key: z.string().min(1).describe('键名：字母/数字/enter/tab/escape/space/delete/up/down/left/right/home/end/pageup/pagedown/f1-f12'),
      modifiers: z.array(z.enum(['cmd', 'ctrl', 'alt', 'shift', 'command', 'control', 'option'])).optional().describe('修饰键'),
      app: z.string().optional().describe('目标应用名（可选）'),
      pid: z.number().int().optional().describe('目标进程 id（可选，优先于 app）'),
      confirmationToken: z.string().optional().describe('ab_confirm 批准后的一次性令牌（危险组合键第二次调用时带）'),
    },
  }, guard(async (args) => {
    try {
      return textResult(await cua.key(args));
    } catch (err) {
      if (err && err.needsConfirmation) {
        return textResult({ needConfirmation: true, description: err.description, token: err.token });
      }
      throw err;
    }
  }));

  server.registerTool('cua_app_focus', {
    title: '应用切前台',
    description: '把目标应用带到前台（A 层：AX raise 主窗口 + 激活；B 层：System Events 置 frontmost）。入参 app=应用名（cua_windows 的 ownerName）。',
    inputSchema: { app: z.string().min(1).describe('应用名（cua_windows 的 ownerName）') },
  }, guard(async (args) => textResult(await cua.appFocus(args))));

  server.registerTool('cua_verify', {
    title: '物理验证（动作前后证据）',
    description: '防幻觉验证：动作执行后取新证据（截图），与上一动作执行前的证据成对返回 {before, after, action}。声称已点击不算数——必须核对两份截图确认界面真的变了；没变=动作没生效，重取 cua_ax_tree 再决策。可选 x/y（验证坐标周边）或 windowId（验证指定窗口）；都不给=上一动作的目标。',
    inputSchema: {
      x: z.number().optional().describe('验证该坐标周边 480x320 区域'),
      y: z.number().optional().describe('配合 x'),
      windowId: z.number().int().optional().describe('验证指定窗口'),
    },
  }, guard(async (args) => textResult(await cua.verify(args))));
}
