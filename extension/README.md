# Chrome Agent Browser（扩展端）

MV3 单文件 service worker（`background.js`）。它通过 Chrome Native Messaging（每帧一个 JSON）连接本机的 `com.chromeagentbrowser.host` 宿主进程，宿主再把 JSON 原样转发给本机 agent 服务（`127.0.0.1`）。协议定义见仓库根目录的 `shared/protocol.mjs` 与 `docs/PROTOCOL.md`。

## 安装（开发者模式加载）

1. 打开 Chrome，地址栏输入 `chrome://extensions` 并回车。
2. 打开右上角的 **开发者模式**（Developer mode）开关。
3. 点击左上角 **加载已解压的扩展程序**（Load unpacked）。
4. 选择本目录（`chrome-agent-browser/extension/`，即包含 `manifest.json` 的目录），确认。
5. 列表里出现 **Chrome Agent Browser** 即安装成功。修改 `background.js` 后，点击卡片上的刷新图标重新加载。

前提：本机已安装 native host（安装器会写入 `com.chromeagentbrowser.host` 的原生消息清单并启动本机服务）。未安装宿主时扩展会以 1s/2s/5s/10s/30s（封顶）的退避持续重连，控制台（Service worker 链接 → Console）可见 `[ab] transport: ...` 日志。

## 扩展 ID 怎么来的

`chrome://extensions` 卡片上那串 32 位小写字母（形如 `abcdefghijklmnopabcdefghijklmnop`）就是扩展 ID：

- 从 Chrome 网上应用店安装：ID 由商店公钥决定，固定不变。
- Load unpacked：ID 由 `manifest.json` 所在目录的绝对路径哈希派生。**目录移动或换机器加载，ID 都会变**；ID 变了，native host 清单里登记的 `allowed_origins` 就不再匹配，连接会被 Chrome 拒绝——重新加载后需要重跑安装器更新清单。

## 角标（badge）含义

- 标签页上出现橙色 **●**：该标签页当前被某个 agent 会话持有（租约 active，记录在 `chrome.storage.session`）。
- 角标消失：会话结束（`session_finalize`，租约转 finalized）或标签页被关闭/释放。
- agent 新建的标签页会被归入名为 **Agent** 的灰色标签组，便于一眼区分。

## 已知限制

- **`tab_clipboard_write_text` 不生效**：service worker 没有 DOM 剪贴板，命令诚实返回 `{ok:false, reason:'use locator fill'}`。需要写入输入框请改用 `locator_action`（action=`fill`）。
- **`download_open` 可能失败**：Chrome 要求 `downloads.open` 是 optional permission（本 manifest 未声明），调用失败时会原样返回错误。下载列表事件（`onDownloadChange`）不受影响。
- **定位器不支持跨 frame/iframe**：`locator_*` 只在页面主文档（main frame）里查找元素。
- AX 快照做了规模截断：深度 ≤ 12、最多 800 行；`locator_snapshot` 的 HTML 截断在 200KB。CDP 事件环每标签页最多保留最近 500 条（`tab_cdp_events` 会以 `truncated:true` 提示旧事件被逐出），控制台日志环每标签页 200 条。
- `chrome.debugger` 是独占的：标签页开着 DevTools（或被其他自动化扩展 attach）时，涉及 CDP 的命令会返回 -32005（NOT_ATTACHED）并带原因。
- 挂起调试器时，页面顶部会出现 Chrome 自带的 "…正在调试此浏览器" 提示条，属正常现象。

## 隐私说明

- 本扩展**只与本机回环地址通信**：Native Messaging 连接的是本机 `com.chromeagentbrowser.host` 宿主进程，宿主只连 `127.0.0.1` 上的 agent 服务。扩展自身不发起任何对外网络请求（无 fetch/XHR）。
- 权限用途：`tabs`/`tabGroups`/`history`/`downloads`/`debugger` 用于命令实现；`storage` 保存实例 ID 与租约；`alarms` 用于断线重连退避；`nativeMessaging` 用于与宿主通信；`host_permissions` 仅用于页面内容操作（定位器注入）。
- 租约与实例 ID 存放在 `chrome.storage.session` / `chrome.storage.local`，不离开本机；浏览记录查询（`browser_history`）结果也只经本机链路回传给 agent 服务。
