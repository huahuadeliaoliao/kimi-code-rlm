Set the status of the current autonomous goal.

- `active` resumes a paused or blocked goal only when the user explicitly asks to work on it again.
- `complete` ends the goal. Use it only when every explicit requirement is satisfied, required validation has passed, and no useful action remains. A plan, summary, first pass, partial result, weak evidence, or an exhausted budget is not completion.
- `blocked` records a genuine impasse. Use it immediately when the objective itself is impossible, unsafe, or contradictory. For other blockers, the same external condition, required user input, missing credential or permission, or persistent technical failure must prevent useful progress for at least three consecutive goal turns. A resumed goal starts that count again. Large, hard, slow, uncertain, incomplete, or still-unvalidated work is not blocked.

Do not call this tool to record progress, checkpoint a phase, or request another turn. Leave an active goal unchanged and continue working; the runtime manages continuation boundaries. When the blocking threshold is met and no meaningful action remains without an external change, call `blocked` instead of leaving the goal active.

After `complete` or `blocked`, write the corresponding concise completion summary or blocker explanation. The tool call is the machine-readable state transition; your following text explains it to the user.
