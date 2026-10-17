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
- attach 即启用 WebMCP（v0.2.2）：ensureAttached 附带 WebMCP.enable（尽力而为，旧浏览器静默跳过），页面工具从附身起即有第一推动，无需先手动 list。
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
- **推送式发现通知（v0.2.1）**：扩展在 WebMCP 域已启用（首次 `webmcp_list_tools` 后）收到 `toolsAdded`/`toolsRemoved`，或主文档换页清缓存时，上报
  `onWebmcpTools {tabId, kind:'added'|'removed'|'changed', toolNames:[string]}`（`toolNames` 为该 tab **完整工具名快照**，非增量）。
  service 侧：
  - `connection` 把它分发为 `webmcp` 事件；`api` 层全局收件箱按 `instanceId:tabId` 保留最近一次快照 + 时间戳（`webmcp_list_tools` 成功也回填）；
  - `tab_info`（含 `user.getTabContext`）、`ab_new_tab`、`ab_navigate` 的返回在该 tab 有已申报工具时附 `webmcpHint:{toolNames, count}`；
  - MCP 面（若客户端支持日志通知）在收到清单变化时即时推送一行 `notifications/message`（info 级，logger=`webmcp`；同清单去重只推一次）。

## 5c. 登录表单探测（`login_detect`，v0.3.2）

`login_detect {tabId}` → `{found:true, username?, password, submit?, totp?}` 或 `{found:false, reason}`。
每个字段是定位器描述对象 `{kind:'css', value}`，供后续 `locator_action` 的 fill/click。**只读命令，不入审计白名单**；凭据不经此命令传输——填写走 `locator_action`（审计层对 fill 值记 `[redacted]`）。

扩展在页面内一次 Runtime.evaluate 完成：
- 找**可见**的 `input[type=password]`（第一个）；找不到 → `{found:false, reason:'no visible password input'}`。
- scope = 密码框所属 `<form>`（无 form 退化为整文档）。
- `username`：同 scope 内可见 text/email/tel 输入框——优先 `autocomplete=username`，其次 name/id/placeholder 含 user/email/account/login，再次密码框之前最近的一个；没有则 null。
- `submit`：scope 内 `button[type=submit]`/`input[type=submit]`/`button`；都没有则全页找带登录字样（登录/登陆/log in/sign in/continue/submit）的可见按钮。
- `totp`：scope 内 `input[autocomplete="one-time-code"]`，或同表单第二个密码风格输入框（OTP 框常伪装成密码框）；没有则 null（service 端存了 TOTP 种子也会跳过并在结果注明）。
- css 选择器生成：`#id` 唯一优先 → `name`/`autocomplete` 属性唯一 → nth-of-type 路径（锚在最近的带 id 祖先）。

service 端 `ab_login` 的完整流程（防钓鱼双锁见 README 安全模型）：origin 精确匹配（容忍 www.）→ 钥匙串取凭据（内存即用即弃）→ `login_detect` → locator fill（用户名/密码/TOTP）→ locator click 提交 → 3 秒内 tab 跳完全不同的域则结果标 `suspicious:true` 并写审计 `login_suspicious`。

## 5d. 实时投屏（`screencast_start`/`screencast_stop`，v0.4.0）

把网页变成帧流（`Page.startScreencast`），视觉 AI 从"看照片"（截图）升级到"看直播"（连续取帧）：

- `screencast_start {tabId, everyNthFrame?, quality?, maxWidth?, maxHeight?}` → `{ok:true}`
  扩展侧：ensureAttached → `Page.startScreencast {format:'jpeg', quality:60(默认), maxWidth:1280, maxHeight:800, everyNthFrame:1(默认)}`，登记该 tab 为投屏中（重复 start 视为重启）。
- `screencast_stop {tabId}` → `{ok:true}`
  `Page.stopScreencast` + 除名（幂等）。
- 帧上行：通知 `onScreencastFrame {tabId, data, ts, metadata}`。扩展收到 `Page.screencastFrame`
  事件后**立即回 `Page.screencastFrameAck {sessionId}`**（不回浏览器会停止发帧），再按
  **250ms/tab 节流**转发（窗口内的中间帧丢弃、保留最新一帧到期补发）。`data` 为 jpeg base64；
  `metadata` 只留 offsetTop/pageScaleFactor/deviceWidth/deviceHeight 摘要。
  **帧不进通用 CDP 事件环 / onCDPEvent**（体积大，避免冲爆环形缓冲）。
- 生命周期（扩展侧自动 stop / 除名）：tab 关闭（tabs.onRemoved）、debugger onDetach、
  `session_finalize`（本会话所有投屏中的标签页，含保留页）。
- service 侧：`connection` 把通知分发为 `screencast` 事件；`api` 层每 tab **环形缓存最近
  20 帧**（收到即存；帧数据不进审计、不落盘）；`tab.capabilities.get('screencast')` →
  `{start(opts), stop(), frames({limit?, sinceTs?})}`。`frames` 无缓存且未投屏时自动
  **lazy start** 并等首帧（至多 3s）——默认零开销；`stop` 清缓存并除名。
- MCP 面：`ab_screencast {action:'frames'|'stop', tabId, limit?(默认 1、上限 5)}`——
  frames 返回 MCP image content（jpeg）+ 每帧时间戳文本行；**不提供 start 动作**，
  开始投屏由首次取帧自动完成，stop 由模型显式调（或 tab 关闭兜底）。
- CDP 白名单新增 `Page.startScreencast` / `Page.stopScreencast` / `Page.screencastFrameAck`
  （经 `tab_cdp_call` 手动使用时帧仍走专用通道节流转发，不泛洪 onCDPEvent）。

## 6. 安全门（service 层强制）

- 高危动作（转账/发送/删除/下载执行/CDP 危险面）由 service 的 policy 模块拦截 → `POLICY_BLOCKED`，data 里带需要的人类确认句柄。
- MCP 面的确认通过 MCP elicitation（不支持时降级为：返回待确认描述，由调用方人工批准后带 confirmation token 重试）。

## 6b. 屏幕操作工具族（cua_*，v0.5.1）

`cua_*` 是浏览器链路之外的**屏幕级**操控面（任何应用），与 MCP 服务同进程
（`service/cua.mjs`，注册于 `service/mcp.mjs`），不经过 extension→host→service 线缆。

### 执行三层（逐级探测，优雅降级；cua_status 如实报告 tier）

| 层 | 执行体 | 能力 |
|---|---|---|
| A | `host/cua-helper`（`swift/cua-helper.swift` 由 setup 用 swiftc 编译；未编译产物不入库） | windows（CGWindowList）/ ax-tree（AXUIElement 遍历，深度 12、每层 80、总 1500、文本截断 120）/ element-click（AXPress 优先，失败取元素 bounds 中心定向坐标兜底）/ xy-click（有 pid → 定向投递不动真实光标；无 pid → 全局）/ type（≤4000 字符，20 字符/事件分段）/ key（键码映射 + cmd/ctrl/alt/shift）/ app-focus（AX raise + activate）/ overlay-show · overlay-hide（幽魂光标叠加）/ request-permissions（系统标准权限申请）/ show-permission-card · hide-permission-card（权限引导悬浮卡片，v0.5.4） |
| B | osascript + System Events（零编译兜底） | 同形状的 ax-tree / element-click / type / key / app-focus / windows（较慢；无坐标能力；窗口无 CGWindowID，截图用 rect） |
| C | 无任何授权 | windows（仅 helper 编译过时走 CGWindowList，窗口表本身无需授权）+ 截图（screencapture，需屏幕录制授权） |

- helper 行协议：stdin 每行一个 JSON 请求 `{id, cmd, ...参数}`，stdout 每行一个 JSON 响应
  `{id, ok:true, ...}` | `{id, ok:false, error, code?}`；常驻进程、按 id 配对、死亡自动重启。
- 权限探测：helper `probe` → `{axGranted: AXIsProcessTrusted, screenGranted: CGPreflightScreenCaptureAccess,
  responsibleProcess 负责进程名（TCC 记账的宿主 App，沿 ppid 链向上找最近带 bundle 的 App 推断——
  从终端跑时即终端名，设置列表里要勾选的就是它）, screen:{w,h} 主屏尺寸}`；
  无 helper 时 AX 用 osascript 试探（不可靠的项如实报 unknown）。
- 权限申请（v0.5.3）：helper `request-permissions` → `{axGranted, axRequested, screenGranted,
  screenRequested, responsibleProcess}`。各自仅在缺失时申请：AX 用
  `AXIsProcessTrustedWithOptions(kAXTrustedCheckOptionPrompt=true)`（弹标准对话框并把负责进程
  加进辅助功能列表，未勾选），屏幕录制用 `CGPreflightScreenCaptureAccess()` → `CGRequestScreenCaptureAccess()`；
  静置 ~500ms 让弹窗出现后立即返回（不阻塞等用户操作），用户在系统设置勾选后经 `probe` 复测生效。
  引导编排见 `service/cua-guide.mjs`（cua-selftest 互动引导 / setup 非交互指引）。
- 引导卡片（v0.5.4）：helper `show-permission-card {kind:'accessibility'|'screen', appName,
  durationSec?(默认120,夹取5..600)}` → `{kind, autoHideSec, frame:{x,y,w,h}(屏幕左上原点), dragFrom?}`；
  `hide-permission-card {kind}` 幂等收卡。300×116 borderless NSPanel：floating/nonactivating/
  canJoinAllSpaces，**ignoresMouseEvents=false（本工具族唯一可交互的叠加窗——它就是给用户看
  的引导 UI）**、isMovableByWindowBackground（拖背景=挪位置）、整卡不抢焦点。左侧琥珀图标=
  拖拽句柄：`NSDraggingSource` 文件拖拽，拖出的就是 `responsibleAppBundleURL()`（负责进程的
  .app bundle——TCC 记账、设置列表要加的正是它），可直接放进系统设置权限列表（等同点 + 号
  选 App）；文案主推「点 + 号选终端」、拖拽为快捷路径。双卡（accessibility 上/screen 下）错位
  不重叠；同 kind 重复 show=就地更新文案并保留用户拖过的位置。stdin EOF 时若卡片在屏则留守、
  收齐再退（setup 非交互留卡，寿命封顶 600s）。服务侧 `showPermissionCard/hidePermissionCard/
  openPrivacyPane`（引导编排见 `service/cua-guide.mjs`：申请后自动开对应设置面板+浮卡，权限
  到手或引导中止即收卡；旧 helper 无卡片命令时静默降级为纯文字引导）。
- tier 判定：A = helper 且 AX 已授权；B = 无 helper 但 AX 已授权；C = AX 未授权；非 macOS = unsupported。

### MCP 工具（9 个）

`cua_status`（能力矩阵+人话授权指引 `permissionGuide:{text,card}`，card=有无悬浮引导卡片能力）/ `cua_windows` / `cua_ax_tree {app?|pid?, maxDepth?}` /
`cua_screenshot {windowId?|rect?, format?}` / `cua_click {app?|pid?, role?, title?} | {x, y, pid?}` /
`cua_type {text, app?|pid?}` / `cua_key {key, modifiers?, confirmationToken?}` / `cua_app_focus {app}` /
`cua_verify {x?|y?|windowId?}`。

### cua_verify 的物理验证契约（防幻觉）

每个动作（click/type/key/app_focus）执行前，服务自动对动作目标（窗口/坐标周边 480×320/前台窗口）
截一张 **JPEG 前证据**（截图失败降级为 `{kind:'none', reason}`，不阻塞动作）；`cua_verify` 再取
**后证据**，连同上一动作描述成对返回 `{action, before, after, note}`。note 明确告知调用方：
**声称已点击不算数，必须核对两份证据**。证据只保留最近一次动作（内存，不落盘）。

### 审计与策略

- 审计：`audit.recordCua` 写 `cua_click` / `cua_type` / `cua_key` / `cua_app_focus` 四类条目
  （读类不入档）；xy 点击记坐标，type 记 `[redacted]` + 长度，key 记键名与修饰键。
- 策略：policy kind `cua_action`——默认 `cua_key` 的 `cmd+q` / `cmd+w`（`confirmCuaKeys` 可配）
  走确认门（`POLICY_BLOCKED` + 一次性 token，`ab_confirm` 批准后带 `confirmationToken` 重试），
  其余动作直行；未知 kind 仍 fail-closed。
- 截图统一走 `screencapture` 子进程（`-x` 静默；窗口 `-l<windowId>`；区域 `-Rx,y,w,h`；临时文件读回即删）。

### 幽魂光标叠加（overlay，v0.5.1）

helper 新增两条命令（均在 v0.5.1 的线程模型下工作：主线程跑 AppKit run loop，
stdin 由后台队列逐行读，窗口操作经主队列执行，stdin EOF → terminate 退出）：

- `overlay-show {x, y, kind:'arrow'|'click', durationMs?}` → `{ok:true}`：在屏幕坐标 (x,y)
  闪现琥珀色（#f59e0b，与扩展角标同色系）AI 专属箭头；kind=click 追加约 350ms 扩散涟漪；
  durationMs（默认 700，夹取 100..5000）后淡出并 orderOut。窗口为懒创建复用的 140×140
  borderless NSPanel：level=floating+2、isOpaque=false、backgroundColor=clear、
  **ignoresMouseEvents=true（点击穿透）**、collectionBehavior=[canJoinAllSpaces,
  fullScreenAuxiliary]（全屏应用上也显示）、hidesOnDeactivate=false，**绝不 activate**；
  绘制为纯代码 NSBezierPath（箭头 + 白描边 + 阴影外发光），无资源文件。
  参数不合法 → `{ok:false, code:'bad-args'|'bad-kind'}`；任何失败只回错误，不影响主命令循环。
- `overlay-hide` → `{ok:true}`：取消在途淡出/涟漪并立即隐藏（幂等）。

服务侧集成（`service/cua.mjs`）：**点击类动作在注入前** fire-and-forget 调 overlay-show
（坐标模式用点击坐标；元素模式用目标窗口中心近似——AX press 无坐标语义，坐标兜底应答的
`at` 会把后续输入提示精化到真实落点）；**type/key 在最近一次点击 30 秒内**于原地显示 arrow。
叠加在「前证据」截图之后、注入之前触发（不入镜、不污染物理验证）；失败自吞、绝不阻塞真实
动作；本身不入审计（纯可视化）。开关：policy-defaults.json 的 `cuaOverlay`（默认 true），
关闭后零调用；`cua_status` 以 `overlay:{available,enabled}` 如实报告（仅 A 层 available）。

### 永不做的

锁屏/解锁/绕过认证类能力（helper 二进制中不存在对应命令）。
无 pid 的全局坐标点击会移动真实光标——工具描述如实声明，这是唯一会动用户光标的操作
（幽魂光标是叠加窗可视化，点击穿透、不动真鼠标、不抢焦点）。

