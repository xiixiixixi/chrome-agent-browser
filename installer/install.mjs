#!/usr/bin/env node
// installer/install.mjs — 原生宿主安装器
//
//   - 五家族(chrome/edge/brave/opera/vivaldi) × 三系统(darwin/linux/win32) 的
//     原生通信清单路径表、清单 JSON 字段、宿主配置文件结构、Windows 注册表策略。
//   - 全部为逻辑对照重写，未复制其字符串常量；本产品宿主名固定 com.chromeagentbrowser.host。
//
// 行为概要：
//   1. 定位仓库内 host/host.mjs；
//   2. 生成 shim 可执行脚本（Native Messaging 的 manifest.path 必须指向可执行文件）；
//   3. 为每个目标浏览器家族写 com.chromeagentbrowser.host.json 清单；
//   4. 把 host-config.json 写进仓库 host/（service 默认 127.0.0.1:7331）；
//      已存在且是本产品 → 覆盖前备份 .bak。

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 常量与家族表
// ---------------------------------------------------------------------------

export const NATIVE_HOST_NAME = 'com.chromeagentbrowser.host';
export const MANIFEST_BASENAME = `${NATIVE_HOST_NAME}.json`;
export const HOST_DESCRIPTION = 'Chrome Agent Browser native host';
export const DEFAULT_SERVICE_PORT = 7331;
export const DEFAULT_SERVICE_HOST = '127.0.0.1';
export const HOST_CONFIG_BASENAME = 'host-config.json';

// Windows：所有家族共用一个清单缓存目录（相对 HOME），注册表键指向该目录里的清单。
// 逻辑参考: installManifest.mjs 的 windowsNativeMessaging{manifestDirectory,registryRoot}。
export const WINDOWS_MANIFEST_DIR_SEGMENTS = ['AppData', 'Local', 'ChromeAgentBrowser', 'NativeMessagingHosts'];

/**
 * 家族表。每家族按平台给出：
 *   - 清单目录（darwin/linux 相对 HOME；win32 走 WINDOWS_MANIFEST_DIR_SEGMENTS + 注册表）
 *   - 进程名（discovery 判存活用）
 *   - 用户数据目录段（discovery 解析 profile 用）
 *   - Linux 命令名 / macOS 应用名+bundleId / Windows 命令名与安装路径段
 * Windows 各家族注册表根键：chrome 来自参考实现；其余为各浏览器公开文档的标准位置。
 */
export const BROWSERS = {
  chrome: {
    displayName: 'Google Chrome',
    linux: {
      commands: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'google-chrome-beta', 'google-chrome-unstable', 'google-chrome-for-testing'],
      nativeMessagingManifestDirectories: [
        '.config/google-chrome/NativeMessagingHosts',
        '.config/chromium/NativeMessagingHosts',
        '.config/google-chrome-beta/NativeMessagingHosts',
        '.config/google-chrome-unstable/NativeMessagingHosts',
        '.config/google-chrome-for-testing/NativeMessagingHosts',
      ],
      processNames: ['chrome'],
      userDataDirectorySegments: ['.config', 'google-chrome'],
    },
    macos: {
      applicationNames: ['Google Chrome.app'],
      bundleId: 'com.google.Chrome',
      nativeMessagingManifestDirectories: [
        'Library/Application Support/Google/Chrome/NativeMessagingHosts',
        'Library/Application Support/Chromium/NativeMessagingHosts',
        'Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts',
        'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts',
      ],
      processNames: ['Google Chrome', 'Google Chrome Helper'],
      userDataDirectorySegments: ['Library', 'Application Support', 'Google', 'Chrome'],
    },
    windows: {
      commandNames: ['chrome.exe', 'chrome'],
      registryRoot: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
      installPathSegments: ['Google', 'Chrome', 'Application', 'chrome.exe'],
      processNames: ['chrome.exe'],
      userDataDirectorySegments: ['Google', 'Chrome', 'User Data'],
    },
  },
  edge: {
    displayName: 'Microsoft Edge',
    linux: {
      commands: ['microsoft-edge', 'microsoft-edge-stable'],
      nativeMessagingManifestDirectories: ['.config/microsoft-edge/NativeMessagingHosts'],
      processNames: ['msedge'],
      userDataDirectorySegments: ['.config', 'microsoft-edge'],
    },
    macos: {
      applicationNames: ['Microsoft Edge.app'],
      bundleId: 'com.microsoft.edgemac',
      nativeMessagingManifestDirectories: ['Library/Application Support/Microsoft Edge/NativeMessagingHosts'],
      processNames: ['Microsoft Edge', 'Microsoft Edge Helper'],
      userDataDirectorySegments: ['Library', 'Application Support', 'Microsoft Edge'],
    },
    windows: {
      commandNames: ['msedge.exe', 'msedge'],
      registryRoot: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
      installPathSegments: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      processNames: ['msedge.exe'],
      userDataDirectorySegments: ['Microsoft', 'Edge', 'User Data'],
    },
  },
  brave: {
    displayName: 'Brave Browser',
    linux: {
      commands: ['brave-browser', 'brave-browser-stable', 'brave'],
      nativeMessagingManifestDirectories: ['.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'],
      processNames: ['brave', 'brave-browser'],
      userDataDirectorySegments: ['.config', 'BraveSoftware', 'Brave-Browser'],
    },
    macos: {
      applicationNames: ['Brave Browser.app'],
      bundleId: 'com.brave.Browser',
      nativeMessagingManifestDirectories: ['Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'],
      processNames: ['Brave Browser', 'Brave Browser Helper'],
      userDataDirectorySegments: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'],
    },
    windows: {
      commandNames: ['brave.exe', 'brave', 'brave-browser'],
      registryRoot: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
      installPathSegments: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      processNames: ['brave.exe'],
      userDataDirectorySegments: ['BraveSoftware', 'Brave-Browser', 'User Data'],
    },
  },
  opera: {
    displayName: 'Opera',
    linux: {
      commands: ['opera', 'opera-stable'],
      nativeMessagingManifestDirectories: ['.config/opera/NativeMessagingHosts'],
      processNames: ['opera'],
      userDataDirectorySegments: ['.config', 'opera'],
    },
    macos: {
      applicationNames: ['Opera.app'],
      bundleId: 'com.operasoftware.Opera',
      nativeMessagingManifestDirectories: ['Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts'],
      processNames: ['Opera', 'Opera Helper'],
      userDataDirectorySegments: ['Library', 'Application Support', 'com.operasoftware.Opera'],
    },
    windows: {
      commandNames: ['opera.exe', 'opera'],
      registryRoot: 'HKCU\\Software\\OperaSoftware\\Opera\\NativeMessagingHosts',
      installPathSegments: ['Opera', 'opera.exe'],
      processNames: ['opera.exe'],
      userDataDirectorySegments: ['Opera Software', 'Opera Stable'],
    },
  },
  vivaldi: {
    displayName: 'Vivaldi',
    linux: {
      commands: ['vivaldi', 'vivaldi-stable'],
      nativeMessagingManifestDirectories: ['.config/vivaldi/NativeMessagingHosts'],
      processNames: ['vivaldi', 'vivaldi-bin'],
      userDataDirectorySegments: ['.config', 'vivaldi'],
    },
    macos: {
      applicationNames: ['Vivaldi.app'],
      bundleId: 'com.vivaldi.Vivaldi',
      nativeMessagingManifestDirectories: ['Library/Application Support/Vivaldi/NativeMessagingHosts'],
      processNames: ['Vivaldi', 'Vivaldi Helper'],
      userDataDirectorySegments: ['Library', 'Application Support', 'Vivaldi'],
    },
    windows: {
      commandNames: ['vivaldi.exe', 'vivaldi'],
      registryRoot: 'HKCU\\Software\\Vivaldi\\NativeMessagingHosts',
      installPathSegments: ['Vivaldi', 'Application', 'vivaldi.exe'],
      processNames: ['vivaldi.exe'],
      userDataDirectorySegments: ['Vivaldi', 'User Data'],
    },
  },
  // Arc（The Browser Company，Chromium 内核）。本机未装 Arc，路径按 Chromium
  // 「用户数据目录下 NativeMessagingHosts」规则 + 公开资料实现；macOS 双写两个
  // 候选位置做保险；Windows 结构未实测。装了 Arc 的机器跑 npm run setup 即验证。
  arc: {
    displayName: 'Arc',
    backendCompatibilityKey: 'chrome',
    userAgentIdentifiers: ['Arc/', 'Chrome/'],
    internalUrlSchemes: ['arc', 'chrome'],
    extensionManagementUrl: 'chrome://extensions',
    linux: {
      commands: [],
      nativeMessagingManifestDirectories: [],
      processNames: [],
      userDataDirectorySegments: [],
    },
    macos: {
      applicationNames: ['Arc.app'],
      bundleId: 'company.thebrowser.Browser',
      nativeMessagingManifestDirectories: [
        'Library/Application Support/Arc/User Data/NativeMessagingHosts',
        'Library/Application Support/Arc/NativeMessagingHosts',
      ],
      processNames: ['Arc', 'Arc Helper'],
      userDataDirectorySegments: ['Library', 'Application Support', 'Arc', 'User Data'],
    },
    windows: {
      commandNames: ['Arc.exe', 'arc'],
      registryRoot: 'HKCU\\Software\\TheBrowserCompany\\Arc\\NativeMessagingHosts',
      installPathSegments: ['TheBrowserCompany', 'Arc', 'Application', 'Arc.exe'],
      processNames: ['Arc.exe'],
      userDataDirectorySegments: ['TheBrowserCompany', 'Arc', 'User Data'],
    },
  },
};

export const FAMILY_NAMES = Object.keys(BROWSERS);

// ---------------------------------------------------------------------------
// Chrome unpacked 扩展 ID（已知算法，非借鉴自参考实现）
// ---------------------------------------------------------------------------

/**
 * 计算 Chrome unpacked 扩展 ID：
 *   SHA-256(绝对路径 UTF-8) 前 16 字节 → 32 个 hex 字符 → 每字符 0-9a-f 映射到 a-p。
 * 与 Chromium crx_file::id_util::GenerateIdForPath 一致（POSIX 上按给定绝对路径原样哈希）。
 */
export function computeExtensionId(unpackedDir, { mustExist = true } = {}) {
  const absolute = path.resolve(unpackedDir);
  if (mustExist && !existsSync(absolute)) {
    throw new Error(`extension directory does not exist: ${absolute}`);
  }
  const hex = crypto.createHash('sha256').update(absolute, 'utf8').digest('hex').slice(0, 32);
  return hex
    .split('')
    .map((char) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(char, 16)))
    .join('');
}

// ---------------------------------------------------------------------------
// 清单路径计算
// ---------------------------------------------------------------------------

/**
 * 某家族在本平台的全部清单候选路径。
 * 逻辑参考: installManifest.mjs 的 manifestPaths(family)：
 *   - darwin: HOME + 各 nativeMessagingManifestDirectories；
 *   - linux:  CHROME_CONFIG_HOME 仅影响 chrome 家族，XDG_CONFIG_HOME 影响全部，
 *             清单目录去掉 ".config/" 前缀后接到所选 configHome 下；
 *   - win32:  统一缓存目录（注册表键指向它）。
 */
export function manifestPathsForFamily(family, { home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const browser = BROWSERS[family];
  if (!browser) throw new Error(`unknown browser family: ${family}`);

  if (platform === 'darwin') {
    return browser.macos.nativeMessagingManifestDirectories.map(
      (dir) => path.join(home, ...dir.split('/'), MANIFEST_BASENAME),
    );
  }
  if (platform === 'linux') {
    const defaultConfigHome = path.join(home, '.config');
    const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : defaultConfigHome;
    const configHome = family === 'chrome' && env.CHROME_CONFIG_HOME && env.CHROME_CONFIG_HOME.length > 0 ? env.CHROME_CONFIG_HOME : xdg;
    return browser.linux.nativeMessagingManifestDirectories.map((dir) => {
      const relative = path.posix.relative('.config', dir); // 如 'google-chrome/NativeMessagingHosts'
      return path.join(configHome, relative, MANIFEST_BASENAME);
    });
  }
  if (platform === 'win32') {
    return [path.win32.join(home, ...WINDOWS_MANIFEST_DIR_SEGMENTS, MANIFEST_BASENAME)];
  }
  throw new Error(`unsupported platform: ${platform}`);
}

/** Windows 注册表键（含各家族键名）对应的 reg add 命令参数。 */
export function windowsRegistryAddArgs(family, manifestPath) {
  const browser = BROWSERS[family];
  if (!browser) throw new Error(`unknown browser family: ${family}`);
  return ['add', `${browser.windows.registryRoot}\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'];
}

// ---------------------------------------------------------------------------
// shim 与文件内容构造
// ---------------------------------------------------------------------------

/** POSIX shim：#!/bin/sh + exec node（清单 path 必须是可执行文件，不能带参数）。 */
export function buildShimContent(hostScriptPath, platform = process.platform) {
  if (platform === 'win32') {
    return `@echo off\r\nnode "${hostScriptPath}" %*\r\n`;
  }
  return `#!/bin/sh\nexec node "${hostScriptPath}" "$@"\n`;
}

export function buildManifest({ extensionIds, hostPath }) {
  if (!Array.isArray(extensionIds) || extensionIds.length === 0) {
    throw new Error('extensionIds must be a non-empty array');
  }
  // 逻辑参考: installManifest.mjs 的清单字段（allowed_origins/description/name/path/type）
  return {
    allowed_origins: [...new Set(extensionIds.map((id) => `chrome-extension://${id}/`))],
    description: HOST_DESCRIPTION,
    name: NATIVE_HOST_NAME,
    path: hostPath,
    type: 'stdio',
  };
}

/** 宿主配置（host.mjs 启动时读；逻辑参考: installManifest.mjs 的 extension-host-config.json）。 */
export function buildHostConfig({ servicePort = DEFAULT_SERVICE_PORT, serviceHost = DEFAULT_SERVICE_HOST } = {}) {
  return { schemaVersion: 1, serviceHost, servicePort };
}

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function parseArgs(argv) {
  const parsed = {
    browser: 'chrome',
    dryRun: false,
    extensionIds: [],
    computeExtensionId: null,
    home: null,
    port: DEFAULT_SERVICE_PORT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--browser': parsed.browser = next(); break;
      case '--dry-run': parsed.dryRun = true; break;
      case '--extension-id': parsed.extensionIds.push(next()); break;
      case '--compute-extension-id': parsed.computeExtensionId = next(); break;
      case '--home': parsed.home = path.resolve(next()); break;
      case '--port': parsed.port = Number(next()); break;
      case '--help':
      case '-h':
        process.stdout.write(usageText());
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}\n\n${usageText()}`);
    }
  }
  if (parsed.browser !== 'all' && !FAMILY_NAMES.includes(parsed.browser)) {
    throw new Error(`--browser must be one of ${FAMILY_NAMES.join('|')}|all, got: ${parsed.browser}`);
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error(`--port must be an integer in [1,65535], got: ${parsed.port}`);
  }
  for (const id of parsed.extensionIds) {
    if (!EXTENSION_ID_PATTERN.test(id)) {
      throw new Error(`--extension-id must match ${EXTENSION_ID_PATTERN} (32 chars a-p), got: ${id}`);
    }
  }
  return parsed;
}

function usageText() {
  return [
    'Usage: node installer/install.mjs [options]',
    '',
    'Options:',
    '  --browser <chrome|edge|brave|opera|vivaldi|all>   target browser family (default: chrome)',
    '  --dry-run                                          print planned writes only, touch nothing',
    '  --extension-id <id>                                allowed origin id (repeatable)',
    '  --compute-extension-id <unpackedDir>               print the Chrome ID for an unpacked dir and exit',
    '  --home <dir>                                       override HOME for sandboxed installs',
    '  --port <n>                                         service port written to host-config.json (default 7331)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 安装主流程
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

/** 默认 allowed origin：仓库 extension/ 目录（unpacked）自身的 Chrome ID。 */
function defaultExtensionIds(repoRoot = REPO_ROOT) {
  const extensionDir = path.join(repoRoot, 'extension');
  if (!existsSync(extensionDir)) {
    throw new Error(`no --extension-id given and repo extension directory not found: ${extensionDir}`);
  }
  return [computeExtensionId(extensionDir)];
}

/**
 * 执行安装。返回动作列表（dry-run 也返回同样的列表，只是不落盘）。
 * 任一「拒绝覆盖」都会让返回结果里带 refused 项，由 CLI 决定退出码。
 */
export async function runInstall(parsed, { platform = process.platform, env = process.env, repoRoot = REPO_ROOT, out = process.stdout } = {}) {
  const home = parsed.home ?? os.homedir();
  const hostScriptPath = path.join(repoRoot, 'host', 'host.mjs');
  if (!existsSync(hostScriptPath)) {
    throw new Error(`host script not found: ${hostScriptPath}`);
  }

  const extensionIds = parsed.extensionIds.length > 0 ? parsed.extensionIds : defaultExtensionIds(repoRoot);

  // shim：清单 path 必须是可执行文件，所以宿主入口包一层脚本。
  const shimPath = path.join(repoRoot, 'host', platform === 'win32' ? 'chrome-agent-browser-host.cmd' : 'chrome-agent-browser-host');
  const shimContent = buildShimContent(hostScriptPath, platform);
  const manifest = buildManifest({ extensionIds, hostPath: shimPath });
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const hostConfigJson = `${JSON.stringify(buildHostConfig({ servicePort: parsed.port }), null, 2)}\n`;

  const families = parsed.browser === 'all' ? FAMILY_NAMES : [parsed.browser];
  const actions = [];

  for (const family of families) {
    const manifestPaths = manifestPathsForFamily(family, { home, env, platform });

    for (const manifestPath of manifestPaths) {
      if (isForeignManifest(manifestPath)) {
        actions.push({ action: 'refused', family, path: manifestPath, reason: refusalReason(manifestPath) });
        continue;
      }
      if (existsSync(manifestPath) && !parsed.dryRun) {
        copyFileSync(manifestPath, `${manifestPath}.bak`);
        actions.push({ action: 'backup', family, path: `${manifestPath}.bak` });
      }
      if (!parsed.dryRun) {
        mkdirSync(path.dirname(manifestPath), { recursive: true });
        writeFileSync(manifestPath, manifestJson);
      }
      actions.push({ action: 'write-manifest', family, path: manifestPath });
    }

    // Windows 注册表：本机是 Windows 时执行 reg add；非 Windows 只打印等价命令。
    if (platform === 'win32') {
      const winManifestPath = manifestPaths[0];
      const args = windowsRegistryAddArgs(family, winManifestPath);
      if (!parsed.dryRun) {
        execFileSync('reg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
      }
      actions.push({ action: 'registry-add', family, path: `${BROWSERS[family].windows.registryRoot}\\${NATIVE_HOST_NAME}` });
    } else {
      const winManifestPath = path.win32.join(home, ...WINDOWS_MANIFEST_DIR_SEGMENTS, MANIFEST_BASENAME);
      actions.push({
        action: 'registry-print',
        family,
        path: `${BROWSERS[family].windows.registryRoot}\\${NATIVE_HOST_NAME}`,
        command: `reg ${windowsRegistryAddArgs(family, winManifestPath).map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ')}`,
      });
    }
  }

  // shim 与 host-config 写进仓库 host/（全局一次，不随浏览器家族重复）。
  if (!parsed.dryRun) {
    mkdirSync(path.dirname(shimPath), { recursive: true });
    const previous = existsSync(shimPath);
    writeFileSync(shimPath, shimContent);
    if (platform !== 'win32') chmodSync(shimPath, 0o755);
    actions.push({ action: previous ? 'rewrite-shim' : 'write-shim', path: shimPath });

    const hostConfigPath = path.join(repoRoot, 'host', HOST_CONFIG_BASENAME);
    writeFileSync(hostConfigPath, hostConfigJson);
    actions.push({ action: 'write-host-config', path: hostConfigPath, content: JSON.parse(hostConfigJson) });
  } else {
    actions.push({ action: 'write-shim (dry-run)', path: shimPath, content: shimContent });
    actions.push({ action: 'write-host-config (dry-run)', path: path.join(repoRoot, 'host', HOST_CONFIG_BASENAME), content: JSON.parse(hostConfigJson) });
  }

  return { actions, manifest, shimPath, extensionIds };
}

/** 读既有清单；不存在/不可解析/name 不是本产品 → 视为他人文件。 */
function isForeignManifest(manifestPath) {
  if (!existsSync(manifestPath)) return false;
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    existing = null;
  }
  return !existing || existing.name !== NATIVE_HOST_NAME;
}

function refusalReason(manifestPath) {
  let name = null;
  try {
    name = JSON.parse(readFileSync(manifestPath, 'utf8'))?.name ?? null;
  } catch { /* 不可解析也拒绝 */ }
  return `refusing to overwrite ${manifestPath}: existing file is not ${NATIVE_HOST_NAME} (found name: ${name ?? '<unparseable>'})`;
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  // --compute-extension-id：独立工具模式，算完即退出。
  if (parsed.computeExtensionId) {
    const id = computeExtensionId(parsed.computeExtensionId);
    process.stdout.write(`${id}\n`);
    return;
  }

  const { actions, manifest } = await runInstall(parsed);

  for (const action of actions) {
    if (action.action === 'refused') {
      process.stdout.write(`REFUSED ${action.path}: ${action.reason}\n`);
    } else if (action.action === 'registry-print') {
      process.stdout.write(`INFO (windows) ${action.command}\n`);
    } else {
      process.stdout.write(`${action.action.toUpperCase()} ${action.path}\n`);
    }
  }
  process.stdout.write(`\nmanifest content:\n${JSON.stringify(manifest, null, 2)}\n`);

  const refused = actions.filter((action) => action.action === 'refused');
  if (refused.length > 0) {
    process.stdout.write(`\n${refused.length} target(s) refused; nothing was overwritten at those paths.\n`);
    process.exitCode = 1;
  }
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
    process.stderr.write(`install: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
