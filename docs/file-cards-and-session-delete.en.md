# File cards and session deletion

2026-11-10 update: deletion now acknowledges a durable marker before full snapshot pruning and MCP disposal. See [Asynchronous deletion](async-session-delete.en.md).

Standalone local-document links become cards with a file-type icon, name, format and Open with action. Clicking the name opens the right panel. Inline prose links, source-line references and existing media cards retain their presentation. A card does not prove that a file was created; opening failures remain explicit.

Existing viewers handle Excel `.xlsx`, PDF, Word `.docx` and PowerPoint `.pptx`. Markdown `.md`, `.mdx` and `.markdown` render as documents, while line references retain source positioning. CSV/TXT/JSON remain text previews. Legacy Office binary formats are not guaranteed inline previews and can use system applications. Missing fonts can change Office preview layout. Imported read-only history retains existing workspace access restrictions.

Delete session appears immediately below Archive session. Confirmation explains that deletion cannot be restored within CodeBuddy and workspace files are retained. Cancel does nothing; failure keeps the dialog and conversation. Successful deletion updates navigation and returns to a new task if the current conversation was deleted. The existing backend rejects deletion of running sessions.

2026-11-09 validation: 148 component tests, 13 navigation tests, TypeScript and i18n checks passed. Actual Windows development-window checks covered five file types, cancellation, confirmed deletion, navigation and unchanged workspace file hashes. Source: `D:/CodeBuddy-v1`, `main`, `b7865d54aa19d3023e495bc7982b84ac68f686b2` plus working changes. No commit, push, new installer or Mac hardware retest. Evidence: `.local/file-cards-20261109/`.
