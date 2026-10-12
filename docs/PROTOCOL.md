# chrome-agent-browser 线缆协议（PROTOCOL_VERSION = 1）

## 1. 分层

```
extension (MV3 background.js)
   │  Chrome Native Messaging（每帧一个 JSON 对象，Chrome 自带长度前缀）
   ▼
native host (host/host.mjs, Node)  ——哑中继 + host/hello 握手
   │  WebSocket ws://127.0.0.1:<port>，每帧一个 JSON-RPC 2.0 对象
   ▼
service (service/service.mjs) ——命令层 + 租约镜像 + MCP 服务器
```

- **host 不理解任何命令**。它只做三件事：读配置、把 native messaging 的 JSON 原样转发到 service 的 WS、把 WS 的 JSON 原样转发回扩展。断任一侧即上报并退出。
- 连接方向：**host 主动连 service**（service 监听 127.0.0.1）。一个浏览器一个 host 进程（Chrome 按扩展会话拉起）。
- service 可同时挂多个浏览器（每浏览器一个 host 连接），按 ext/hello 的 instanceId 区分。

## 2. 握手

1. service 启动 → 监听 `127.0.0.1:<port>`（端口写进安装时生成的 host 配置）。
2. 扩展 background 启动 → `chrome.runtime.connectNative('com.chromeagentbrowser.host')`。
3. host 进程启动 → 读同目录 `host-config.json` → 连 service WS → 发 `host/hello`：
   `{jsonrpc:"2.0", id:1, method:"host/hello", params:{protocol:1, hostVersion, pid}}`
4. 扩展发第一个通知注册自己：
   `{jsonrpc:"2.0", method:"ext/hello", params:{instanceId, family, browserVersion, userAgent, capabilities:[...]}}`
5. service 回 `result:{ok:true}`（对 host/hello），此后按 method 分发。

## 3. 消息规则（全部 JSON-RPC 2.0）

- 请求：`{jsonrpc, id, method, params}`；method === 命令名（shared/protocol.mjs 的 COMMANDS 键）。
- 响应：`{jsonrpc, id, result}` 或 `{jsonrpc, id, error:{code, message, data?}}`。
- 通知（无 id）：扩展上报事件（EV.*）；service 下发 `session_expire` 等。
- 超时：service 端每请求默认 15s（CDP 调用 30s）。
- 断线：扩展端重连用 chrome.alarms 退避（1s/2s/5s/…封顶 30s）；host 退出码 0；service 保留租约镜像 60s 等重连。


- 扩展是租约权威（chrome.storage.session 持久化），service 只镜像。
- `tab_create` / `tab_claim` 成功即写入 `{tabId, sessionId, turnId, instanceId, origin:'agent', claimedAt, state:'active'}` 并广播 `onLeaseChange`。
- 被他人持有 → `LEASE_CONFLICT`。
- `session_finalize` 关闭非 keep 的 agent 标签页，租约置 finalized；`tab_mark` 改状态（deliverable/handoff 保留）。

## 5. CDP 直通

- `tab_cdp_call` 白名单在 shared/protocol.mjs `CDP_ALLOWLIST`（默认拒绝）；含实验域 `WebMCP.*`。
- 原始事件环：扩展按 tabId 缓冲（环形，每 tab 最多 500 条，带自增 sequence）；`tab_cdp_events` 游标分页，`truncated:true` 表示旧事件被逐出。
- attach 生命周期：命令需要时自动 attach（chrome.debugger.attach(tabId,"1.3")）；租约释放/tab 关闭时 detach；收到 onDetach 事件同步状态。

## 5b. WebMCP（页面自声明工具）

网页按 WebMCP 标准经页面 JS API（`document.modelContext.registerTool`）申报结构化工具，服务侧两条命令发现与调用（走 CDP 实验 `WebMCP` 域，Chrome ~156+）：

- `webmcp_list_tools {tabId}` → `{tools:[{name, description, inputSchema?, readOnly}], hint?}`
  扩展侧 `WebMCP.enable` 后收 `toolsAdded` 事件构建缓存（换页/关 tab 失效）。`readOnly` 来自 CDP annotations，**声明里没标就 false**。空列表时附 `hint`（页面 JS API 未启用的诊断）。
- `webmcp_invoke_tool {tabId, name, args?}` → `{result}`
  扩展侧发 `WebMCP.invokeTool`（frameId 取工具申报 frame），经 `toolResponded` 事件收结果（等待上限 12s，须低于命令超时 15s；超时发 `WebMCP.cancelInvocation`）。
- 浏览器无 WebMCP 域（旧版 Chrome）→ 错误码 `-32011 WEBMCP_UNSUPPORTED`。
- 策略门（service 层）：`webmcp_invoke` 的 readOnly 工具放行；非 readOnly 首次返回待确认（`POLICY_BLOCKED` + 一次性 token），批准后带 `confirmationToken` 重试放行。

## 6. 安全门（service 层强制）

- 高危动作（转账/发送/删除/下载执行/CDP 危险面）由 service 的 policy 模块拦截 → `POLICY_BLOCKED`，data 里带需要的人类确认句柄。
- MCP 面的确认通过 MCP elicitation（不支持时降级为：返回待确认描述，由调用方人工批准后带 confirmation token 重试）。
