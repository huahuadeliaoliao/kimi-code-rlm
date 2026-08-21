---
name: write-goal
description: Help the user draft or refine a `/goal` objective with a clear finish line, proof, boundaries, and stop rule. Do not use for running, continuing, checking, or completing an existing goal.
---

# Write a good goal

Help the user turn a rough intention into a `/goal` objective that can be pursued across many turns without supervision. A goal is a completion contract: it says what must become true, how that is proven, what the work may touch, and when to stop and report instead of continuing blindly.

Drafting and starting are separate. Settle the wording with the user first. Call `CreateGoal` only after they have approved the exact objective.

## Conversation

Ask only for information that would materially change the goal. Use a short plain-text question for missing facts or concrete choices, group closely related choices when that makes answering easier, and wait for the answer. Do not bury several decisions in a long explanatory paragraph. Open-ended input is appropriate when no honest options can be prepared yet.

- Help only when the user asks to write or refine a goal. Do not turn an ordinary request into a goal on your own.
- Write the draft in the user's language.
- Show the full objective before starting it, not a paraphrase.
- Explain consequential choices briefly and revise from the user's feedback.
- If the user accepts a looser goal after one warning about the trade-off, use their wording rather than silently expanding it.

## What makes a goal good

Strong goals define proof rather than effort. “Keep improving the code” never establishes an end. “Done when `npm test` exits 0 and no file outside `src/auth` changed” is observable.

Cover only the parts the task needs:

1. **End state** — the concrete condition that must become true.
2. **Proof** — observable evidence such as a command exit code, test count, zero-match search, file, or measured threshold.
3. **Boundaries** — allowed scope and actions that are off limits.
4. **Loop** — for iterative work, how to repeat work and checks.
5. **Stop rule** — when to stop honestly and report a blocker instead of forcing a pass or widening scope.

Queue-shaped goals work well because progress and completion are countable: failing tests, files to migrate, issues to close, rows to process. Existing tests, CI, type checks, linters, evals, browser checks, and searches are useful completion evidence. If no realistic proof exists, help the user add one or reconsider whether goal mode fits.

Do not put arbitrary turn or token budgets into the objective. A well-specified goal stops when its proof passes or a genuine blocker remains.

## Workflow

1. Understand the intended outcome and what would prove it. Ask a short question if a missing fact changes the contract.
2. Draft a readable objective: one or a few sentences for simple work, or a short block for end state, checks, boundaries, and stop rule.
3. Show the exact draft and explain only the choices that matter.
4. Revise until the user approves it.
5. Call `CreateGoal` with the agreed objective and a `completionCriterion` when one was agreed. Do not start before approval, and do not merely print text for the user to paste.

## Reusable shape

```text
<What must become true.>
Done when <command, search, or state that proves it>.
Scope: only <files or area>; do not <off-limits action>.
Loop: <how to iterate and re-check>.
If <blocking condition>, stop and report instead of forcing a pass.
```

Not every goal needs every line. Add structure only as task size or the cost of a wrong autonomous run increases.

## Examples

- Weak: `Find all bugs in this codebase.`
  Strong: `Fix every test in test/auth that currently fails, rerun npm test until it exits 0, change no file outside test/ or src/auth, and report anything you cannot fix with its location and why.`
- Weak: `Optimize the project.`
  Strong: `Migrate the payment module to the new API, make npm test -- payment exit 0, keep the diff limited to payment-related files, and stop and ask before touching shared infrastructure.`
- Weak: `Make it faster.`
  Strong: `Make renderFrame at least 3x faster measured by the bench/render benchmark; if that is not reached after several evidence-backed attempts, report the best result and the remaining limit.`

## Common mistakes

| Mistake | Better |
| --- | --- |
| Starting or suggesting a goal the user did not request | Wait for an explicit request |
| Drafting in a different language | Match the user's language or project preference |
| Starting before the exact text is approved | Show the full draft and wait |
| Silently overriding the user's final wording | Note the trade-off once, then respect it |
| Burying a concrete choice in prose | Ask a short question with clearly labelled options |
| Specifying effort | Specify observable proof |
| No blocked path | Add an explicit stop-and-report condition |
| No way to verify completion | Anchor the goal to an inspectable check |
