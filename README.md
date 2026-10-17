# chrome-agent-browser

一句话：让 AI 代理（agent）直接操控**你真实的、带登录态的 Chromium 系浏览器**，并按需延伸到**整块屏幕**（窗口清单 / 界面元素 / 截图 / 点击输入）——通过「浏览器扩展 + 原生宿主 + 本地服务」三层桥接，以 MCP（Model Context Protocol）工具面暴露给任意 MCP 客户端（ZCode / Cursor 等）。

**纯本地架构**：所有指令只在你机器上的 127.0.0.1 里流动，不出网、无云端组件、无需账号。

## 架构（五层）

```
┌─ 5 ─ MCP 客户端（任意支持 MCP 的 AI 工具）
│        │ MCP over stdio（JSON-RPC 2.0）           ← service/mcp-entry.mjs（入口）
│        ▼
├─ 4 ─ MCP 工具面  service/mcp.mjs：30 个工具（ab_* 粗粒度 + browser_eval REPL + cua_* 屏幕操作）
│        ▼
├─ 3 ─ service 命令层  service/api.mjs（Agent API）+ policy.mjs（策略门）
│        + connection.mjs（WS 服务端 / 租约镜像 / 心跳）
│        │ WebSocket ws://127.0.0.1:<port>（JSON-RPC 2.0，见 docs/PROTOCOL.md）
│        ▼
├─ 2 ─ native host  host/host.mjs —— 哑中继（读 host-config.json，帧转发，无浏览器逻辑）
│        │ Chrome Native Messaging（每帧一个 JSON）
│        ▼
├─ 1 ─ extension  extension/background.js（MV3）—— 租约权威 + chrome.debugger CDP 执行体
│        ▼
└─ 用户浏览器（Chrome/Edge/Brave/Opera/Vivaldi，真实 profile，登录态天然可用）
```

- 命令目录、事件、错误码、CDP 白名单的单一事实来源：`shared/protocol.mjs`。
- 连接方向：host 主动连 service（service 监听 127.0.0.1）；一个浏览器一个 host 进程；断连后租约镜像保留 60s 等重连。

## 快速开始（npm 安装，两条命令 + 一次拖拽）

```bash
# 1. 全局安装（需要 Node 18+；全局路径固定 → 扩展 ID 稳定，升级不失效）
npm install -g chrome-agent-browser

# 2. 一条命令安装：自动算扩展ID → 检测已装浏览器 → 写清单/配置 → 打开 Chrome 扩展页
#    （扩展目录路径自动进剪贴板）→ 原地等待验证，你在 Chrome 里加载完扩展那一刻自动打钩
chrome-agent-browser          # 即 setup
```

MCP 配置（无需路径，命令已进 PATH）：

```json
{ "mcpServers": { "chrome-agent-browser": { "command": "chrome-agent-browser-mcp" } } }
```

其他命令：`chrome-agent-browser-doctor`（体检）、`chrome-agent-browser-uninstall`（卸载）、
`chrome-agent-browser -- --no-open/--port/--browser arc` 等参数照旧。

<details><summary>从 GitHub 源码安装（替代方式）</summary>

```bash
git clone https://github.com/xiixiixixi/chrome-agent-browser.git
cd chrome-agent-browser && npm install
npm run setup
```
MCP 配置指向 `node /绝对路径/chrome-agent-browser/service/mcp-entry.mjs`。

</details>

setup 会打印唯一的手动步骤：Chrome 的 `chrome://extensions` → 开发者模式 →
「加载已解压的扩展程序」→ 粘贴剪贴板里的目录路径。验证打钩后，setup 直接给出
可复制的 MCP 客户端配置片段（端口已自动固化，无需传参）。

> 扩展 ID 由扩展目录的绝对路径决定（Chrome 的规则）。**npm 全局安装的路径固定 → 升级版本 ID 不变**；
> 源码安装的目录一旦移动就要重跑 setup 重新加载扩展。

卸载：npm 安装用户 `chrome-agent-browser-uninstall` 后再 `npm uninstall -g chrome-agent-browser`；
源码用户 `npm run uninstall`。两者都只删本机清单与配置，Chrome 内手动移除扩展即彻底干净。

高级参数：`chrome-agent-browser -- --no-open`（不自动开 Chrome）/ `--port N` / `--timeout 秒` /
`--browser all|chrome|edge|brave|opera|vivaldi|arc` / `--dry-run`（源码用户等价命令 `npm run setup -- …`）。

更新到新版：npm 安装用户 `npm update -g chrome-agent-browser`；源码用户 `git pull && npm install`。
两者升级后扩展无需重新加载（ID 不变），但建议重跑一次 setup 刷新配置。

## 服务生命周期（常问三问）

- **要开机自启吗？** 不用。`npm install` 只是放文件，不启动任何东西。
- **服务什么时候启动？** MCP 客户端发起会话时按配置拉起 `mcp-entry.mjs` 子进程；客户端退出
  （stdin 关闭）或关掉会话，进程随之优雅退出。没有客户端连它，它就不存在。
- **独立跑过服务又退出了，列表变空？** 服务是按需进程：`npm run doctor` 一条命令看断点；空列表≠报错，先 doctor。
- **服务中途死了怎么办？** 前端模式的进程会自动**接管端口变成新服务**（浏览器扩展自动重连，AI 客户端全程无感）；连续恢复失败才退出待重拉。
- **多个 MCP 客户端同时用？** 支持。第一个实例充当 service 并监听端口；后续实例探测到
  端口已占用后自动切换为「前端模式」连接既有服务，共享同一个浏览器连接；全部客户端退出后
  最后一个 service 进程退出，不留孤儿进程。

## MCP 工具面（30 个 = 21 个浏览器 + 9 个屏幕操作）

| 工具 | 作用 |
|---|---|
| `ab_status` / `ab_list_browsers` | **服务体检**（区分"没浏览器"vs"链路断"）/ 列出受控浏览器 |
| `ab_open_tabs` | 列出用户已开的标签页（可选 `browserId` 指定目标，如 Arc） |
| `ab_new_tab` / `ab_tab_info` / `ab_navigate` | 开标签页 / 读信息 / 导航（过策略门） |
| `ab_read_urls` | **批量隐形读页**：后台开临时标签逐个读取标题+正文、读完即关，不干扰用户当前屏幕（1-10 个 URL，被策略拦的记 blocked） |
| `ab_screenshot` / `ab_ax_state` | 截图（PNG；可选 `selector` 做元素级截图）/ 无障碍树文本 |
| `ab_screencast` | **实时帧**：把标签页当直播看——`frames` 取最新画面（JPEG，首次自动开始投屏，`limit` 最多 5 帧对比变化），看完 `stop` 省资源。等加载/动画/滚动时连续取帧，比反复截图更省更直观 |
| `ab_visibility` / `ab_viewport` | 显示/隐藏浏览器窗口（想"围观"AI 操作时 set(true)）/ 读取、设置、重置视口尺寸 |
| `ab_claim_tab` | 认领一个已开的用户标签页（标题/网址三重匹配，防认错） |
| `ab_cdp` / `ab_download_open` | 原样 CDP（白名单+确认门）/ 打开下载文件（确认门） |
| `ab_confirm` | 批准一次待确认动作（5 分钟一次性令牌） |
| `ab_audit` | **审计流水**：查询 AI 对浏览器的操作留痕（本地 `audit/` 目录；按命令/标签页/时间过滤，回答"我刚才动了什么/这个标签页被做过什么"） |
| `ab_login` | **自动登录**：从本机钥匙串取该站点凭据，自动填用户名/密码/TOTP 并提交（入参只有 `tabId`——凭据不进对话/日志/审计；页面 origin 必须与存储 origin 一致才动笔，提交后跳陌生域会标 `suspicious`） |
| `ab_credentials` | 列出已存凭据的站点清单（只列 origin，零秘密；配合 `npm run credential` 用） |
| `ab_webmcp` | **WebMCP**：发现/调用网页自己申报的结构化工具（`action:list\|invoke`；非只读工具过确认门）。页面申报的工具会**自动提示**：`ab_tab_info`/导航返回的 `webmcpHint` 与运行中的日志推送，无提示再手动 list |
| `browser_eval` | **核心特色**：给 agent 一段代码，内含完整 API 对象 `agent`，一次完成「看页面→操作→验证」循环 |
| `cua_status` / `cua_windows` | **屏幕能力体检**（当前到哪层+授权指引）/ 列出屏幕上的窗口 |
| `cua_ax_tree` | 读任意应用的界面元素清单（AI 找"按钮叫什么"，比看截图猜坐标可靠） |
| `cua_screenshot` | 屏幕/窗口/区域截图（PNG） |
| `cua_click` / `cua_type` / `cua_key` | 屏幕级点击（元素优先、坐标兜底）/ 输入文本 / 按键（危险组合键过确认门） |
| `cua_app_focus` / `cua_verify` | 应用切前台 / **物理验证**：返回动作前后两份截图证据，防"声称点了其实没点" |

## 屏幕操作（CUA，v0.5.0）

浏览器之外，同一服务还提供 `cua_*` 工具族操控**整块屏幕**（任何应用，不限于浏览器）。
设计原则：**分层注入**（元素级 AX 动作优先，坐标兜底）、**AX 优先**（先读无障碍树再谈坐标）、
**物理验证**（动作留"前证据"，`cua_verify` 取"后证据"成对核对）、**能力探测**（逐级降级，如实报告）。

### 三层能力（逐级探测，优雅降级）

| 层 | 条件 | 窗口清单 | 读元素 | 元素点击 | 坐标点击 | 输入/按键 | 截图 |
|---|---|---|---|---|---|---|---|
| **A**（最强） | `host/cua-helper` 已编译 + 辅助功能已授权 | ✓ | ✓（快） | ✓（AX 动作，失败自动取元素中心兜底） | ✓（**给 pid 定向投递，不动真实光标**） | ✓（可定向） | ✓ |
| **B**（零编译兜底） | 无 helper，但辅助功能已授权（osascript + System Events） | ✓ | ✓（较慢） | ✓ | ✗ | ✓（进前台应用） | ✓ |
| **C**（无任何授权） | 辅助功能未授权 | helper 编译过时 ✓（窗口表本身无需授权） | ✗ | ✗ | ✗ | ✗ | ✓（需屏幕录制授权） |

- A 层助手是随包分发的单文件 Swift 源码（`swift/cua-helper.swift`），`npm run setup` 自动用本机
  swiftc 编译成 `host/cua-helper`（编译产物不入库；无 swiftc 时静默落到 B 层，不算安装失败）。
- `cua_status` 随时报告 `{tier, axGranted, screenGranted, helperCompiled, swiftcAvailable, capabilities, guidance}`；
  `npm run cua-selftest` 是只读的交互动全清单自检（**不做任何点击**，安全默认）。

### 两条授权怎么开（人话）

都在 **系统设置 → 隐私与安全性**：

1. **辅助功能**：勾选你运行 MCP 客户端的那个终端/应用 → 元素读取/点击/输入可用（A/B 层）。
2. **屏幕录制**：勾选同一项 → 截图可用；未授权时截图可能只剩桌面壁纸、窗口标题缺失（系统隐私裁剪，工具会如实报告）。

### 安全模型（cua 部分补遗）

- **动作全审计**：每次 `cua_click/type/key/app_focus` 本地留痕（`audit/`，与浏览器操作同一本账，
  `ab_audit` 查 `cmd=cua_*`）；输入文本值脱敏记 `[redacted]`，坐标点击记坐标。
- **危险键确认**：默认 `cua_key` 的 `cmd+q`（退程序）/ `cmd+w`（关窗）首次返回待确认 token，
  `ab_confirm` 批准后带 `confirmationToken` 重试才执行；名单可在 `service/policy-defaults.json`
  的 `confirmCuaKeys` 配置，其余按键/点击/输入直行。
- **物理验证（防幻觉）**：每个动作执行前自动对目标区域截一张"前证据"；`cua_verify` 再取
  "后证据"成对返回。**声称已点击不算数**——调用方必须核对两份截图确认界面真的变了。

### 已知限制（如实声明）

- 坐标点击分两档：**给 pid = 定向投递给目标进程（真实鼠标不动）**；不给 pid = 全局投递
  （**会移动你的真实光标**，工具描述已标明，慎用）。
- 不做"幻影光标"（在屏幕上画一个假 AI 光标）之类的演示层。
- **锁屏/解锁/绕过任何认证类功能永不做**；助手二进制里也没有这类能力。
- B 层（osascript）没有坐标点击与定向投递能力；窗口标题的可见性受系统隐私裁剪影响
  （工具会用无障碍接口尽力回填，回填不到就如实留空）。
- CUA 仅支持 macOS；屏幕坐标按实际显示器像素，多显示器布局由系统坐标自然覆盖。

## 安全模型

- **租约可见**：被 agent 控制的标签页进专属标签组 + 橙色 ● 角标；谁借走哪个页面有据可查。
- **审计日志**：AI 的每次浏览器操作本地留痕（`audit/` 目录 JSONL，只记有副作用的命令与人工确认，敏感值脱敏；可用 `ab_audit` 查询，host-config 设 `auditDisabled:true` 或 `CAB_AUDIT=off` 可关闭）。
- **策略门**（`service/policy-defaults.json` 可自定义）：默认拦截 `chrome://settings` 等敏感页；危险动作（打开下载文件、部分 CDP）需人工确认令牌放行；未知动作类型一律拒绝（fail-closed）。
- **CDP 白名单**：`shared/protocol.mjs` 的 `CDP_ALLOWLIST` 之外的调试指令，服务端直接拒绝，到不了浏览器。
- **默认后台**：浏览器窗口默认不抢焦点，按需可见。

### 全自动凭据仓（钥匙串存一次，以后登录全自动）

把常用站点的登录凭据**只存进本机 macOS 钥匙串**一次，之后 AI 就能用 `ab_login` 全自动登录——凭据永远不会进入 AI 的对话内容：

```bash
npm run credential -- set https://github.com   # 交互录入：用户名回显、密码/TOTP 种子静默不回显
npm run credential -- list                     # 只列已存站点，不显示任何秘密
npm run credential -- remove https://github.com
```

- **密码不进模型**：`ab_login` 的入参只有 `tabId`；凭据由本地服务从钥匙串取出、直发浏览器扩展填进真实输入框、用完即弃。任何工具响应、日志、审计记录里都不含凭据明文（审计层对 fill 输入本来就记 `[redacted]`）。TOTP 动态口令由服务端本地生成（`node:crypto` 手写，零新依赖），种子同样不出本机。
- **双锁防钓鱼**：第一锁——页面的 origin 必须与存储 origin 完全一致（仅容忍 `www.` 前缀差异）才会动笔，否则返回设置指引且一个动作不发；第二锁——提交后 3 秒内若跳到**完全不同的域**，结果标 `suspicious:true` 并写审计 `login_suspicious`（不拦截，但如实报告供人工复核）。

### browser_eval 的沙箱边界（诚实声明）

`browser_eval` 在本地 Node 的隔离上下文执行代码，注入 `agent` / `nodeRepl.write` / `console`，
**不注入** `require` 与 `process`；但 await 之后回到正常环境、且 `agent` 本身就能指挥浏览器。
它是**给可信本地客户端的便利工具，不是防恶意代码的保险箱**；超过 30 秒放弃等待但已触发的
浏览器任务无法强制中止。

## 已知限制

- 支持 Chromium 系浏览器：Chrome / Edge / Brave / Opera / Vivaldi / Arc（Arc 的清单路径按 Chromium 规则实现并双写候选位置，已在无 Arc 的机器上通过安装测试；Windows 侧未实测）。Safari/Firefox 不适用。
- 凭据仓**当前仅支持 macOS 钥匙串**（非 macOS 上 `ab_login`/`ab_credentials` 明确报不支持）；登录路上的**图形验证码、设备确认**（推送/短信二次确认）无法全自动，需要人工接手。
- Windows 分支（注册表等）已实现但未在真实 Windows 上测试过。
- 剪贴板写入返回「不支持，请用定位器输入」（诚实报错）；`downloads.open` 需 Chrome 可选权限；嵌套 iframe 内的元素定位暂不支持（`ab_login` 因此也只认主文档里的登录表单）。
- 扩展 ID 依赖目录绝对路径：源码安装挪目录后需重跑 setup 并重新加载扩展；npm 全局安装不受影响（路径固定）。发布到 Chrome 商店后此限制彻底消失。

## 测试

```bash
npm test          # 128 个单元测试
npm run selftest  # 全链路自检（真 WS + 伪扩展，无需浏览器）
npm run cua-selftest  # 屏幕操作自检（只读探测 + 试拍，不做任何点击）
npm run doctor    # 本机链路体检：扩展目录/通信清单/端口监听/CUA 助手与授权，逐项给修复建议
npm run e2e       # 端到端（需 Playwright 的 Chromium for Testing；自动装/清清单，不碰用户 Chrome；登录用例会短暂写入并清理本机钥匙串测试条目）
npm run check     # 全部语法检查
```

## 现成配方

`browser_eval` 直接抄的任务级代码（YouTube 字幕导出等）：见 [docs/recipes.md](docs/recipes.md)。

## License

MIT（见 [LICENSE](LICENSE)）。
