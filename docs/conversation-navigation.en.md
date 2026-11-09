# Conversation titles, branches and the main conversation

Header titles use available width and ellipsize only on actual overflow. Sidebar names remain complete with a fading edge; hover or keyboard focus slowly reveals overflow, respecting reduced-motion preferences. Numeric copy suffixes remain visible beside the scrolling name.

Opening history positions the committed visible content at the latest message before dismissing loading feedback. Reopening a cached conversation also positions it immediately, without scrolling down from the top. Manual upward reading still retains its position; live output keeps the existing follow behavior.

Cold plan, goal and permission reads share the existing native session admission queue, avoiding competing write handles. Loaded sessions are reused directly; read-only queries do not initialize tools.

New branches use the original name with `(1)`, `(2)`, including nested branches. Archived siblings count toward numbering. An explicitly renamed conversation starts a new naming family. Existing names and history are not rewritten. Numbers are presentation; session IDs and `forkedFrom` retain identity and provenance.

Official Harness fork still owns native history and boundary validation. Native history is flushed before publishing the product session. Insertion uses the existing durable commit queue and atomic replacement, cloning only the new session and reusing serialized unrelated histories. Archive, restore and rename use single-session updates. Failed writes publish no successful state. File format and permissions remain unchanged.

An empty main conversation shows a CodeBuddy introduction and capability examples. It disappears when history or execution begins. Presentation and title animations send no model requests.

CPU sampling in the real application also identified repeated registry work: every live session rebuilt complete tool views for every tool after registry changes. Name comparison now limits identity lookups to global namesakes; default inherited roles skip unnecessary restriction scans. Public upstream APIs and synchronous filtering remain authoritative, without delaying permission updates.

Comparison with the pinned official Harness 0.2.1-alpha.2 controller identified execution setup in read-only plan and goal queries. These queries now read native state directly; prompting and tool execution retain their existing capability preparation. Branches still use official `sessionController.fork`, preserving history and persistence contracts. No third-party implementation or dependency upgrade was introduced. See the [official session documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md).

A local isolated benchmark with roughly 27 MB and 120 histories measured three state-layer forks at 44–46 ms versus 175–195 ms, and archives at 43–52 ms versus 125–151 ms. Native fork is stubbed in this benchmark; it cannot establish complete installed-app latency or cross-platform acceptance.

Animation follows [WCAG guidance](https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions). [React optimistic updates](https://react.dev/reference/react/useOptimistic) were evaluated; this change preserves updating after durable success. No external implementation or dependency was added.
