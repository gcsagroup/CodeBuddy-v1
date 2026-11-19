import Foundation
import CoreGraphics

struct RuntimeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

// Only the native input boundary owns this fact; activation/preflight is not input.
final class InputDispatchReceipt {
    private(set) var dispatched = false

    func perform<T>(_ operation: () throws -> T) rethrows -> T {
        dispatched = true
        return try operation()
    }

    func failureDescription(_ error: Error, scopedWindow: Bool = false) -> String {
        if scopedWindow && !dispatched {
            return "\(error) No requested input was dispatched. Keep the original window title. If it remains unavailable after one refresh, report that result and continue independent work."
        }
        return "\(error)" + (dispatched
            ? " Input may have occurred. Observe before retrying; do not replay an uncertain action."
            : " No requested input was dispatched. Observe get_app_state(app=foreground) and use that window's current observation before retrying.")
    }
}

struct NativeWindow {
    let id: CGWindowID
    let pid: pid_t
    let name: String
    let bundle: String
    let title: String
    let bounds: WindowFrame
    var selector: String { "window:\(pid):\(id)" }
}

func validateValueWriteFocus(role: String, inWebContent: Bool, matchesFocusedElement: Bool) throws {
    // WebKit can apply AXValue to the focused editor instead of the addressed
    // text element. Refuse before dispatch rather than repairing another field.
    // Native PDF annotations need not be the app's focused editor to accept
    // AXValue. Limit this additional requirement to web accessibility content.
    if inWebContent && ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) && !matchesFocusedElement {
        throw RuntimeFailure("The requested web text field is not the verified focused element. Click that field, inspect the returned focus, then set its value.")
    }
}

// Focus can run application handlers. Revalidate the observation and lease after
// it yields, before checking the actual focus or dispatching the value change.
@MainActor
func performVerifiedValueWrite(focus: (() async throws -> Void)?, validate: () throws -> Void,
                               verifyFocus: () throws -> Void, write: () throws -> Void) async throws {
    try validate()
    if let focus {
        try await focus()
        try validate()
    }
    try verifyFocus()
    try write()
}

// Quartz uses top-left desktop coordinates; AppKit mouse hit-testing uses
// bottom-left coordinates relative to the primary display, even on other screens.
func appKitHitPoint(_ quartzPoint: CGPoint, primaryDisplayTop: Double) -> CGPoint {
    CGPoint(x: quartzPoint.x, y: primaryDisplayTop - quartzPoint.y)
}

func validateMouseHit(_ windowNumber: Int, target: NativeWindow) throws {
    guard windowNumber > 0 else {
        throw RuntimeFailure("The system could not identify a mouse target at this point; re-observe.")
    }
    guard windowNumber == Int(target.id) else {
        throw RuntimeFailure("Another window receives mouse input at this point (window \(windowNumber)); re-observe.")
    }
}


func confirmedForegroundPID(accessibilityPID: pid_t?, workspacePID: pid_t?, focusedElementPID: pid_t? = nil, hasFocusedWindow: Bool = false) -> pid_t? {
    // AppKit is the independent OS foreground authority when system-wide AX
    // returns cannotComplete, even though per-app AX and permission are valid.
    guard let focused = accessibilityPID, focused > 0 else {
        return workspacePID.flatMap { $0 > 0 ? $0 : nil }
    }
    if let workspacePID, workspacePID > 0, workspacePID != focused {
        // Nonactivating system panels can receive keyboard focus while AppKit
        // still names the underlying app. Require corroborating AX and CG facts.
        return focusedElementPID == focused && hasFocusedWindow ? focused : nil
    }
    return focused
}

// Window stacking and keyboard focus differ when an app shows a nonactivating popover.
func matchFocusedWindow(_ candidates: [NativeWindow], pid: pid_t, frame: WindowFrame, title: String) -> NativeWindow? {
    let geometryMatches = candidates.filter { $0.pid == pid && $0.bounds.matches(frame) }
    let titleMatches = geometryMatches.filter { $0.title == title }
    if titleMatches.count == 1 { return titleMatches.first }
    // AX may append document metadata (Preview adds its page count) that CG
    // does not expose. Only a unique same-process geometry can bridge that gap.
    return geometryMatches.count == 1 ? geometryMatches.first : nil
}

struct WindowFrame: Codable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    init(_ rect: CGRect) {
        x = rect.minX; y = rect.minY; width = rect.width; height = rect.height
    }
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    func matches(_ other: WindowFrame) -> Bool {
        zip([x, y, width, height], [other.x, other.y, other.width, other.height])
            .allSatisfy { pair in abs(pair.0 - pair.1) < 0.5 }
    }
    func globalPoint(x localX: Double?, y localY: Double?) throws -> CGPoint {
        guard let localX, let localY, localX.isFinite, localY.isFinite,
              localX >= 0, localY >= 0, localX < width, localY < height else {
            throw RuntimeFailure("Coordinates must be inside the observed screenshot.")
        }
        return CGPoint(x: x + localX, y: y + localY)
    }
}

struct NativeElement: Codable {
    var index: Int
    var runtimeId: [Int]
    var automationId: String
    var name: String
    var controlType: String
    var value: String
    var frame: WindowFrame?
    var actions: [String]

    var treeLine: String {
        // Keep every index and all nonempty evidence, without repeating empty
        // properties on the many structural nodes in PDF accessibility trees.
        var parts = ["\(index)", controlType]
        if !name.isEmpty { parts.append(name.debugDescription) }
        if !value.isEmpty || ["AXTextField", "AXTextArea", "AXComboBox"].contains(controlType) {
            parts.append("value=\(value.debugDescription)")
        }
        if !actions.isEmpty { parts.append("actions=\(actions)") }
        return parts.joined(separator: " ")
    }

    func matches(_ current: NativeElement) -> Bool {
        runtimeId == current.runtimeId && automationId == current.automationId
            && name == current.name && controlType == current.controlType
            && value == current.value && frame == current.frame
    }
}

struct NativeFormEntity: Decodable {
    let label: String
    let value: String
}

struct NativeFormFieldLabel: Decodable {
    let element: NativeElement
    let label: String
}

struct NativeFormLabels: Decodable {
    let title: String?
    let fields: [NativeFormFieldLabel]
    let entities: [String]
    let observedElements: [NativeElement]
    let observedTitle: String
    let observedBounds: WindowFrame
}

func validateFormLabels(_ labels: NativeFormLabels, title: String, bounds: WindowFrame?, elements: [NativeElement], entities: [NativeFormEntity]) throws -> [Int: String] {
    func valid(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespaces).isEmpty && text.utf8.count <= 64 && text.utf8.allSatisfy { $0 >= 32 && $0 <= 126 }
    }
    // Safari adds/removes anonymous decoration groups between otherwise identical
    // observations. They carry no translation context. Keep every named/value node
    // and editable field, including unlabelled/empty fields; native paths, geometry
    // and old values of those nodes still have to match exactly.
    func context(_ nodes: [NativeElement]) -> [NativeElement] {
        nodes.filter { !$0.name.isEmpty || !$0.value.isEmpty ||
            ["AXTextField", "AXTextArea", "AXComboBox"].contains($0.controlType) }
    }
    let before = context(labels.observedElements), current = context(elements)
    guard labels.observedTitle == title, bounds?.matches(labels.observedBounds) == true,
          !elements.isEmpty, before.count == current.count,
          zip(before, current).allSatisfy({ pair in pair.0.matches(pair.1) }) else {
        throw RuntimeFailure("Form label projection expired: window, labels, controls or values changed. Use the fresh observation to translate again; no projected scoring occurred.")
    }
    guard labels.entities.count == entities.count, !entities.isEmpty,
          labels.entities.allSatisfy(valid), labels.title.map(valid) ?? true,
          Set(labels.entities.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }).count == labels.entities.count,
          labels.fields.count <= 400 else {
        throw RuntimeFailure("Invalid or ambiguous English scoring labels. Original observation remains usable.")
    }
    var result: [Int: String] = [:]
    for projected in labels.fields {
        let matches = elements.filter { projected.element.matches($0) }
        guard valid(projected.label), matches.count == 1, let element = matches.first,
              ["AXTextField", "AXTextArea", "AXComboBox"].contains(element.controlType), result[element.index] == nil else {
            throw RuntimeFailure("Projected field no longer identifies one observed editable control. Observe again.")
        }
        result[element.index] = projected.label
    }
    return result
}

func validateFormEntities(_ entities: [NativeFormEntity]) throws {
    // The model has 32 options, including check, click and skip.
    guard !entities.isEmpty, entities.count <= 29,
          entities.allSatisfy({ !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              && !$0.value.isEmpty && $0.label.utf8.count <= 4096 && $0.value.utf8.count <= 16384 }) else {
        throw RuntimeFailure("form_entities requires 1–29 labeled, nonempty values; label limit 4096 UTF-8 bytes, value limit 16384 bytes.")
    }
}

struct NativeRequest: Decodable {
	var focus: Bool?
    var formLabels: NativeFormLabels?
    var formEntities: [NativeFormEntity]?
    var windowTitle: String?
    var controlDirectory: String?
    var controlIdentity: String?
    var inputVersion: String?
    var tool: String
    var app: String?
    var expectedWindow: UInt32?
    var expectedPid: Int32?
    var windowBounds: WindowFrame?
    var element: NativeElement?
    var x: Double?
    var y: Double?
    var from_x: Double?
    var from_y: Double?
    var to_x: Double?
    var to_y: Double?
    var click_count: Int?
    var mouse_button: String?
    var direction: String?
    var pages: Double?
    var text: String?
    var key: String?
    var value: String?
    var action: String?

    // Go's established omitempty wire format omits value when clearing text.
    // Numeric controls still require a finite number; empty is not zero.
    func accessibilityValue(isNumeric: Bool) throws -> NSObject {
        let text = value ?? ""
        if isNumeric {
            guard let number = Double(text), number.isFinite else {
                throw RuntimeFailure("This control requires a finite numeric value.")
            }
            return NSNumber(value: number)
        }
        return text as NSString
    }

    var requiresKeyboardFocus: Bool { tool == "press_key" || tool == "type_text" }

    var isInput: Bool { tool != "get_app_state" && tool != "list_apps" && tool != "doctor" }
    func validateBinding(pid: Int32, window: UInt32, bounds: WindowFrame) throws {
        if let expectedPid, expectedPid != pid { throw RuntimeFailure("Window owner changed; re-observe.") }
        if let expectedWindow, expectedWindow != window { throw RuntimeFailure("Window identity changed; re-observe.") }
        if isInput {
            guard expectedPid == pid, expectedWindow == window, let windowBounds,
                  windowBounds.matches(bounds) else {
                throw RuntimeFailure("Input requires the current observed window and unchanged bounds.")
            }
        }
    }
}

struct DesktopInputConflict: Error, CustomStringConvertible {
    var description: String { "Desktop input changed since observation. Inspect a fresh observation before deciding the next action; do not replay uncertain input." }
}

// Native input facts only. The host owns consecutive-conflict policy and queues.
enum DesktopInputPolicy {
    static let marker: Int64 = 0x43424459494E5054
    static func conflicts(_ type: CGEventType, marker: Int64) -> Bool {
        guard marker != self.marker else { return false }
        return [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .keyDown,
                .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type)
    }
    static func escape(_ type: CGEventType, key: Int64, marker: Int64, flags: CGEventFlags) -> Bool {
        type == .keyDown && key == 53 && marker != self.marker
            && flags.intersection([.maskShift, .maskControl, .maskAlternate, .maskCommand]).isEmpty
    }
    static func validateLease(directory: String?, identity: String?) throws {
        guard let directory, !directory.isEmpty else { return }
        guard let identity, !identity.isEmpty,
              !FileManager.default.fileExists(atPath: directory + "/paused"),
              let current = try? String(contentsOfFile: directory + "/lease.json", encoding: .utf8),
              current == identity else {
            throw RuntimeFailure("Desktop control was released. Do not retry desktop tools in this turn; continue other work that does not use the desktop.")
        }
    }
}

// Go omits empty optional properties; preserve that wire contract on macOS.
extension NativeElement {
    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        index = try fields.decode(Int.self, forKey: .index)
        runtimeId = try fields.decode([Int].self, forKey: .runtimeId)
        automationId = try fields.decodeIfPresent(String.self, forKey: .automationId) ?? ""
        name = try fields.decodeIfPresent(String.self, forKey: .name) ?? ""
        controlType = try fields.decodeIfPresent(String.self, forKey: .controlType) ?? ""
        value = try fields.decodeIfPresent(String.self, forKey: .value) ?? ""
        frame = try fields.decodeIfPresent(WindowFrame.self, forKey: .frame)
        actions = try fields.decodeIfPresent([String].self, forKey: .actions) ?? []
    }
}

func keySpec(_ chord: String) throws -> (CGKeyCode, CGEventFlags) {
    let parts = chord.lowercased().split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    guard let last = parts.last, !parts.contains("") else { throw RuntimeFailure("Empty key in chord.") }
    let key = last.hasPrefix("numpad_") ? "kp_" + last.dropFirst(7) : last
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier {
        case "cmd", "command", "super", "win", "meta", "super_l", "super_r": flags.insert(.maskCommand)
        case "ctrl", "control", "control_l", "control_r": flags.insert(.maskControl)
        case "alt", "option", "alt_l", "alt_r": flags.insert(.maskAlternate)
        case "shift", "shift_l", "shift_r": flags.insert(.maskShift)
        default: throw RuntimeFailure("Unknown key modifier: \(modifier)")
        }
    }
    let codes: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"equal":24,"9":25,"7":26,"minus":27,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"enter":36,"return":36,"l":37,"j":38,"k":40,"n":45,"m":46,"tab":48,"space":49,"backspace":51,"escape":53,"esc":53,"home":115,"pageup":116,"delete":117,"end":119,"pagedown":121,"left":123,"right":124,"down":125,"up":126,"f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111]
    let additional: [String: CGKeyCode] = ["bracketright":30,"bracketleft":33,"apostrophe":39,"semicolon":41,"backslash":42,"comma":43,"slash":44,"period":47,"grave":50,"kp_decimal":65,"kp_multiply":67,"kp_add":69,"kp_divide":75,"kp_enter":76,"kp_subtract":78,"kp_equal":81,"kp_0":82,"kp_1":83,"kp_2":84,"kp_3":85,"kp_4":86,"kp_5":87,"kp_6":88,"kp_7":89,"kp_8":91,"kp_9":92,"f13":105,"f14":107,"f15":113,"f16":106,"f17":64,"f18":79,"f19":80,"f20":90,"page_up":116,"page_down":121]
    let shifted: [String: CGKeyCode] = ["plus":24,"underscore":27,"colon":41,"quotedbl":39,"question":44,"greater":47,"less":43,"asciitilde":50,"braceleft":33,"braceright":30,"bar":42,"exclam":18,"at":19,"numbersign":20,"dollar":21,"percent":23,"asciicircum":22,"ampersand":26,"asterisk":28,"parenleft":25,"parenright":29]
    guard let code = codes[key] ?? additional[key] ?? shifted[key] else { throw RuntimeFailure("Unsupported key; use type_text for text, or a named special key.") }
    if shifted[key] != nil { flags.insert(.maskShift) }
    return (code, flags)
}

// Requesting access is not itself a grant. Always recheck OS state afterwards.
func requestMissingPermission(check: () -> Bool, request: () -> Void) -> Bool {
    if check() { return true }
    request()
    return check()
}

// Rendering an accessibility tree is optional app functionality, not a TCC grant.
// Some Electron versions accept the setter without exposing a getter. Unsupported
// setters fail harmlessly; preserve a known enabled state and trust only success.
func enableTargetAccessibility(read: (String) -> Bool?, enable: (String) -> Bool) -> Bool {
    var changed = false
    for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
        guard read(name) != true else { continue }
        if enable(name) { changed = true }
    }
    return changed
}

struct PermissionApplication {
    let name: String
    let identifier: String
    let path: String
    let isApplicationBundle: Bool

    static func locate(executable: URL, bundleInfo: (URL) -> [String: Any]?) -> PermissionApplication {
        var directory = executable.deletingLastPathComponent()
        while directory.path != "/" {
            if directory.pathExtension == "app", let info = bundleInfo(directory) {
                return PermissionApplication(
                    name: info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String ?? directory.deletingPathExtension().lastPathComponent,
                    identifier: info["CFBundleIdentifier"] as? String ?? "unknown",
                    path: directory.path, isApplicationBundle: true)
            }
            directory.deleteLastPathComponent()
        }
        return PermissionApplication(name: executable.lastPathComponent, identifier: "standalone helper", path: executable.path, isApplicationBundle: false)
    }

    func denied(_ permission: String) -> String {
        // A containing bundle identifies our executable, not necessarily TCC's
        // responsible process. Development launch chains may belong to Terminal.
        let identity = isApplicationBundle
            ? "Containing application: \(name) (\(identifier)); path: \(path). For normal installed launches, check this application; if launched from an installer volume, quit it and launch the installed copy first."
            : "Standalone executable: \(path). This file is not an application bundle. In development, macOS can attribute permission to the launcher, such as Terminal, rather than this helper."
        return "macOS denied \(permission) access for the current process. \(identity) The executable path alone does not establish the responsible application. Check the application identified by the macOS permission prompt or TCC diagnostic attribution in System Settings > Privacy & Security > \(permission). Authorize the actual responsible application and reopen it if macOS requests a restart. An enabled switch does not prove access for this process; verify the launch identity before changing entries. If the confirmed responsible application's grant still fails after restart, investigate its signing identity and an older code signature before suggesting removal of its entry. Do not repeatedly toggle permissions or add this helper solely because its path appears here. Preserve other applications' permissions. No desktop input was dispatched."
    }
}

// Read-only prerequisites; does not grant input permission or prove acceptance.
struct DesktopEnvironmentDiagnostic {
    let onConsole: Bool
    let loginDone: Bool
    let sameUser: Bool
    let lockSignal: String
    let accessibility: Bool
    let screenRecording: Bool

    init(session: [String: Any]?, userID: UInt32, accessibility: Bool, screenRecording: Bool) {
        onConsole = session?[kCGSessionOnConsoleKey as String] as? Bool == true
        loginDone = session?[kCGSessionLoginDoneKey as String] as? Bool == true
        sameUser = (session?[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == userID
        // This additional OS signal is used by Chromium, but is not a public
        // CoreGraphics constant. Absence is reported, never called "unlocked".
        // Public session prerequisites and per-action target checks still apply.
        if let raw = session?["CGSSessionScreenIsLocked"] {
            if let locked = raw as? Bool { lockSignal = locked ? "locked" : "unlocked" }
            else { lockSignal = "invalid" }
        } else { lockSignal = "notReported" }
        self.accessibility = accessibility
        self.screenRecording = screenRecording
    }

    var desktopAvailable: Bool {
        onConsole && loginDone && sameUser && lockSignal != "locked" && lockSignal != "invalid"
    }
    var permissionAvailable: Bool { accessibility && screenRecording }
    var dictionary: [String: Any] {
        ["schemaVersion": 1, "platform": "macos",
         "desktopAvailable": desktopAvailable, "permissionAvailable": permissionAvailable,
         "onConsole": onConsole, "loginDone": loginDone, "sameUser": sameUser,
         "lockSignal": lockSignal, "accessibility": accessibility, "screenRecording": screenRecording]
    }
}
