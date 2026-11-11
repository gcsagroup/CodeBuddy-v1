# Context compaction recovery

Pinned Harness 0.2.1-alpha.2 retains ownership of range selection, tool pairing, surface replacement and persistence. Changes use its summarize extension and the hash-checked compatibility loader, without upgrading dependencies or adding another conversation state machine.

The default summary cap is 32768 tokens (user adjustment on 2026-11-10; headroomTokens remains 1024), limited to a quarter of a small context window. The cap includes provider-counted reasoning. Low reasoning is selected only when declared supported; task settings stay intact. This can reduce prefix cache reuse on some servers. A confirmed exhausted cap permits one doubled attempt, bounded by 32768 tokens and half the context window. Adapter admission still checks the full input and output reservation.

Empty summaries, early server truncation and exhausted retries never commit a checkpoint. Subsequent automatic attempts on the same route in the same turn do not repeatedly pay for the same failure; idle, route changes and explicit manual compaction allow another try. Network and permission errors retain their classifications. No automatic model switching occurs.

Manual failure retains its real cause. One inline receipt with collapsed technical details replaces the duplicate Submit error banner. Diagnostics include purpose, model, budget, reasoning setting, usage and character counts, excluding bodies and credentials. Tests cover truncation, empty responses, cancellation, tool pairing, original instructions, request fit, restart and continuation. Installed acceptance is recorded separately; unavailable original coworker environments remain unverified.

Reference: [Harness compaction design](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md).
