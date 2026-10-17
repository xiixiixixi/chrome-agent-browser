// swift/cua-helper.swift — 屏幕操作助手（单文件 Swift，行协议 JSON 服务）
//
// 由 setup.mjs / cua-selftest.mjs 用 swiftc 编译为 host/cua-helper（编译产物不入库）。
// 协议：stdin 每行一个 JSON 请求 {id, cmd, ...参数}；stdout 每行一个 JSON 响应
//   成功 {id, ok:true, ...数据} / 失败 {id, ok:false, error:"...", code?:"..."}。
// 除本协议外不向 stdout 写任何内容；诊断信息一律 stderr。
//
// 命令集（与 service/cua.mjs 的调用侧一一对应）：
//   probe                              → {axGranted, screenGranted}（AXIsProcessTrusted / CGPreflightScreenCaptureAccess）
//   windows                            → {windows:[{windowId, ownerPid, ownerName, title, bounds:{x,y,w,h}, onScreen}]}
//   ax-tree {pid, maxDepth?}           → {nodes:[{depth, role, title?, value?, bounds?, actions?}], truncated}
//                                        遍历限额：深度 12 / 每层 80 / 总 1500 节点；文本截断 120 字符。
//                                        AX 未授权 → {ok:false, code:"not-granted"}（结构化，不崩溃）。
//   element-click {pid, role, title?}  → 先 AXUIElement PerformAction(press)；失败兜底取元素 bounds
//                                        中心做定向坐标点击 → {pressed} | {xyFallback, bounds, at}
//   xy-click {x, y, pid?}              → 有 pid：CGEventPostToPid 定向投递（不动真实光标）；
//                                        无 pid：CGEventPost 全局（会移动真实光标）
//   type {pid?, text}                  → 键盘事件逐段输入（≤20 字符/事件，规避单事件长度限制）
//   key {pid?, key, modifiers?}        → modifiers: cmd/ctrl/alt/shift；key 用键码映射表
//   app-focus {pid}                    → AX raise 主窗口 + NSRunningApplication activate
//
// 安全边界：本助手不做任何锁屏/解锁/认证类操作；只执行调用方显式给出的动作。

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
    respondOk(id, ["axGranted": axTrusted(), "screenGranted": CGPreflightScreenCaptureAccess()])
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
    // 路径 B：取元素 bounds 中心做定向坐标点击（发给该进程，不动真实光标）
    guard let pos = axPointOrSize(axAttr(el, kAXPositionAttribute)),
          let size = axPointOrSize(axAttr(el, kAXSizeAttribute)), size[0] > 0, size[1] > 0 else {
        respondErr(id, "元素无 bounds，无法坐标兜底", code: "no-bounds")
        return
    }
    let cx = pos[0] + size[0] / 2
    let cy = pos[1] + size[1] / 2
    postClick(pid, cx, cy)
    respondOk(id, ["xyFallback": true, "bounds": ["x": pos[0], "y": pos[1], "w": size[0], "h": size[1]], "at": [cx, cy]])
}

// ---------- 事件投递 ----------

func eventSource() -> CGEventSource? { CGEventSource(stateID: .combinedSessionState) }

/** 有 pid → 定向投递到该进程（不动真实光标）；无 pid → 全局（会移动真实光标）。 */
func postEvent(_ pid: Int?, _ e: CGEvent) {
    if let pid = pid, pid > 0 { e.postToPid(pid_t(pid)) } else { e.post(tap: .cghidEventTap) }
}

func postClick(_ pid: Int?, _ x: Double, _ y: Double) {
    let src = eventSource()
    let pt = CGPoint(x: x, y: y)
    guard let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left),
          let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) else { return }
    postEvent(pid, down)
    postEvent(pid, up)
}

func cmdXyClick(_ id: Any?, _ p: [String: Any]) {
    guard let x = (p["x"] as? NSNumber)?.doubleValue, let y = (p["y"] as? NSNumber)?.doubleValue else {
        respondErr(id, "xy-click 需要 x/y（数字）")
        return
    }
    let pid = p["pid"] as? Int
    postClick(pid, x, y)
    var out: [String: Any] = ["x": x, "y": y, "targeted": (pid ?? 0) > 0]
    if (pid ?? 0) <= 0 { out["note"] = "无 pid：全局投递（会移动真实光标）" }
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
    // CGEventKeyboardSetUnicodeString 单事件建议 ≤20 字符，逐段发送
    var sent = 0
    var start = text.startIndex
    while start < text.endIndex {
        let end = text.index(start, offsetBy: 20, limitedBy: text.endIndex) ?? text.endIndex
        let chunk = String(text[start..<end])
        let utf16 = Array(chunk.utf16)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { break }
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        postEvent(pid, down)
        usleep(12000) // 12ms/段：太快部分应用会丢字
        postEvent(pid, up)
        usleep(8000)
        sent += chunk.count
        start = end
    }
    respondOk(id, ["chars": sent])
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
    down.flags = flags
    up.flags = flags
    postEvent(pid, down)
    usleep(15000)
    postEvent(pid, up)
    respondOk(id, ["key": lowered, "keyCode": code, "modifiers": names])
}

// ---------- app-focus ----------

func cmdAppFocus(_ id: Any?, _ p: [String: Any]) {
    guard let pid = p["pid"] as? Int, pid > 0 else { respondErr(id, "app-focus 需要 pid"); return }
    var raised = false
    let app = AXUIElementCreateApplication(pid_t(pid))
    if let raw = axAttr(app, kAXMainWindowAttribute) {
        let win = unsafeBitCast(raw, to: AXUIElement.self) // CFTypeRef → AXUIElement（kAXMainWindowAttribute 必为元素）
        if AXUIElementPerformAction(win, "AXRaise" as CFString) == .success { raised = true }
    }
    var activated = false
    if let running = NSRunningApplication(processIdentifier: pid_t(pid)) {
        activated = running.activate(options: []) // macOS 14 起 activateIgnoringOtherApps 已废弃且无效
    }
    respondOk(id, ["axRaised": raised, "appActivated": activated])
}

// ---------- 主循环 ----------

while let line = readLine() {
    autoreleasepool {
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
        case "windows": cmdWindows(id, obj)
        case "ax-tree": cmdAxTree(id, obj)
        case "element-click": cmdElementClick(id, obj)
        case "xy-click": cmdXyClick(id, obj)
        case "type": cmdType(id, obj)
        case "key": cmdKey(id, obj)
        case "app-focus": cmdAppFocus(id, obj)
        default: respondErr(id, "未知命令: \(cmd)", code: "unknown-cmd")
        }
    }
}
