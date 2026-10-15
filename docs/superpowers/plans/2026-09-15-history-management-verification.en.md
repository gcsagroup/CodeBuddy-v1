# History management phase-one verification

Date: 2026-09-15.

## Scope and design

This phase adds Active, Archived, and All history views, treats the working directory as the project filter value, and offers Today, Last 7 days, and Last 30 days activity filters. A single session can be archived or restored. Deletion keeps its existing confirmation flow.

The backend already exposed `_goose/unstable/session/archive` and `unarchive`, while list metadata already contained `archivedAt`, `projectId`, and activity timestamps. This phase reuses that protocol instead of creating another archive state. The history page loads every page before applying client-side filters. That is correct for the current bounded list but does not scale to an unbounded history store; server-side filtering and transactional bulk management require a later protocol design.

OpenAI's published behavior defines archive as a recoverable way to hide a chat rather than delete it, requires no deletion confirmation for archive, and provides a separate archived-chat management and restore path. This phase adopts that recovery boundary. It does not add delete-all because CodeBuddy has no atomic bulk-delete ACP contract yet. [OpenAI: delete and archive chats](https://help.openai.com/en/articles/8809935-how-to-delete-and-archive-chats-in-chatgpt) [OpenAI: archive and delete Codex chats](https://help.openai.com/en/articles/20001333-how-to-archive-and-delete-chats-in-codex)

## Automated evidence

- RED: the first `SessionListView.management.test.tsx` run failed 3 tests because the view, filters, and archive actions were absent.
- GREEN: the 3 new tests passed. Pagination, search, copy capability, and ACP session coverage passed 31 tests total with 0 failures.
- `prettier --write`, `tsc --noEmit`, and exact-file ESLint exited 0.
- Evidence: `.cargo/evidence/audit-fixes-20260914/history-management-red.log`, `history-management-green.log`, `history-management-focused.log`, and `history-management-ui-gates.json`.

## Remaining gates

- The 15 locale catalogs have not been regenerated. That must wait for the shared i18n writer to finish and then run once for both changes.
- Archive, restore, filtering, and refresh persistence have not been accepted in a real Electron window because this task currently has no native-app control API.
- Bulk management is not implemented. Bulk deletion first needs explicit atomicity, partial-failure, and confirmation boundaries; a frontend `Promise.all` is not a transaction.
