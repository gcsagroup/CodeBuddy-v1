# Standalone Computer Use MCP

After a successful action, a changed caption in the same PID/HWND receipt (such as an unsaved document marker) is used for subsequent exact title matching. The original user scope remains fixed. External renames, conflicting input and cross-window receipts cannot establish this continuation.

Windows field views retain the current control tree, document values, buttons, selection and focus. Field candidates constrain write targets, not read evidence. Explicit full applies to that observation only; subsequent actions in the same Windows window return control-first receipts. Request full again for unresolved visual details. Window transitions still invalidate old targets; original frames and input-conflict checks remain.

Windows retains the requested control-readback view across minimization and restoration of the same window. Hidden windows receive no image evidence or field tokens; their fresh restored receipts continue control readback without repeated vision calls. Explicit `view=full` still provides visual observation. A transition to another window does not inherit the previous window's field observation.

When a completed input closes its launcher or dialog, observe the verified new foreground window as its after-state. Do not replay input or rebind the old window name or ID to the new application. If the new window cannot be verified, retain the uncertain-result outcome.

On macOS, a nonactivating system panel can receive keyboard focus while AppKit still reports the underlying application. Accept the panel only when system-wide AX application focus, focused-element ownership and a visible focused window corroborate it. Missing evidence still rejects input. An old window image cannot remain a valid observation under the dynamic foreground alias after a transition. Like Windows, macOS returns a fresh target observation after a brief external input burst, without dispatching or replaying the stale action. This still counts as an input conflict. See [Apple nonactivating panels](https://developer.apple.com/documentation/appkit/nswindow/stylemask-swift.struct/nonactivatingpanel).

## Snapshot-bound field candidates

`get_app_state(view="fields")` returns `capture_id` and `field_candidates` for writable fields. Pass a candidate ID to `set_value`. Candidates reuse the tool's window, element and original-value snapshot. Observe again after input; do not replay old IDs. Existing tree text and element-index clients remain compatible.

Windows now defaults to the `fields` control view. Apps without writable fields return their button/readout control tree; subsequent actions retain this mode. The host consumes the structured `desktop_observation.view` and sends control evidence directly to the main model, retaining the original frame in the receipt. Request `view="full"` explicitly for appearance, canvas content or information missing from controls. Older clients requiring full observations must specify `full`; the macOS default is unchanged.

When standard Windows EDIT or WinForms EDIT controls lack UIA ValuePattern, replacement is available only for visible, enabled, non-password, non-read-only fields with at most 500 characters. Before dispatch, verify window ownership, original value, occlusion and focus. Use the existing tagged mouse and keyboard input with desktop-lease and human-takeover checks. Replacement values must be single-line and at most 500 characters; other controls retain their existing path. Field observations retain adjacent labels for unnamed controls.

The main model decides actions; CUA only describes images. Read controls directly when sufficient, avoiding repeated image inference. A dispatch receipt does not prove task completion: verify actual field values and submission count.

## Windows control feedback

Pointer movement does not pause a task. Physical clicks, wheel events and keyboard input invalidate earlier observations. Native input lets a brief input burst settle. If observation is stale before dispatch, it returns fresh state for the same target and explicitly reports that the requested action was not dispatched. The model decides from that state; stale actions are never replayed automatically. Sustained input or conflicts during an action still return a specific conflict without persisting a pause. Escape immediately interrupts computer control only. Further desktop calls return a stopped outcome without waiting for resume or dispatching input. Reasoning and independent non-desktop tools remain available. Escape does not cancel the task or force a final message. After the original turn ends, a new message in that chat can continue it. Stopping the task releases its pause without restarting it. Chats share one desktop lease and queue locally, with separate queue withdrawal. Resume never replays an action with an unknown outcome. Native input validates the lease generation; bridge failure cleanup releases mouse buttons held by that bridge. Each display retains a banner and edge glow, with brief action feedback. The conversation explains pauses without a global pause/resume bar. Existing model, reasoning and approval settings are preserved.

The native layer renders only pointer glow and up to 850 ms of afterglow, without waiting for animation or drawing a text card beside the pointer. Windows 10 2004+ capture exclusion prevents feedback from polluting observations; unsupported native capture exclusion disables animation. Activation establishes a message queue before attaching input threads and retains foreground checks and zero input on rejection. No synthetic Alt or foreground-lock setting changes are used. User model reasoning preferences are preserved.

Windows foreground `type_text` rejects newlines before typing because controls may silently discard them; it never converts a literal newline into an Enter shortcut that could submit a message. Use the existing `set_value` for multiline text only when replacing the complete observed editor value is intended, preserving required existing content. Verify the screen and the saved file.

On Windows, reopening a folder first restores an existing Shell window by its actual folder address, including hidden or minimized windows. Decorated window titles are not used for matching; a new launch occurs only when no matching window exists. Element-ID fallback reuses one live tree enumeration, and focus/selected-text evidence belongs only to the foreground window. See [Shell.Windows](https://learn.microsoft.com/en-us/windows/win32/shell/shell-windows).

Mac observations enable the Electron/Chromium accessibility tree through capabilities exposed by the target process. Already enabled or unsupported attributes remain unchanged. This does not grant system permission or replace Screen Recording, Accessibility, or verification after input. See the [Electron accessibility interface](https://github.com/electron/electron/blob/main/docs/tutorial/accessibility.md).

On macOS permission denial, check the responsible application identified by the system prompt or TCC logs. Development launches may be attributed to Terminal. A helper path or containing application directory alone does not prove permission attribution. Confirm the launch source before checking Screen Recording and Accessibility, then restart if requested by macOS. Do not repeatedly add the helper or remove existing grants based only on a helper error.

Observations with screenshots include the window's screen position so fresh observations before and after a drag can verify movement. Click, scroll and drag input still uses window-local coordinates. Observations without screenshots do not claim an observed position.

[繁體中文](README.md) · [简体中文](README.zh-CN.md)

Based on Qwen open-computer-use 0.2.3 for Windows, commit 24b7cae4d449a5a8ea58c583e5151096b26de03c, MIT license. Retains Unicode, window identity and foreground input fixes. The hybrid host bridge and Rust Qwen adapter have been removed. The original nine MCP tools remain compatible; Windows additionally exposes `open_path`.

`open_path` opens an explicit local document or folder with its default application, requires foreground-input opt-in and retains host tool approval. It rejects URLs, network paths, scripts, executables and shortcuts. Launch acceptance does not verify visible content: observe the target window afterward. Do not launch or keep GUI applications alive through confined shell commands or long sleeps.

Windows reuses one PowerShell bridge per MCP connection to amortize runtime initialization. Each observation still reads live data. Interrupted actions are never replayed automatically; observe before deciding again. Loading the builtin computer-use skill reveals entry tools from the currently connected, permitted registry without enabling disabled extensions.

Run `go test ./...`, `go vet ./...`, and `go build -o ../../target/debug/qwen-computer-use.exe .` here. Synchronize the binary to `runtime/tools/bin/qwen-computer-use.exe` and update its size and SHA256 in provenance.json and builtin-artifacts.mjs as documented in the root README, then start with `start-preview.ps1`. The current Harness preview validates existing tools; it does not rebuild Go automatically. Use the full path of an existing go.exe when Go is absent from PATH.

Enable the builtin qwen_computer extension, disable computer and computercontroller, and start a new session. Arguments: `--foreground-input mcp`. The Windows path requires the local desktop; see the Mac path below. A user-configured stdio extension with the same name is not classified as the trusted builtin.

Reuse action after-states; re-observe changed windows. Preserve drafts, verify recipient and message, and reconcile uncertain sends before retrying. Outgoing UI evidence is not recipient-side delivery confirmation.

## Window transitions and scrolling

`get_app_state(app="foreground")` observes the current foreground window. After a global shortcut changes focus, results distinguish the original app screenshot from the newly active window to prevent false failure conclusions. Windows-key aliases include `super`, `win`, and left/right variants.

`scroll` accepts screenshot-relative `x`/`y` coordinates for panes with sparse accessibility data. Coordinates and `element_index` are mutually exclusive and require a valid prior observation of the window.

This extension supplies tools, not a separate model. Image understanding and decisions still depend on the session model or host image routing. Successful dispatch is not proof of task completion; verify the visible postcondition.

## Multiple windows and result evidence

`list_apps` lists visible top-level windows, not installed apps or usage history. Chat, login and image-viewer windows in one process have separate `window:PID:HWND` selectors. Exact selectors retain window identity and reject stale or wrong-owner windows.

Reuse fresh action after-states. For an app that is not running, choose an available desktop launch entry. The host desktop_interaction evidence binds an actual input to its after-image, distinguishing UI submission and an application reply from independently confirmed recipient delivery. Never replay an uncertain send.

## macOS 14+ runtime

Mac reuses this Go MCP interface and snapshot/receipt contract. Its sibling `qwen-computer-runtime` Swift helper executes AppKit, Accessibility and ScreenCaptureKit operations. All nine tools are integrated with the current Harness catalog, preview and packaging. Run native contract tests, signed builds and real desktop acceptance for each batch. Historical evidence and compilation do not establish input acceptance for the current build. Component binaries are not installers.

Use `node scripts/build-harness-macos.cjs --arch arm64 --node-license /path/to/Node/LICENSE` (x64 on Intel). Existing Go 1.22+, Xcode/Swift, project Rust and offline dependencies are required; CODEBUDDY_GO_EXECUTABLE can select Go. Preview builds/synchronizes both helpers and tool-only Rust MCP without running tests by default. Contracts remain available through `buildMacComputer(repo, arch, { test: true })`. Both binary identities are checked after signing. See the [current Mac guide](../../docs/macos.en.md).

Users must grant Screen Recording/Accessibility; input requires `--foreground-input`. `cmd`/`super` mean Command and `ctrl` means Control; use type_text for text. `window:PID:WINDOW_ID` binds an exact window and screenshot coordinates use window-relative points. Re-observe changed windows/elements and uncertain input outcomes.

Mac key parsing also accepts `Control_L` / `Control_R`, `Shift_L` / `Shift_R`, `Alt_L` / `Alt_R`, `Numpad_*`, and common symbol names such as `plus`. Main-keyboard plus and keypad plus retain distinct key codes. Swift contract checks cover modifier aliases, Command mapping, symbol/keypad differences and rejection of invalid chords.
# Windows operation feedback

Clicks show a blue halo, right clicks a violet ripple, double clicks two rings, drags a following halo, and scrolling a directional arrow. Short labels distinguish active operations, dispatched actions and unsuccessful operations without exposing typed text or claiming task completion. A separate drawing thread never delays input to finish an animation. Feedback fades after about 850 ms, stops its timer while idle, and honors reduced system animation. The overlay does not activate, accepts click-through, and is excluded from screenshots and window discovery. If capture exclusion is unsupported, it remains hidden. No MCP tools or permissions were added; macOS integration is pending. Developers can set `CODEBUDDY_DESKTOP_FEEDBACK=0` before starting a new MCP connection to disable it.

Run ordinary tests with `go test ./...`. On an unlocked Windows desktop, run `$env:CODEBUDDY_RUN_DESKTOP_TESTS='1'; go test -run TestDesktopFeedback -v` for native lifecycle, focus, capture exclusion and event-throughput checks. Design references: [PowerToys](https://learn.microsoft.com/en-us/windows/powertoys/mouse-utilities) and [Windows layered windows](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features). This is a local implementation with no new rendering dependency.


Chats requesting the same desktop are serialized by a lease. Escape withdraws active and queued desktop proposals so the next chat cannot immediately reclaim the pointer. Independent work continues. Native cleanup releases ownership; a new user message renews only its target conversation, never other interrupted turns.

Interruption also withdraws pending desktop approvals while preserving approvals for other tools. The shared control epoch fences approvals in processes that missed a short interruption.

Messages queued before Escape can continue independent work, but automatic delivery does not renew desktop access. A new message or explicit Send now uses the current control generation.

After three consecutive native input conflicts, including refresh-only outcomes with no dispatch, the host fences the desktop episode and existing queued desktop requests. Independent task work continues. Only successful input resets the streak; observations and unrelated failures do not. No resume prompt or automatic replay is added. New explicit input starts a new episode without reviving older queued messages. Upgrade the host and native tool together; legacy receipts are never inferred from prose.

Mac retains a Quartz event monitor across requests. Plain pointer movement and tagged tool-generated events preserve observations; external clicks, drags, scrolling and key presses invalidate them and produce a structured input-conflict receipt. Escape is armed only while the host owns control and does not cancel the overall task. Text characters, drag steps and repeated clicks recheck the lease, clean up held input when interrupted, and never replay automatically. Chat navigation preserves feedback and Escape; document reloads and transport disconnects clear them.
[Foreground handoff] When Windows refuses target activation before input dispatch, ask the user to bring that exact window forward. A new background observation does not prove foreground recovery. Verify the intended foreground and existing values before continuing; do not cycle through clicks, shortcuts, or scripts to force activation.
