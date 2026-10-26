# Reasoning-only model responses: diagnosis and presentation

Date: 2026-10-26. Source baseline: `189096734438abafbb3580851cdce150f4ffd520`, `main`, including pre-existing uncommitted work and this patch.

## Verified observations

The supplied drawing conversation contains two turns, each with an initial attempt and five native retries. All 12 native `assistant/attempt` records contain reasoning only, with replay signature `reasoning` and original stop reason `stop`, subsequently classified as `EMPTY_RESPONSE`. There are no native `tool/call` or `tool/result` events. Protocol markers and tool names inside text are not tool invocations. Service-reported output tokens total 46,118; this is not a cost calculation.

The selected connection was Ollama Cloud's OpenAI-compatible endpoint with model ID `kimi-k3`. Three subsequently authorized short probes all returned HTTP 200 and completed normally: a text request returned content, a default-thinking tool request returned a structured call, and a tool request with `reasoning_effort: none` also returned a structured call. No tools were executed, the original conversation was not sent, and credentials were not saved.

The historical reasoning-only failure is established. A transient upstream fault, context-dependent generation/parsing failure, and loss of a particular stream shape in the client remain to be distinguished. Successful short probes do not establish recovery of the original task; the native journal is not raw upstream SSE. A recurrence should compare raw fields and adapted blocks for the same request.

## Changes and boundaries

- `runtime/work-status.mjs` uses existing diagnostic counts to explain reasoning-only output only when the native failure is `EMPTY_RESPONSE` and the counts are complete. Missing or contrary observations retain generic wording. Retry counts remain native facts; only native termination announces that the turn stopped and suggests retrying, switching models, or checking the service output format.
- `GooseMessage.tsx` displays execution failure without failed verification evidence as Needs attention / Not completed. Tests failed requires a failed entry in structured `verification_summary`. Existing English and Chinese translations are reused. `INCOMPLETE` is a display-only distinction, not a persistence or public protocol change.
- Regression coverage includes `reasoning`, `reasoning_content`, `reasoning_text`, real Harness stream adaptation, retries, cancellation, session isolation, and component rendering.

Harness retains completion, failure, and retry authority. Observation counts only explain failure. Reasoning text never becomes answer text, executable tool calls, or authorization. Original records and unrelated edits remain intact.

## Options considered

The patch reuses the pinned MIT-licensed DSH `0.2.1-alpha.2` field boundaries, validation and retry facilities without new dependencies or execution loops. Parsing tool markers out of reasoning would turn prose into actions and is not adopted. Automatically disabling thinking or changing models would override user choices, and successful short probes do not justify it.

The native five-retry policy remains unchanged. Globally lowering retries would also affect transport, rate-limit and server recovery. Per-error limits need a separate assessment of native policy facilities and boundaries, rather than a second retry state machine inside a presentation fix.

## References and verification

- [Ollama OpenAI compatibility](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)
- [Ollama tool calling](https://github.com/ollama/ollama/blob/main/docs/capabilities/tool-calling.mdx)
- Pinned upstream documentation: `runtime/harness/node_modules/@deepseek-ai/dsh-llm-retry/README.md`. Public latest source is not evidence of the installed version.

## Verification results

Final checks used the existing Node 24.18.0 runtime: 45 backend tests and 64 frontend tests across four files passed; TypeScript, targeted ESLint and `git diff --check` also exited 0. Backend `node --test` targets were `runtime/tests/work-status.test.mjs` and the Harness `response-channels`, `model-response-validation`, `empty-response-recovery` and `recovery` tests. Frontend `vitest run --maxWorkers=1` targets were `GooseMessage.test.ts`, `GooseMessage.handoff.test.tsx`, `GooseMessage.stream.test.tsx` and `codeProPresentation.test.ts`. TypeScript used `tsc --noEmit`; ESLint used `--max-warnings 0 --no-warn-ignored` on affected files.

Two initial explicit runner paths incorrectly assumed `ui/desktop/node_modules` and exited 1. Dependencies were confirmed at `ui/node_modules`, after which the commands passed without installing or rebuilding dependencies. The first frontend run passed on default Node 22 with an engine warning; it was repeated successfully on Node 24.

The actual desktop was started through the standard `startPreview` export of `scripts/start-harness-preview.cjs`, using the current dirty source tree and an isolated data directory. A local HTTP model fixture made no cloud requests and executed no tools. Composer submission, recovery through a new user turn, and reload checks all exited 0. Native records contain six failed attempts, five retries, zero tool calls and two terminal outcomes: error followed by completed. The fixture received seven streaming requests. The UI displayed Needs attention / Not completed with the reasoning-only notice; the next turn produced real answer text and cleared the notice; reload preserved the records. Screenshots were reviewed. Dependency sourcemap warnings appeared during development startup; no renderer exception related to this patch was found. Dependencies were not changed to address those warnings.

Local probes, isolated profiles, logs and screenshots reside in `.preview-evidence/response-diagnosis-20261026/` and are excluded from commits. No branch, commit, push, release package or installation was created. The original request's upstream cause still requires reproduction. This patch improves diagnostic and presentation accuracy; it does not claim to fix the underlying model-generation anomaly.

The isolated preview is closed: desktop and standard launcher both exited 0 and the launch receipt reports stopped. The CDP close helper exited 1 because the target closed before acknowledging the request; desktop exit status and the launch receipt independently confirm successful shutdown.
