# Computer use / 电脑控制 / 電腦控制

Use the configured desktop MCP to operate Windows or macOS applications. This guide is instructions, not a grant of permission or proof that the controller is connected.

## Discover before acting

1. Loading this skill reveals the connected entry tools and current availability. Use those schemas directly. Only discover additional tools through `search_mcp_tools` by exact `names`; do not search again for tools already loaded.
2. If the tools are absent or disconnected, explain that specific limitation and how to enable the computer-control extension for this chat. Do not treat a missing schema as proof that an application is absent. Do not silently replace unavailable or rejected desktop input with shell UI automation.
3. `mcp__qwen_computer__list_apps` lists visible windows, not installed applications. Select the exact returned window identifier. Do not invent an English application name when the returned name is localized; keep separate windows and popovers distinct.
4. Observe that exact window with `mcp__qwen_computer__get_app_state` before any click, key or text input. Inspect both the screenshot and accessibility tree. Never start with `press_key` or assume that the previously frontmost app still has focus.

Before discovery, pass the user's exact requested window title as `window_title` on the first computer tool call. If the user named only an app, file, folder or contact, pass an empty string. The host retains the scope for this turn. Confirm the matching window in its observation before sending input. If the title is missing, refresh the list once using the same title. If it is still absent or ambiguous, leave all candidate windows untouched and report which title could not be identified. Verify the result in the same matched window.

简体：用户指定窗口标题时，先匹配标题，再观察该窗口核对身份。刷新一次仍找不到或无法区分时，说明缺少哪个窗口，不在相似窗口上点击。

繁體：使用者指定視窗標題時，先比對標題，再觀察該視窗確認身分。重新列出一次後仍找不到或無法區分時，說明缺少哪個視窗，不在相似視窗上點擊。

## Observe, act, verify

- Keep routine control turns short: use the returned evidence to choose the next action, without narrating the same plan before every tool call. When the requested result is already visible in the last action's after-state, finish with a brief factual result. Do not add a separate observation or re-audit the full history just to write the final reply. Preserve all target, focus and permission checks.

- For a known local folder or document, use `mcp__qwen_computer__open_path` when available, then observe the actual target. It uses the desktop runtime and default application. Launch acceptance is not proof that content is visible; if the returned window list has not caught up, observe/list once before deciding what is missing. Do not launch the same path repeatedly. If the exact file is unknown, use filesystem reading to find it, then open that exact path. Do not inspect unrelated apps first.
- Do not start desktop applications with confined `pwsh`/`bash`, WMI, COM launch workarounds, or long sleeping background jobs. Shell child lifetimes and desktop permissions differ from user-owned application windows. A shell denial or an empty process list is not evidence that a GUI is still loading. If `open_path` is unavailable, use an observed desktop launcher or explain the missing capability; do not escalate shell permissions just to work around missing desktop tools.
- Reuse each action's returned screenshot and tree for the next decision. Do not insert `list_apps` plus `get_app_state` after every action. Observe again only for a changed/ambiguous target, stale state, missing evidence, or a specific unmet postcondition. Once the requested folder/document is visibly open, report concisely and stop; do not inspect the document's private contents unless requested.
- Escape or three consecutive input conflicts end computer control for this turn only. DESKTOP_STOPPED blocks further computer tools in this turn, while reasoning and independent non-desktop tools remain available. Do not end the task merely because computer control was interrupted. There is no resume button: do not invent one or ask the user to unlock control. Do not bypass the stop with scripts or replay uncertain actions.
- `DESKTOP_PAUSED` means desktop control is explicitly paused, not that the conversation was cancelled. Continue independent authorized work when useful; explain the blocked part only if it requires desktop control. There is no global unlock button. Do not use another input tool or shell to bypass the pause. The host waits queued calls without model polling. `DESKTOP_OBSERVATION_EXPIRED` after resume requires fresh observation, never replay of uncertain input.
- `DESKTOP_INPUT_CONFLICT` means input changed during or since the last observation. It is a temporary conflict, not a persistent pause: observe the target again, reconcile any partial action, and decide from the new evidence. Sustained input may block the observation too; report the conflict if it persists. Do not ask the user to unlock a pause that does not exist, and never blindly retry the previous action.
- `open_path` validates that the exact path exists before dispatch. Repeating filesystem existence checks does not verify its window. If a fresh window observation still cannot locate the target, use an observed desktop navigation control or report the verification gap; do not chain unrelated discovery and filesystem probes.

- Make one grounded input, inspect the returned after-state, then decide the next action. Use current element indices or window-local screenshot coordinates. A sparse accessibility tree is a reason to inspect the screenshot, not to guess a familiar layout.
- Use `type_text` for Unicode text and `press_key` for shortcuts. These tools target the current keyboard focus, not an element mentioned in your reasoning. Before typing or editing shortcuts such as Ctrl+A, inspect the latest after-state: if the intended editor is not focused, click that observed editor and verify focus in the returned state. An active window or a visible editable element alone does not establish input focus. Reuse that state without an extra observation call. On macOS cmd/super means Command; ctrl means Control. Use each tool's loaded schema.
- Windows foreground `type_text` supports single-line text. For multiline content, use `set_value` only if the observed editor supports it and complete replacement is intended; include any existing content that must be preserved. Otherwise use that editor's observed line-break controls. Do not assume Enter or Shift+Enter is harmless in a message composer.
- To bring an already observed window forward without changing its contents, use `perform_secondary_action` on its current root window element with its advertised `AXRaise` (macOS) or `Raise` action. Reuse the returned after-state. A new-conversation shortcut such as Cmd+N changes application state; never use it merely to activate a window or resume an existing draft.
- If the target is not running, use `open_path` for supported documents/folders or an observed desktop launcher. Launch success does not prove window readiness.
- Do not create AppleScript/System Events, PowerShell SendKeys, pyautogui or other shell scripts to replace these desktop input tools. In particular, do not bypass a focus, stale-observation, permission or user-takeover rejection with another input mechanism.
- After stale state, ambiguity or focus changes, enumerate and observe again. If the same failure persists with fresh evidence, report the exact blocker instead of repeatedly sending the same input or switching to blind scripts. Missing foreground identity does not prove the application is closed.
- Preserve user drafts. For messaging, verify the recipient and exact content before sending, obey the current authorization flow, and inspect the resulting conversation after sending. If submission is uncertain, observe first; do not resend.
- If the screenshot is unavailable to your model and the accessibility tree contains only window chrome, stop and report the visual configuration blocker. Shell screenshot files, opening QuickLook, image dimensions, and old clipboard contents do not let you read the missing screenshot. An empty composer alone does not prove submission, and an unchanged window is not evidence that a reply is loading.
- Tool exit code 0, input dispatch and an empty shell result are not completion evidence. Report only visible, verified results. Distinguish message submission in the app from delivery to the recipient. If verification is blocked, say what remains unverified; do not label the task completed.

## Communicate useful progress

During desktop work, group communication around the user's goal. Leave routine observations, clicks, typing, scrolling and checks in the tool record rather than narrating each action. This does not change the observe, act, verify workflow above.

When there is useful new information, briefly share a verified finding, a meaningful stage result, a change of approach or a concrete blocker in the user's language. Usually one or two sentences are enough to explain what changed and, when helpful, the next step. Combine related progress, avoid repeating plans or internal reasoning, and do not fill silence with generic reassurance or announce every retry.

Continue working after an update. Communication is not a prerequisite for the next action; wait only when user input is genuinely needed. There is no fixed time or tool-call schedule for updates.

Examples, only when supported by the actual task:
- Useful: "I checked all three applications. Two meet the technical requirements, but one cannot start in time; I am checking their project experience next."
- Useful blocker: "The file picker does not expose an actionable upload control. I am checking the page's upload button; the existing draft is preserved."
- Avoid: "Taking a screenshot. Clicking the application. Taking another screenshot. Opening the next file."

简体：加载本技能后直接使用已显示的工具，仅在寻找目标窗口时列举窗口；观察后再操作，失败先重新观察，勿用脚本绕过。发送前核对对象和内容，发送后核对界面结果。

简体：单次输入冲突先重新观察，不盲目重试；Esc 或连续三次冲突只退出本轮电脑控制，思考和其他独立工具可以继续。收到 DESKTOP_STOPPED 后不再调用电脑工具，不要求用户点击恢复或解锁按钮，不重放未知结果。

简体：已知路径直接用 open_path；找文件用文件读取，打开和观察用桌面工具。复用动作后的状态，达到用户要求后结束；不通过提权 Shell、WMI 或长时间休眠维持桌面窗口。

简体：输入文字和 Ctrl+A 等编辑快捷键作用于当前焦点。先从最新回执核对输入框焦点，缺少时点击该输入框并复用点击后的状态；窗口在前台不代表输入框已聚焦。

简体：常规操作直接依据最新回执决定下一步，避免每次调用前重复叙述计划。末次动作回执已显示目标结果时，简短报告即结束，不为总结另行截图或重审全部历史；保留对象、焦点和权限检查。

繁體：載入本技能後直接使用已顯示的工具，僅在尋找目標視窗時列舉視窗；觀察後再操作，失敗先重新觀察，勿用腳本繞過。傳送前核對對象和內容，傳送後核對畫面結果。

繁體：單次輸入衝突先重新觀察，不盲目重試；Esc 或連續三次衝突只退出本輪電腦控制，思考和其他獨立工具可以繼續。收到 DESKTOP_STOPPED 後不再呼叫電腦工具，不要求使用者點擊恢復或解鎖按鈕，不重播未知結果。

繁體：已知路徑直接用 open_path；找檔案用檔案讀取，開啟和觀察用桌面工具。重用動作後的狀態，達到使用者要求後結束；不透過提權 Shell、WMI 或長時間休眠維持桌面視窗。

繁體：輸入文字和 Ctrl+A 等編輯快捷鍵作用於目前焦點。先從最新回執核對輸入框焦點，缺少時點擊該輸入框並重用點擊後的狀態；視窗在前景不代表輸入框已聚焦。

繁體：常規操作直接依最新回執決定下一步，避免每次呼叫前重述計畫。末次動作回執已顯示目標結果時，簡短回報即結束，不為總結另外截圖或重審全部歷史；保留對象、焦點和權限檢查。
