import Foundation
import CoreGraphics

@main
struct ContractTests {
    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw RuntimeFailure(message) }
    }
    static func rejects(_ work: () throws -> Void) throws {
        do { try work() } catch is RuntimeFailure { return }
        throw RuntimeFailure("Invalid input was accepted")
    }
    @MainActor static func main() async throws {
        var compactField = NativeElement(index: 18, runtimeId: [0, 2], automationId: "", name: "工作邮箱", controlType: "AXTextField", value: "", frame: nil, actions: [])
        try require(compactField.treeLine == "18 AXTextField \"工作邮箱\" value=\"\"", "Compact tree hid an empty writable value or changed its target")
        compactField.value = " 旧值\n保留 "; compactField.actions = ["AXPress"]
        try require(compactField.treeLine.contains(compactField.value.debugDescription) && compactField.treeLine.contains("AXPress"), "Compact tree altered draft text or actions")
        let source = [NativeFormEntity(label: "工作邮箱", value: "qa@example.test"), NativeFormEntity(label: "公司", value: " 海风测试 ")]
        let projectionBounds = WindowFrame(CGRect(x: 0, y: 0, width: 600, height: 400))
        let labelNode = NativeElement(index: 17, runtimeId: [0,1], automationId: "", name: "", controlType: "AXStaticText", value: "工作邮箱", frame: nil, actions: [])
        compactField.value = ""
        let observedProjection = [labelNode, compactField]
        let projection = NativeFormLabels(title: "Customer Form", fields: [NativeFormFieldLabel(element: compactField, label: "Email")], entities: ["Email", "Company"], observedElements: observedProjection, observedTitle: "客户表单", observedBounds: projectionBounds)
        try require(try validateFormLabels(projection, title: "客户表单", bounds: projectionBounds, elements: observedProjection, entities: source)[18] == "Email", "Projection lost the observed field")
        for position in observedProjection.indices {
            var changed = observedProjection; changed[position].value = "changed"
            try rejects { _ = try validateFormLabels(projection, title: "客户表单", bounds: projectionBounds, elements: changed, entities: source) }
        }
        try rejects { _ = try validateFormLabels(projection, title: "another window", bounds: projectionBounds, elements: observedProjection, entities: source) }
        try rejects { _ = try validateFormLabels(projection, title: "客户表单", bounds: nil, elements: observedProjection, entities: source) }
        var remapped = observedProjection; remapped[1].index = 118
        try require(try validateFormLabels(projection, title: "客户表单", bounds: projectionBounds, elements: remapped, entities: source)[118] == "Email", "Display index remapping changed native identity")
        let decoration = NativeElement(index: 60, runtimeId: [0,9], automationId: "", name: "", controlType: "AXGroup", value: "", frame: nil, actions: [])
        let decorated = observedProjection + [decoration]
        try require(try validateFormLabels(projection, title: "客户表单", bounds: projectionBounds, elements: decorated, entities: source)[18] == "Email", "Anonymous Safari decoration invalidated unchanged field context")
        var newLabel = decoration; newLabel.value = "账单邮箱"
        try rejects { _ = try validateFormLabels(projection, title: "客户表单", bounds: projectionBounds, elements: observedProjection + [newLabel], entities: source) }
        var newEmptyField = decoration; newEmptyField.controlType = "AXTextField"
        try rejects { _ = try validateFormLabels(projection, title: "客户表单", bounds: projectionBounds, elements: observedProjection + [newEmptyField], entities: source) }
        var rebound = observedProjection; rebound[1].runtimeId = [0,3]
        try rejects { _ = try validateFormLabels(projection, title: "客户表单", bounds: projectionBounds, elements: rebound, entities: source) }
        print("Form label projection: original labels, values, window bounds and native identity verified; stale evidence rejected.")
        try validateFormEntities(source)
        try require(source[1].value == " 海风测试 ", "Form source value changed")
        try rejects { try validateFormEntities([]) }
        try rejects { try validateFormEntities(Array(repeating: source[0], count: 30)) }
        try rejects { try validateFormEntities([NativeFormEntity(label: " ", value: "x")]) }
        try rejects { try validateFormEntities([NativeFormEntity(label: "Email", value: "")]) }
        let legacy = try JSONDecoder().decode(NativeRequest.self, from: Data(#"{"tool":"get_app_state"}"#.utf8))
        try require(legacy.formEntities == nil, "Legacy observations require forms")
        let formRequest = try JSONDecoder().decode(NativeRequest.self, from: Data(#"{"tool":"get_app_state","formEntities":[{"label":"工作邮箱","value":"qa@example.test"}]}"#.utf8))
        try validateFormEntities(formRequest.formEntities!)
        let inactiveMonitor = NativeInputMonitor()
        let observation = try JSONDecoder().decode(NativeRequest.self, from: Data(#"{"tool":"get_app_state","app":"foreground"}"#.utf8))
        let observationReady = try await inactiveMonitor.prepare(observation)
        try require(observationReady, "Screen-only observation was blocked by an unavailable input monitor")
        let unmonitoredInput = try JSONDecoder().decode(NativeRequest.self, from: Data(#"{"tool":"press_key","key":"a"}"#.utf8))
        do {
            _ = try await inactiveMonitor.prepare(unmonitoredInput)
            throw NSError(domain: "UncheckedInput", code: 1)
        } catch is RuntimeFailure { }
        try require(!DesktopInputPolicy.conflicts(.mouseMoved, marker: 0), "Pure mouse movement invalidated input")
        for type: CGEventType in [.keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel, .leftMouseDragged] {
            try require(DesktopInputPolicy.conflicts(type, marker: 0), "User input was ignored")
            try require(!DesktopInputPolicy.conflicts(type, marker: DesktopInputPolicy.marker), "Own input caused conflicts")
        }
        try require(DesktopInputPolicy.escape(.keyDown, key: 53, marker: 0, flags: []), "Human Esc ignored")
        try require(!DesktopInputPolicy.escape(.keyDown, key: 53, marker: DesktopInputPolicy.marker, flags: []), "Own Esc interrupted control")
        try require(!DesktopInputPolicy.escape(.keyDown, key: 53, marker: 0, flags: .maskCommand), "Modified Esc interrupted control")
        let leaseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: leaseDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: leaseDirectory) }
        let leaseFile = leaseDirectory.appendingPathComponent("lease.json")
        try "current".write(to: leaseFile, atomically: true, encoding: .utf8)
        try DesktopInputPolicy.validateLease(directory: leaseDirectory.path, identity: "current")
        try rejects { try DesktopInputPolicy.validateLease(directory: leaseDirectory.path, identity: "old") }
        try Data().write(to: leaseDirectory.appendingPathComponent("paused"))
        try rejects { try DesktopInputPolicy.validateLease(directory: leaseDirectory.path, identity: "current") }
        print("Desktop control: pure movement, own injection, Esc classification and revoked leases passed.")
        var requested: [String] = []
        try require(!enableTargetAccessibility(read: { _ in nil }, enable: { _ in false }), "Unsupported app capabilities reported enabled")
        try require(!enableTargetAccessibility(read: { _ in true }, enable: { requested.append($0); return true }), "Existing enabled accessibility was toggled")
        try require(requested.isEmpty, "Existing enabled accessibility was written again")
        try require(enableTargetAccessibility(read: { _ in nil }, enable: { requested.append($0); return $0 == "AXManualAccessibility" }), "Electron write-only accessibility was not initialized")
        try require(requested == ["AXManualAccessibility", "AXEnhancedUserInterface"], "Accessibility initialization escaped known target attributes")
        try require(!enableTargetAccessibility(read: { _ in false }, enable: { _ in false }), "Failed attribute writes reported enabled accessibility")
        print("Target accessibility: optional capabilities, existing grants and failed writes preserved.")
        let input = InputDispatchReceipt()
        for role in ["AXTextField", "AXTextArea", "AXComboBox"] {
            try rejects {
                try validateValueWriteFocus(role: role, inWebContent: true, matchesFocusedElement: false)
                input.perform { fatalError("An unfocused text write reached dispatch") }
            }
            try require(!input.dispatched, "An unfocused field write was dispatched")
            try validateValueWriteFocus(role: role, inWebContent: true, matchesFocusedElement: true)
            try validateValueWriteFocus(role: role, inWebContent: false, matchesFocusedElement: false)
        }
        try validateValueWriteFocus(role: "AXSlider", inWebContent: true, matchesFocusedElement: false)
        print("Value-write focus: unfocused web text rejected before dispatch; focused web fields, native PDF annotations and numeric controls accepted.")
        for failure in ["none", "focus", "lease", "identity", "foreground", "actual-focus"] {
            var phases: [String] = []
            var focused = false, wrote = false
            do {
                try await performVerifiedValueWrite(focus: {
                    phases.append("focus")
                    if failure == "focus" { throw RuntimeFailure("AX focus rejected") }
                    focused = true
                }, validate: {
                    phases.append("validate")
                    if focused && ["lease", "identity", "foreground"].contains(failure) { throw RuntimeFailure(failure) }
                }, verifyFocus: {
                    phases.append("verify")
                    if failure == "actual-focus" { throw RuntimeFailure("focus moved to popup") }
                }, write: { phases.append("write"); wrote = true })
                try require(failure == "none", "Invalid focused write succeeded: \(failure)")
            } catch is RuntimeFailure {
                try require(failure != "none", "Valid focused write rejected")
            }
            try require(wrote == (failure == "none"), "Focus-stage failure wrote a value: \(failure)")
            if wrote { try require(phases == ["validate", "focus", "validate", "verify", "write"], "Missing focus revalidation") }
        }
        var legacyPhases: [String] = []
        try await performVerifiedValueWrite(focus: nil, validate: { legacyPhases.append("validate") },
            verifyFocus: { legacyPhases.append("verify") }, write: { legacyPhases.append("write") })
        try require(legacyPhases == ["validate", "verify", "write"], "Legacy write acquired focus")
        print("Focused write: unsupported focus, revoked lease, changed identity/window and wrong actual focus all prevent writing; legacy behavior preserved.")
        try rejects { throw RuntimeFailure("Foreground window changed") }
        try require(!input.dispatched, "Preflight failure was reported as input")
        try require(input.failureDescription(RuntimeFailure("Covered point")).contains("No requested input was dispatched"), "Known non-dispatch reported as uncertain")
        try rejects { try input.perform { throw RuntimeFailure("Native operation failed after dispatch") } }
        try require(input.dispatched && input.failureDescription(RuntimeFailure("After-state unavailable")).contains("Input may have occurred"), "Partial dispatch lost its uncertainty")
        print("Input receipt: preflight and uncertain native dispatch distinguished.")
        try require(confirmedForegroundPID(accessibilityPID: 54081, workspacePID: -1) == 54081,
            "Installed helper rejected the actual focused app when AppKit returned an invalid PID")
        try require(confirmedForegroundPID(accessibilityPID: 54081, workspacePID: nil) == 54081,
            "Missing AppKit metadata rejected a confirmed system-wide focus")
        try require(confirmedForegroundPID(accessibilityPID: 54081, workspacePID: 54081) == 54081,
            "Agreeing focus identities rejected")
        try require(confirmedForegroundPID(accessibilityPID: 54081, workspacePID: 76) == nil,
            "Conflicting foreground identities accepted")
        try require(confirmedForegroundPID(accessibilityPID: 619, workspacePID: 60503,
            focusedElementPID: 619, hasFocusedWindow: true) == 619,
            "Verified keyboard focus in a nonactivating system panel was lost")
        try require(confirmedForegroundPID(accessibilityPID: 619, workspacePID: 60503,
            focusedElementPID: 60503, hasFocusedWindow: true) == nil,
            "An unrelated focused element resolved conflicting foreground identities")
        try require(confirmedForegroundPID(accessibilityPID: 619, workspacePID: 60503,
            focusedElementPID: 619, hasFocusedWindow: false) == nil,
            "A disappeared panel resolved conflicting foreground identities")
        for invalid in [nil, -1, 0] as [pid_t?] {
            try require(confirmedForegroundPID(accessibilityPID: invalid, workspacePID: 54081) == 54081,
                "Valid AppKit focus lost when system-wide AX is unavailable")
        }
        try require(confirmedForegroundPID(accessibilityPID: nil, workspacePID: -1) == nil,
            "Two unavailable authorities must not guess a foreground app")
        print("Foreground identity: installed helper invalid AppKit PID and fail-closed conflicts passed.")
        let mainWindow = NativeWindow(id: 575, pid: 76632, name: "WeChat", bundle: "com.tencent.xinWeChat", title: "微信", bounds: WindowFrame(CGRect(x: 273, y: 156, width: 880, height: 640)))
        let popover = NativeWindow(id: 772, pid: 76632, name: "WeChat", bundle: "com.tencent.xinWeChat", title: "", bounds: WindowFrame(CGRect(x: 321, y: 191, width: 368, height: 96)))
        try validateMouseHit(575, target: mainWindow)
        try rejects { try validateMouseHit(772, target: mainWindow) }
        try rejects { try validateMouseHit(0, target: mainWindow) }
        try rejects { try validateMouseHit(-1, target: mainWindow) }
        try validateMouseHit(772, target: popover)
        try require(appKitHitPoint(CGPoint(x: 434, y: 261), primaryDisplayTop: 956) == CGPoint(x: 434, y: 695), "Primary display hit-test coordinates inverted incorrectly")
        try require(appKitHitPoint(CGPoint(x: -400, y: -200), primaryDisplayTop: 956) == CGPoint(x: -400, y: 1156), "Secondary display coordinates were clamped or flipped against the wrong display")
        try require(appKitHitPoint(CGPoint(x: 1600, y: 1200), primaryDisplayTop: 956) == CGPoint(x: 1600, y: -244), "Lower secondary display coordinates were clamped")
        print("Mouse hit-test contract: exact window, real overlay, unknown recipient and multi-display coordinates passed.")
        try require(matchFocusedWindow([popover, mainWindow], pid: 76632, frame: mainWindow.bounds, title: "微信")?.id == 575, "Search popover stole keyboard focus solely due to stacking order")
        try require(matchFocusedWindow([popover, mainWindow], pid: 76632, frame: popover.bounds, title: "")?.id == 772, "A genuinely focused popup was ignored")
        try require(matchFocusedWindow([mainWindow, mainWindow], pid: 76632, frame: mainWindow.bounds, title: "微信") == nil, "Ambiguous focus identity was accepted")
        try require(matchFocusedWindow([mainWindow], pid: 123, frame: mainWindow.bounds, title: "微信") == nil, "Focus crossed process identity")
        let pdfWindow = NativeWindow(id: 1107, pid: 95721, name: "预览", bundle: "com.apple.Preview",
            title: "haifeng-form.pdf", bounds: WindowFrame(CGRect(x: -13, y: 86, width: 1091, height: 797)))
        try require(matchFocusedWindow([pdfWindow], pid: 95721, frame: pdfWindow.bounds,
            title: "haifeng-form.pdf – 1页")?.id == 1107, "Preview AX page-count metadata hid the real window")
        let overlappingPDF = NativeWindow(id: 1108, pid: 95721, name: "预览", bundle: "com.apple.Preview",
            title: "other.pdf", bounds: pdfWindow.bounds)
        try require(matchFocusedWindow([pdfWindow, overlappingPDF], pid: 95721, frame: pdfWindow.bounds,
            title: "haifeng-form.pdf – 1页") == nil, "Title mismatch guessed between overlapping windows")
        try require(matchFocusedWindow([pdfWindow], pid: 95721,
            frame: WindowFrame(CGRect(x: -13, y: 86, width: 1091, height: 798)), title: pdfWindow.title) == nil,
            "Matching title bypassed changed geometry")
        let trackingSurface = NativeWindow(id: 70, pid: 39855, name: "Compositor", bundle: "", title: "",
            bounds: WindowFrame(CGRect(x: 0, y: 0, width: 1470, height: 956)))
        try require(matchFocusedWindow([trackingSurface, mainWindow], pid: mainWindow.pid,
            frame: mainWindow.bounds, title: mainWindow.title)?.id == mainWindow.id,
            "A full-display tracking surface replaced the system-wide AX hit window")
        try require(matchFocusedWindow([trackingSurface, mainWindow], pid: trackingSurface.pid,
            frame: trackingSurface.bounds, title: "")?.id != mainWindow.id,
            "A real hit on another process was accepted as the intended window")
        print("Focus contract: nonactivating popover, focused dialog, ambiguity and process isolation passed.")
        var granted = true
        var prompts = 0
        try require(requestMissingPermission(check: { granted }, request: { prompts += 1 }), "Existing grant rejected")
        try require(prompts == 0, "Already granted permission prompted again")
        granted = false
        try require(!requestMissingPermission(check: { granted }, request: { prompts += 1 }), "A prompt was treated as a grant")
        try require(prompts == 1, "Missing permission did not request authorization")
        try require(requestMissingPermission(check: { granted }, request: { prompts += 1; granted = true }), "New OS grant was not rechecked")
        let mounted = URL(fileURLWithPath: "/Volumes/CodeBuddy/CodeBuddy.app/Contents/Resources/bin/qwen-computer-runtime")
        let current = PermissionApplication.locate(executable: mounted, bundleInfo: { url in
            url.path == "/Volumes/CodeBuddy/CodeBuddy.app" ? ["CFBundleName": "CodeBuddy", "CFBundleIdentifier": "local.codebuddy.desktop"] : nil
        })
        try require(current.identifier == "local.codebuddy.desktop" && current.path == "/Volumes/CodeBuddy/CodeBuddy.app", "Permission guidance used the wrong application identity")
        try require(current.denied("Screen Recording").contains(current.path), "Permission failure omitted the exact application path")
        let standalone = PermissionApplication.locate(executable: URL(fileURLWithPath: "/tmp/qwen-computer-runtime"), bundleInfo: { _ in nil })
        try require(standalone.path == "/tmp/qwen-computer-runtime" && standalone.identifier == "standalone helper", "Standalone helper impersonated an installed application")
        try require(!standalone.isApplicationBundle && current.isApplicationBundle, "Bundle identity was confused with a standalone executable")
        let standaloneDenial = standalone.denied("Screen Recording")
        try require(standaloneDenial.contains("launcher, such as Terminal") && standaloneDenial.contains("TCC diagnostic attribution"), "Development permission denial omitted responsible-launcher guidance")
        try require(!standaloneDenial.contains("Select this exact application"), "Standalone helper was incorrectly claimed to own TCC permission")
        try require(current.denied("Accessibility").contains("does not establish the responsible application"), "Containing bundle was incorrectly treated as authoritative TCC attribution")
        let session: [String: Any] = [kCGSessionOnConsoleKey as String: true,
            kCGSessionLoginDoneKey as String: true, kCGSessionUserIDKey as String: NSNumber(value: 501)]
        func diagnostic(_ value: [String: Any]?, ax: Bool = true, screen: Bool = true) -> DesktopEnvironmentDiagnostic {
            DesktopEnvironmentDiagnostic(session: value, userID: 501, accessibility: ax, screenRecording: screen)
        }
        let ready = diagnostic(session)
        try require(ready.desktopAvailable && ready.permissionAvailable && ready.lockSignal == "notReported", "Ready desktop rejected or missing lock signal misrepresented")
        try require(!diagnostic(nil).desktopAvailable, "Missing Quartz session accepted")
        for (key, value) in [(kCGSessionOnConsoleKey as String, false as Any),
            (kCGSessionLoginDoneKey as String, false as Any),
            (kCGSessionUserIDKey as String, NSNumber(value: 502) as Any),
            ("CGSSessionScreenIsLocked", true as Any),
            ("CGSSessionScreenIsLocked", "invalid" as Any)] {
            var altered = session; altered[key] = value
            try require(!diagnostic(altered).desktopAvailable, "Unavailable session accepted: \(key)")
        }
        try require(!diagnostic(session, ax: false).permissionAvailable, "Missing AX permission accepted")
        try require(!diagnostic(session, screen: false).permissionAvailable, "Missing screen permission accepted")
        print("Desktop environment contract: 9 checks passed; no desktop input or permission request.")
        let data = Data(#"{"tool":"click","app":"window:71:902","expectedPid":71,"expectedWindow":902,"windowBounds":{"x":-500,"y":30,"width":640,"height":480},"element":{"index":4,"runtimeId":[0,2],"controlType":"AXButton"}}"#.utf8)
        let request = try JSONDecoder().decode(NativeRequest.self, from: data)
        let bounds = WindowFrame(CGRect(x: -500, y: 30, width: 640, height: 480))
        try request.validateBinding(pid: 71, window: 902, bounds: bounds)
        try require(request.element?.name == "" && request.element?.actions == [], "Go omitted fields did not decode")
        try require(bounds.globalPoint(x: 20, y: 40) == CGPoint(x: -480, y: 70), "Secondary display coordinate conversion changed")
        try rejects { _ = try bounds.globalPoint(x: -1, y: 0) }
        try rejects { _ = try bounds.globalPoint(x: 640, y: 0) }
        try rejects { _ = try bounds.globalPoint(x: .nan, y: 0) }
        try rejects { try request.validateBinding(pid: 72, window: 902, bounds: bounds) }
        try rejects { try request.validateBinding(pid: 71, window: 903, bounds: bounds) }
        try rejects { try request.validateBinding(pid: 71, window: 902, bounds: WindowFrame(CGRect(x: 0, y: 30, width: 640, height: 480))) }
        let unbound = try JSONDecoder().decode(NativeRequest.self, from: Data(#"{"tool":"type_text","text":"中文🙂"}"#.utf8))
        try rejects { try unbound.validateBinding(pid: 71, window: 902, bounds: bounds) }
        var changed = request.element!
        changed.name = "different recipient"
        try require(!request.element!.matches(changed), "Recycled element identity was accepted")
        let chord = try keySpec("Control_L+Shift_R+Return")
        try require(chord.0 == 36 && chord.1 == [.maskControl, .maskShift], "X11 modifier aliases differ from Windows")
        let command = try keySpec("Super_L+c")
        try require(command.0 == 8 && command.1 == .maskCommand, "Super must map to macOS Command")
        let plus = try keySpec("plus")
        let keypad = try keySpec("Numpad_Add")
        try require(plus.0 == 24 && plus.1 == .maskShift, "Main keyboard plus requires Shift")
        try require(keypad.0 == 69 && keypad.1.isEmpty, "Keypad plus must remain distinct")
        try rejects { _ = try keySpec("typo+a") }
        try rejects { _ = try keySpec("ctrl++a") }
        try rejects { _ = try keySpec("") }
        // The empty request is exactly the JSON produced by Go psRequest.Value omitempty.
        func valueRequest(_ value: String?) throws -> NativeRequest {
            var object: [String: Any] = ["tool": "set_value", "element": ["index": 4, "runtimeId": [0, 2]]]
            if let value { object["value"] = value }
            return try JSONDecoder().decode(NativeRequest.self, from: JSONSerialization.data(withJSONObject: object))
        }
        let clear = try valueRequest(nil)
        try require(clear.accessibilityValue(isNumeric: false) == NSString(string: ""), "Go omitted empty text must clear the control")
        try require(valueRequest("").accessibilityValue(isNumeric: false) == NSString(string: ""), "Explicit empty text must clear the control")
        try require(valueRequest("中文🙂\n ").accessibilityValue(isNumeric: false) == NSString(string: "中文🙂\n "), "Text value must preserve Unicode and whitespace")
        try require(valueRequest("12.5").accessibilityValue(isNumeric: true) == NSNumber(value: 12.5), "Numeric control value changed")
        try require(valueRequest("0").accessibilityValue(isNumeric: true) == NSNumber(value: 0), "Numeric zero rejected")
        for value in [nil, "", "abc", "nan", "inf", "1e999"] as [String?] {
            try rejects { _ = try valueRequest(value).accessibilityValue(isNumeric: true) }
        }
        print("set_value contract: 11 checks passed (omitted/explicit empty, Unicode, numeric values and invalid-number rejection).")
        print("Native contract checks passed: omitted fields, Unicode, coordinates, process/window/geometry element binding, and keyboard aliases.")
    }
}
