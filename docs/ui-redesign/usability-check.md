# Usability check: the five baseline tasks

Goal: the redesigned UI is not harder to use than the old one, for the five tasks of `measurement.md`. The Foundry delivers the script, the result table and the automated effort check. The owner runs the sessions with people in a follow-up issue (see "Where to record the result"). **Turning the redesign on by default waits for that result.**

## Automated effort check

`npm run test:ui` runs `tests/browser/journeys.spec.ts`. It walks the five tasks in the real UI with the seeded data and counts navigation steps, clicks and typed fields through one helper (`tests/browser/journey.ts`) that wraps click, fill and goto. The test fails when a count is higher than the baseline in `tests/browser/journeys-baseline.ts`. `tests/ui-redesign-audit.test.ts` checks that this file and the table in `measurement.md` agree.

Two tasks are not green yet. Both are `test.fixme`, and each is an open gate for the default rollout:

- **Task 1, Start work:** 2 / 3 / 1 against a baseline of 1 / 2 / 1. One more step and one more click. Follow-up issue: "UI quality 4c follow-up — Start work takes one more step and click than the baseline".
- **Task 2, Approve a waiting run:** not measured. "Show request" is only offered for a run that a watcher started for a GitHub issue; the harness runs without watchers. It needs a watcher-backed fixture.

The redesign counts below are what the test is written to measure. They were taken from reading the UI code and are not yet confirmed by a browser run. Check them against the first `npm run test:ui` run.

## How to run the sessions

- **Who:** one person per session. A user for tasks 1, 4 and 5, an admin for tasks 2 and 3. Someone who has not seen the redesign. Run the old UI and the redesign with the same kind of people, and mix the order.
- **What to say:** read the task and the end state, nothing more. Do not name a page or a button. Do not explain anything first.
- **Set up:** the fixture in `journeys.md`, signed in, at the start URL, at 1440×900. Reset the data between tasks.
- **What to record:** seconds from "go" to the end state, the pages opened in order, every error, the confidence and the clarity.

## The five tasks

| # | Task | Role and start | End state that counts as done |
|---|---|---|---|
| 1 | Start work | user, `/user/`, Empty variant | The run page of the new run is open |
| 2 | Approve a waiting run | admin, `/` | The waiting run is approved (dialog closed, toast "Done — continuing") |
| 3 | Diagnose a failed run | admin, `/` | The failing step is open (its transcript or error shown) |
| 4 | Add a repository | user, `/user/` | `example/new-app` (not in the fixture) shows in the list (toast "Repository added") |
| 5 | Refine an idea into a story draft | user, `/user/` | A story draft with a title is shown in the session |

## What counts as an error

A wrong page opened, a wrong control used, or asking for help. Each is counted once.

## Questions after each task

- **Confidence:** "How sure were you that you did it right, 1 (not at all) to 5 (completely)?"
- **Clarity:** "How clear was it what to do next, 1–5?" Ask it once per task, so five answers per session.

## Result

Effort is navigation steps / clicks / typed fields. The effort columns come from the automated counts. The people columns are empty on purpose; the owner fills them in. Fill one row per task and per UI (baseline and redesign).

| Task | Baseline: done | Baseline: seconds | Baseline: errors | Baseline: confidence | Baseline: effort | Redesign: done | Redesign: seconds | Redesign: errors | Redesign: confidence | Redesign: clarity | Redesign: effort |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 Start work | | | | | 1 / 2 / 1 | | | | | | 2 / 3 / 1 (above, `test.fixme`) |
| 2 Approve a waiting run | | | | | 1 / 2 / 0 | | | | | | 1 / 2 / 0 (not measured, `test.fixme`) |
| 3 Diagnose a failed run | | | | | 2 / 3 / 0 | | | | | | 2 / 3 / 0 |
| 4 Add a repository | | | | | 2 / 5 / 2 | | | | | | 2 / 4 / 2 |
| 5 Refine an idea into a story draft | | | | | 3 / 5 / 2 | | | | | | 3 / 5 / 2 |

The baseline has no clarity question, so there is no baseline clarity column. The table in `measurement.md` stays as it is.

## Pass rule

The redesign passes when all of this is true:

- Every task completes.
- Errors are not above the baseline.
- Navigation effort is not above the baseline (the automated check).
- Confidence is not below the baseline.
- Clarity is at least 4 of 5 on average (over the five tasks and all people).

Write down every miss.

## Where to record the result

In the follow-up issue "UI quality 4d — Usability sessions for the five baseline tasks" (no `Factory_go` label). The Foundry could not open it; open it with this link, then post the filled-in table there:

<https://github.com/MeloMar-IT/spaghetti-code-foundry/issues/new?title=UI%20quality%204d%20%E2%80%94%20Usability%20sessions%20for%20the%20five%20baseline%20tasks&body=Follow-up%20of%20%23400%20%28part%20of%20%23267%29.%20Run%20the%20sessions%20in%20%60docs%2Fui-redesign%2Fusability-check.md%60%20and%20post%20the%20filled-in%20result%20table%20here.%0A%0A-%20%5B%20%5D%20All%205%20tasks%20done%2C%20each%20with%20time%2C%20errors%2C%20confidence%20and%20clarity%0A-%20%5B%20%5D%20The%20pass%20rule%20is%20checked%0A-%20%5B%20%5D%20Turning%20the%20redesign%20on%20by%20default%20waits%20for%20this%20result>
