# Completion gates removed

On 2026-11-10 the user requested removal of completion review and independent script verification, including their settings and prompt configuration. Tasks use native Harness completion without additional reviewer calls or verifier execution. Legacy settings are inert; history is preserved.

Permissions, sandboxing, command outcomes, tool/model protocol validation, empty-response recovery, cancellation and compaction remain. Agents can still run project tests. Reviewer outages and verifier failures no longer block delivery; their false-completion safeguards are also removed.
