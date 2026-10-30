# CodeBuddy data directory

Right-click a conversation and choose **Export logs** to save its native Harness event journal as `.jsonl`. Harness flushes existing events before reading without stopping the task. The export is a snapshot; later events are not appended to it. It contains only the current session, not subagent journals, attachment files, configuration or the project. Journal content may contain conversations and tool output; review before sharing. Imported read-only history has no native Harness journal; use **View session JSON** instead. Cancelling does not write a file, and read or save errors are reported.

The default root is `~/.CodeBuddy` (`C:\Users\<username>\.CodeBuddy` on Windows). Source previews and packaged apps share this default; the runtime lock protects the data root from concurrent writers. Tests and parallel development must explicitly select isolated directories.

New workspaces use `workspaces/<task>`. Generated images and videos stay in that workspace's `generated-images` and `generated-videos` directories. Pets and selection preferences remain in `state/electron-app/pets`. Sessions, model settings, schedules and tool receipts retain the existing `backend` layout. Profile/browser data and caches use `profiles/local` and `state/electron-app`; logs use `logs` and `state/electron-app/logs`. Plugin packages and migration records use `plugins/packages` and `migrations` when needed.

File → Open CodeBuddy Data Folder opens the active root. `CODEBUDDY_HOME` relocates the root and its default workspaces; an explicit `CODEBUDDY_WORKSPACE_ROOT` overrides the workspace location. User-selected projects stay where they are, including their generated media. Remote generation services still manage their own models, workflows and caches.

Startup does not automatically merge `.CodeBuddy-Harness` or `.preview-data`. Exit the source app before copying the chosen profile to a nonexistent destination, verify every file, and retain the source for rollback. Existing destinations require an explicit source decision. Existing projects and historical absolute links are preserved. Back up the new root before rollback to preserve changes made after switching.

For this machine, the user selected the current preview data as the daily profile and retained the older installation independently. Existing projects in `D:\CodeBuddy-Workspace` remain available to historical chats.

References: [VS Code portable data](https://code.visualstudio.com/docs/setup/portable) and [Electron app data paths](https://github.com/electron/electron/blob/main/docs/api/app.md).

## Disk usage controls

- Each browser session has a 128 MiB HTTP cache budget. Startup and six-hour checks reclaim oversized caches through Electron; compiled script caches are reclaimed above 64 MiB. Cookies, site storage, chats, and user files are preserved. These are periodic maintenance thresholds, not a hard quota for the entire data root.
- Preview and packaged runtime logs rotate at 10 MiB per segment, retaining the current and previous segment. Desktop main logs retain electron-log's existing 1 MiB rotation.
- Image/video submission checks the workspace and receipt volumes. Saving downloads checks again, requiring the output size plus 512 MiB free. A low-space error requests freeing space or selecting another disk. Completed remote outputs can be downloaded using the same job ID without generating again. This preflight does not reserve disk space against concurrent applications.
- Previews read existing output files without a second media copy. Chat history, artwork, pets, and rollback copies are not automatically deleted and may keep growing. The user decides when to retire migration backups after acceptance. CODEBUDDY_HOME or CODEBUDDY_WORKSPACE_ROOT can select another disk.
- ComfyUI server models and outputs remain server-managed; local limits do not clean remote storage.

Cache maintenance uses the [Electron Session API](https://www.electronjs.org/docs/latest/api/session), preserving the rest of the browser profile.

An old root may still be referenced by historical projects, including early pet creation workspaces. In that case it is more than a rollback copy: resolve those project references before retiring it. Deleting the entire old root can break historical media links.

## Installation and data preservation

The installer uses a compact native Windows layout with consistent typography, spacing, buttons and progress. Expandable install and uninstall activity shows application UI, assistant, document processing and built-in tool components, coalescing consecutive duplicates. Internal paths and dependency filenames remain in diagnostic logs. Percentages come from actual Inno progress; component labels describe the real file being processed.

Storage management and its migration, disk-usage and manual cache-cleanup interfaces have been removed. The default remains ~/.CodeBuddy. Existing saved locations and legacy migration guards remain readable so previously moved data does not disappear. No existing data or projects are removed. Existing automatic Electron cache limits remain active.

Uninstall details retain the latest 200 component activity entries. Inno continues to own deletion; user data, projects and the location record are preserved by default.

Button layout: Install, Cancel and Browse share consistent dimensions. Footer actions align with the content column and use an 8-logical-pixel gap. The completion page follows the same column. Installation details use a lightweight link on the progress row, aligned with the percentage and accessible by keyboard.
