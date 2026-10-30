import AppKit
import ApplicationServices
import ScreenCaptureKit

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}

func textAttribute(_ element: AXUIElement, _ name: String) -> String {
    if let value = attribute(element, name) as? String { return value }
    if let value = attribute(element, name) as? NSNumber { return value.stringValue }
    return ""
}

func elementRect(_ element: AXUIElement) -> CGRect? {
    guard let p = attribute(element, kAXPositionAttribute), let s = attribute(element, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point),
          AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

func record(_ element: AXUIElement, path: [Int], index: Int, window: NativeWindow) -> NativeElement {
    let title = textAttribute(element, kAXTitleAttribute)
    let description = textAttribute(element, kAXDescriptionAttribute)
    let local = elementRect(element).map {
        WindowFrame($0.offsetBy(dx: -window.bounds.x, dy: -window.bounds.y))
    }
    return NativeElement(index: index, runtimeId: path,
        automationId: textAttribute(element, kAXIdentifierAttribute),
        name: title.isEmpty ? description : title,
        controlType: textAttribute(element, kAXRoleAttribute),
        value: textAttribute(element, kAXValueAttribute), frame: local, actions: actions(element))
}

@MainActor
func windows() -> [NativeWindow] {
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    return (info as? [[String: Any]] ?? []).compactMap { row in
        // Include visible menus/dialogs as separate targets, not only layer-zero
        // document windows. Otherwise an overlay could receive a stale click.
        guard (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
              let pid = row[kCGWindowOwnerPID as String] as? Int32,
              let id = row[kCGWindowNumber as String] as? UInt32, pid > 0, id > 0,
              let box = row[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: box as CFDictionary),
              rect.width > 1, rect.height > 1 else { return nil }
        let app = NSRunningApplication(processIdentifier: pid)
        return NativeWindow(id: id, pid: pid,
            name: app?.localizedName ?? (row[kCGWindowOwnerName as String] as? String ?? ""),
            bundle: app?.bundleIdentifier ?? "", title: row[kCGWindowName as String] as? String ?? "",
            bounds: WindowFrame(rect))
    }
}

@MainActor
func frontmostPID() -> pid_t? {
    let workspacePID = NSWorkspace.shared.frontmostApplication?.processIdentifier
    // Installed child processes can receive AppKit's invalid PID (-1) even
    // while system-wide AX identifies the application accepting keyboard input.
    guard AXIsProcessTrusted() else {
        return workspacePID.flatMap { $0 > 0 ? $0 : nil }
    }
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 1)
    guard let value = attribute(system, kAXFocusedApplicationAttribute),
          CFGetTypeID(value) == AXUIElementGetTypeID() else {
        return confirmedForegroundPID(accessibilityPID: nil, workspacePID: workspacePID)
    }
    var focusedPID: pid_t = -1
    guard AXUIElementGetPid(value as! AXUIElement, &focusedPID) == .success else {
        return confirmedForegroundPID(accessibilityPID: nil, workspacePID: workspacePID)
    }
    var elementPID: pid_t?
    if let element = attribute(system, kAXFocusedUIElementAttribute),
       CFGetTypeID(element) == AXUIElementGetTypeID() {
        var pid: pid_t = -1
        if AXUIElementGetPid(element as! AXUIElement, &pid) == .success { elementPID = pid }
    }
    return confirmedForegroundPID(accessibilityPID: focusedPID, workspacePID: workspacePID,
        focusedElementPID: elementPID, hasFocusedWindow: focusedWindow(pid: focusedPID, candidates: windows()) != nil)
}

@MainActor
func focusedWindow(pid: pid_t, candidates: [NativeWindow]) -> NativeWindow? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    guard let value = attribute(app, kAXFocusedWindowAttribute),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    let focused = value as! AXUIElement
    guard let rect = elementRect(focused) else { return nil }
    return matchFocusedWindow(candidates, pid: pid, frame: WindowFrame(rect), title: textAttribute(focused, kAXTitleAttribute))
}

@MainActor
func resolve(_ request: NativeRequest) throws -> NativeWindow {
    let all = windows()
    if let id = request.expectedWindow, let pid = request.expectedPid {
        guard let exact = all.first(where: { $0.id == id && $0.pid == pid }) else {
            throw RuntimeFailure("Observed window disappeared or changed owner. Run list_apps and re-observe.")
        }
        return exact
    }
    let query = (request.app ?? "").lowercased()
    if query == "foreground" {
        guard let pid = frontmostPID(),
              let front = focusedWindow(pid: pid, candidates: all) ?? all.first(where: { $0.pid == pid }) else { throw RuntimeFailure("No foreground window.") }
        return front
    }
    let matches = all.filter {
        [$0.selector, $0.name, $0.bundle, $0.title, String($0.pid)].contains { $0.lowercased() == query }
    }
    guard matches.count == 1, let selected = matches.first else {
        throw RuntimeFailure("Target is absent or ambiguous. Use an exact window:PID:WINDOW_ID from list_apps.")
    }
    return selected
}

func accessibilityWindow(_ window: NativeWindow) throws -> AXUIElement {
    let app = AXUIElementCreateApplication(window.pid)
    AXUIElementSetMessagingTimeout(app, 1)
    let candidates = (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter {
        guard let rect = elementRect($0) else { return false }
        return WindowFrame(rect).matches(window.bounds) && textAttribute($0, kAXTitleAttribute) == window.title
    }
    guard candidates.count == 1, let root = candidates.first else {
        throw RuntimeFailure("Accessibility window identity is ambiguous or unavailable; re-observe after the app is ready.")
    }
    return root
}

@MainActor
func snapshot(_ window: NativeWindow) async throws -> [String: Any] {
    let inputVersion = NativeRuntime.monitor.version
    if AXIsProcessTrusted() {
        let app = AXUIElementCreateApplication(window.pid)
        AXUIElementSetMessagingTimeout(app, 1)
        // Electron/Chromium defer their web accessibility tree until an AT client
        // requests it. Scope this to the observed PID; never toggle system access.
        let enabled = enableTargetAccessibility(
            read: { attribute(app, $0) as? Bool },
            enable: { AXUIElementSetAttributeValue(app, $0 as CFString, kCFBooleanTrue) == .success })
        if enabled { try await Task.sleep(nanoseconds: 500_000_000) }
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let target = content.windows.first(where: { $0.windowID == window.id && $0.owningApplication?.processID == window.pid }),
          WindowFrame(target.frame).matches(window.bounds) else {
        throw RuntimeFailure("Window changed during observation; re-observe.")
    }
    let config = SCStreamConfiguration()
    // Output one pixel per global coordinate point, including Retina displays.
    config.width = Int(window.bounds.width.rounded())
    config.height = Int(window.bounds.height.rounded())
    config.showsCursor = false
    config.ignoreShadowsSingleWindow = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: target), configuration: config)
    guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw RuntimeFailure("Failed to encode the current window image.")
    }
    var elements: [NativeElement] = []
    var lines: [String] = []
    if let root = try? accessibilityWindow(window) {
        let deadline = Date().addingTimeInterval(3)
        func visit(_ item: AXUIElement, path: [Int], depth: Int) {
            guard depth < 20, elements.count < 400, Date() < deadline else { return }
            let node = record(item, path: path, index: elements.count, window: window)
            elements.append(node)
            lines.append("\(node.index) \(node.controlType) \(node.name.debugDescription) value=\(node.value.debugDescription) actions=\(node.actions)")
            for (index, child) in (attribute(item, kAXChildrenAttribute) as? [AXUIElement] ?? []).enumerated() {
                visit(child, path: path + [index], depth: depth + 1)
            }
        }
        visit(root, path: [0], depth: 0)
        if elements.count >= 400 || Date() >= deadline { lines.append("Accessibility tree truncated; use visible image coordinates where needed.") }
    } else {
        if AXIsProcessTrusted() {
            lines.append("Accessibility tree unavailable for this app. Inspect the actual screenshot before choosing coordinates.")
        } else {
            lines.append("Accessibility permission is missing. Screen capture alone does not grant input. Authorize the responsible application identified by macOS; development launches may belong to Terminal. Reopen that application if requested and recheck access. Do not substitute shell UI automation.")
        }
    }
    // Reject geometry changes while the image/tree were being collected.
    guard windows().contains(where: { $0.id == window.id && $0.pid == window.pid && $0.bounds.matches(window.bounds) }) else {
        throw RuntimeFailure("Window changed while collecting its image and tree; re-observe.")
    }
    let encoded = try JSONEncoder().encode(elements)
    let bounds = try JSONEncoder().encode(window.bounds)
    var result: [String: Any] = [
        "app": ["name": window.name, "bundleIdentifier": window.bundle, "pid": window.pid],
        "windowHandle": window.id, "windowTitle": window.title,
        "windowBounds": try JSONSerialization.jsonObject(with: bounds),
        "screenshotPngBase64": png.base64EncodedString(), "treeLines": lines,
        "elements": try JSONSerialization.jsonObject(with: encoded)
    ]
    if let pid = frontmostPID(),
       let front = focusedWindow(pid: pid, candidates: windows()) ?? windows().first(where: { $0.pid == pid }) {
        result["foreground"] = ["name": front.name, "pid": front.pid, "windowHandle": front.id, "title": front.title]
    }
    guard inputVersion == NativeRuntime.monitor.version else { throw DesktopInputConflict() }
    if NativeRuntime.monitor.available { result["inputVersion"] = inputVersion }
    return result
}

func lookup(_ expected: NativeElement, in window: NativeWindow) throws -> AXUIElement {
    guard expected.runtimeId.first == 0 else { throw RuntimeFailure("Unknown accessibility element identity.") }
    var current = try accessibilityWindow(window)
    for index in expected.runtimeId.dropFirst() {
        let children = attribute(current, kAXChildrenAttribute) as? [AXUIElement] ?? []
        guard children.indices.contains(index) else { throw RuntimeFailure("Element disappeared; re-observe.") }
        current = children[index]
    }
    guard expected.matches(record(current, path: expected.runtimeId, index: expected.index, window: window)) else {
        throw RuntimeFailure("Element changed since observation; re-observe before input.")
    }
    return current
}

@MainActor
func assertForeground(_ window: NativeWindow, keyboard: Bool = false) throws {
    let activePID = frontmostPID()
    let focusedID = keyboard ? focusedWindow(pid: window.pid, candidates: windows())?.id : nil
    guard activePID == window.pid, !keyboard || focusedID == window.id else {
        throw RuntimeFailure("Foreground window changed; observe the active window before retrying. Expected pid=\(window.pid), window=\(window.id); active pid=\(activePID.map(String.init) ?? "unknown"), focused window=\(focusedID.map(String.init) ?? "unchecked").")
    }
}

@MainActor
func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, count: Int = 1, receipt: InputDispatchReceipt) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw RuntimeFailure("Failed to create mouse input.")
    }
    event.flags = []
    event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    event.setIntegerValueField(.eventSourceUserData, value: DesktopInputPolicy.marker)
    receipt.perform { event.post(tap: .cghidEventTap) }
}


@main
struct NativeRuntime {
    @MainActor static let monitor = NativeInputMonitor()
    @MainActor static func main() {
        // AppKit focus/activation state needs its event loop to receive changes.
        NSApplication.shared.setActivationPolicy(.prohibited)
        if CommandLine.arguments.contains("--watch-escape") {
            let escape = NativeInputMonitor(escapeWorker: true)
            guard escape.start() else { fputs("Escape monitor unavailable\n", stderr); exit(1) }
            print("ready"); fflush(stdout)
            readNativeLines { line in
                guard line.hasPrefix("arm "), line.count <= 260 else { return }
                escape.armed = String(line.dropFirst(4))
                print("armed \(escape.armed)"); fflush(stdout)
            }
        } else if CommandLine.arguments.contains("--stream") {
            readNativeLines { line in await processRequest(Data(line.utf8)) }
        } else {
            Task { await processRequest(FileHandle.standardInput.readDataToEndOfFile()); exit(0) }
        }
        NSApplication.shared.run()
    }

    @MainActor static func processRequest(_ input: Data) async {
        let receipt = InputDispatchReceipt()
        do {
            NSApplication.shared.setActivationPolicy(.prohibited)
            let request = try JSONDecoder().decode(NativeRequest.self, from: input)
            if request.tool == "doctor" {
                let diagnostic = DesktopEnvironmentDiagnostic(
                session: CGSessionCopyCurrentDictionary() as? [String: Any], userID: getuid(),
                accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
            try emit(["ok": true, "desktopEnvironment": diagnostic.dictionary,
                "text": "macOS runtime available. Desktop=\(diagnostic.desktopAvailable), Accessibility=\(diagnostic.accessibility), ScreenRecording=\(diagnostic.screenRecording), LockSignal=\(diagnostic.lockSignal)."])
                return
            }
            let desktop = DesktopEnvironmentDiagnostic(
                session: CGSessionCopyCurrentDictionary() as? [String: Any], userID: getuid(),
                accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
            guard desktop.desktopAvailable else {
                throw RuntimeFailure("The current macOS desktop session is unavailable or locked. Ask the user to unlock the same logged-in desktop and observe again. No desktop input was dispatched.")
            }
            let permissionApplication = PermissionApplication.locate(
                executable: Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0]),
                bundleInfo: { Bundle(url: $0)?.infoDictionary })
            guard requestMissingPermission(check: { CGPreflightScreenCaptureAccess() },
                request: { _ = CGRequestScreenCaptureAccess() }) else {
                throw RuntimeFailure(permissionApplication.denied("Screen Recording"))
            }
            if request.tool == "list_apps" {
                try emit(["ok": true, "text": windows().map { "\($0.selector) \($0.name) \($0.title.debugDescription)" }.joined(separator: "\n")])
                return
            }
            _ = monitor.start()
            try DesktopInputPolicy.validateLease(directory: request.controlDirectory, identity: request.controlIdentity)
            let window = try resolve(request)
            let inputReady = try await monitor.prepare(request)
            if request.isInput && !inputReady {
                // Match Windows: acknowledge a changed observation, never replay
                // the stale action. The host still counts this as a conflict.
                let fresh = try await snapshot(window)
                try DesktopInputPolicy.validateLease(directory: request.controlDirectory, identity: request.controlIdentity)
                try emit(["ok": true, "actionDispatched": false, "inputConflict": true,
                    "text": "Desktop changed during user interaction. The requested action was NOT dispatched. Here is the fresh target state; decide the next step from it instead of repeating the old action blindly.",
                    "snapshot": fresh])
                return
            }
            try request.validateBinding(pid: window.pid, window: window.id, bounds: window.bounds)
            if request.isInput {
                try monitor.validate(request)
                guard ProcessInfo.processInfo.environment["OPEN_COMPUTER_USE_WINDOWS_FOREGROUND_INPUT"] == "1" else {
                    throw RuntimeFailure("macOS input requires --foreground-input.")
                }
                guard requestMissingPermission(check: { AXIsProcessTrusted() }, request: {
                    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
                }) else {
                    throw RuntimeFailure(permissionApplication.denied("Accessibility"))
                }
                _ = try request.element.map { try lookup($0, in: window) }
                guard let app = NSRunningApplication(processIdentifier: window.pid) else { throw RuntimeFailure("Target process exited.") }
                // Activation can change focus but is not the requested keyboard/mouse input.
                if frontmostPID() != window.pid
                    || (request.requiresKeyboardFocus && focusedWindow(pid: window.pid, candidates: windows())?.id != window.id) {
                    app.activate(options: [.activateIgnoringOtherApps])
                    if let root = try? accessibilityWindow(window) { AXUIElementPerformAction(root, kAXRaiseAction as CFString) }
                    try await Task.sleep(nanoseconds: 150_000_000)
                }
                try assertForeground(window, keyboard: request.requiresKeyboardFocus)
                guard let current = windows().first(where: { $0.id == window.id && $0.pid == window.pid }) else { throw RuntimeFailure("Window closed during activation.") }
                try request.validateBinding(pid: current.pid, window: current.id, bounds: current.bounds)
                let element = try request.element.map { try lookup($0, in: current) }
                try monitor.validate(request)
                try await inputAction(request, window: current, element: element, receipt: receipt)
                try await Task.sleep(nanoseconds: 120_000_000)
            }
            try DesktopInputPolicy.validateLease(directory: request.controlDirectory, identity: request.controlIdentity)
            if request.isInput { try monitor.validate(request) }
            let after: [String: Any]
            do {
                after = try await snapshot(resolve(request))
            } catch {
                // Launchers and dialogs close after successful input. Their
                // disappearance is not evidence that the input failed. Observe
                // a verified new keyboard target without replaying the action.
                // Human input during capture must still be reported as a conflict.
                if request.isInput { try monitor.validate(request) }
                guard request.isInput, receipt.dispatched, let pid = frontmostPID(),
                      let active = focusedWindow(pid: pid, candidates: windows()),
                      active.pid != window.pid || active.id != window.id else { throw error }
                after = try await snapshot(active)
            }
            try DesktopInputPolicy.validateLease(directory: request.controlDirectory, identity: request.controlIdentity)
            if request.isInput { try monitor.validate(request) }
            try emit(["ok": true, "actionDispatched": receipt.dispatched, "snapshot": after])
        } catch {
            try? emit(["ok": false, "actionDispatched": receipt.dispatched,
                "inputConflict": error is DesktopInputConflict, "error": receipt.failureDescription(error)])
        }
    }

    static func emit(_ object: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    @MainActor static func inputAction(_ request: NativeRequest, window: NativeWindow, element: AXUIElement?, receipt: InputDispatchReceipt) async throws {
        func point() throws -> CGPoint {
            if let frame = request.element?.frame {
                return try window.bounds.globalPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
            }
            return try window.bounds.globalPoint(x: request.x, y: request.y)
        }
        func visiblePoint(_ point: CGPoint) throws {
            guard let primary = NSScreen.screens.first else {
                throw RuntimeFailure("No primary display is available for mouse hit-testing; re-observe.")
            }
            // This public API applies mouse-down hit-testing, including transparent
            // and ignoresMouseEvents surfaces. CG window rectangles include Dock's
            // full-display tracking surface and do not identify input recipients.
            let hit = NSWindow.windowNumber(at: appKitHitPoint(point, primaryDisplayTop: primary.frame.maxY),
                belowWindowWithWindowNumber: 0)
            try validateMouseHit(hit, target: window)
        }
        try monitor.validate(request)
        switch request.tool {
        case "click":
            let p = try point(); try visiblePoint(p)
            let count = request.click_count ?? 1
            guard (1...3).contains(count) else { throw RuntimeFailure("click_count must be 1, 2, or 3.") }
            let button: CGMouseButton
            let down: CGEventType
            let up: CGEventType
            switch request.mouse_button ?? "left" {
            case "left": button = .left; down = .leftMouseDown; up = .leftMouseUp
            case "right": button = .right; down = .rightMouseDown; up = .rightMouseUp
            case "middle": button = .center; down = .otherMouseDown; up = .otherMouseUp
            default: throw RuntimeFailure("Unsupported mouse button.")
            }
            for n in 1...count {
                try monitor.validate(request)
                try assertForeground(window)
                try visiblePoint(p)
                try mouse(down, p, button, count: n, receipt: receipt)
                try mouse(up, p, button, count: n, receipt: receipt)
                if n < count { try await Task.sleep(nanoseconds: 20_000_000) }
            }
        case "drag":
            let start = try window.bounds.globalPoint(x: request.from_x, y: request.from_y)
            let end = try window.bounds.globalPoint(x: request.to_x, y: request.to_y)
            try visiblePoint(start); try visiblePoint(end)
            try mouse(.leftMouseDown, start, receipt: receipt)
            var last = start
            defer { try? mouse(.leftMouseUp, last, receipt: receipt) }
            for step in 1...20 {
                try monitor.validate(request)
                try assertForeground(window)
                let p = CGPoint(x: start.x + (end.x - start.x) * Double(step) / 20,
                                y: start.y + (end.y - start.y) * Double(step) / 20)
                try mouse(.leftMouseDragged, p, receipt: receipt)
                last = p
                try await Task.sleep(nanoseconds: 10_000_000)
            }
        case "scroll":
            let p = try point(); try visiblePoint(p)
            let pages = request.pages ?? 1
            guard pages.isFinite, pages > 0, pages <= 100 else { throw RuntimeFailure("Scroll pages must be finite and between 0 and 100.") }
            let vertical: Int32
            let horizontal: Int32
            let amount = Int32(min(100_000, max(1, (pages * window.bounds.height * 0.8).rounded())))
            switch request.direction {
            case "up": vertical = amount; horizontal = 0
            case "down": vertical = -amount; horizontal = 0
            case "left": vertical = 0; horizontal = amount
            case "right": vertical = 0; horizontal = -amount
            default: throw RuntimeFailure("Unknown scroll direction.")
            }
            try mouse(.mouseMoved, p, receipt: receipt)
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0) else { throw RuntimeFailure("Failed to create scroll input.") }
            event.flags = []
            event.location = p
            event.setIntegerValueField(.eventSourceUserData, value: DesktopInputPolicy.marker)
            receipt.perform { event.post(tap: .cghidEventTap) }
        case "press_key":
            try monitor.validate(request)
            try assertForeground(window, keyboard: true)
            let (code, flags) = try keySpec(request.key ?? "")
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw RuntimeFailure("Failed to create key input.") }
            down.flags = flags; up.flags = flags
            down.setIntegerValueField(.eventSourceUserData, value: DesktopInputPolicy.marker)
            up.setIntegerValueField(.eventSourceUserData, value: DesktopInputPolicy.marker)
            receipt.perform { down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap) }
        case "type_text":
            for character in request.text ?? "" {
                try monitor.validate(request)
                try assertForeground(window, keyboard: true)
                let units = Array(String(character).utf16)
                guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { throw RuntimeFailure("Failed to create text input.") }
                // A remote session can leave Command held; text must not become shortcuts.
                down.flags = []; up.flags = []
                down.setIntegerValueField(.eventSourceUserData, value: DesktopInputPolicy.marker)
                up.setIntegerValueField(.eventSourceUserData, value: DesktopInputPolicy.marker)
                units.withUnsafeBufferPointer { buffer in
                    down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
                    up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
                }
                receipt.perform { down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap) }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
        case "set_value":
            guard let element else { throw RuntimeFailure("set_value requires an observed element.") }
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { throw RuntimeFailure("The observed element has no settable value.") }
            let typed = try request.accessibilityValue(isNumeric: attribute(element, kAXValueAttribute) is NSNumber)
            let result = receipt.perform { AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, typed) }
            guard result == .success else { throw RuntimeFailure("Setting value failed: \(result.rawValue)") }
        case "perform_secondary_action":
            guard let element, let requested = request.action else { throw RuntimeFailure("An observed element and advertised action are required.") }
            let action = requested == "Raise" ? kAXRaiseAction : requested
            guard actions(element).contains(action) else { throw RuntimeFailure("Action is not advertised by the current element.") }
            let result = receipt.perform { AXUIElementPerformAction(element, action as CFString) }
            guard result == .success else { throw RuntimeFailure("Accessibility action failed: \(result.rawValue)") }
        default: throw RuntimeFailure("Unsupported input tool: \(request.tool)")
        }
    }
}
