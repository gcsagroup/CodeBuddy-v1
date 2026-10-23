# Desktop skill discovery and progress feedback

## R19: vision interruption and macOS pointer targeting

The Kimi K3 WeChat session received screenshots but failed native pointer targeting. A read-only probe found a full-display Dock surface and WeChat AX hit-testing returning `-25208`. The runtime now uses [AppKit mouse-down hit-testing](https://developer.apple.com/documentation/appkit/nswindow/windownumber(at:belowwindowwithwindownumber:)) to identify the actual receiving window, retaining rejection for real overlays, unknown targets and stale observations.

When a desktop screenshot has no usable image model or auxiliary observer, Harness reports an error and stops before the next step. Original action receipts remain intact and actions are not replayed. Skill guidance prohibits using a new-window shortcut to activate an app or treating an empty composer as proof of sending. The composer extension icon/count is removed; toolbox and slash-menu access remain available.

Windows vision/ACP regressions passed (8 tests). Mac native, Harness, packaging and installation smoke checks passed. Mac ACP first encountered SSH Keychain access restrictions, then passed in a child process of the logged-in app. Real-model message sending remains user acceptance work.

[简体中文](computer-use-routing.zh-CN.md) · [繁體中文](computer-use-routing.zh-TW.md)

CodeBuddy registers a bundled `computer-use` guide through the official Harness skill provider API. The skill catalog and lightweight `skill` loader are available on the first request; full MCP schemas remain deferred. Loading the guide neither establishes a connection nor authorizes input. Harness retains execution, permissions, skill precedence and persistence ownership.

The guide asks the model to discover desktop tools, enumerate actual windows, observe, act and verify. Visible windows are not an inventory of installed applications. Focus, stale observation and user takeover failures require fresh observation; persistent failure must be reported rather than bypassed with AppleScript, SendKeys or blind shell automation. A narrow application launch command remains acceptable, followed by observation. Messaging requires recipient/content checks and post-send observation. Exit code 0 or empty shell output is not completion evidence. This is model guidance, not a keyword router or an additional executor.

Existing structured execution facts drive friendlier Simplified Chinese, Traditional Chinese and English copy: “Working on your request”, “Thinking”, “Writing a response” and “Reviewing the tool results”. Approval, cancellation, real connection errors and elapsed time remain distinct. Transport silence alone is not represented as observed reasoning.

The user-supplied macOS conversation examined on 2026-10-21 shows a blind script followed by an unverified completion claim, desktop input before observation, and subsequent unknown foreground PID rejections. Current revision `3126465` already contains an AppKit/AX foreground identity fix; native protections were not changed in this patch. The tested installed revision and the Windows native failure cause remain unconfirmed.

Changes cover the Harness skill provider and guide, profile registration, first-request skill loader visibility, progress labels and three locale catalogs, regression/browser fixtures, and staging resource copying plus packaged skill-load verification. Source: `D:\CodeBuddy-v1`, `main`, `3126465` plus uncommitted changes. Other existing edits were preserved. No commit or push was performed.

Using existing Node 24.19.0: Harness 8/8, library/dependency regression 14/14, UI components 18/18 and Edge browser tests 3/3 passed with exit 0. Browser tests load the product's compiled locale resources. Type checking, targeted lint, locale compilation and extraction consistency also passed. Exact commands appear in the [verification table](computer-use-routing.zh-CN.md#验证记录). An initial pnpm test invocation unexpectedly reconciled dependencies and contacted the registry; it was stopped with exit 1. Dependency directory changes were observed, with no tracked lockfile changes observed. Subsequent validation called the existing runners directly without another installation.

Real-model WeChat interaction, recipient recognition, message sending and focus recovery on Windows/macOS were not retested. No messages were sent to contacts. Full staging, new installer builds and installation acceptance were not executed; the new packaged skill check is wired into that future verification. Browser component success is not desktop messaging E2E success.
