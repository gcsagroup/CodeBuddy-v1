# Conversation drag and drop

Running chats retain the blue spinner. Host-owned `sidebarPlacement` (tasks/project) separates sidebar membership from cwd. Absent fields retain legacy grouping. Dropping into Tasks retains files and cwd; dropping onto a project reuses directory switching, preserves history, rebinds tools and refreshes cached session metadata. Same-directory moves only change membership. Cross-directory moves during execution require the user to stop first. No automatic cancellation, deferred moves or file relocation. Read-only, archived and main chats cannot move; CodePro drag moves rebind the workspace lease after a successful native switch; agent directory restrictions remain.

`_goose/unstable/session/navigation/move` requires sessionId and destination; project destinations also require an absolute workingDir. Compat is the sole writer; ACP metadata and navigation consume it. Older clients ignore the optional field without changing execution directories.

## Empty projects and removal

The sidebar retains known projects in the existing desktop local-storage scope (sidebarProjects.v1), including projects whose last chat moves out. Right-click Remove project hides only sidebar membership; chats remain available under Tasks, with cwd, files and history preserved. Selecting the directory again restores it. Reload retains the removal marker. Successful moves refresh navigation before reloading session capabilities; the actual directory switch still waits for the backend.

Drop targets cover each entire project group, including conversation rows and bottom padding. Tasks extend through remaining sidebar whitespace; hitting the heading is unnecessary. Valid targets highlight during drag and clear on leave, cancel or drop. Remove project uses the FolderMinus icon.
