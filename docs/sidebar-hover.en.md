# Sidebar conversation hover

Conversation rows retain a 4px inset from the scroll viewport's right edge, removing stacked right margins. Pin and archive actions occupy space only during hover or keyboard focus within the row, leaving more room for titles otherwise.

Overflowing titles start moving linearly as soon as the pointer enters the row. The previous 600ms delay and initial keyframe pause are removed. Leaving resets the title. Reduced-motion preferences disable movement while the information card still provides the full name.

The card anchors to the complete row so that shrinking the title for action buttons cannot move the card over those buttons. It shows the complete name, latest update as relative and exact time, workspace alias and full path. Relative time refreshes when the card opens, without permanent per-row timers. Missing metadata remains explicitly unknown or unbound. Long content wraps, collision handling keeps the card inside narrow windows, and Escape dismisses it.

Timestamp selection uses the first valid value among `updatedAt`, `lastMessageAt` and `createdAt`. Existing metadata and Tooltip are reused. Backend protocols, persistence and session deletion remain unchanged.
