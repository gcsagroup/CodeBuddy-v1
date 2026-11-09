# Sidebar and thinking effort controls

Sliders for the same model reflect local changes and successfully saved levels. A delayed settings read cannot restore an older level after a save. Display synchronization does not contact the model server.

Workspaces precede Tasks. Conversation hover actions are Pin and Archive; right-click retains the full menu. Pins stay within their owning workspace or task group, with the latest pin first. Unpin restores activity ordering.

Folders expose More and New conversation. More includes pin, rename and archive conversations. Archive confirms all matching conversations before calling the existing service; files are untouched and partial failures retain the remaining items for retry.

Composer thinking edits remain in application memory until the next explicit submission saves the existing connection/model preference. Slider and keyboard adjustments issue no configuration requests and do not modify a running turn. Automatic continuation does not consume pending changes. Unsent changes are discarded on application exit. A failed settings save blocks the new prompt and retains the draft for retry.

The model picker has a refresh button next to search. Refresh suppresses duplicate clicks, retains the selected model, and preserves cached lists when a service fails, with retry available.

Clicking a folder name expands or collapses its conversations. More > Open folder opens its actual project path in the system file manager using the same host API as conversation actions. Failures are reported and can be retried.
