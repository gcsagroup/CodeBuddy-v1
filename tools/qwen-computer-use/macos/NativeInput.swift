import AppKit
import CoreGraphics

@MainActor
final class NativeInputMonitor {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private(set) var version = UUID().uuidString
    var armed = ""
    private var escapeHeld = false
    private var heldKeys = Set<Int64>()
    private var heldButtons = Set<Int64>()
    private var lastInputTime: TimeInterval = 0
    private let escapeWorker: Bool
    init(escapeWorker: Bool = false) { self.escapeWorker = escapeWorker }
    var available: Bool { tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false }

    func start() -> Bool {
        if available { return true }
        let types: [CGEventType] = [.keyDown, .keyUp, .leftMouseDown, .rightMouseDown,
            .otherMouseDown, .leftMouseUp, .rightMouseUp, .otherMouseUp,
            .scrollWheel, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        // Accessibility already gates desktop input. Observe all events unchanged,
        // except a human Escape explicitly armed by the current host lease.
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
                MainActor.assumeIsolated {
                    let monitor = Unmanaged<NativeInputMonitor>.fromOpaque(pointer!).takeUnretainedValue()
                    return monitor.receive(type, event)
                }
            }, userInfo: Unmanaged.passUnretained(self).toOpaque())
        guard let tap else { return false }
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        version = UUID().uuidString
        return true
    }

    private func receive(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            version = UUID().uuidString // Observations spanning a lost event stream expire.
            heldKeys.removeAll(); heldButtons.removeAll()
            lastInputTime = ProcessInfo.processInfo.systemUptime
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let marker = event.getIntegerValueField(.eventSourceUserData)
        let key = event.getIntegerValueField(.keyboardEventKeycode)
        if type == .keyUp && key == 53 && marker != DesktopInputPolicy.marker {
            let consumed = escapeHeld
            escapeHeld = false
            if escapeWorker && consumed { return nil }
        }
        if escapeWorker && !armed.isEmpty && DesktopInputPolicy.escape(type, key: key, marker: marker, flags: event.flags) {
            if !escapeHeld { print("cancel \(armed)"); fflush(stdout) }
            escapeHeld = true
            return nil
        }
        if marker != DesktopInputPolicy.marker {
            if type == .keyDown { heldKeys.insert(key) }
            if type == .keyUp { heldKeys.remove(key) }
            let button = event.getIntegerValueField(.mouseEventButtonNumber)
            if [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type) { heldButtons.insert(button) }
            if [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) { heldButtons.remove(button) }
        }
        if DesktopInputPolicy.conflicts(type, marker: marker) {
            version = UUID().uuidString
            lastInputTime = ProcessInfo.processInfo.systemUptime
        }
        return Unmanaged.passUnretained(event)
    }

    func prepare(_ request: NativeRequest) async throws -> Bool {
        // Screen capture remains available before Accessibility is granted.
        // Only input requires an active event monitor.
        if !available && !request.isInput { return true }
        let deadline = ProcessInfo.processInfo.systemUptime + 3
        while true {
            try DesktopInputPolicy.validateLease(directory: request.controlDirectory, identity: request.controlIdentity)
            guard available else { throw RuntimeFailure("macOS input monitoring is unavailable for this process. No new input dispatched.") }
            let now = ProcessInfo.processInfo.systemUptime
            if heldKeys.isEmpty && heldButtons.isEmpty && now - lastInputTime >= 0.6 {
                return !request.isInput || request.inputVersion == version
            }
            if now >= deadline { throw DesktopInputConflict() }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
    }

    func validate(_ request: NativeRequest) throws {
        try DesktopInputPolicy.validateLease(directory: request.controlDirectory, identity: request.controlIdentity)
        guard available else { throw RuntimeFailure("macOS input monitoring is unavailable for this process. No new input dispatched.") }
        guard request.inputVersion == version else { throw DesktopInputConflict() }
    }
}

// Both reader modes keep AppKit's main run loop free for focus and input events.
// Only one request is admitted at a time; an uncertain request is never replayed.
func readNativeLines(_ handle: @escaping @MainActor (String) async -> Void) {
    DispatchQueue.global().async {
        while let line = readLine() {
            let complete = DispatchSemaphore(value: 0)
            Task { @MainActor in await handle(line); complete.signal() }
            complete.wait()
        }
        exit(0)
    }
}
