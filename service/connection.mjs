// service/connection.mjs — 扩展连接管理
//
// 职责（对照 docs/PROTOCOL.md）：
//   - WebSocket 服务端监听 127.0.0.1:<port>；每个 WS 连接 = 一个浏览器实例
//     （host 是哑中继，一个浏览器一个 host 进程，host 主动连进来）。
//   - 握手：对端先发 host/hello 请求（回 {ok:true}），随后发 ext/hello 通知
//     完成浏览器注册（instanceId 区分多浏览器）。
//   - 出站命令 cmd()：JSON-RPC 请求，id 自增 + 挂起表 + 超时（默认 15s）。
//   - 入站通知按 EV.* 分发为 'page'/'cdp'/'lease'/'download'/'dialog'/'badge'/'webmcp'。
//   - 心跳：每 heartbeatIntervalMs 发 browser_status，连续失败 maxFailures 次判死。
//   - 断连保留租约镜像 leaseMirrorTtlMs（默认 60s），同 instanceId 重连恢复。
//
// 多实例（frontend 模式，v1）：
//   - 入站连接的第一条请求若为 {method:'mcp/hello'}（带 id）→ 归类为 frontend 连接
//     （FrontendConnection）：回 {ok:true, protocol:1}，不参与 ext/hello 浏览器注册，
//     liveConnections() 不含它，心跳/租约镜像逻辑也一概跳过。
//   - frontend 发 {method:'mcp/cmd', params:{command, params}} → 服务端取第一个活跃
//     浏览器连接执行，结果/错误原样回传（保留错误 code）；无浏览器回 -32002。
//   - frontendSockets（Set）维护 frontend 计数，增减时触发 'frontendCountChange'。
//   - 浏览器全部断开时主动断开所有 frontend（给前端一个明确的「共用浏览器没了」信号）。

import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { EV, ERR, COMMANDS, PROTOCOL_VERSION, FRONTEND_HELLO, FRONTEND_CMD } from '../shared/protocol.mjs';

// v1 前端协议约定：无浏览器连接时的 mcp/cmd 错误码（数值上与 ERR.TAB_NOT_FOUND 相同）。
const FRONTEND_NO_BROWSER_CODE = -32002;

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7331,
  cmdTimeoutMs: 15_000,
  heartbeatIntervalMs: 30_000, // 每 30s 一次 → 3 次失败 ≈ 60~90s 判死
  heartbeatTimeoutMs: null,    // 默认 max(2000, interval/2)
  heartbeatMaxFailures: 3,
  leaseMirrorTtlMs: 60_000,
};

/** 单个浏览器连接（一个 WS = 一个 host + 一个浏览器）。 */
export class BrowserConnection extends EventEmitter {
  constructor(socket, manager, opts, connId) {
    super();
    this.socket = socket;
    this.manager = manager;
    this.opts = opts;
    this.connId = connId;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    // ext/hello 注册信息
    this.instanceId = null;
    this.family = null;
    this.browserVersion = null;
    this.userAgent = null;
    this.profileName = null;
    this.capabilities = [];
    this.registeredAt = null;
    this.restored = false; // 重连恢复（同 instanceId）
    this.leases = new Map(); // tabId -> lease（镜像，权威在扩展）
    this.closedAt = null;
    this.heartbeatFailures = 0;
    this.heartbeatTimer = null;
    socket.on('message', (data) => this._onMessage(data));
    socket.on('close', () => this._onClose());
    socket.on('error', () => { /* 出错后必有 close */ });
  }

  get isClosed() { return this.closedAt !== null; }

  /** 发一条命令给扩展，返回 Promise（超时 reject code=-32000）。 */
  cmd(method, params = {}, { timeoutMs = this.opts.cmdTimeoutMs } = {}) {
    if (typeof method !== 'string' || !COMMANDS[method]) {
      return Promise.reject(this._err(`unknown command: ${method}`, ERR.INVALID_PARAMS));
    }
    return new Promise((resolve, reject) => {
      if (this.isClosed) { reject(this._err('connection closed', -32000)); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this._err(`timeout: ${method}`, -32000));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  // ---- 内部 ----

  _err(message, code, data) {
    const e = new Error(message);
    e.code = code;
    if (data !== undefined) e.data = data;
    return e;
  }

  _send(obj) {
    if (this.socket.readyState !== 1 /* WebSocket.OPEN */) return;
    try { this.socket.send(JSON.stringify(obj)); } catch { /* 关闭竞态，交给 close 处理 */ }
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) this._onRequest(msg);
      else this._onNotification(msg);
    } else if (msg.id !== undefined) {
      this._onResponse(msg);
    }
  }

  /** 入站请求：v1 只expect host/hello，其余一律 METHOD_NOT_FOUND。 */
  _onRequest(msg) {
    if (msg.method === 'host/hello') {
      this.hostHello = msg.params ?? {};
      this._send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
      return;
    }
    this._send({ jsonrpc: '2.0', id: msg.id, error: { code: ERR.METHOD_NOT_FOUND, message: `method not found: ${msg.method}` } });
  }

  /** 入站响应：配对挂起表。 */
  _onResponse(msg) {
    const slot = this.pending.get(msg.id);
    if (!slot) return;
    this.pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) slot.reject(this._err(msg.error.message ?? 'rpc error', msg.error.code ?? ERR.INTERNAL, msg.error.data));
    else slot.resolve(msg.result ?? {});
  }

  /** 入站通知：ext/hello 注册；EV.* 分发。 */
  _onNotification(msg) {
    const p = msg.params ?? {};
    switch (msg.method) {
      case EV.HELLO: this._register(p); return;
      case EV.BYE: this.socket.close(); return;
      case EV.PAGE_EVENT: this.emit('page', p); return;
      case EV.CDP_EVENT:
      case EV.CDP_DETACH: this.emit('cdp', p); return;
      case EV.LEASE_CHANGE: {
        if (p.lease === null || p.lease === undefined) this.leases.delete(p.tabId);
        else this.leases.set(p.tabId, p.lease);
        this.emit('lease', p);
        return;
      }
      case EV.DOWNLOAD_CHANGE: this.emit('download', p); return;
      case EV.DIALOG: this.emit('dialog', p); return;
      case EV.BADGES: this.emit('badge', p); return;
      case EV.WEBMCP_TOOLS: this.emit('webmcp', p); return; // {tabId, kind, toolNames}
      default: this.emit('notification', msg); return;
    }
  }

  /** ext/hello：注册 + 同 instanceId 重连恢复镜像租约。 */
  _register(p) {
    this.instanceId = p.instanceId ?? `anon-${this.connId}`;
    this.family = p.family ?? 'unknown';
    this.browserVersion = p.browserVersion ?? null;
    this.userAgent = p.userAgent ?? null;
    this.profileName = p.profileName ?? null;
    this.capabilities = Array.isArray(p.capabilities) ? p.capabilities : [];
    this.registeredAt = Date.now();
    this.restored = false;
    const retained = this.manager.retained.get(this.instanceId);
    if (retained) {
      for (const [tabId, lease] of retained.leases) this.leases.set(tabId, lease);
      clearTimeout(retained.purgeTimer);
      this.manager.retained.delete(this.instanceId);
      this.restored = true;
    }
    this.manager._onRegistered(this);
    this._startHeartbeat();
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatFailures = 0;
    const timeoutMs = this.opts.heartbeatTimeoutMs ?? Math.max(2_000, Math.floor(this.opts.heartbeatIntervalMs / 2));
    this.heartbeatTimer = setInterval(async () => {
      if (this.isClosed) return;
      try {
        await this.cmd('browser_status', {}, { timeoutMs });
        this.heartbeatFailures = 0;
      } catch {
        if (this.isClosed) return;
        this.heartbeatFailures += 1;
        if (this.heartbeatFailures >= this.opts.heartbeatMaxFailures) {
          this._stopHeartbeat();
          this.socket.terminate(); // 判死 → 触发 close → browserClosed + 镜像保留
        }
      }
    }, this.opts.heartbeatIntervalMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  _onClose() {
    if (this.isClosed) return;
    this.closedAt = Date.now();
    this._stopHeartbeat();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(this._err('connection closed', -32000));
    }
    this.pending.clear();
    this.manager._onClosed(this);
  }
}

/** 单个 frontend 连接（另一个 mcp-entry 进程以「前端模式」共用本服务时连入）。 */
export class FrontendConnection {
  constructor(socket, manager, helloMsg) {
    this.socket = socket;
    this.manager = manager;
    this.closedAt = null;
    socket.on('message', (data) => this._onMessage(data));
    socket.on('close', () => this._onClose());
    socket.on('error', () => { /* 出错后必有 close */ });
    // hello 应答：{ok:true, protocol:1}（browsers 为附加快照，供前端标识当前共用的浏览器；
    // 快照会过期——v1 不推送浏览器上下线事件，前端以「第一个活跃浏览器」为准）。
    this._send({
      jsonrpc: '2.0', id: helloMsg.id,
      result: { ok: true, protocol: PROTOCOL_VERSION, browsers: manager._browserSnapshot() },
    });
    manager._onFrontendOpen(this);
  }

  get isClosed() { return this.closedAt !== null; }

  // ---- 内部 ----

  _send(obj) {
    if (this.socket.readyState !== 1 /* WebSocket.OPEN */) return;
    try { this.socket.send(JSON.stringify(obj)); } catch { /* 关闭竞态，交给 close 处理 */ }
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.method === 'string' && msg.id !== undefined) this._onRequest(msg);
    // v1：frontend -> service 只有请求（mcp/cmd），通知一律忽略
  }

  /** 入站请求：mcp/cmd 代理到第一个活跃浏览器；其余 METHOD_NOT_FOUND。 */
  _onRequest(msg) {
    if (msg.method === FRONTEND_CMD) { this._onCmd(msg); return; }
    this._send({ jsonrpc: '2.0', id: msg.id, error: { code: ERR.METHOD_NOT_FOUND, message: `method not found: ${msg.method}` } });
  }

  /** mcp/cmd 路由：结果/错误原样回传（保留错误 code 与 data）。 */
  _onCmd(msg) {
    const p = (msg.params && typeof msg.params === 'object') ? msg.params : {};
    const conns = this.manager.liveConnections();
    if (!conns.length) {
      this._send({ jsonrpc: '2.0', id: msg.id, error: { code: FRONTEND_NO_BROWSER_CODE, message: 'no browser connected' } });
      return;
    }
    conns[0].cmd(p.command, p.params ?? {})
      .then((result) => this._send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }))
      .catch((err) => {
        const error = { code: (err && err.code !== undefined) ? err.code : ERR.INTERNAL, message: String((err && err.message) || err) };
        if (err && err.data !== undefined) error.data = err.data;
        this._send({ jsonrpc: '2.0', id: msg.id, error });
      });
  }

  _onClose() {
    if (this.isClosed) return;
    this.closedAt = Date.now();
    this.manager._onFrontendClosed(this);
  }
}

/** 连接管理器：WS 服务端 + 已注册浏览器目录 + 60s 租约镜像保留 + frontend 目录。 */
export class ConnectionManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.wss = null;
    this.connections = new Set();
    this.retained = new Map(); // instanceId -> {leases, closedAt, purgeTimer}
    this.frontendSockets = new Set(); // FrontendConnection 集合（多实例前端）
    this._nextConnId = 1;
  }

  get port() { return this.wss && this.wss.address() ? this.wss.address().port : null; }
  get protocolVersion() { return PROTOCOL_VERSION; }

  async start() {
    await new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: this.opts.host, port: this.opts.port }, resolve);
      this.wss.once('error', reject);
      this.wss.on('error', () => { /* 运行期错误由 close 兜底（含 EADDRINUSE 被拒后） */ });
    });
    this.wss.on('connection', (socket) => this._onConnection(socket));
    return this;
  }

  /**
   * 连接分类：第一条请求决定身份——
   *   mcp/hello（带 id）→ frontend（共用本服务的另一个 mcp-entry）；
   *   其余（host/hello 等）→ 浏览器 host 连接，首帧回放给 BrowserConnection。
   */
  _onConnection(socket) {
    const onFirst = (data) => {
      detach();
      let msg = null;
      try { msg = JSON.parse(String(data)); } catch { /* 坏帧按浏览器连接处理（BrowserConnection 同样会忽略） */ }
      if (msg && typeof msg === 'object' && msg.method === FRONTEND_HELLO && msg.id !== undefined) {
        new FrontendConnection(socket, this, msg); // 构造内完成应答与计数登记
      } else {
        const conn = new BrowserConnection(socket, this, this.opts, this._nextConnId++);
        this.connections.add(conn);
        conn._onMessage(data); // 回放首帧（其监听器在本帧派发之后才挂上）
      }
    };
    const onClose = () => detach(); // 首条消息前就断开：直接遗忘
    const detach = () => { socket.off('message', onFirst); socket.off('close', onClose); };
    socket.on('message', onFirst);
    socket.on('close', onClose);
  }

  /** 已注册（ext/hello 完成）且未断开的连接。 */
  liveConnections() {
    return [...this.connections].filter((c) => c.instanceId && !c.isClosed);
  }

  get(instanceId) {
    return this.liveConnections().find((c) => c.instanceId === instanceId) ?? null;
  }

  _onRegistered(conn) { this.emit('browser', conn); }

  _onClosed(conn) {
    this.connections.delete(conn);
    if (!conn.instanceId) return;
    this.emit('browserClosed', conn);
    const purgeTimer = setTimeout(() => this.retained.delete(conn.instanceId), this.opts.leaseMirrorTtlMs);
    if (purgeTimer.unref) purgeTimer.unref();
    this.retained.set(conn.instanceId, { leases: new Map(conn.leases), closedAt: Date.now(), purgeTimer });
    // 浏览器全部断开 → 断开所有 frontend（v1 约定：给前端明确的「共用浏览器没了」信号，
    // 而不是让它对着一个只会回 -32002 的连接空转）。
    if (this.liveConnections().length === 0 && this.frontendSockets.size > 0) {
      for (const f of [...this.frontendSockets]) f.socket.terminate();
    }
  }

  // ---- frontend 目录（多实例共用） ----

  /** 当前活跃浏览器的身份快照（随 mcp/hello 应答发给前端；会过期，仅作展示用）。 */
  _browserSnapshot() {
    return this.liveConnections().map((c) => ({
      instanceId: c.instanceId, family: c.family, browserVersion: c.browserVersion,
      profileName: c.profileName, capabilities: c.capabilities,
    }));
  }

  _onFrontendOpen(frontend) {
    this.frontendSockets.add(frontend);
    this.emit('frontendCountChange', this.frontendSockets.size);
  }

  _onFrontendClosed(frontend) {
    if (!this.frontendSockets.delete(frontend)) return;
    this.emit('frontendCountChange', this.frontendSockets.size);
  }

  async stop() {
    for (const conn of this.connections) { conn._stopHeartbeat(); conn.socket.terminate(); }
    this.connections.clear();
    for (const f of this.frontendSockets) f.socket.terminate();
    this.frontendSockets.clear();
    for (const r of this.retained.values()) clearTimeout(r.purgeTimer);
    this.retained.clear();
    if (this.wss) await new Promise((resolve) => this.wss.close(() => resolve()));
    this.wss = null;
  }
}
