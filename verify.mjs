#!/usr/bin/env node
// verify.mjs —— 一键真机验收：起服务（host-config 端口）→ 等真实浏览器扩展连入
// → 11 项检查 → 人话记分卡。
//
// 用法：npm run verify [-- --port 7331 | --timeout 40]
//   --port N      指定服务端口（默认读 host/host-config.json，与浏览器宿主同一份）
//   --timeout 秒  等浏览器连入的窗口（默认 40；扩展断线重连退避 30s 封顶，40s 足够）
//
// 安全红线（与 test/e2e 同源）：
//   - 只动自建标签页（新开/导航/关闭的都是自己的）；不认领、不碰用户既有标签页；
//   - CUA 只做只读探测（窗口清单/截图）+ 屏幕中央一次幽魂光标试闪（叠加窗点击穿透、
//     不动任何真实应用与真鼠标）；绝不点击真实应用；
//   - 结束清理自建标签页，确认 openTabs 无残留。
// 隔离写法照抄 test/e2e：只认「本服务启动之后才新出现」的浏览器，启动前已在线的
// 实例一律忽略（防本机其他服务的连接串扰）。
// 实现说明：直接用 service 层模块（api/cua/audit/policy）+ 同一个 ConnectionManager，
// 不走 MCP 客户端线缆（少两层、更稳）；cua 工厂注入同一份 audit/policy。

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ConnectionManager } from './service/connection.mjs';
import { RemoteFrontend } from './service/remote-frontend.mjs';
import { createAgentApi } from './service/api.mjs';
import { loadPolicy } from './service/policy.mjs';
import { createAudit } from './service/audit.mjs';
import { createCua } from './service/cua.mjs';
import { ERR } from './shared/protocol.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const HOST_CONFIG = resolve(ROOT, 'host', 'host-config.json');
const URL_EXAMPLE = 'https://example.com/';
const URL_HTTPBIN = 'https://httpbin.org/html';
const OVERLAY_FLASH_MS = 700;

const log = (s) => console.log(s);

// ---------- 纯逻辑（单测覆盖；见 test/verify.test.mjs） ----------

/** 二进制魔数识别：PNG / JPEG，否则 null。 */
export function imageKind(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

/** 浏览器 family → 窗口清单 ownerName 的匹配提示词（CGWindowList 里是完整应用名）。 */
export const FAMILY_APP_HINT = {
  chrome: 'Chrome', edge: 'Edge', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi', arc: 'Arc',
};

/** 从窗口清单里挑目标浏览器的窗口：ownerName 含 family 提示词；优先在屏的。 */
export function pickBrowserWindow(windows, family) {
  const hint = String(FAMILY_APP_HINT[family] ?? family ?? '').toLowerCase();
  if (!hint) return null;
  const cands = (Array.isArray(windows) ? windows : [])
    .filter((w) => String(w?.ownerName ?? '').toLowerCase().includes(hint));
  return cands.find((w) => w.onScreen) ?? cands[0] ?? null;
}

/** 记分卡统计：{total, pass, fail, skip}。 */
export function summarize(results) {
  const rows = Array.isArray(results) ? results : [];
  const count = (s) => rows.filter((r) => r && r.status === s).length;
  return { total: rows.length, pass: count('PASS'), fail: count('FAIL'), skip: count('SKIP') };
}

// ---------- 参数与端口 ----------

function parseArgs(argv) {
  const out = { port: null, timeoutSec: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--timeout') out.timeoutSec = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}（支持 --port N / --timeout 秒）`);
  }
  if (out.port !== null && (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535)) throw new Error(`invalid port: ${out.port}`);
  if (!Number.isFinite(out.timeoutSec) || out.timeoutSec <= 0) throw new Error(`invalid timeout: ${out.timeoutSec}`);
  return out;
}

/** 与 service.mjs/mcp-entry.mjs 同一优先级：--port > host-config.json > 7331。 */
function resolvePort(override) {
  if (Number.isInteger(override)) return override;
  try {
    const cfg = JSON.parse(readFileSync(HOST_CONFIG, 'utf8'));
    if (Number.isInteger(cfg.servicePort) && cfg.servicePort > 0 && cfg.servicePort < 65536) return cfg.servicePort;
  } catch { /* 无配置文件则用默认端口 */ }
  return 7331;
}

// ---------- 主流程 ----------

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const port = resolvePort(args.port);
  const startedAtIso = new Date().toISOString();

  log('chrome-agent-browser 真机验收（npm run verify）');
  log(`服务端口 ${port}（host-config）；等浏览器连入窗口 ${args.timeoutSec}s；安全红线：只动自建标签页，CUA 只读 + 中央试闪，结束清理自建页`);
  log('');

  // ---- 1. 起服务（占住 host-config 端口 = 浏览器宿主拨号的目标） ----
  const audit = createAudit(); // 真审计目录（与日常使用同一本账，第 7 项查的就是它）
  const policy = loadPolicy(null, { audit });
  let manager;
  try {
    manager = new ConnectionManager({ port, audit });
    await manager.start();
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      // 探一下占端口的是不是本家族服务（另一个正在使用的 MCP 客户端会话）
      let ours = false;
      try {
        const probe = new RemoteFrontend({ port });
        await probe.start();
        probe.stop();
        ours = true;
      } catch { /* 不是本服务（或握手失败） */ }
      log(`[verify] 端口 ${port} 已被占用${ours ? '（探测到是本服务：某个 MCP 客户端会话正开着 chrome-agent-browser，请先退出那个会话再验收）' : '（且不是本服务）'}。`);
      log('[verify] 排查：npm run doctor（端口监听/链路逐项体检）；确认没有别的终端在跑 npm start / 使用中的 MCP 会话。');
      process.exit(1);
    }
    throw err;
  }
  log(`[verify] 服务已监听 ws://127.0.0.1:${manager.port}（审计：${audit.disabled ? 'off（配置关闭）' : audit.dir}）`);

  // ---- 2. 等真实浏览器扩展连入（隔离：忽略启动前已在线的实例） ----
  const knownBefore = new Set(manager.liveConnections().map((c) => c.instanceId));
  log(`[verify] 等待真实浏览器扩展连入（≤${args.timeoutSec}s；浏览器里的扩展会自动重连到本端口）…`);
  const conn = await new Promise((resolveP) => {
    const timer = setTimeout(() => { manager.off('browser', onNew); resolveP(null); }, args.timeoutSec * 1000);
    function onNew(c) {
      if (knownBefore.has(c.instanceId)) return; // 启动前已在线的实例不算（e2e 同款隔离）
      clearTimeout(timer);
      manager.off('browser', onNew);
      resolveP(c);
    }
    manager.on('browser', onNew);
  });

  const results = [];
  const check = (name, fn) => (async () => {
    try {
      const detail = await fn();
      results.push({ name, status: 'PASS', detail: detail ?? '' });
      log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      if (err && err.skip === true) {
        results.push({ name, status: 'SKIP', detail: err.reason ?? '' });
        log(`SKIP  ${name} — ${err.reason ?? ''}`);
      } else {
        results.push({ name, status: 'FAIL', detail: String((err && err.message) || err) });
        log(`FAIL  ${name} — ${String((err && err.message) || err)}`);
      }
    }
  })();
  const skip = (reason) => { const e = new Error(reason); e.skip = true; e.reason = reason; return e; };
  /** CUA 类检查：能力层不够（授权/未编译）→ SKIP 并带指引，不算功能缺陷。 */
  const cuaGate = (err, what) => {
    if (err && ['CAPABILITY_UNAVAILABLE', 'AX_NOT_GRANTED', 'SCREEN_CAPTURE_FAILED', 'UNSUPPORTED_PLATFORM'].includes(err.code)) {
      throw skip(`${what}在当前能力层不可用（${err.message}）`);
    }
    throw err;
  };

  const api = createAgentApi(() => manager.liveConnections(), { policy });
  const cua = createCua({ audit, policy }); // 同一份 audit/policy（cua 工厂注入）
  const selfTabs = []; // 只记直接自建标签页（批量阅读的临时页自带即关）
  let tab = null; // 第 3 项开的 example.com 页（后续多项复用）

  try {
    if (!conn) {
      log('');
      log(`[verify] ${args.timeoutSec}s 内没有真实浏览器连入 —— 真机验收未执行（如实报告，不造假通过）。`);
      log('[verify] 排查：npm run doctor（扩展目录/通信清单/端口逐项体检）；浏览器里确认本仓库扩展已加载（chrome://extensions）');
      log('[verify]        且 npm run setup 跑过（host-config 端口一致）；本验收退出后服务即停，扩展下次有服务时会自动重连。');
      process.exit(1);
    }
    const family = conn.family ?? 'unknown';
    const version = conn.browserVersion ?? '?';
    log(`[verify] 浏览器已连入：${family} ${version}（instanceId ${conn.instanceId.slice(0, 10)}…）`);
    log('');
    const browser = api.browsers.get(conn.instanceId);

    // 1/11 能力体检
    await check('1/11 能力体检：服务在线 + browsers.list（浏览器家族版本）', async () => {
      const list = api.browsers.list();
      if (list.length < 1) throw new Error('browsers.list 为空');
      const me = list.find((b) => b.id === conn.instanceId);
      if (!me || me.type !== 'extension') throw new Error(`browsers.list 异常: ${JSON.stringify(list)}`);
      return `服务 ws://127.0.0.1:${manager.port} 在线；browsers.list=${list.length} 台：${me.family} ${version}`;
    });

    // 2/11 用户标签只读
    await check('2/11 用户标签只读：openTabs 数量', async () => {
      const tabs = await browser.user.openTabs();
      if (!Array.isArray(tabs)) throw new Error(`openTabs 未返回数组: ${typeof tabs}`);
      return `当前 ${tabs.length} 个已开标签页（只读列出，不认领、不触碰）`;
    });

    // 3/11 开页导航
    await check('3/11 开页导航：新标签 → example.com → title 断言', async () => {
      tab = await browser.tabs.new();
      selfTabs.push(tab);
      await tab.goto(URL_EXAMPLE);
      const title = await tab.title();
      if (!/example/i.test(String(title))) throw new Error(`title 不含 example: ${JSON.stringify(title)}`);
      return `新标签 tabId=${tab.id} → ${URL_EXAMPLE}，title="${title}"`;
    });

    // 4/11 截图
    await check('4/11 截图：标签页 PNG 魔数 + 字节数', async () => {
      const png = await tab.screenshot();
      const kind = imageKind(png);
      if (kind !== 'png') throw new Error(`非 PNG（识别为 ${kind}，前 4 字节 ${png && png.slice(0, 4).toString('hex')}）`);
      if (!png.length || png.length < 100) throw new Error(`字节数异常: ${png.length}`);
      return `tab_screenshot PNG ${png.length} 字节`;
    });

    // 5/11 批量隐形阅读
    await check('5/11 批量隐形阅读：read_urls 读 example.com + httpbin.org/html', async () => {
      const t0 = Date.now();
      const pages = await browser.tabs.content({ urls: [URL_EXAMPLE, URL_HTTPBIN] });
      const ms = Date.now() - t0;
      if (!Array.isArray(pages) || pages.length !== 2) throw new Error(`结果数异常: ${JSON.stringify(pages).slice(0, 200)}`);
      for (const p of pages) {
        if (p.blocked) throw new Error(`${p.url} 被策略拦: ${p.reason}`);
        if (p.error) throw new Error(`${p.url} 读取失败: ${p.error}`);
        if (!p.text || !p.text.trim()) throw new Error(`${p.url} 正文为空`);
      }
      return `2 页正文非空（${pages[0].text.trim().length} + ${pages[1].text.trim().length} 字符），耗时 ${(ms / 1000).toFixed(1)}s，临时标签读完即关`;
    });

    // 6/11 WebMCP 探测
    await check('6/11 WebMCP 探测：list 返回（空清单也算过）', async () => {
      const webmcp = tab.capabilities.get('webmcp');
      let tools;
      try {
        tools = await webmcp.list();
      } catch (err) {
        if (err && err.code === ERR.WEBMCP_UNSUPPORTED) {
          throw skip(`此浏览器无 WebMCP CDP 域（${err.message}；需更新版浏览器，e2e 的 Chrome for Testing 已验证该链路）`);
        }
        throw err;
      }
      if (!Array.isArray(tools)) throw new Error(`list 未返回数组: ${typeof tools}`);
      return tools.length
        ? `list 返回 ${tools.length} 个页面申报工具：${tools.map((t) => t.name).join(', ')}`
        : 'list 正常返回空清单（页面未申报任何 WebMCP 工具）';
    });

    // 7/11 审计在记账
    await check('7/11 审计在记账：最近条目含本次导航记录', async () => {
      if (audit.disabled) throw skip('审计已按配置关闭（host-config auditDisabled / CAB_AUDIT=off），记账功能未启用');
      const q = audit.query({ cmd: 'navigate_tab_url', since: startedAtIso, limit: 500 });
      const hit = (q.entries ?? []).find((e) => e.paramsLite && e.paramsLite.url === URL_EXAMPLE);
      if (!hit) throw new Error(`审计里找不到本次 navigate_tab_url → ${URL_EXAMPLE}（本轮共 ${q.total} 条）`);
      return `审计命中 navigate_tab_url → example.com @ ${hit.ts}`;
    });

    // 8/11 CUA 窗口清单
    await check('8/11 CUA 窗口清单：cua windows 数量', async () => {
      let wins;
      try { wins = await cua.windows(); }
      catch (err) { cuaGate(err, '窗口清单'); }
      if (!Array.isArray(wins)) throw new Error(`windows 未返回数组: ${typeof wins}`);
      return `屏幕上 ${wins.length} 个窗口（${wins.filter((w) => w.title).length} 个带标题）`;
    });

    // 9/11 CUA 截图（截自建标签页所在的浏览器窗口；无 windowId 则按窗口区域）
    await check('9/11 CUA 截图：浏览器窗口/区域，PNG 魔数校验', async () => {
      let wins;
      try { wins = await cua.windows(); }
      catch (err) { cuaGate(err, '窗口清单'); }
      const win = pickBrowserWindow(wins, family);
      if (!win) throw skip(`窗口清单里没找到 ${family} 的窗口（浏览器可能最小化/无窗；清单共 ${wins.length} 个）`);
      let shot;
      try {
        shot = win.windowId
          ? await cua.screenshot({ windowId: win.windowId, format: 'png' })
          : await cua.screenshot({ rect: win.bounds, format: 'png' });
      } catch (err) { cuaGate(err, '截图'); }
      const buf = Buffer.from(shot.dataBase64, 'base64');
      const kind = imageKind(buf);
      if (kind !== 'png') throw new Error(`非 PNG（识别为 ${kind}）`);
      if (buf.length < 100) throw new Error(`字节数异常: ${buf.length}`);
      return `PNG ${shot.bytes} 字节（owner=${win.ownerName}${win.windowId ? ` windowId=${win.windowId}` : ` rect=${win.bounds.w}x${win.bounds.h}`}，自建标签所在浏览器窗口）`;
    });

    // 10/11 幽魂试闪（尊重 cuaOverlay 开关）
    await check('10/11 幽魂试闪：overlay-show 屏幕中央 700ms', async () => {
      const st = await cua.status();
      if (st.supported === false) throw skip('CUA 仅支持 macOS');
      if (st.overlay?.available !== true) throw skip('叠加层需 A 层助手 host/cua-helper（npm run setup 编译后可用）');
      if (st.overlay?.enabled === false) throw skip('已在 policy 关闭（cuaOverlay=false），尊重配置跳过');
      const w = st.screen?.w ?? 1920;
      const h = st.screen?.h ?? 1080;
      const x = Math.round(w / 2);
      const y = Math.round(h / 2);
      let r;
      try {
        r = await cua.overlayFlash({ x, y, kind: 'click', durationMs: OVERLAY_FLASH_MS });
      } catch (err) { cuaGate(err, '幽魂光标'); }
      if (r.ok !== true) throw new Error(`helper 未返回 ok: ${JSON.stringify(r)}`);
      return `屏幕中央 (${x},${y}) 闪现 ${OVERLAY_FLASH_MS}ms（叠加窗点击穿透、不动真鼠标、不记账）`;
    });

    // 11/11 清理
    await check('11/11 清理：关自建标签页，openTabs 无残留', async () => {
      let closed = 0;
      for (const t of selfTabs) {
        if (t._closed) continue;
        try { await t.close(); closed += 1; } catch { /* 已关（页面事件先到）则忽略 */ }
      }
      const tabs = await browser.user.openTabs();
      const residue = tabs.filter((t) => String(t.url ?? '').startsWith(URL_EXAMPLE) || String(t.url ?? '').startsWith(URL_HTTPBIN));
      if (residue.length > 0) throw new Error(`残留 ${residue.length} 个自建页: ${JSON.stringify(residue.map((t) => t.url))}`);
      return `关闭 ${closed} 个自建标签页；openTabs 无 example.com/httpbin 残留（现 ${tabs.length} 个标签页，全部是验收前已有）`;
    });
  } finally {
    // 无论成败：自建页收尾 + 常驻资源退出（浏览器本身不动）
    for (const t of selfTabs) {
      if (t._closed) continue;
      try { await t.close(); } catch { /* 已关则忽略 */ }
    }
    try { cua.stop(); } catch { /* noop */ }
    await manager.stop().catch(() => {});
    log(`[verify] 清理完成（自建标签页已关；服务监听已停；浏览器扩展稍后会自动连回下一个在线的服务）`);
  }

  // ---- 记分卡 ----
  const s = summarize(results);
  log('');
  log(`验收结果：${s.pass}/${s.total} 通过，${s.skip} 跳过，${s.fail} 失败${s.skip ? '（跳过=本机能力/配置不满足，已注明原因）' : ''}`);
  log('npm publish 提示：发布前把 npm test、npm run e2e、npm run verify 三者跑绿（e2e 验协议链路、verify 验真机链路），bump 版本号后 npm pack 抽查内容再 npm publish。');
  return s.fail ? 1 : 0;
}

// 作为脚本直接运行时才启动（被 import 时不执行，供 test/verify.test.mjs 引纯逻辑）
const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`[verify] fatal: ${err.message}`);
    process.exit(1);
  });
}
