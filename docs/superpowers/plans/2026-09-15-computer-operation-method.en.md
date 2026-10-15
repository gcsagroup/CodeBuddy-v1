# Computer operation method constraints

Status: automated checks, Clippy, backend rebuild, and isolated native scenarios passed for this slice. Real-model interpretation and an autonomous end-to-end workflow remain NOT_RUN.

The [official OpenAI computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use) was checked on 2026-09-15. The runtime retains state and enforces constraints; screen and tool text cannot authorize actions. This implementation adopts host execution checks and actual outcome verification. It does not adopt the sample script execution path when the user explicitly prohibits scripts. No private Codex behavior is assumed, external code copied, or dependency added.

## Behavior and boundaries

The existing unified turn goal and continuation relationship carry computer_operation_method. Requiring computer control permits registered computer keyboard actions; mouse-only permits mouse actions, necessary focus, stopping, and observation. Both retain host-classified read-only tools and block direct file mutation, shell, code execution, and delegation bypasses. Model tool presentation and actual dispatch share the same rule; nested calls inherit the method. The application tool catalog remains a catalog, not execution permission for the current task. Existing approval and computer safeguards still apply. Manual approval cannot lift the method constraint.

Only finite, explicit user phrases are recognized, including “must use computer control”, “only use the mouse”, and the explicitly supported continuation forms “继续，但必须只用鼠标” and “继续，解除操作方式限制”. Tool output cannot establish or lift a constraint. Arbitrary longer text containing these phrases is not automatically a continuation.

Continuations retain the original goal and method. Explicit changes in a visible, bound user message atomically update only the method, comparing session, original source, and turn identity. Other state is preserved. Bound changes and releases persist even when the provider is unavailable, and are used after recovery. A new unified goal resets the method; accepted new SimpleChange/Test/Change goals retire the previous method, while clarification does not lift it early. Plain continuation of legacy messages without IDs retains the method. Failure to read or parse an existing method does not imply permission.

## Automated evidence

The valid RED used the public entry point to change a real isolated file from original to guarded. Insufficient test turn budget was a fixture error. Intermediate failures that lost continuation state or hid Platform developer reads are retained. Two earlier backend builds were deliberately interrupted and remained incomplete; neither is counted as a pass or test failure.

Final frozen source: method 8 passed, SimpleChange 39 passed, preflight 13 passed, unified 10 passed; fmt, Clippy, and backend build exited 0. The preceding implementation checkpoint passed ExtensionManager 65, tool_task 33, analysis 1, and ACP 59+55. An incorrect context-test filter matched zero and is recorded as NOT_RUN; the corrected real module passed 12 tests. Filters overlap, so their counts are not summed as distinct tests.

Public-entry tests use a scripted provider to verify rejection, lifting and restoring restrictions during provider failure, and actual file content after recovery. A host route test covers a new accepted goal. Atomic-update tests reject late turns, old source goals, and other sessions; tool text and nested dispatch cannot bypass the method. These fixtures do not prove real-model interpretation.

Evidence directory: .cargo/evidence/audit-fixes-20260914/. method-final-gates.json records each command, cwd, timestamps, and exit code. method-source-frozen.json and method-frozen-verification.json verify seven source files. Final binary SHA256: E865D59C515942E2244A3B31D996F71A509591A7DDDF809052453E801FD3256E.

## Isolated native acceptance

The real Electron window and rebuilt goose.exe executed actual ACP calls from an isolated CodePro persisted-state fixture. read_document returned original. Keyboard, typing, and direct writing returned method-specific policy_denied before approval; focus and UI text were unchanged and the actual file stayed original. The unqualified write denial retains the existing unknown::tool audit sentinel; raw evidence retains the requested tool and explicit method reason.

The first mouse call was rejected by the existing expired desktop-observation safeguard before input. After refreshing observation, a click opened History: the receipt reported worked and a new “导入链接” button appeared in the real UI. This was a corrected acceptance precondition, not a product regression. After releasing the ACP session, the task was loaded and refreshed in the UI. Its original goal and mouse_only state remained intact, as did the sampled other session. Owned windows and backends were closed.

See method-native-summary.json, method-native-call-02/03/04/05/09/13.json, method-native-mouse-result.png, and method-native-reloaded.png. Native real-model release on a new goal was not run; that boundary has automated evidence only. The model identifier is the isolated fixture-preserved value. Neither the stopped 120 endpoint nor substitute 107 was probed.
