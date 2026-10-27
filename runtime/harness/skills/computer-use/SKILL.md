# Computer use / 电脑控制 / 電腦控制

Use the configured desktop MCP to operate Windows or macOS applications. This guide is instructions, not a grant of permission or proof that the controller is connected.

## Discover before acting

1. Load `mcp__qwen_computer__list_apps` and `mcp__qwen_computer__get_app_state` through `search_mcp_tools` using exact `names`. Load the input tools you need through the same discovery tool. A search for an application name can return no matches even when generic desktop control is available.
2. If the tools are absent or disconnected, explain that specific limitation and how to enable the computer-control extension for this chat. Do not treat a missing schema as proof that an application is absent. Do not silently replace unavailable or rejected desktop input with shell UI automation.
3. `list_apps` lists visible windows, not installed applications. Select the exact returned window identifier. Do not invent an English application name when the returned name is localized; keep separate windows and popovers distinct.
4. Observe that exact window with `get_app_state` before any click, key or text input. Inspect both the screenshot and accessibility tree. Never start with `press_key` or assume that the previously frontmost app still has focus.

## Observe, act, verify

- Make one grounded input, inspect the returned after-state, then decide the next action. Use current element indices or window-local screenshot coordinates. A sparse accessibility tree is a reason to inspect the screenshot, not to guess a familiar layout.
- Use `type_text` for Unicode text and `press_key` for shortcuts. On macOS cmd/super means Command; ctrl means Control. Use each tool's loaded schema.
- To bring an already observed window forward without changing its contents, use `perform_secondary_action` on its current root window element with its advertised `AXRaise` (macOS) or `Raise` action. Reuse the returned after-state. A new-conversation shortcut such as Cmd+N changes application state; never use it merely to activate a window or resume an existing draft.
- If the target is not running, use an observed desktop launcher. A narrowly scoped OS application-launch command is acceptable when needed; re-enumerate and observe before input. Launch success does not prove window readiness.
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

简体：先加载电脑控制工具，列出真实窗口，观察后再操作；失败先重新观察，勿用脚本绕过。发送前核对对象和内容，发送后核对界面结果。

繁體：先載入電腦控制工具，列出真實視窗，觀察後再操作；失敗先重新觀察，勿用腳本繞過。傳送前核對對象和內容，傳送後核對畫面結果。
