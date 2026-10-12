// service/remote-frontend.mjs — 前端模式的「远程管理器」
//
// 场景：第二个 mcp-entry 进程发现端口被既有 service 占用（EADDRINUSE）时，不再退出，
// 而是以 frontend 身份连上既有 service，共用它的浏览器连接（README 的多实例承诺）。
// 线缆协议见 shared/protocol.mjs 的 FRONTEND_HELLO / FRONTEND_CMD 注释。
//
// 对 api.mjs 暴露与 ConnectionManager 相同的最小面：
//   - liveConnections() → [remoteConn]（remoteConn 具备 instanceId/isClosed/cmd/
//     family/profileName/browserVersion/capabilities/on('page') 形状）；
//   - 'browser' 事件（start() 握手成功后发一次，载荷即 remoteConn）；
//   - 'browserClosed' 事件（ws 断开时发——service 侧浏览器全部断开会主动关掉本连接）。
//
// v1 限制（诚实声明）：
//   - 不订阅 page/lease/download/dialog/badge 等事件通知 → api 层的 tab 缓存
//     （url/title/removed）在前端模式不会因事件更新，只能靠 tab_info 等请求-响应兜底；
//     remoteConn.leases 恒为空（租约镜像只在 service 侧维护）。
//   - 不自动重连；service 连接断开后所有命令报错，直至本进程退出重启。
//   - 命令固定路由到 service 侧「第一个活跃浏览器」（v1 无浏览器选择）。

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { FRONTEND_HELLO, FRONTEND_CMD, COMMANDS, ERR, PROTOCOL_VERSION } from '../shared/protocol.mjs';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7331,
  helloTimeoutMs: 3_000, // 连接 + mcp/hello 握手总上限（防端口被非本协议程序占用时挂死）
  cmdTimeoutMs: 20_000,  // 单条 mcp/cmd 超时（service 侧还会受其 15s cmd 超时约束）
};

/** JS Error（保留线缆错误 code/data，与 BrowserConnection 的错误形状一致）。 */
function rpcErr(message, code, data) {
  const e = new Error(message);
  e.code = code;
  if (data !== undefined) e.data = data;
  return e;
}

/** 远程浏览器连接（代表 service 侧「第一个活跃浏览器」，身份来自 mcp/hello 快照）。 */
class RemoteConnection extends EventEmitter {
  constructor(frontend, info = {}) {
    super();
    this.frontend = frontend;
    this.instanceId = info.instanceId ?? 'remote';
    this.family = info.family ?? 'remote';
    this.browserVersion = info.browserVersion ?? null;
    this.profileName = info.profileName ?? null;
    this.capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
    this.leases = new Map(); // 形状对齐（v1 无事件桥，恒为空）
  }

  get isClosed() { return this.frontend.isClosed; }

  /** 命令 → 包成 mcp/cmd 发给 service 路由（错误 code 原样透传）。 */
  cmd(method, params = {}, { timeoutMs } = {}) {
    if (typeof method !== 'string' || !COMMANDS[method]) {
      return Promise.reject(rpcErr(`unknown command: ${method}`, ERR.INVALID_PARAMS));
    }
    return this.frontend._request(FRONTEND_CMD, { command: method, params }, { timeoutMs });
  }
}

/** 前端模式的远程管理器：ws 连上既有 service，代理全部命令。 */
export class RemoteFrontend extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.ws = null;
    this.remoteConn = null;
    this._closed = true;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer}
  }

  get isClosed() { return this._closed; }
  get port() { return this.opts.port; }

  /** 连接 + mcp/hello 握手（总上限 helloTimeoutMs，失败抛清晰错误，绝不挂死）。 */
  async start() {
    if (this.ws) throw new Error('RemoteFrontend already started');
    const url = `ws://${this.opts.host}:${this.opts.port}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('error', () => { /* 统一由 open/close 路径处理 */ });

    const hello = await new Promise((resolve, reject) => {
      const fail = (err) => {
        cleanup();
        try { ws.terminate(); } catch { /* 已关 */ }
        reject(err);
      };
      const timer = setTimeout(
        () => fail(rpcErr(`mcp/hello timeout after ${this.opts.helloTimeoutMs}ms: ${url}`, ERR.INTERNAL)),
        this.opts.helloTimeoutMs,
      );
      const onOpen = () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: FRONTEND_HELLO, params: { protocol: PROTOCOL_VERSION } }));
      };
      const onMessage = (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (!msg || msg.id !== 1) return;
        if (msg.result && msg.result.ok === true) { cleanup(); resolve(msg.result); return; }
        fail(rpcErr(`mcp/hello refused by ${url}: ${JSON.stringify(msg.error ?? msg.result ?? msg)}`, ERR.INTERNAL));
      };
      const onError = (err) => fail(rpcErr(`cannot connect to ${url}: ${(err && err.message) || err}`, ERR.INTERNAL));
      const onClose = () => fail(rpcErr(`connection to ${url} closed before mcp/hello reply`, ERR.INTERNAL));
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
      };
      ws.once('open', onOpen);
      ws.on('message', onMessage);
      ws.once('error', onError);
      ws.once('close', onClose);
    });

    this._closed = false;
    // 身份快照（hello 附带；无浏览器时为空 → 占位 'remote'）
    const info = (Array.isArray(hello.browsers) && hello.browsers[0]) || {};
    this.remoteConn = new RemoteConnection(this, info);
    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', () => this._onClose());
    this.emit('browser', this.remoteConn);
    return this;
  }

  /** api.mjs 所需：活跃连接列表（service 连接断开后为空）。 */
  liveConnections() {
    return (!this._closed && this.remoteConn) ? [this.remoteConn] : [];
  }

  /** 内部：发一条 frontend 请求并等待应答（超时/断线 reject，错误 code 透传）。 */
  _request(method, params, { timeoutMs = this.opts.cmdTimeoutMs } = {}) {
    if (this._closed || !this.ws || this.ws.readyState !== 1 /* OPEN */) {
      return Promise.reject(rpcErr('frontend connection closed', -32000));
    }
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(rpcErr(`timeout: ${method}`, -32000));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(rpcErr(`send failed: ${err.message}`, -32000));
      }
    });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object' || msg.id === undefined) return; // v1 不订阅 service 通知
    const slot = this._pending.get(msg.id);
    if (!slot) return;
    this._pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) slot.reject(rpcErr(msg.error.message ?? 'rpc error', msg.error.code ?? ERR.INTERNAL, msg.error.data));
    else slot.resolve(msg.result ?? {});
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(rpcErr('frontend connection closed', -32000));
    }
    this._pending.clear();
    if (this.remoteConn) this.emit('browserClosed', this.remoteConn);
  }

  /** 断开（幂等；挂起命令立即 reject）。 */
  stop() {
    if (this.ws) { try { this.ws.terminate(); } catch { /* 已关 */ } }
    this._onClose();
  }
}
