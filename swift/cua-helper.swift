// swift/cua-helper.swift — 屏幕操作助手（单文件 Swift，行协议 JSON 服务）
//
// 由 setup.mjs / cua-selftest.mjs 用 swiftc 编译为 host/cua-helper（编译产物不入库）。
// 协议：stdin 每行一个 JSON 请求 {id, cmd, ...参数}；stdout 每行一个 JSON 响应
//   成功 {id, ok:true, ...数据} / 失败 {id, ok:false, error:"...", code?:"..."}。
// 除本协议外不向 stdout 写任何内容；诊断信息一律 stderr。
//
// 命令集（与 service/cua.mjs 的调用侧一一对应）：
//   probe                              → {axGranted, screenGranted}（AXIsProcessTrusted / CGPreflightScreenCaptureAccess）
//                                        附 responsibleProcess（TCC 记账的宿主 App 名，通常为终端——
//                                        用户在系统设置里要勾选的就是这个名字；沿 ppid 链推断）
//   request-permissions                → 向系统申请辅助功能与屏幕录制权限（各自仅在缺失时申请）：
//                                        AXIsProcessTrustedWithOptions(kAXTrustedCheckOptionPrompt=true)
//                                        弹标准对话框并把负责进程加进辅助功能列表（未勾选）；
//                                        CGRequestScreenCaptureAccess() 同理注册屏幕录制。
//                                        两者立即返回（不阻塞等用户操作），静置 ~500ms 让弹窗出现后
//                                        即报 {axGranted, axRequested, screenGranted, screenRequested,
//                                        responsibleProcess}。用户在系统设置勾选后经 probe 复测生效。
//   windows                            → {windows:[{windowId, ownerPid, ownerName, title, bounds:{x,y,w,h}, onScreen}]}
//   ax-tree {pid, maxDepth?}           → {nodes:[{depth, role, title?, value?, bounds?, actions?}], truncated}
//                                        遍历限额：深度 12 / 每层 80 / 总 1500 节点；文本截断 120 字符。
//                                        AX 未授权 → {ok:false, code:"not-granted"}（结构化，不崩溃）。
//   element-click {pid, role, title?}  → 先 AXUIElement PerformAction(press)；失败兜底取元素 bounds
//                                        中心做坐标点击 → {pressed} | {xyFallback, bounds, at}
//   xy-click {x, y, pid?}              → v0.5.5：进程定向鼠标注入（CGEventPostToPid）在新系统已全面失效
//                                        （窗口服务器按真实光标 hit-testing，Chromium 系与原生应用实测均忽略）。
//                                        有 pid：点击点最上层不是目标窗口（不前台/被遮挡）先 AXRaise+activate
//                                        把目标置前（遮挡者记 coveredBy），再全局注入并回 fallback:"global"
//                                        （会移动真实光标，但保证生效）；无 pid：全局注入。
//   type {pid?, text}                  → 键盘事件逐段输入：CGEventKeyboardSetUnicodeString 直塞 UTF-16 文本
//                                        （中文等无键码字符的唯一可靠路径），按 UTF-16 码元分段（≤20/事件，
//                                        规避单事件长度上限——一个 emoji 常占多个码元，按字符合段会超限）
//   key {pid?, key, modifiers?}        → modifiers: cmd/ctrl/alt/shift；key 用键码映射表。v0.5.5 起修饰键按
//                                        真实按键序列注入：flagsChange(按下修饰键) → keyDown(带 flag) → keyUp
//                                        → flagsChange(释放)，事件间 5ms 间隔，配合 hidSystemState 事件源，
//                                        ⌘S/⌘N 等组合键才能稳定触发系统对话框
//   app-focus {pid}                    → AX raise 主窗口 + NSRunningApplication activate
//   overlay-show {x, y, kind:'arrow'|'click', durationMs?(默认700)} → {ok:true}
//                                       幽魂光标：在 (x,y) 闪现琥珀色 AI 专属箭头（kind=click
//                                       追加约 350ms 扩散涟漪），durationMs 后淡出。叠加窗点击
//                                       穿透、不抢焦点、真鼠标不动；窗口懒创建并复用。
//   overlay-hide                       → 立即隐藏叠加 → {ok:true}
//   show-permission-card {kind:'accessibility'|'screen', appName, durationSec?(默认120,夹取5..600)}
//                                       → {kind, autoHideSec, frame:{x,y,w,h}(屏幕左上原点), dragFrom?}
//                                       权限引导悬浮卡片（v0.5.4）：NSPanel(borderless/nonactivating/
//                                       floating/canJoinAllSpaces)。本项目唯一「可交互」的叠加窗
//                                       （ignoresMouseEvents=false，但它就是给用户看的引导 UI；仍不抢
//                                       焦点）：拖卡片背景=挪位置；左侧琥珀图标=拖拽句柄，按住可把
//                                       「负责进程的 .app bundle」（TCC 记账、设置列表要加的正是它）
//                                       作为文件拖进系统设置的权限列表（NSDraggingSource 文件拖拽）；
//                                       右上 ✕ 关闭；durationSec 秒后自动淡出。accessibility 在上、
//                                       screen 在下错位排布，两卡不重叠。
//   hide-permission-card {kind}        → 立即隐藏对应卡片（幂等，未显示的 kind 也回 ok）
//
// 线程模型（v0.5.1 起）：主线程跑 NSApplication run loop（叠加窗口需要 AppKit）；
// stdin 移到后台队列逐行读，命令解析与执行留在读取线程（与旧版单线程行为一致），
// 仅 overlay/permission-card 的窗口操作经 DispatchQueue.main.async 切主线程执行后应答；
// stdin EOF → 主线程 NSApp.terminate 退出（保持旧行为：进程随 stdin 关闭而退出）；
// 例外（v0.5.4）：权限引导卡片还在屏上时留守，待卡片全数收起（淡出/隐藏/关闭）后再退
// （setup 非交互模式把卡片留给用户看、脚本自身先退出；卡片寿命最长 durationSec 秒封顶）。
//
// 安全边界：本助手不做任何锁屏/解锁/认证类操作；只执行调用方显式给出的动作。
// 幽灵光标叠加窗点击穿透（不可交互）；权限引导卡片是唯一的例外——可交互但不抢焦点
// （nonactivating panel）：它就是引导用户完成系统授权的 UI，不碰任何其他应用。

import Cocoa
import Foundation

// ---------- 响应输出（唯一 stdout 出口） ----------

func respond(_ id: Any?, _ payload: [String: Any]) {
    var out = payload
    out["id"] = id ?? -1
    if let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

func respondOk(_ id: Any?, _ data: [String: Any]) { respond(id, ["ok": true].merging(data) { _, new in new }) }

func respondErr(_ id: Any?, _ error: String, code: String? = nil) {
    var p: [String: Any] = ["ok": false, "error": error]
    if let c = code { p["code"] = c }
    respond(id, p)
}

// ---------- 通用小工具 ----------

let textLimit = 120

func truncStr(_ s: String) -> String { s.count <= textLimit ? s : String(s.prefix(textLimit)) + "…" }

/** 读 AX 属性，失败返回 nil（AX 调用里「读不到」是常态，不视为错误）。 */
func axAttr(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
    return v
}

/** AXValue(CGPoint/CGSize) → [Double]；非对应类型返回 nil。 */
func axPointOrSize(_ v: CFTypeRef?) -> [Double]? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    let axv = v as! AXValue // 类型已核对，强转安全
    var point = CGPoint()
    if AXValueGetValue(axv, .cgPoint, &point) { return [point.x, point.y] }
    var size = CGSize()
    if AXValueGetValue(axv, .cgSize, &size) { return [size.width, size.height] }
    return nil
}

func axTrusted() -> Bool { AXIsProcessTrusted() }

let AX_NOT_GRANTED_HINT = "辅助功能（AX）未授权：系统设置 → 隐私与安全性 → 辅助功能，勾选运行本助手的终端/应用后重试"

// ---------- probe ----------

func cmdProbe(_ id: Any?, _ p: [String: Any]) {
    var out: [String: Any] = ["axGranted": axTrusted(), "screenGranted": CGPreflightScreenCaptureAccess(),
                              "responsibleProcess": responsibleProcessName()]
    let b = CGDisplayBounds(CGMainDisplayID()) // 主屏尺寸（自检把幽魂光标定位到屏幕中央用）
    out["screen"] = ["w": b.width, "h": b.height]
    respondOk(id, out)
}

// ---------- request-permissions（v0.5.3：标准 macOS 权限申请——申请，而不只是检查） ----------

/** 父 pid（sysctl kinfo_proc；失败返回 -1）。 */
func parentPid(_ pid: pid_t) -> pid_t {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.size
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return -1 }
    return info.kp_eproc.e_ppid
}

/**
 * 负责进程名（TCC 记账的宿主 App，从终端跑时就是终端）：沿 ppid 链向上找最近的真 App
 * 进程（NSRunningApplication 非 nil 且带 bundleIdentifier 的才算——主线程的 NSApplication
 * 会把本 CLI 进程也注册成「app」，但无 bundle，借此排除）；找不到回退本进程名。
 * 申请权限时系统弹窗与设置列表里显示的就是这个名字——用户要勾选的也是它。
 */
func responsibleProcessName() -> String {
    var pid = parentPid(getpid()) // 从父进程起步，跳过被 NSApplication 自注册的本进程
    for _ in 0..<16 { // 链深兜底，防异常成环
        if pid <= 1 { break }
        if let app = NSRunningApplication(processIdentifier: pid),
           let bundleId = app.bundleIdentifier, !bundleId.isEmpty,
           let name = app.localizedName, !name.isEmpty {
            return name
        }
        let ppid = parentPid(pid)
        if ppid <= 0 { break }
        pid = ppid
    }
    return ProcessInfo.processInfo.processName
}

/**
 * 向系统申请辅助功能与屏幕录制（各自仅在缺失时申请，已授权的不重复弹窗）。
 * 两个 API 都把「负责进程」（调用链上的宿主 App，通常是终端）注册进对应列表（未勾选状态），
 * 并立即返回；静置 ~500ms 让系统对话框出现后即报状态，不阻塞等用户操作。
 */
func cmdRequestPermissions(_ id: Any?, _ p: [String: Any]) {
    var axGranted = axTrusted()
    var axRequested = false
    if !axGranted {
        // kAXTrustedCheckOptionPrompt 在 Swift 里是 Unmanaged<CFString>，取值后作字典键
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        axGranted = AXIsProcessTrustedWithOptions(opts)
        axRequested = !axGranted // 已向系统申请（弹窗+注册未勾选项），等用户去设置里勾选
    }
    var screenGranted = CGPreflightScreenCaptureAccess()
    var screenRequested = false
    if !screenGranted {
        screenGranted = CGRequestScreenCaptureAccess()
        screenRequested = !screenGranted
    }
    usleep(500_000) // 给系统 ~500ms 弹出对话框，随后立即返回
    respondOk(id, [
        "axGranted": axGranted,
        "axRequested": axRequested,
        "screenGranted": screenGranted,
        "screenRequested": screenRequested,
        "responsibleProcess": responsibleProcessName(),
    ])
}

// ---------- windows（CGWindowList：窗口清单本身无需授权；窗口标题需屏幕录制授权才可见） ----------

func cmdWindows(_ id: Any?, _ p: [String: Any]) {
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] else {
        respondErr(id, "CGWindowListCopyWindowInfo returned nothing")
        return
    }
    var out: [[String: Any]] = []
    for w in list {
        let layer = (w[kCGWindowLayer as String] as? Int) ?? -1
        let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? 0
        // 只报常规层（layer 0）的真实进程窗口，排除菜单条/Dock/悬浮层等系统装饰
        if layer != 0 || pid <= 0 { continue }
        var b: [String: Any] = [:]
        if let bounds = w[kCGWindowBounds as String] as? [String: Any] {
            b = [
                "x": (bounds["X"] as? Double) ?? Double((bounds["X"] as? Int) ?? 0),
                "y": (bounds["Y"] as? Double) ?? Double((bounds["Y"] as? Int) ?? 0),
                "w": (bounds["Width"] as? Double) ?? Double((bounds["Width"] as? Int) ?? 0),
                "h": (bounds["Height"] as? Double) ?? Double((bounds["Height"] as? Int) ?? 0),
            ]
        }
        out.append([
            "windowId": (w[kCGWindowNumber as String] as? Int) ?? 0,
            "ownerPid": pid,
            "ownerName": (w[kCGWindowOwnerName as String] as? String) ?? "",
            "title": (w[kCGWindowName as String] as? String) ?? "", // 无屏幕录制授权时系统不给标题 → 空串
            "bounds": b,
            "onScreen": (w[kCGWindowIsOnscreen as String] as? Bool) ?? false,
        ])
        if out.count >= 200 { break }
    }
    respondOk(id, ["windows": out])
}

// ---------- ax-tree（AXUIElement 遍历，限额见文件头） ----------

func axNode(_ el: AXUIElement, _ depth: Int) -> [String: Any] {
    var node: [String: Any] = ["depth": depth]
    if let role = axAttr(el, kAXRoleAttribute) as? String { node["role"] = truncStr(role) }
    if let title = axAttr(el, kAXTitleAttribute) as? String { node["title"] = truncStr(title) }
    if let value = axAttr(el, kAXValueAttribute) {
        if let s = (value as? String), !s.isEmpty { node["value"] = truncStr(s) }
        else if let n = value as? NSNumber { node["value"] = n.doubleValue }
    }
    if let pos = axPointOrSize(axAttr(el, kAXPositionAttribute)),
       let size = axPointOrSize(axAttr(el, kAXSizeAttribute)) {
        node["bounds"] = ["x": pos[0], "y": pos[1], "w": size[0], "h": size[1]]
    }
    var names: CFArray?
    if AXUIElementCopyActionNames(el, &names) == .success, let arr = names {
        let acts = (arr as [AnyObject]).compactMap { $0 as? String }
        if !acts.isEmpty { node["actions"] = acts }
    }
    return node
}

/// 深度优先遍历；返回节点数。限额：maxDepth(≤12)、每层 80 子节点、总 1500。
func axWalk(_ el: AXUIElement, _ depth: Int, _ maxDepth: Int, _ out: inout [[String: Any]], _ budget: inout Int) {
    if budget <= 0 || depth > maxDepth { return }
    out.append(axNode(el, depth))
    budget -= 1
    guard let kids = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
    var n = 0
    for kid in kids {
        if n >= 80 || budget <= 0 { break }
        axWalk(kid, depth + 1, maxDepth, &out, &budget)
        n += 1
    }
}

func cmdAxTree(_ id: Any?, _ p: [String: Any]) {
    guard axTrusted() else { respondErr(id, AX_NOT_GRANTED_HINT, code: "not-granted"); return }
    guard let pid = p["pid"] as? Int, pid > 0 else {
        respondErr(id, "ax-tree 需要 pid（正整数）")
        return
    }
    let maxDepth = min((p["maxDepth"] as? Int) ?? 12, 12)
    let app = AXUIElementCreateApplication(pid_t(pid))
    var nodes: [[String: Any]] = []
    var budget = 1500
    axWalk(app, 0, maxDepth, &nodes, &budget)
    respondOk(id, ["nodes": nodes, "truncated": budget <= 0])
}

// ---------- element-click（AX press 优先，元素 bounds 中心坐标兜底） ----------

/// 深度优先找 role（精确）+ title（给 title 时精确，否则第一个同 role）匹配的元素。
func axFind(_ el: AXUIElement, _ depth: Int, _ role: String, _ title: String?) -> AXUIElement? {
    if depth > 12 { return nil }
    if let r = axAttr(el, kAXRoleAttribute) as? String, r == role {
        if let want = title {
            if let t = axAttr(el, kAXTitleAttribute) as? String, t == want { return el }
        } else { return el }
    }
    guard let kids = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
    var n = 0
    for kid in kids {
        if n >= 80 { break }
        if let hit = axFind(kid, depth + 1, role, title) { return hit }
        n += 1
    }
    return nil
}

func cmdElementClick(_ id: Any?, _ p: [String: Any]) {
    guard axTrusted() else { respondErr(id, AX_NOT_GRANTED_HINT, code: "not-granted"); return }
    guard let pid = p["pid"] as? Int, pid > 0, let role = p["role"] as? String, !role.isEmpty else {
        respondErr(id, "element-click 需要 pid 与 role（title 可选）")
        return
    }
    let wantTitle = p["title"] as? String
    let title = (wantTitle?.isEmpty ?? true) ? nil : wantTitle
    let app = AXUIElementCreateApplication(pid_t(pid))
    guard let el = axFind(app, 0, role, title) else {
        respondErr(id, "未找到匹配元素 role=\(role) title=\(title ?? "")（先用 ax-tree 核对元素的真实 role/title）", code: "element-not-found")
        return
    }
    // 路径 A：元素自己的 AXPress 动作
    if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
        respondOk(id, ["pressed": true])
        return
    }
    // 路径 B：取元素 bounds 中心做坐标点击（v0.5.5：定向鼠标不可信，postClick 内部降级全局并回执）
    guard let pos = axPointOrSize(axAttr(el, kAXPositionAttribute)),
          let size = axPointOrSize(axAttr(el, kAXSizeAttribute)), size[0] > 0, size[1] > 0 else {
        respondErr(id, "元素无 bounds，无法坐标兜底", code: "no-bounds")
        return
    }
    let cx = pos[0] + size[0] / 2
    let cy = pos[1] + size[1] / 2
    let d = postClick(pid, cx, cy)
    var out: [String: Any] = ["xyFallback": true, "bounds": ["x": pos[0], "y": pos[1], "w": size[0], "h": size[1]], "at": [cx, cy]]
    if d.fallbackGlobal { out["fallback"] = "global" }
    if d.focusedFirst { out["focusedFirst"] = true }
    if let covered = d.coveredBy { out["coveredBy"] = covered }
    if let wid = d.windowId { out["windowId"] = wid }
    respondOk(id, out)
}

// ---------- 事件投递（v0.5.5：hidSystemState 事件源 + 定向鼠标降级全局） ----------

/**
 * 键盘/鼠标事件统一用 HID 系统状态源创建。combinedSessionState 合成的事件不带真实 HID 修饰键状态，
 * 修饰键与按键事件之间的顺序在窗口服务器侧会错乱——⌘S/⌘N「有时不弹」的根源。
 */
func eventSource() -> CGEventSource? { CGEventSource(stateID: .hidSystemState) }

/** 键盘事件：有 pid → 定向投递到该进程；无 pid → 全局（键盘不涉及 hit-testing，两条路都可靠）。 */
func postEvent(_ pid: Int?, _ e: CGEvent) {
    if let pid = pid, pid > 0 { e.postToPid(pid_t(pid)) } else { e.post(tap: .cghidEventTap) }
}

/** 把进程带到前台（AXRaise 主窗口 + activate）；app-focus 与定向鼠标降级共用。 */
@discardableResult
func focusApp(_ pid: pid_t) -> (raised: Bool, activated: Bool) {
    var raised = false
    let app = AXUIElementCreateApplication(pid)
    if let raw = axAttr(app, kAXMainWindowAttribute) {
        let win = unsafeBitCast(raw, to: AXUIElement.self) // kAXMainWindowAttribute 必为元素
        if AXUIElementPerformAction(win, "AXRaise" as CFString) == .success { raised = true }
    }
    var activated = false
    if let running = NSRunningApplication(processIdentifier: pid) {
        activated = running.activate(options: []) // macOS 14 起 activateIgnoringOtherApps 已废弃且无效
    }
    return (raised, activated)
}

/** kCGMouseEventWindowUnderMousePointer(91)/…ThatCanHandleThisEvent(92)：Swift overlay 未导出，用原值。 */
let FIELD_WIN_UNDER_POINTER = CGEventField(rawValue: 91)!
let FIELD_WIN_CAN_HANDLE = CGEventField(rawValue: 92)!

/** pid 在屏上（常规层）的窗口：优先取包含 (x,y) 的，否则第一张；返回 (windowId, bounds)。 */
func onScreenWindow(_ pid: pid_t, _ x: Double, _ y: Double) -> (windowId: Int, bounds: CGRect)? {
    var fallback: (Int, CGRect)?
    for w in onScreenWindows() where w.pid == Int(pid) {
        if w.bounds.contains(CGPoint(x: x, y: y)) { return (w.windowId, w.bounds) }
        if fallback == nil { fallback = (w.windowId, w.bounds) }
    }
    return fallback
}

/** 在屏常规层窗口快照（CGWindowList 本就按前→后 z 序返回）。 */
func onScreenWindows() -> [(windowId: Int, pid: Int, ownerName: String, bounds: CGRect)] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] else { return [] }
    var out: [(Int, Int, String, CGRect)] = []
    for w in list {
        let layer = (w[kCGWindowLayer as String] as? Int) ?? -1
        let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? 0
        guard layer == 0, pid > 0 else { continue }
        guard let b = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        out.append((
            (w[kCGWindowNumber as String] as? Int) ?? 0,
            pid,
            (w[kCGWindowOwnerName as String] as? String) ?? "",
            CGRect(x: (b["X"] as? Double) ?? 0, y: (b["Y"] as? Double) ?? 0,
                   width: (b["Width"] as? Double) ?? 0, height: (b["Height"] as? Double) ?? 0)
        ))
    }
    return out
}

/** 一次点击的投递方式回执：targeted=真定向（仅键盘语义可保）；fallbackGlobal=走了全局降级。 */
struct ClickDelivery {
    var targeted = false
    var fallbackGlobal = false
    var focusedFirst = false
    var windowId: Int? = nil
    var coveredBy: String? = nil // 点击点当前最上层窗口属于别的应用（已代为 raise，仍如实回执）
}

/**
 * 鼠标点击（v0.5.5）。实测（Chromium 系网页 + 原生应用）CGEventPostToPid 的鼠标事件在现代系统
 * 一律不生效：窗口服务器按真实光标位置 hit-testing，进程定向投递绕过了这一步，目标应用直接忽略。
 * 因此有 pid 时：①关联目标窗口字段（尽力而为）②点击点最上层不是目标窗口（目标不前台/被别的窗口
 * 盖住）先 focusApp 把它带到最前——否则全局注入按屏幕坐标 hit-testing 会点在遮挡窗口上
 * ③全局注入（唯一可靠路径，会移动真实光标）——调用方应答必须带 fallback:"global"。
 */
func postClick(_ pid: Int?, _ x: Double, _ y: Double) -> ClickDelivery {
    var d = ClickDelivery()
    let src = eventSource()
    let pt = CGPoint(x: x, y: y)
    guard let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left),
          let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) else {
        return d
    }
    if let pid = pid, pid > 0 {
        if let (wid, _) = onScreenWindow(pid_t(pid), x, y) {
            d.windowId = wid
            for e in [down, up] { // 关联目标窗口：部分应用的事件路由会参考（对本机实测无碍）
                e.setIntegerValueField(FIELD_WIN_UNDER_POINTER, value: Int64(wid))
                e.setIntegerValueField(FIELD_WIN_CAN_HANDLE, value: Int64(wid))
            }
        }
        // 点击点当前最上层窗口（z 序第一）不是目标的：目标不前台、或被其他应用窗口盖住。
        // 全局注入认屏幕坐标不认 pid——先把目标 raise 到最前，点击才落在它的窗口上。
        let topAtPoint = onScreenWindows().first { $0.bounds.contains(pt) }
        if let top = topAtPoint, top.pid != pid {
            d.coveredBy = top.ownerName.isEmpty ? "pid \(top.pid)" : top.ownerName
        }
        if d.coveredBy != nil || NSWorkspace.shared.frontmostApplication?.processIdentifier != pid_t(pid) {
            focusApp(pid_t(pid))
            d.focusedFirst = true
            usleep(250_000) // 等窗口服务器完成前台切换
        }
        d.fallbackGlobal = true // 进程定向已不可信，统一走全局（如实回执）
    }
    down.post(tap: .cghidEventTap)
    usleep(10_000) // down/up 间隔 10ms：贴近真实点击，双击检测等时序才正常
    up.post(tap: .cghidEventTap)
    return d
}

func cmdXyClick(_ id: Any?, _ p: [String: Any]) {
    guard let x = (p["x"] as? NSNumber)?.doubleValue, let y = (p["y"] as? NSNumber)?.doubleValue else {
        respondErr(id, "xy-click 需要 x/y（数字）")
        return
    }
    let pid = p["pid"] as? Int
    let d = postClick(pid, x, y)
    var out: [String: Any] = ["x": x, "y": y, "targeted": d.targeted]
    if d.fallbackGlobal {
        out["fallback"] = "global"
        var note = "进程定向鼠标注入在现代系统不生效：已"
        if let covered = d.coveredBy { note += "把被「\(covered)」遮挡的目标置前并" }
        else if d.focusedFirst { note += "把目标带到前台并" }
        note += "全局注入（会移动真实光标）"
        out["note"] = note
    } else if (pid ?? 0) <= 0 {
        out["note"] = "无 pid：全局投递（会移动真实光标）"
    }
    if d.focusedFirst { out["focusedFirst"] = true }
    if let covered = d.coveredBy { out["coveredBy"] = covered }
    if let wid = d.windowId { out["windowId"] = wid }
    respondOk(id, out)
}

// ---------- type / key ----------

func cmdType(_ id: Any?, _ p: [String: Any]) {
    guard let text = p["text"] as? String, !text.isEmpty else {
        respondErr(id, "type 需要 text（非空字符串）")
        return
    }
    if text.count > 4000 {
        respondErr(id, "text 过长（>4000 字符），请分段输入", code: "text-too-long")
        return
    }
    let pid = p["pid"] as? Int
    let src = eventSource()
    // 中文等非键码字符唯一可靠路径：CGEventKeyboardSetUnicodeString 把 UTF-16 文本直接塞进事件，
    // 绕过键码翻译与输入法合成。单事件上限 20 个 UTF-16 码元——必须按码元（而非 Character）
    // 分段：一个 emoji 常占 2+ 码元，按字符合段会静默超限丢字。
    let units = Array(text.utf16)
    var sent = 0
    var i = 0
    while i < units.count {
        let n = min(20, units.count - i)
        let chunk = Array(units[i..<(i + n)])
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { break }
        down.keyboardSetUnicodeString(stringLength: n, unicodeString: chunk)
        up.keyboardSetUnicodeString(stringLength: n, unicodeString: chunk)
        postEvent(pid, down)
        usleep(12000) // 12ms/段：太快部分应用会丢字
        postEvent(pid, up)
        usleep(8000)
        sent += n
        i += n
    }
    respondOk(id, ["chars": sent]) // 与 JS text.length 同口径（UTF-16 码元数）
}

/** 常用键 → 虚拟键码（ANSI 布局）；字母数字直接查表。 */
let KEY_CODES: [String: Int] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

let MOD_FLAGS: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand,
    "ctrl": .maskControl, "control": .maskControl,
    "alt": .maskAlternate, "option": .maskAlternate,
    "shift": .maskShift,
]

/** 修饰键物理键码（flagsChange 事件要带真实键码）：cmd=0x37 shift=0x38 option=0x3A control=0x3B。 */
let MOD_KEY_CODES: [(flag: CGEventFlags, code: CGKeyCode)] = [
    (.maskCommand, 0x37), (.maskShift, 0x38), (.maskAlternate, 0x3A), (.maskControl, 0x3B),
]

/**
 * 合成一次 flagsChange 事件（修饰键按下/释放）：键事件改 type 为 .flagsChanged 并携带
 * 「该修饰键之后」的系统修饰状态，与真实键盘的报告方式一致。
 */
func makeFlagsChange(_ src: CGEventSource?, _ keyCode: CGKeyCode, _ keyDown: Bool, _ flags: CGEventFlags) -> CGEvent? {
    guard let e = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: keyDown) else { return nil }
    e.type = .flagsChanged
    e.flags = flags
    return e
}

func cmdKey(_ id: Any?, _ p: [String: Any]) {
    guard let key = p["key"] as? String else { respondErr(id, "key 需要键名"); return }
    let lowered = key.lowercased()
    guard let code = KEY_CODES[lowered] else {
        respondErr(id, "不支持的键名: \(key)（支持字母/数字/enter/tab/escape/space/delete/方向键/home/end/pageup/pagedown/f1-f12）", code: "unknown-key")
        return
    }
    var flags: CGEventFlags = []
    var names: [String] = []
    if let mods = p["modifiers"] as? [String] {
        for m in mods {
            guard let f = MOD_FLAGS[m.lowercased()] else {
                respondErr(id, "不支持的修饰键: \(m)（cmd/ctrl/alt/shift）", code: "unknown-modifier")
                return
            }
            flags.insert(f)
            names.append(m.lowercased())
        }
    }
    let pid = p["pid"] as? Int
    let src = eventSource()
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: false) else {
        respondErr(id, "无法构造键盘事件")
        return
    }
    // v0.5.5 真实按键序列：修饰键 flagsChange 逐个按下 → keyDown → keyUp → flagsChange 逐个释放，
    // 事件间 5ms 让系统消化顺序；keyDown/keyUp 自身也带修饰 flag（真实键盘正是如此，兜底只看
    // 按键事件 flag 的应用）。combinedSessionState 源 + 瞬发 down/up 正是 ⌘S/⌘N「有时不弹」的根因。
    let modFlags = MOD_KEY_CODES.filter { flags.contains($0.flag) }
    var held: CGEventFlags = []
    for m in modFlags {
        held.insert(m.flag)
        if let e = makeFlagsChange(src, m.code, true, held) { postEvent(pid, e) }
        usleep(5000)
    }
    down.flags = flags
    postEvent(pid, down)
    usleep(10000)
    up.flags = flags
    postEvent(pid, up)
    usleep(5000)
    for m in modFlags.reversed() {
        held.remove(m.flag)
        if let e = makeFlagsChange(src, m.code, false, held) { postEvent(pid, e) }
        usleep(5000)
    }
    respondOk(id, ["key": lowered, "keyCode": code, "modifiers": names])
}

// ---------- app-focus ----------

func cmdAppFocus(_ id: Any?, _ p: [String: Any]) {
    guard let pid = p["pid"] as? Int, pid > 0 else { respondErr(id, "app-focus 需要 pid"); return }
    let r = focusApp(pid_t(pid))
    respondOk(id, ["axRaised": r.raised, "appActivated": r.activated])
}

// ---------- 幽魂光标叠加层（overlay：AI 动手位置的可见化提示；真鼠标始终不动） ----------

let AMBER = NSColor(srgbRed: 245 / 255, green: 158 / 255, blue: 11 / 255, alpha: 1) // 与扩展角标同色系

/** 箭头多边形（热区在 (0,0)，箭体向右下延伸；y 向下坐标，draw 时按锚点平移）。 */
let ARROW_POINTS: [CGPoint] = [
    CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 16.9), CGPoint(x: 4.2, y: 12.7), CGPoint(x: 7.1, y: 19.6),
    CGPoint(x: 10.3, y: 18.2), CGPoint(x: 7.4, y: 11.5), CGPoint(x: 12.2, y: 11.5),
]

/** 叠加绘制视图：kind=arrow 只画琥珀箭头；kind=click 追加约 350ms 的扩散涟漪。 */
final class OverlayView: NSView {
    var isClick = false
    var ripple: CGFloat = 0 // 涟漪进度 0→1
    let anchor = CGPoint(x: 56, y: 56) // 热区在 140x140 视图内的锚点（涟漪最大半径 52 也容纳得下）

    override var isFlipped: Bool { true } // 与屏幕像素同向（y 向下），坐标换算直观

    override func draw(_ dirtyRect: NSRect) {
        // 涟漪：以热区为圆心，半径 8→52、透明度 0.85→0 扩散一圈
        if isClick, ripple > 0 {
            let t = min(max(ripple, 0), 1)
            let radius = 8 + 44 * t
            let ring = NSBezierPath(ovalIn: NSRect(x: anchor.x - radius, y: anchor.y - radius,
                                                   width: radius * 2, height: radius * 2))
            AMBER.withAlphaComponent(0.85 * (1 - t)).setStroke()
            ring.lineWidth = 3 - 2 * t
            ring.stroke()
        }
        // 箭头主体：多边形 × 1.15 平移到锚点（热区尖端精确落在动作坐标上）
        let path = NSBezierPath()
        for (i, pt) in ARROW_POINTS.enumerated() {
            let p = NSPoint(x: anchor.x + pt.x * 1.15, y: anchor.y + pt.y * 1.15)
            if i == 0 { path.move(to: p) } else { path.line(to: p) }
        }
        path.close()
        // 柔和外发光：给填充挂一圈琥珀阴影（blur 12），再实心填充 + 白描边
        let shadow = NSShadow()
        shadow.shadowBlurRadius = 12
        shadow.shadowColor = AMBER.withAlphaComponent(0.55)
        shadow.shadowOffset = .zero
        shadow.set()
        AMBER.setFill()
        path.fill()
        NSShadow().set() // 清除阴影，避免影响描边
        NSColor.white.setStroke()
        path.lineWidth = 1.4
        path.stroke()
    }
}

/**
 * 幽魂光标控制器：懒创建一次 140x140 点击穿透面板并复用；显示 durationMs 后淡出。
 * 仅主线程调用（命令分发处保证）。失败安全：任何异常路径只返回错误文案，不影响主命令循环。
 */
final class OverlayController {
    private let panelSize: CGFloat = 140
    private var panel: NSPanel?
    private var view: OverlayView?
    private var fadeItem: DispatchWorkItem?
    private var rippleTimer: Timer?
    private var generation = 0 // 防串台：新一次显示后，旧淡出/涟漪回调不得动新窗口

    /** 显示；成功返回 nil，失败返回错误文案。 */
    func show(x: Double, y: Double, kind: String, durationMs: Int) -> String? {
        guard let main = NSScreen.screens.first else { return "无可用屏幕（NSScreen.screens 为空）" }
        if panel == nil {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: panelSize, height: panelSize),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 2) // 盖普通窗口，不抢系统 UI
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = false
            p.ignoresMouseEvents = true // 点击穿透
            p.hidesOnDeactivate = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary] // 全屏应用上也显示
            p.isReleasedWhenClosed = false
            let v = OverlayView(frame: NSRect(x: 0, y: 0, width: panelSize, height: panelSize))
            p.contentView = v
            panel = p
            view = v
        }
        guard let panel, let view else { return "叠加窗口创建失败" }

        generation += 1
        let gen = generation
        fadeItem?.cancel()
        rippleTimer?.invalidate()
        rippleTimer = nil
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0
            view.animator().alphaValue = 1 // 若正处淡出中，立即回满
        })
        view.isClick = (kind == "click")
        view.ripple = 0
        view.needsDisplay = true

        // 屏幕坐标（CG 系：y 向下、原点在主屏左上）→ AppKit 窗口 frame（y 向上、原点在主屏左下）。
        // 锚点对准 (x, y)，即箭头尖端/涟漪圆心精确落在动作坐标上。
        let topLeftCgY = y - Double(view.anchor.y)
        panel.setFrameOrigin(NSPoint(x: x - Double(view.anchor.x),
                                     y: main.frame.maxY - topLeftCgY - Double(panelSize)))
        panel.orderFrontRegardless() // 显示但绝不 activate（不抢焦点）

        if view.isClick {
            let start = Date()
            rippleTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] timer in
                guard let self, let v = self.view else { timer.invalidate(); return }
                v.ripple = CGFloat(min(Date().timeIntervalSince(start) * 1000 / 350, 1))
                v.needsDisplay = true
                if v.ripple >= 1 {
                    timer.invalidate()
                    if self.rippleTimer === timer { self.rippleTimer = nil }
                }
            }
        }

        let item = DispatchWorkItem { [weak self] in
            guard let self, self.generation == gen else { return } // panel/view 已是本函数解包后的局部常量
            self.rippleTimer?.invalidate()
            self.rippleTimer = nil
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.18
                view.animator().alphaValue = 0
            }, completionHandler: {
                guard self.generation == gen else { return } // 已被新一次显示接管
                panel.orderOut(nil)
                view.alphaValue = 1
            })
        }
        fadeItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(durationMs), execute: item)
        return nil
    }

    /** 立即隐藏（自检/收尾用；幂等）。 */
    func hide() {
        generation += 1 // 使一切在途淡出/涟漪回调失效
        fadeItem?.cancel()
        fadeItem = nil
        rippleTimer?.invalidate()
        rippleTimer = nil
        panel?.orderOut(nil)
    }
}

let overlay = OverlayController()

func cmdOverlayShow(_ id: Any?, _ p: [String: Any]) {
    guard let x = (p["x"] as? NSNumber)?.doubleValue, let y = (p["y"] as? NSNumber)?.doubleValue,
          x.isFinite, y.isFinite else {
        respondErr(id, "overlay-show 需要 x/y（数字，屏幕坐标）", code: "bad-args")
        return
    }
    let kind = p["kind"] as? String ?? "arrow"
    guard kind == "arrow" || kind == "click" else {
        respondErr(id, "overlay-show 的 kind 需为 arrow 或 click", code: "bad-kind")
        return
    }
    var durationMs = p["durationMs"] as? Int ?? 700
    if durationMs < 100 { durationMs = 100 }
    if durationMs > 5000 { durationMs = 5000 }
    DispatchQueue.main.async { // 窗口操作必须在主线程（run loop 上）
        if let reason = overlay.show(x: x, y: y, kind: kind, durationMs: durationMs) {
            respondErr(id, reason, code: "overlay-failed")
        } else {
            respondOk(id, [:])
        }
    }
}

func cmdOverlayHide(_ id: Any?) {
    DispatchQueue.main.async {
        overlay.hide()
        respondOk(id, [:])
    }
}

// ---------- 权限引导悬浮卡片（v0.5.4：可拖拽/可交互的引导 UI；照抄成熟 macOS 工具的授权引导模式） ----------

let CARD_W: CGFloat = 300
let CARD_H: CGFloat = 116
let CARD_GAP: CGFloat = 20 // 双卡同屏时的纵向错位间距（accessibility 在上、screen 在下）

/** 负责进程的 .app bundle 路径（拖拽句柄 promise 它——TCC 记账、设置列表要加的正是这个 App）。 */
func responsibleAppBundleURL() -> URL? {
    var pid = parentPid(getpid()) // 与 responsibleProcessName() 同一条 ppid 链
    for _ in 0..<16 {
        if pid <= 1 { break }
        if let app = NSRunningApplication(processIdentifier: pid),
           let bundleId = app.bundleIdentifier, !bundleId.isEmpty,
           let url = app.bundleURL {
            return url
        }
        let ppid = parentPid(pid)
        if ppid <= 0 { break }
        pid = ppid
    }
    return nil
}

/** 卡片右上角 ✕：自绘 + mouseUp 触发（不依赖窗口 key 状态，nonactivating 面板里最稳的点击路径）。 */
final class CardCloseButton: NSView {
    var onClick: (() -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.withAlphaComponent(0.55).setStroke()
        let b = bounds.insetBy(dx: 5, dy: 5)
        let path = NSBezierPath()
        path.move(to: NSPoint(x: b.minX, y: b.minY))
        path.line(to: NSPoint(x: b.maxX, y: b.maxY))
        path.move(to: NSPoint(x: b.maxX, y: b.minY))
        path.line(to: NSPoint(x: b.minX, y: b.maxY))
        path.lineWidth = 1.6
        path.lineCapStyle = .round
        path.stroke()
    }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    override func mouseUp(with event: NSEvent) { onClick?() }
}

/**
 * 左侧琥珀图标 = 拖拽句柄：按住它发起一次文件拖拽，拖出的就是「负责进程的 .app bundle」——
 * 用户直接把它放进系统设置 → 隐私与安全性 → 辅助功能/屏幕录制 的列表里（macOS 对拖入的
 * App 自动建 TCC 条目，效果等同点 + 号再选 App）。fileURL 为 nil（父链上找不到带 bundle 的
 * App）时鼠标事件交还父视图，句柄区退化为窗口拖动。
 */
final class CardIconDragView: NSView, NSDraggingSource {
    var fileURL: URL?

    override var isFlipped: Bool { true }

    override func resetCursorRects() {
        if fileURL != nil { addCursorRect(bounds, cursor: .openHand) } else { super.resetCursorRects() }
    }

    override func draw(_ dirtyRect: NSRect) {
        // 琥珀圆 + 白描边（与扩展角标/幽灵光标同色系）
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 2.5, dy: 2.5))
        AMBER.setFill()
        circle.fill()
        NSColor.white.withAlphaComponent(0.85).setStroke()
        circle.lineWidth = 1.5
        circle.stroke()
        // 圆心内嵌小箭头（幽灵光标的品牌符号，热区在左上的箭头形）
        let c = NSPoint(x: bounds.midX, y: bounds.midY)
        let path = NSBezierPath()
        for (i, pt) in ARROW_POINTS.enumerated() {
            let p = NSPoint(x: c.x - 6.4 + pt.x * 1.05, y: c.y - 10.3 + pt.y * 1.05)
            if i == 0 { path.move(to: p) } else { path.line(to: p) }
        }
        path.close()
        NSColor.white.setFill()
        path.fill()
    }

    override func mouseDown(with event: NSEvent) {
        guard let url = fileURL else { super.mouseDown(with: event); return } // 无可拖对象：退回窗口移动
        let pb = NSPasteboard()
        pb.clearContents()
        pb.writeObjects([url as NSURL]) // 磁盘上已存在的 .app：文件 URL 直拖（无需 NSFilePromiseProvider 的惰性承诺）
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        item.setDraggingFrame(bounds, contents: snapshotImage())
        beginDraggingSession(with: [item], event: event, source: self)
    }

    /** 拖拽随行图像：把自己画进离屏 NSImage（CG 上下文翻转一次，与 flipped 绘制同向）。 */
    private func snapshotImage() -> NSImage {
        let img = NSImage(size: bounds.size)
        img.lockFocus()
        if let ctx = NSGraphicsContext.current {
            ctx.cgContext.translateBy(x: 0, y: bounds.height)
            ctx.cgContext.scaleBy(x: 1, y: -1)
        }
        draw(bounds)
        img.unlockFocus()
        return img
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
}

/** 卡片内容视图：深色圆角底 + 琥珀描边；标题/主文案/副文案三行（图标句柄与 ✕ 为子视图）。 */
class PermissionCardView: NSView {
    let kind: String // accessibility | screen（决定主文案指向哪个列表）
    var appName = "" { didSet { needsDisplay = true } } // 副文案里要勾选的终端名

    init(frame frameRect: NSRect, kind: String) {
        self.kind = kind
        super.init(frame: frameRect)
    }

    required init?(coder: NSCoder) { fatalError("PermissionCardView 不走 XIB 路径") }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let bg = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 14, yRadius: 14)
        NSColor(white: 0.12, alpha: 0.97).setFill() // 近黑底：浅色/深色外观下都衬得住琥珀描边
        bg.fill()
        AMBER.withAlphaComponent(0.9).setStroke()
        bg.lineWidth = 1.5
        bg.stroke()

        let textX: CGFloat = 76
        let textW = bounds.width - textX - 12
        drawText("Chrome Agent Browser",
                 in: NSRect(x: textX, y: 20, width: textW, height: 18),
                 [.font: NSFont.boldSystemFont(ofSize: 12.5), .foregroundColor: NSColor.white])
        drawText(kind == "accessibility" ? "拖我到上面的辅助功能列表" : "拖我到上面的屏幕录制列表",
                 in: NSRect(x: textX, y: 42, width: textW, height: 18),
                 [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.white])
        let name = appName.isEmpty ? "运行本命令的终端" : appName
        drawText("或点列表下方的 + 号 → 选「\(name)」",
                 in: NSRect(x: textX, y: 63, width: textW, height: 16),
                 [.font: NSFont.systemFont(ofSize: 10.5), .foregroundColor: NSColor.white.withAlphaComponent(0.62)])
    }

    private func drawText(_ s: String, in rect: NSRect, _ attrs: [NSAttributedString.Key: Any]) {
        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byTruncatingTail
        let full = attrs.merging([.paragraphStyle: para]) { _, new in new }
        NSAttributedString(string: s, attributes: full).draw(in: rect)
    }
}

/** 一张卡片 = 面板 + 内容视图 + 淡出定时器。 */
final class CardEntry {
    let kind: String
    let panel: NSPanel
    let view: PermissionCardView
    var fadeItem: DispatchWorkItem?

    init(kind: String, panel: NSPanel, view: PermissionCardView) {
        self.kind = kind
        self.panel = panel
        self.view = view
    }
}

/**
 * 权限引导卡片控制器：按 kind 管理至多两张卡片（accessibility/screen），可并存、错位不重叠。
 * 仅主线程调用（命令分发处保证）。失败安全：任何路径只影响自身卡片，不影响主命令循环。
 */
final class PermissionCardController {
    private var cards: [String: CardEntry] = [:]
    private var exitAfterCardsClose = false // stdin 已 EOF 但卡片还在：等最后一张收起再退进程

    var hasVisibleCards: Bool { !cards.isEmpty }

    /** 显示（同 kind 已在屏则就地更新文案并重置淡出计时，保留用户拖过的位置）。 */
    func show(kind: String, appName: String, durationSec: Int, dragURL: URL?) -> [String: Any] {
        if let entry = cards[kind] {
            entry.view.appName = appName
            scheduleFade(entry, durationSec)
            return reply(entry, durationSec: durationSec)
        }
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: CARD_W, height: CARD_H),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating // 盖在系统设置等普通窗口上方（比幽灵光标低两层：引导不必压系统 UI）
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.ignoresMouseEvents = false // 本项目唯一可交互的叠加窗：它就是给用户操作的引导 UI
        panel.isMovableByWindowBackground = true // 拖卡片背景 = 挪到列表附近（拖图标句柄 = 拖 App 进列表）
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        let view = PermissionCardView(frame: NSRect(x: 0, y: 0, width: CARD_W, height: CARD_H), kind: kind)
        view.appName = appName
        panel.contentView = view

        let icon = CardIconDragView(frame: NSRect(x: 14, y: 30, width: 52, height: 52))
        icon.fileURL = dragURL
        view.addSubview(icon)
        let close = CardCloseButton(frame: NSRect(x: CARD_W - 26, y: 8, width: 18, height: 18))
        view.addSubview(close)

        let entry = CardEntry(kind: kind, panel: panel, view: view)
        close.onClick = { [weak self] in
            self?.hide(kind: kind)
            self?.exitIfDone()
        }
        cards[kind] = entry

        // 默认位置：主屏中央偏右（系统设置通常开在左半屏/居中）；screen 卡在 accessibility 卡下方错开
        let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let slot: CGFloat = kind == "accessibility" ? 0 : 1
        let x = vis.midX + vis.width * 0.12 - CARD_W / 2
        let y = vis.midY + 34 - slot * (CARD_H + CARD_GAP) - CARD_H / 2
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        panel.orderFrontRegardless() // 显示但绝不 activate（不抢系统设置的焦点）
        scheduleFade(entry, durationSec)
        return reply(entry, durationSec: durationSec)
    }

    /** 立即隐藏（幂等；未显示的 kind 静默 ok）。 */
    func hide(kind: String) {
        guard let entry = cards[kind] else { return }
        entry.fadeItem?.cancel()
        entry.fadeItem = nil
        cards[kind] = nil
        entry.panel.orderOut(nil)
    }

    /** stdin EOF 时的退出决策：无卡片立即退（旧行为）；有卡片留守，收齐后由 exitIfDone 收尾。 */
    func noteStdinClosed() {
        if cards.isEmpty {
            NSApp.terminate(nil)
        } else {
            exitAfterCardsClose = true
        }
    }

    /** 卡片全数收起后（且 stdin 已 EOF）退出进程。 */
    func exitIfDone() {
        guard exitAfterCardsClose, cards.isEmpty else { return }
        exitAfterCardsClose = false
        NSApp.terminate(nil)
    }

    private func scheduleFade(_ entry: CardEntry, _ durationSec: Int) {
        entry.fadeItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.cards[entry.kind] != nil else { return }
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.25
                entry.panel.animator().alphaValue = 0
            }, completionHandler: { [weak self] in
                guard let self else { return }
                if self.cards[entry.kind] != nil {
                    self.cards[entry.kind] = nil
                    entry.panel.orderOut(nil)
                    entry.panel.alphaValue = 1 // 下次重建时从全不透明起步
                }
                self.exitIfDone()
            })
        }
        entry.fadeItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(durationSec), execute: item)
    }

    /** 应答数据：frame 换算成屏幕左上原点（与 windows/overlay 的 CG 坐标系一致）。 */
    private func reply(_ entry: CardEntry, durationSec: Int) -> [String: Any] {
        let f = entry.panel.frame
        let topY = (NSScreen.main?.frame.maxY ?? f.maxY) - f.maxY
        var out: [String: Any] = [
            "kind": entry.kind,
            "autoHideSec": durationSec,
            "frame": ["x": f.minX, "y": topY, "w": f.width, "h": f.height],
        ]
        if let url = entry.view.subviews.compactMap({ ($0 as? CardIconDragView)?.fileURL }).first {
            out["dragFrom"] = url.path
        }
        return out
    }
}

let permissionCards = PermissionCardController()

func cmdShowPermissionCard(_ id: Any?, _ p: [String: Any]) {
    guard let kind = p["kind"] as? String, kind == "accessibility" || kind == "screen" else {
        respondErr(id, "show-permission-card 的 kind 需为 accessibility 或 screen", code: "bad-kind")
        return
    }
    let appName = (p["appName"] as? String) ?? ""
    var durationSec = p["durationSec"] as? Int ?? 120
    if durationSec < 5 { durationSec = 5 }
    if durationSec > 600 { durationSec = 600 }
    DispatchQueue.main.async { // 窗口操作必须在主线程（run loop 上）
        let dragURL = responsibleAppBundleURL()
        respondOk(id, permissionCards.show(kind: kind, appName: appName, durationSec: durationSec, dragURL: dragURL))
    }
}

func cmdHidePermissionCard(_ id: Any?, _ p: [String: Any]) {
    let kind = (p["kind"] as? String) ?? ""
    DispatchQueue.main.async {
        if !kind.isEmpty { permissionCards.hide(kind: kind) } // 未知 kind 幂等 ok
        permissionCards.exitIfDone()
        respondOk(id, [:])
    }
}

// ---------- 主循环（主线程跑 AppKit run loop；stdin 移后台队列逐行读） ----------

/** 解析并执行一行请求；overlay/permission-card 命令切主线程执行，其余在读取线程内联完成（与旧版行为一致）。 */
func handleLine(_ line: String) {
    guard let data = line.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        respondErr(nil, "请求不是合法 JSON 对象（需要单行 {id, cmd, ...}）", code: "bad-request")
        return
    }
    let id = obj["id"]
    guard let cmd = obj["cmd"] as? String else {
        respondErr(id, "缺少 cmd 字段", code: "bad-request")
        return
    }
    switch cmd {
    case "probe": cmdProbe(id, obj)
    case "request-permissions": cmdRequestPermissions(id, obj)
    case "windows": cmdWindows(id, obj)
    case "ax-tree": cmdAxTree(id, obj)
    case "element-click": cmdElementClick(id, obj)
    case "xy-click": cmdXyClick(id, obj)
    case "type": cmdType(id, obj)
    case "key": cmdKey(id, obj)
    case "app-focus": cmdAppFocus(id, obj)
    case "overlay-show": cmdOverlayShow(id, obj)
    case "overlay-hide": cmdOverlayHide(id)
    case "show-permission-card": cmdShowPermissionCard(id, obj)
    case "hide-permission-card": cmdHidePermissionCard(id, obj)
    default: respondErr(id, "未知命令: \(cmd)", code: "unknown-cmd")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 无 Dock 图标；叠加窗 orderFrontRegardless 显示、绝不 activate

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        autoreleasepool { handleLine(line) }
    }
    // stdin EOF：结束主线程 run loop（terminate），保持旧版「管道关闭即退出」的行为；
    // 权限引导卡片还在屏上时留守到卡片全数收起（setup 非交互留卡场景，寿命最长 600s）
    DispatchQueue.main.async { permissionCards.noteStdinClosed() }
}

app.run()
// run() 在 terminate 后返回，进程随之退出（退出码 0，与旧版一致）
