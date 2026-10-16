#!/usr/bin/env node
// service/mcp-entry.mjs — MCP stdio 入口
//
//   node service/mcp-entry.mjs [--port 7331] [--policy <json>]
//
// stdout 归 MCP 协议（StdioServerTransport），一切日志走 stderr。
//
// 多实例（README 承诺）：多个 MCP 客户端同时用时——
//   - 第一个实例抢到端口 → service 模式（监听 ws 等浏览器 host 连入），行为同 v1；
//   - 后续实例端口被占（EADDRINUSE）→ 自动转「前端模式」（remote-frontend.mjs）：
//     以 frontend 身份连上既有 service 共用浏览器，MCP 工具照常可用（日志注明
//     "frontend mode: sharing service on port N"）；每个前端进程各自的 --policy 在
//     本进程本地生效（策略检查发生在 api/工具层，即各前端自己的规则）；
//   - 端口被其他程序占用且不是本服务（3s 内无 mcp/hello 应答）→ stderr 明确报错 exit 1；
//   - service 模式的 stdin EOF 不再立刻退出：若仍有活跃 frontend 连接，等它们全部
//     断开再退（事件驱动 + 最多 60s 宽限），避免把共用者踢成孤儿；全部退出后无孤儿进程。
//
// 组装说明：service/service.mjs 的 main() 没有把组装段导出为函数，且本任务约定不改动
// service.mjs —— 因此「policy + api」组装段复制自 service.mjs main()（policy =
// loadPolicy(args.policy); api = createAgentApi(getLiveConnections, {policy})），两边保持同步。
// 参数解析直接复用 service.mjs 导出的 parseArgs。

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConnectionManager } from './connection.mjs';
import { RemoteFrontend } from './remote-frontend.mjs';
import { createAgentApi } from './api.mjs';
import { loadPolicy } from './policy.mjs';
import { createAudit } from './audit.mjs';
import { buildMcpServer } from './mcp.mjs';
import { parseArgs, runSelfTest } from './service.mjs';

const USAGE = 'usage: node service/mcp-entry.mjs [--port 7331] [--policy <json>] [--selftest]';
const FRONTEND_DRAIN_GRACE_MS = 60_000; // stdin EOF 后等 frontend 排水的最长宽限

/** 日志一律 stderr（stdout 是 MCP 线缆）。 */
const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

/** 尝试接管端口成为 service（后端死亡恢复用）。成功返回新 ConnectionManager；端口被占返回 null。 */
export async function attemptServiceTakeover(port, audit = null) {
  try {
    const m = new ConnectionManager({ port, audit });
    await m.start();
    return m;
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') return null;
    throw err;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { log(USAGE); return 0; }

  // --selftest：不起 MCP，复用 service.mjs 的全链路自检（stdout 打 PASS/FAIL）
  if (args.selftest) {
    const ok = await runSelfTest();
    log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL');
    return ok ? 0 : 1;
  }

  // ---- 端口决定（与 service.mjs 保持同步） ----
  // 优先级：--port 参数 > setup.mjs 写入的 host/host-config.json（浏览器宿主按它连入）> 默认 7331
  if (!argv.includes('--port')) {
    try {
      const cfg = JSON.parse(readFileSync(resolve(path.dirname(fileURLToPath(import.meta.url)), '../host/host-config.json'), 'utf8'));
      if (Number.isInteger(cfg.servicePort) && cfg.servicePort > 0 && cfg.servicePort < 65536) args.port = cfg.servicePort;
    } catch { /* 无配置文件则用默认端口 */ }
  }
  const audit = createAudit(); // 审计日志（host-config auditDisabled:true / CAB_AUDIT=off 可关；frontend 与 service 落盘同一目录）
  const policy = loadPolicy(args.policy, { audit });

  // ---- 抢 service 端口：抢到 → service 模式；EADDRINUSE → 前端模式连既有 service ----
  let manager = null;
  let remoteFrontend = null;
  try {
    manager = new ConnectionManager({ port: args.port, audit });
    await manager.start();
  } catch (err) {
    if (!err || err.code !== 'EADDRINUSE') throw err;
    manager = null; // 抢端口失败的对象直接丢弃（其 wss 未监听）
    try {
      remoteFrontend = new RemoteFrontend({ port: args.port });
      await remoteFrontend.start(); // 3s 内无 mcp/hello 应答会在此抛错
    } catch (helloErr) {
      log(`[cab-mcp] fatal: 端口 ${args.port} 被其他程序占用且不是本服务（frontend 模式握手失败：${helloErr.message}）`);
      process.exit(1); // 明确失败，绝不挂死
    }
  }

  // ---- 组装 api / MCP 面（两种模式共用；前端模式下 policy 在本进程本地生效） ----
  const getConnections = () => (manager ? manager.liveConnections() : remoteFrontend.liveConnections());
  const api = createAgentApi(getConnections, { policy });
  const serviceInfo = { mode: manager ? 'service' : 'frontend', startedAt: Date.now(), port: args.port };
  const server = buildMcpServer({ api, policy, connections: getConnections, serviceInfo, audit });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const attachManagerLogs = (m) => {
    m.on('browser', (c) => log(`[browser] connected ${c.instanceId} (${c.family} ${c.browserVersion ?? ''})${c.restored ? ' [restored]' : ''}`));
    m.on('browserClosed', (c) => log(`[browser] closed ${c.instanceId}; lease mirror retained for reconnect window`));
    m.on('frontendCountChange', (n) => log(`[cab-mcp] frontend connections: ${n}`));
  };

  if (manager) {
    log(`[cab-mcp] MCP stdio ready; service ws://127.0.0.1:${manager.port} (policy: ${args.policy ?? 'defaults'}; audit: ${audit.disabled ? 'off' : audit.dir})`);
    attachManagerLogs(manager);
  } else {
    log(`[cab-mcp] frontend mode: sharing service on port ${args.port} (policy: ${args.policy ?? 'defaults'})`);

    // ---- 后端死亡恢复（实战教训：服务中途死掉时 MCP 客户端不会重拉活着的子进程）----
    // 前端进程发现后端断开 → 先尝试接管端口变成新服务（浏览器扩展会自动重连）；
    // 接管失败（别人占着）→ 重新以前端模式接入；连续失败才退出让客户端重拉。
    let recoveryFailures = 0;
    let recovering = false;
    const scheduleRecovery = async (reason) => {
      if (stopping || recovering) return;
      recovering = true;
      try {
        log(`[cab-mcp] 后端服务连接断开（${reason}），尝试恢复…`);
        await new Promise((r) => setTimeout(r, 800)); // 等端口释放/新服务稳定
        if (stopping) return;
        const m = await attemptServiceTakeover(args.port, audit);
        if (m) {
          try { remoteFrontend?.stop(); } catch { /* 已断 */ }
          remoteFrontend = null;
          manager = m;
          attachManagerLogs(m);
          log(`[cab-mcp] ✓ 已接管为 service 模式（端口 ${args.port}）；浏览器扩展将自动重连`);
          return;
        }
        const rf = new RemoteFrontend({ port: args.port });
        await rf.start(); // 3s 内握手不上会抛
        try { remoteFrontend?.stop(); } catch { /* 已断 */ }
        remoteFrontend = rf;
        rf.on('browserClosed', () => scheduleRecovery('service connection lost'));
        recoveryFailures = 0;
        log('[cab-mcp] ✓ 新服务已出现，重新以 frontend 模式接入');
      } catch {
        recoveryFailures += 1;
        if (recoveryFailures >= 5) {
          log('[cab-mcp] 恢复连续失败 5 次，退出本进程（MCP 客户端下次会话会重新拉起）');
          process.exit(1);
        }
        setTimeout(() => { recovering = false; scheduleRecovery('retry'); }, Math.min(1000 * 2 ** recoveryFailures, 15000));
        return;
      } finally {
        recovering = false;
      }
    };
    remoteFrontend.on('browserClosed', () => scheduleRecovery('service connection lost'));
  }

  let stopping = false;
  const shutdown = async (signal, { drain = false } = {}) => {
    if (stopping) return;
    stopping = true;
    log(`[cab-mcp] ${signal}, shutting down`);
    try { await server.close(); } catch { /* 已关 */ }
    // stdin EOF 的宽限排水：MCP 客户端已走，但仍有前端共用本 service → 等它们断开再退
    if (drain && manager && manager.frontendSockets.size > 0) {
      log(`[cab-mcp] stdin closed; waiting for ${manager.frontendSockets.size} frontend connection(s) to drain (grace ${FRONTEND_DRAIN_GRACE_MS}ms)`);
      await new Promise((finish) => {
        const done = () => { clearTimeout(graceTimer); manager.off('frontendCountChange', onChange); finish(); };
        const onChange = () => { if (manager.frontendSockets.size === 0) done(); };
        const graceTimer = setTimeout(done, FRONTEND_DRAIN_GRACE_MS);
        manager.on('frontendCountChange', onChange);
        onChange(); // 竞态兜底：登记监听前可能刚好已清零
      });
    }
    try {
      if (manager) await manager.stop();
      else remoteFrontend.stop();
    } finally { process.exit(0); }
  };
  // SIGINT/SIGTERM 立即退出（排水中再次收到信号也立即退出）
  const onSignal = (signal) => {
    if (stopping) { process.exit(0); return; }
    shutdown(signal);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  // MCP 客户端断开（stdin EOF）也要退出，否则进程变孤儿；service 模式带 frontend 宽限排水
  process.stdin.on('end', () => shutdown('stdin-end', { drain: true }));
  process.stdin.on('close', () => shutdown('stdin-close', { drain: true }));
  process.stdin.resume(); // 确保 EOF 事件能触发（无消费者时 stdin 处于暂停态）

  await new Promise(() => {}); // 常驻：stdin 上的 MCP 消息驱动一切
  return 0;
}

// 作为脚本直接运行时才启动（被 import 时不执行）
const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`[cab-mcp] fatal: ${err.message}\n`);
    process.exit(1);
  });
}
