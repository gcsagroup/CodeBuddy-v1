# Natural-language long-term preference routing failure

Date: 2026-09-12
Status: Read-only audit complete; no fix implemented
Acceptance evidence: `D:\CodeBuddy\.cargo\evidence\memory-candidate-native-20260912-resume\acceptance-status.md`

[繁體中文 (default)](2026-09-12-memory-natural-routing-failure-analysis.md) · [简体中文](2026-09-12-memory-natural-routing-failure-analysis.zh-CN.md)

## 1. Conclusion

This was not merely random model drift. It has two distinct layers:

1. **Deterministic routing defect:** the user explicitly said, “remember a long-term user preference,” but `is_project_memory_management_request` does not recognize that scope phrase, so the request never entered the memory-only execution path.
2. **Model-dependent manifestation:** `qwen3.5:397b` subsequently classified the request as `ComplexChange`, planned a coding workflow, and created `goose/preferences.yaml`. Another model might manifest the failure differently, but the missing deterministic guard still allows the memory path to be bypassed.

A controlled prompt that names `project_memory_remember` proves that the backend tool and state transition work. It does not validate the natural-language user experience.

## 2. Verified facts

### Original request and model

- Parent session: `20260912_3`.
- Original request: `Please explicitly remember a long-term user preference: use “已确认偏好-ACT-K3M9” on the first line of future answers. I explicitly authorize writing this long-term user preference.`
- Provider: `custom_454541111`.
- Model: `qwen3.5:397b`, `thinking_effort=high`, `toolshim=false`.
- Working directory: isolated `project-a`.

### Actual call chain

1. `is_project_memory_management_request` requires both a memory-scope phrase and a memory-action phrase.
2. Scope phrases include project memory, long-term memory, cross-chat memory, and cross-session memory, but not long-term user preference or user preference.
3. The original request therefore returned `false` despite containing an explicit “remember” action.
4. `reply_codepro_with_intent_core` did not override the outer intent and did not enable `codepro_project_memory_management()`.
5. The memory path would have retained only `project_memory_*` tools and added a system rule forbidding workspace files as a memory substitute. That path was not entered.
6. The outer model treated the request as `ComplexChange` and created planner, coder, tester, and report sessions.
7. The parent session issued no `project_memory_remember` request. Child sessions used only `tree`, `write`, `read_document`, and `shell`, ultimately creating `project-a\goose\preferences.yaml`.

### Scope and persistence outcome

- The failed scenario did not write Project Memory, so it produced no actual memory scope.
- It created a project-local file, incorrectly turning a user preference into project-scoped state.
- A controlled retry explicitly called `project_memory_remember` with `scope=user` and `user_confirmed=true`, producing `source=user_explicit` and `status=active`.
- Candidate behavior, activation, cross-project recall, and restart persistence passed backend acceptance; natural routing remained failed.

## 3. A second prompt and tool-design defect

Adding one keyword is insufficient. The current memory-only system addendum also says that explicit saves should use the current-project scope. That conflicts with the tool schema's support for long-term user preferences.

The schema already states the correct boundary:

- Project is the default scope; long-term low-risk interaction preferences may use user scope.
- `user_confirmed=true` is set only when the user explicitly confirms a user-scoped preference.

The fix must remove the blanket current-project instruction and distinguish:

- Long-term user preference: `scope=user`; set `user_confirmed=true` when the current message explicitly authorizes it.
- Project rule or project context: `scope=project`.
- Automatically inferred low-risk habit: `scope=user`, omit `user_confirmed=true`, and create a candidate.

## 4. Comparison with public Codex behavior

Official OpenAI documentation separates required instructions from generated memories. Guidance that must consistently apply belongs in `AGENTS.md` or checked-in documentation; memory is a supporting recall layer. Local Codex memory also separates whether chats may generate memories from whether existing memories may be used in future sessions.

CodeBuddy should keep the same boundary: an explicit request to save a long-term preference should create structured user memory. It should not be interpreted as a request to develop a project configuration file, and it must not silently modify `AGENTS.md`.

Public sources:

- [OpenAI Docs: Memories](https://learn.chatgpt.com/docs/customization/memories)
- [OpenAI Docs: Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

## 5. Minimal fix scope

### Required changes

1. Extend natural-language memory detection to recognize explicit user-memory scope phrases such as long-term user preference, user-level preference, and my long-term preference. Continue requiring a save action such as remember, save, or write.
2. Change the memory-only system addendum to preserve the scope expressed by the user instead of defaulting every explicit save to the current project.
3. For an explicit long-term user preference, instruct the model to use `scope=user`; set `user_confirmed=true` only when the current message explicitly authorizes it.
4. Keep the memory-only tool allowlist so these requests cannot access `write`, `edit`, `shell`, task decomposition, or subagent workflows.

### Out of scope

- No Project Memory storage-format change.
- No candidate/active state-machine change.
- No vector database or new preference configuration file.
- Do not delete the failed run's `goose/preferences.yaml`; retain it as primary evidence.

## 6. Minimal regression suite

1. **Intent unit test:** the exact natural request must classify as memory management. “I prefer concise answers” without a save action, `save README.md`, and a one-session code phrase must remain negative.
2. **Routing test:** the exact request must enter the unified memory path and must not create a `ComplexChange` DAG or child session.
3. **Tool allowlist test:** expose only `project_memory_search/remember/forget/clear/stats`; expose no workspace write tool.
4. **Prompt snapshot test:** require an explicit user/project scope distinction and remove the blanket current-project rule.
5. **Backend integration test:** a mock provider should issue exactly one `project_memory_remember` call for the natural request; assert `scope=user`, `user_confirmed=true`, `status=active`, and no new workspace file.
6. **Real Electron regression:** enter the exact natural request and approve only once. The parent session must call `project_memory_remember` directly, create no child session, create neither `goose/preferences.yaml` nor `AGENTS.md`, and recall the preference in project B after restart.

## 7. Completion gate and estimate

This defect should be fixed before starting another memory feature. The minimal implementation is approximately half a working day; automated gates plus real Electron regression should fit within one working day. “Explicit long-term user preferences work” cannot be marked complete until the natural-language scenario passes.
