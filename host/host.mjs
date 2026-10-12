#!/usr/bin/env node
// host/host.mjs — 原生宿主（哑中继 / dumb relay）
//
// 分层（见 docs/PROTOCOL.md）：
//   扩展 <--(Chrome Native Messaging，小端 uint32 长度前缀 + UTF-8 JSON)--> 本进程
//   本进程 <--(WebSocket ws://127.0.0.1:<port>，JSON-RPC 2.0)--> service
//
// 本进程只做三件事：
//   1. 读配置（AGENT_BROWSER_CONFIG 或同目录 host-config.json）
//   2. 主动连 service 并发一次 host/hello
//   3. 双向原样转发 JSON；任一侧断开 → 优雅关闭另一侧 → exit 0
//
// 约束：stdout 只准写协议帧（4 字节小端长度 + JSON），一切日志走 stderr。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../shared/protocol.mjs';

export const HOST_VERSION = '0.1.0';

// Chrome 原生消息对宿主→浏览器方向的单条消息上限是 1MB，这里双向统一按 1MB 截断。
export const MAX_FRAME_BYTES = 1024 * 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = (...parts) => process.stderr.write(parts.join(' ') + '\n');

// ---------------------------------------------------------------------------
// 帧编解码（Chrome Native Messaging：4 字节【小端】uint32 长度 + UTF-8 载荷）
// ---------------------------------------------------------------------------

/** 把一个 JSON 字符串编码成原生消息帧（Buffer）。 */
export function encodeNativeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${payload.length} > ${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0); // 小端
  return Buffer.concat([header, payload]);
}

/**
 * 流式帧读取器：喂入任意切片的 chunk，返回 {frames, problems}。
 * - frames: 已完整的载荷 Buffer 列表（不含长度头）
 * - problems: 非致命问题（如超长帧被丢弃），由调用方记日志
 */
export class NativeFrameReader {
  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.buffer = Buffer.alloc(0);
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    const problems = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32LE(0); // 小端
      if (length > this.maxFrameBytes) {
        // 超长帧：无法在流中可靠重新对齐，丢弃整个缓冲区并继续（不崩）。
        problems.push(`dropping oversized frame (${length} bytes > ${this.maxFrameBytes})`);
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < 4 + length) break;
      frames.push(this.buffer.subarray(4, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return { frames, problems };
  }
}

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

/** 配置缺失/非法时抛出的错误（main 捕获后 exit 2）。 */
export class HostConfigError extends Error {}

/**
 * 读宿主配置。优先 AGENT_BROWSER_CONFIG 指向的文件，否则用脚本同目录
 * host-config.json。校验 schemaVersion / serviceHost / servicePort。
 */
export function loadHostConfig(env = process.env, scriptDir = __dirname) {
  const explicit = env.AGENT_BROWSER_CONFIG;
  const configPath = explicit ? path.resolve(explicit) : path.join(scriptDir, 'host-config.json');
  if (!existsSync(configPath)) {
    throw new HostConfigError(`host config not found: ${configPath} (set AGENT_BROWSER_CONFIG or place host-config.json next to host.mjs)`);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new HostConfigError(`host config is not valid JSON: ${configPath} (${error.message})`);
  }
  if (config?.schemaVersion !== 1) {
    throw new HostConfigError(`host config schemaVersion must be 1: ${configPath}`);
  }
  if (typeof config.serviceHost !== 'string' || config.serviceHost.trim() === '') {
    throw new HostConfigError(`host config serviceHost must be a non-empty string: ${configPath}`);
  }
  const port = config.servicePort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HostConfigError(`host config servicePort must be an integer in [1,65535]: ${configPath}`);
  }
  return { serviceHost: config.serviceHost, servicePort: port, configPath };
}

// ---------------------------------------------------------------------------
// WebSocket 连接（1s 起指数退避封顶 15s，总预算 120s，超时 exit 1）
// ---------------------------------------------------------------------------

/**
 * 带重试的连接。只在「尚未打开」时重试；一旦 open 则交给调用方管理，
 * 之后断线通过 onClose 上报（宿主对已建立连接的断线不再重连，直接退出）。
 */
export function connectWithRetry(url, { onMessage, deadlineMs = 120_000, minDelayMs = 1_000, maxDelayMs = 15_000, logFn = log }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let attempt = 0;
    let settled = false;
    let opened = false;
    let socket = null;

    const scheduleRetry = () => {
      if (settled) return;
      const delay = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      attempt += 1;
      if (Date.now() + delay - startedAt > deadlineMs) {
        settled = true;
        reject(new Error(`could not connect to ${url} within ${deadlineMs}ms (${attempt} attempts)`));
        return;
      }
      logFn(`[host] retrying ${url} in ${delay}ms (attempt ${attempt + 1})`);
      setTimeout(tryConnect, delay);
    };

    const tryConnect = () => {
      socket = new WebSocket(url, { handshakeTimeout: 5_000, maxPayload: 4 * MAX_FRAME_BYTES });
      socket.on('open', () => {
        opened = true;
        settled = true;
        resolve(socket);
      });
      socket.on('message', (data) => {
        if (!settled || !opened) return;
        onMessage?.(data);
      });
      socket.on('error', (error) => {
        // error 之后 ws 必然再发 close；重试/失败统一在 close 里决策，避免双发。
        logFn(`[host] ws error: ${error.message}`);
      });
      socket.on('close', () => {
        if (settled && opened) return; // 已交给 main 管理
        scheduleRetry();
      });
    };

    tryConnect();
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function main() {
  let config;
  try {
    config = loadHostConfig();
  } catch (error) {
    log(`[host] ${error.message}`);
    process.exit(2);
  }
  const url = `ws://${config.serviceHost}:${config.servicePort}`;
  log(`[host] starting ${HOST_VERSION} pid=${process.pid} config=${config.configPath} url=${url}`);

  const reader = new NativeFrameReader();
  let socket = null;
  let exiting = false;
  // ws 连上之前到达的原生帧先排队，open 后先发 hello 再冲队列。
  const pendingNativeFrames = [];
  const PENDING_CAP = 100;

  const shutdown = (reason, code = 0) => {
    if (exiting) return;
    exiting = true;
    log(`[host] shutting down: ${reason}`);
    try {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, 'host shutdown');
    } catch { /* 忽略关闭异常 */ }
    // 给 close 帧一点送出时间，然后退出。
    setTimeout(() => process.exit(code), 300).unref?.();
    process.exitCode = code;
  };

  // 防 SIGPIPE：stdout 管道断裂（对端已死）时按断线处理，不让进程被信号打死。
  process.stdout?.on?.('error', (error) => {
    if (error?.code === 'EPIPE') shutdown('stdout closed (EPIPE)');
    else throw error;
  });
  process.stdin?.on?.('error', (error) => {
    if (error?.code === 'EPIPE') shutdown('stdin closed (EPIPE)');
    else log(`[host] stdin error: ${error.message}`);
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (error) => {
    log(`[host] unhandled rejection: ${error?.stack ?? error}`);
    shutdown('unhandledRejection', 1);
  });

  // --- 连接 service（失败重试，总预算 120s，超时 exit 1） ---
  try {
    socket = await connectWithRetry(url, {
      onMessage: (data) => {
        // ws → 扩展：JSON.parse → JSON.stringify → 原生帧。解析失败丢弃并记日志。
        // ws 8.x 的 message 事件载荷是单个 Buffer 或 string。
        const text = typeof data === 'string'
          ? data
          : (Buffer.isBuffer(data) ? data : Buffer.concat(data)).toString('utf8');
        let outbound;
        try {
          outbound = JSON.stringify(JSON.parse(text));
        } catch (error) {
          log(`[host] dropping unparseable ws message: ${error.message}`);
          return;
        }
        let frame;
        try {
          frame = encodeNativeFrame(outbound);
        } catch (error) {
          log(`[host] ${error.message}`);
          return;
        }
        if (!process.stdout.write(frame)) {
          log('[host] warning: stdout backpressure (frame still queued by Node)');
        }
      },
    });
  } catch (error) {
    log(`[host] ${error.message}`);
    process.exit(1);
  }

  socket.on('close', () => shutdown('service websocket closed'));
  socket.on('error', (error) => log(`[host] ws error after open: ${error.message}`));

  // --- 连上即握手 ---
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'host/hello',
    params: { protocol: PROTOCOL_VERSION, pid: process.pid, hostVersion: HOST_VERSION },
  }));
  log('[host] connected; sent host/hello');

  // ws 打开期间积压的原生帧按序冲出去（在 hello 之后）。
  while (pendingNativeFrames.length > 0) {
    const payload = pendingNativeFrames.shift();
    forwardToService(payload);
  }

  function forwardToService(payloadBuffer) {
    let value;
    try {
      value = JSON.parse(payloadBuffer.toString('utf8'));
    } catch (error) {
      log(`[host] dropping unparseable native frame: ${error.message}`);
      return;
    }
    try {
      socket.send(JSON.stringify(value));
    } catch (error) {
      log(`[host] ws send failed: ${error.message}`);
    }
  }

  // --- 扩展 → service ---
  process.stdin.on('data', (chunk) => {
    const { frames, problems } = reader.push(chunk);
    for (const problem of problems) log(`[host] ${problem}`);
    for (const frame of frames) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (pendingNativeFrames.length >= PENDING_CAP) {
          log(`[host] dropping native frame: pending queue full (${PENDING_CAP})`);
          continue;
        }
        pendingNativeFrames.push(frame);
        continue;
      }
      forwardToService(frame);
    }
  });
  process.stdin.on('end', () => shutdown('native messaging stdin closed'));
}

// 仅作为主模块执行时启动（被测试 import 时只暴露纯函数）。
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
    log(`[host] fatal: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
