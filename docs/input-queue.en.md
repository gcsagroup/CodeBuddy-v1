# Message queue and immediate switching

Ordinary sends during execution wait in order. Switch now selects one item; Send all now snapshots all pending items at click time. The selection is persisted before cancelling the current execution and its children. A new turn starts in the same conversation only after settlement. Completed external actions are not undone.

Pending items support editing, removal, reordering and clearing. Selected or dispatching items are frozen. Failed saves preserve the editor. Batches retain separate message IDs, ordering and attachments; later arrivals do not join a frozen batch.

Stop and restart preserve drafts for explicit submission. Unknown delivery is reconciled against native records rather than automatically replayed. Retries reuse the command ID. Legacy browser queues migrate only after backend acknowledgement.

Harness continues to own execution and tool permissions. The delivery ledger manages inputs before native admission; only native consumption receipts establish consumption. Cancellation cannot guarantee immediate release of remote model compute or undo completed tool effects.

Opening the editor first pauses the queue so completion cannot send the old text. After saving or cancelling, explicitly send the saved drafts to continue.

If a direct prompt takes ownership during queued delivery persistence, pending inputs wait for it to finish instead of becoming uncertain or paused. Selected batches retain their order and do not cancel a new run that was not observed when selected.

Queued submissions are durably staged locally before clearing the composer immediately. Acknowledgement never clears newer input; local storage failure preserves the original draft. New text remains editable while confirmation is pending, but submitting it waits for confirmation. Rejected or unacknowledged messages remain available through Refresh / Retry confirmation.
