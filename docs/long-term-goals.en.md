# Goal and plan commands

Type `/` in a new or existing conversation to browse commands. Search, arrow keys, Enter, Escape and mouse selection are supported. Windows and macOS share the same composer; there is no permanent goal form.

- `/goal objective and acceptance criteria`: create and start a goal with the native Harness continuation limit (256 rounds by default in the pinned version). Model credits are consumed.
- `/goal pause`: pause the goal and its current turn, including while execution is running.
- `/goal resume`: continue saved progress. Resuming after an application restart is explicit.
- `/goal status`: show the objective, authoritative state, round usage and blocking reason on demand.
- `/plan task`: enter plan mode and research the task; present the plan for user review before implementation.
- `/plan`: select plan mode in an existing conversation; a new conversation asks for task text.
- `/plan off`: leave plan mode without changing the session approval setting.
- `/compact`: use the existing context compaction entry point.

Harness GoalService owns goal state, rounds and persistence. The pinned native PlanModeController owns plan state. Planning guidance and tool approval policy apply independently. The UI transports explicit commands only; it does not classify ordinary prose as authorization or task state. Review tests and actual outcomes before accepting a goal marked complete.

The menu groups additions, commands, skills and saved tasks. Its main entries are File, Goal, Plan, Compact, Permissions, Model and Export. Skills and saved tasks reflect actual configuration; unavailable features are omitted. Pause, resume and clear remain on the goal strip; the blue Plan indicator exits plan mode.

Selecting a new goal or plan shows a blue input prefix and contextual placeholder. Click the prefix or press Backspace in the empty input to exit. For an unfinished goal, selecting Goal or clicking the status strip opens an Edit goal tab in the right workspace panel. The large editor supports undo and save, with confirmation before discarding unsaved edits. Saving never starts or resumes execution. Conflicts preserve the draft and offer a fresh goal read. Ordinary message drafts remain intact.

File attachment, permissions and model selection reuse existing controls. Export downloads the current conversation as JSON. Explicit `/goal edit revised objective` and `/goal clear` commands remain supported; clearing retains conversation and project files.

The slash menu also lists Toolbox skills, MCP servers and built-in tools in separate groups, searchable by name and description. Disabled entries are labeled. Selecting an entry opens its existing Toolbox details without enabling or invoking it. Project skills use the conversation directory. Lists load independently and partial failures offer a retry notice.

Plan review displays Markdown in a dedicated card with numbered Approve and implement and Keep planning choices below it. The first choice is marked Recommended; choose an option and press Send. A persistent response field accepts your own ideas; responses with feedback stay in plan mode. Approval sends the native Harness choice, and Harness continues to own plan and execution state.
