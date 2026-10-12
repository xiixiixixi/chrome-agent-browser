# chrome-agent-browser

一句话：让 AI 代理（agent）直接操控**你真实的、带登录态的 Chromium 系浏览器**——通过「浏览器扩展 + 原生宿主 + 本地服务」三层桥接，以 MCP（Model Context Protocol）工具面暴露给任意 MCP 客户端（Claude Code / ZCode / Cursor 等）。

## 架构（五层）

```
┌─ 5 ─ MCP 客户端（任意支持 MCP 的 AI 工具）
│        │ MCP over stdio（JSON-RPC 2.0）           ← service/mcp-entry.mjs（入口）
│        ▼
├─ 4 ─ MCP 工具面  service/mcp.mjs：12 个工具（ab_* 粗粒度 + browser_eval REPL）
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

## 快速开始（两条命令 + 一次拖拽）

```bash
# 1. 克隆并装依赖（需要 Node 18+）
git clone https://github.com/xiixiixixi/chrome-agent-browser.git
cd chrome-agent-browser && npm install

# 2. 一条命令安装：自动算扩展ID → 检测已装浏览器 → 写清单/配置 → 打开 Chrome 扩展页
#    （扩展目录路径自动进剪贴板）→ 原地等待验证，你在 Chrome 里加载完扩展那一刻自动打钩
npm run setup
```

setup 会打印唯一的手动步骤：Chrome 的 `chrome://extensions` → 开发者模式 →
「加载已解压的扩展程序」→ 粘贴剪贴板里的目录路径。验证打钩后，setup 直接给出
可复制的 MCP 客户端配置片段（端口已自动固化，无需传参）。

> 扩展 ID 由扩展目录的绝对路径决定（Chrome 的规则）：**目录一旦移动就要重跑 `npm run setup`**。

卸载：`npm run uninstall`（删本机清单与配置；Chrome 内手动移除扩展即彻底干净）。

高级参数：`npm run setup -- --no-open`（不自动开 Chrome）/ `--port N` / `--timeout 秒` /
`--browser all|chrome|edge|brave|opera|vivaldi|arc` / `--dry-run`。

## 服务生命周期（常问三问）

- **要开机自启吗？** 不用。`npm install` 只是放文件，不启动任何东西。
- **服务什么时候启动？** MCP 客户端发起会话时按配置拉起 `mcp-entry.mjs` 子进程；客户端退出
  （stdin 关闭）或关掉会话，进程随之优雅退出。没有客户端连它，它就不存在。
- **独立跑过服务又退出了，列表变空？** 服务是按需进程：`npm run doctor` 一条命令看断点；空列表≠报错，先 doctor。
- **服务中途死了怎么办？** 前端模式的进程会自动**接管端口变成新服务**（浏览器扩展自动重连，AI 客户端全程无感）；连续恢复失败才退出待重拉。
- **多个 MCP 客户端同时用？** 支持。第一个实例充当 service 并监听端口；后续实例探测到
  端口已占用后自动切换为「前端模式」连接既有服务，共享同一个浏览器连接；全部客户端退出后
  最后一个 service 进程退出，不留孤儿进程。

## MCP 工具面（12 个）

| 工具 | 作用 |
|---|---|
| `ab_status` / `ab_list_browsers` | **服务体检**（区分"没浏览器"vs"链路断"）/ 列出受控浏览器 |
| `ab_open_tabs` | 列出用户已开的标签页（可选 `browserId` 指定目标，如 Arc） |
| `ab_new_tab` / `ab_tab_info` / `ab_navigate` | 开标签页 / 读信息 / 导航（过策略门） |
| `ab_screenshot` / `ab_ax_state` | 截图（PNG）/ 无障碍树文本 |
| `ab_visibility` | 显示/隐藏浏览器窗口（想"围观"AI 操作时 set(true)） |
| `ab_claim_tab` | 认领一个已开的用户标签页（标题/网址三重匹配，防认错） |
| `ab_cdp` / `ab_download_open` | 原样 CDP（白名单+确认门）/ 打开下载文件（确认门） |
| `ab_confirm` | 批准一次待确认动作（5 分钟一次性令牌） |
| `browser_eval` | **核心特色**：给 agent 一段代码，内含完整 API 对象 `agent`，一次完成「看页面→操作→验证」循环 |

## 安全模型

- **租约可见**：被 agent 控制的标签页进专属标签组 + 橙色 ● 角标；谁借走哪个页面有据可查。
- **策略门**（`service/policy-defaults.json` 可自定义）：默认拦截 `chrome://settings` 等敏感页；危险动作（打开下载文件、部分 CDP）需人工确认令牌放行；未知动作类型一律拒绝（fail-closed）。
- **CDP 白名单**：`shared/protocol.mjs` 的 `CDP_ALLOWLIST` 之外的调试指令，服务端直接拒绝，到不了浏览器。
- **默认后台**：浏览器窗口默认不抢焦点，按需可见。

### browser_eval 的沙箱边界（诚实声明）

`browser_eval` 在本地 Node 的隔离上下文执行代码，注入 `agent` / `nodeRepl.write` / `console`，
**不注入** `require` 与 `process`；但 await 之后回到正常环境、且 `agent` 本身就能指挥浏览器。
它是**给可信本地客户端的便利工具，不是防恶意代码的保险箱**；超过 30 秒放弃等待但已触发的
浏览器任务无法强制中止。

## 已知限制

- 支持 Chromium 系浏览器：Chrome / Edge / Brave / Opera / Vivaldi / Arc（Arc 的清单路径按 Chromium 规则实现并双写候选位置，已在无 Arc 的机器上通过安装测试；Windows 侧未实测）。Safari/Firefox 不适用。
- Windows 分支（注册表等）已实现但未在真实 Windows 上测试过。
- 剪贴板写入返回「不支持，请用定位器输入」（诚实报错）；`downloads.open` 需 Chrome 可选权限；嵌套 iframe 内的元素定位暂不支持。
- 扩展 ID 依赖目录绝对路径：目录移动后需重跑 `npm run setup`（发布到 Chrome 商店后此限制消失）。

## 测试

```bash
npm test          # 37 个单元测试
npm run selftest  # 全链路自检（真 WS + 伪扩展，无需浏览器）
npm run doctor    # 本机链路体检：扩展目录/通信清单/端口监听，逐项给修复建议
npm run e2e       # 端到端（需 Playwright 的 Chromium for Testing；自动装/清清单，不碰用户 Chrome）
npm run check     # 全部语法检查
```

## License

MIT（见 [LICENSE](LICENSE)）。
