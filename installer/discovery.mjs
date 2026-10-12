#!/usr/bin/env node
// installer/discovery.mjs — 浏览器发现 / 宿主清单诊断 / 打开窗口
//
//   - installed-browsers.js        —— 三平台已装浏览器探测
//   - chrome-is-running.js         —— 进程存活判定
//   - check-native-host-manifest.js —— 清单校验
//   - open-chrome-window.js        —— Profile 挑选与三平台启动命令
//
// CLI: node installer/discovery.mjs installed|check-manifest|open-window [--browser x] [--home dir]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BROWSERS, FAMILY_NAMES, MANIFEST_BASENAME, NATIVE_HOST_NAME, manifestPathsForFamily } from './install.mjs';

function runCommand(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function commandPath(command) {
  if (process.platform === 'win32') {
    const output = runCommand('where', [command]);
    return output ? output.split(/\r?\n/)[0] : null;
  }
  return runCommand('which', [command]);
}

// ---------------------------------------------------------------------------
// macOS 应用定位
// ---------------------------------------------------------------------------

function macosAppSearchDirs() {
  return ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
}

function mdfindAppsForBundleId(bundleId) {
  const output = runCommand('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`]);
  if (!output) return [];
  return output.split(/\r?\n/).filter((line) => line.endsWith('.app'));
}

function findMacosApp(family) {
  const browser = BROWSERS[family];
  for (const baseDir of macosAppSearchDirs()) {
    for (const appName of browser.macos.applicationNames) {
      const appPath = path.join(baseDir, appName);
      if (existsSync(appPath)) return appPath;
    }
  }
  for (const appPath of mdfindAppsForBundleId(browser.macos.bundleId)) {
    if (existsSync(appPath)) return appPath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Windows 可执行文件定位（注册表 App Paths + 标准目录 + where）
// ---------------------------------------------------------------------------

function readWindowsRegistryDefaultValue(keyPath) {
  const output = runCommand('reg', ['query', keyPath, '/ve']);
  if (!output) return null;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(.*?)\s+REG_\w+\s+(.+?)\s*$/);
    if (match && match[1] === '(Default)') return match[2].replace(/^"(.*)"$/, '$1');
  }
  return null;
}

function findWindowsExecutable(family) {
  const browser = BROWSERS[family].windows;
  const appPathKeys = browser.commandNames
    .filter((command) => command.endsWith('.exe'))
    .flatMap((command) => [
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${command}`,
      `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${command}`,
      `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${command}`,
    ]);
  const candidates = appPathKeys
    .map((key) => readWindowsRegistryDefaultValue(key))
    .filter(Boolean);

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  for (const root of [localAppData, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean)) {
    candidates.push(path.join(root, ...browser.installPathSegments));
  }
  for (const command of browser.commandNames) {
    const executable = commandPath(command);
    if (executable) candidates.push(executable);
  }
  for (const candidate of candidates) {
    if (existsSync(path.resolve(candidate))) return path.resolve(candidate);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 已装浏览器 + 存活
// ---------------------------------------------------------------------------

/** 进程存活：macOS/Linux 用 pgrep -x（缺 pgrep 时退回 ps 扫描 comm），Windows 用 tasklist。 */
export function isProcessRunning(family) {
  const platformConfig = process.platform === 'darwin'
    ? BROWSERS[family].macos
    : process.platform === 'win32'
      ? BROWSERS[family].windows
      : BROWSERS[family].linux;
  const processNames = platformConfig.processNames;

  if (process.platform === 'win32') {
    const output = runCommand('tasklist', ['/fo', 'csv', '/nh']);
    if (!output) return false;
    return processNames.some((name) =>
      new RegExp(`^"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}","\\d+"`, 'i').test(output.trim()) ||
      output.split(/\r?\n/).some((line) => line.toLowerCase().startsWith(`"${name.toLowerCase()}",`)));
  }

  for (const name of processNames) {
    if (runCommand('pgrep', ['-x', name])) return true;
  }
  // 兜底：pgrep 不可用时用 ps 扫描进程名列。
  const ps = runCommand('ps', ['-A', '-o', 'comm=']);
  if (ps) {
    const comms = new Set(ps.split('\n').map((line) => line.trim()));
    if (processNames.some((name) => comms.has(name))) return true;
  }
  return false;
}

/** 探测已装浏览器，返回 [{family, displayName, path, running}]。 */
export function installedBrowsers() {
  const found = [];
  for (const family of FAMILY_NAMES) {
    let browserPath = null;
    if (process.platform === 'darwin') {
      browserPath = findMacosApp(family);
    } else if (process.platform === 'win32') {
      browserPath = findWindowsExecutable(family);
    } else {
      for (const command of BROWSERS[family].linux.commands) {
        const executable = commandPath(command);
        if (executable) {
          browserPath = executable;
          break;
        }
      }
    }
    if (!browserPath) continue;
    found.push({ family, displayName: BROWSERS[family].displayName, path: browserPath, running: isProcessRunning(family) });
  }
  return found;
}

// ---------------------------------------------------------------------------
// 宿主清单诊断
// ---------------------------------------------------------------------------

/**
 * 校验某家族的原生宿主清单：
 *   存在 + JSON 合法 + name === com.chromeagentbrowser.host + path 指向存在的文件。
 * 返回 {ok, problems[], manifestPaths, checked[]}。
 */
export function checkNativeHostManifest(family, { home = os.homedir(), env = process.env } = {}) {
  if (!FAMILY_NAMES.includes(family)) {
    throw new Error(`unknown browser family: ${family}`);
  }
  const manifestPaths = manifestPathsForFamily(family, { home, env });
  const problems = [];
  const checked = [];
  let anyOk = false;

  for (const manifestPath of manifestPaths) {
    if (!existsSync(manifestPath)) continue;
    checked.push(manifestPath);
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      problems.push(`${manifestPath}: invalid JSON (${error.message})`);
      continue;
    }
    let valid = true;
    if (manifest.name !== NATIVE_HOST_NAME) {
      problems.push(`${manifestPath}: name is ${JSON.stringify(manifest.name)}, expected ${NATIVE_HOST_NAME}`);
      valid = false;
    }
    if (typeof manifest.path !== 'string' || manifest.path.length === 0 || !existsSync(manifest.path)) {
      problems.push(`${manifestPath}: host path does not exist: ${manifest.path}`);
      valid = false;
    }
    if (!Array.isArray(manifest.allowed_origins) || manifest.allowed_origins.length === 0) {
      problems.push(`${manifestPath}: allowed_origins is empty`);
      valid = false;
    }
    if (valid) anyOk = true;
  }

  if (checked.length === 0) {
    problems.push(`no ${MANIFEST_BASENAME} found in any of: ${manifestPaths.join(', ')}`);
  }
  // Windows：注册表键是否指向清单（仅提示，不作为 ok 的必要条件）。
  if (process.platform === 'win32') {
    const registryPath = readWindowsRegistryDefaultValue(`${BROWSERS[family].windows.registryRoot}\\${NATIVE_HOST_NAME}`);
    if (!registryPath) problems.push(`registry key has no value: ${BROWSERS[family].windows.registryRoot}\\${NATIVE_HOST_NAME}`);
  }

  return { ok: anyOk, problems, manifestPaths, checked };
}

// ---------------------------------------------------------------------------
// Profile 挑选（逻辑参考: open-chrome-window.js）
// ---------------------------------------------------------------------------

function isUsableProfile(userDataDir, profileDirectory) {
  if (typeof profileDirectory !== 'string' || profileDirectory.length === 0) return false;
  return existsSync(path.join(userDataDir, profileDirectory, 'Preferences'));
}

function profileSortKey(profileDirectory) {
  if (profileDirectory === 'Default') return 0;
  const match = profileDirectory.match(/^Profile (\d+)$/);
  if (!match) return -1;
  return Number(match[1]);
}

function latestUsableProfile(userDataDir, profileDirectories) {
  const usable = profileDirectories.filter((name) => isUsableProfile(userDataDir, name));
  if (usable.length === 0) return null;
  return usable.sort((a, b) => profileSortKey(a) - profileSortKey(b)).at(-1);
}

function resolveFromLocalState(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State');
  if (!existsSync(localStatePath)) return null;
  let localState;
  try {
    localState = JSON.parse(readFileSync(localStatePath, 'utf8'));
  } catch {
    return null;
  }
  const profile = localState?.profile;
  if (!profile || typeof profile !== 'object') return null;

  // 1) profile.last_used（可用性 = 目录里有 Preferences）
  if (isUsableProfile(userDataDir, profile.last_used)) return profile.last_used;
  // 2) last_active_profiles 里最新的可用项
  if (Array.isArray(profile.last_active_profiles)) {
    return latestUsableProfile(userDataDir, profile.last_active_profiles);
  }
  return null;
}

function findLatestProfileByScan(userDataDir) {
  if (!existsSync(userDataDir)) {
    throw new Error(`browser user data directory does not exist: ${userDataDir}`);
  }
  const names = readdirSync(userDataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
    .map((entry) => entry.name);
  return latestUsableProfile(userDataDir, names);
}

/**
 * 挑选要打开的 profile 目录名：
 *   Local State → profile.last_used（Preferences 存在才算可用）
 *   → last_active_profiles 中最新可用
 *   → 目录扫描 Default / Profile N 最新可用
 * 找不到任何可用 profile 时抛错。
 */
export function resolveProfileDirectory(userDataDir) {
  const fromLocalState = resolveFromLocalState(userDataDir);
  if (fromLocalState) return fromLocalState;
  const byScan = findLatestProfileByScan(userDataDir);
  if (byScan) return byScan;
  throw new Error(`could not find a profile directory with Preferences in ${userDataDir}`);
}

// ---------------------------------------------------------------------------
// 打开窗口（逻辑参考: open-chrome-window.js 的三平台启动命令）
// ---------------------------------------------------------------------------

export function openWindow(family, { dryRun = false, userDataDir = null } = {}) {
  if (!FAMILY_NAMES.includes(family)) {
    throw new Error(`unknown browser family: ${family}`);
  }
  const platformConfig = process.platform === 'darwin'
    ? BROWSERS[family].macos
    : process.platform === 'win32'
      ? BROWSERS[family].windows
      : BROWSERS[family].linux;

  if (!userDataDir) {
    userDataDir = path.join(os.homedir(), ...platformConfig.userDataDirectorySegments);
  }
  const profileDirectory = resolveProfileDirectory(userDataDir);
  const chromeArgs = [`--profile-directory=${profileDirectory}`, '--new-window', 'about:blank'];

  let command;
  let args;
  if (process.platform === 'darwin') {
    const appPath = findMacosApp(family);
    if (!appPath) throw new Error(`could not find the ${BROWSERS[family].displayName} app`);
    command = 'open';
    args = ['-n', '-a', appPath, '--args', ...chromeArgs];
  } else if (process.platform === 'win32') {
    const executable = findWindowsExecutable(family);
    if (!executable) throw new Error(`could not find the ${BROWSERS[family].displayName} executable`);
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', 'start', '""', executable, ...chromeArgs];
  } else {
    const commandName = BROWSERS[family].linux.commands.find((name) => commandPath(name) != null)
      ?? BROWSERS[family].linux.commands[0];
    command = commandName;
    args = chromeArgs;
  }

  const result = { family, browser: BROWSERS[family].displayName, command, args, profileDirectory };
  if (!dryRun) {
    execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usageText() {
  return [
    'Usage: node installer/discovery.mjs <installed|check-manifest|open-window> [options]',
    '',
    'Options:',
    '  --browser <chrome|edge|brave|opera|vivaldi>   browser family (default: chrome)',
    '  --home <dir>                                   override HOME (check-manifest sandboxing)',
    '  --dry-run                                      (open-window) print the command instead of running it',
    '  --json                                         machine-readable output',
  ].join('\n');
}

function parseCliArgs(argv) {
  const parsed = { command: null, browser: 'chrome', home: null, dryRun: false, json: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--browser') parsed.browser = next();
    else if (arg === '--home') parsed.home = path.resolve(next());
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usageText()}\n`);
      process.exit(0);
    } else if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}\n\n${usageText()}`);
    else positional.push(arg);
  }
  parsed.command = positional[0] ?? null;
  if (!['installed', 'check-manifest', 'open-window'].includes(parsed.command)) {
    throw new Error(`command must be installed|check-manifest|open-window\n\n${usageText()}`);
  }
  if (!FAMILY_NAMES.includes(parsed.browser)) {
    throw new Error(`--browser must be one of ${FAMILY_NAMES.join('|')}`);
  }
  return parsed;
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  let result;
  let exitCode = 0;

  if (parsed.command === 'installed') {
    result = { platform: process.platform, installed: installedBrowsers() };
  } else if (parsed.command === 'check-manifest') {
    result = checkNativeHostManifest(parsed.browser, { home: parsed.home ?? os.homedir() });
    if (!result.ok) exitCode = 1;
  } else {
    result = openWindow(parsed.browser, { dryRun: parsed.dryRun });
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = exitCode;
}

const isMain = () => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
};

if (isMain()) {
  main().catch((error) => {
    process.stderr.write(`discovery: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
