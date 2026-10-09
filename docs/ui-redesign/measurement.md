# Measurement

**Status: partial.** Measured time, errors, confidence, overflow and layout-shift observations, and screenshots at the four widths are open. They need people and a browser. What is here: counts taken from code, modelled times (an estimate, not measured), the protocol, and the lists to capture.

## Widths

| Width | Name | Why |
|---|---|---|
| 1440 | desktop | Wider than any rule in `ui/style.css`. The guide images in `docs/images/` are taken at this width |
| 1280 | laptop | Still above 1100, so the same layout as 1440 is expected; shows content that only just fits |
| 768 | tablet | Between 760 and 1100: the `max-width: 1100px` rule applies (`style.css:288`) but not the 760 rule |
| 390 | mobile | Below 760: both rules apply (`style.css:292`, `:381`) |

The four widths sit on both sides of 1100 and 760, so each width tests a different rule set.

## Measures

| Measure | Definition | How taken | Status |
|---|---|---|---|
| Routes, dialogs, native dialogs | Rows in `inventory.md` and `dialogs.md` | Read from code; `tests/ui-redesign-audit.test.ts` compares them with the code | taken |
| Inline styles | `style:` uses per file | `grep -o 'style *:' ui/*.js ui/user/*.js \| sort \| uniq -c` | taken |
| Journey steps | Navigation steps, clicks and fields per journey | Read from handlers (`journeys.md`) | taken |
| Modelled time | Keystroke-level sum per task | Below; estimate | taken (estimate) |
| Overflow | `document.documentElement.scrollWidth > clientWidth`, plus clipped controls, per route and width | Browser, fixture data, 4 widths | open |
| Layout shift | The browser's layout-shift entries over 10 s on load and across one polling tick, per route | Browser performance observer | open |
| Measured time | Seconds from start state to end state | Sessions with people | open |
| Errors | Wrong page opened, wrong control used, asked for help | Sessions with people | open |
| Confidence | 1–5, asked after each task | Sessions with people | open |

## Existing screenshots

All 19 files in `docs/images/`, one per entry of `SHOTS` in `scripts/screenshots/shots.ts`. They are made by `npm run test:ui -- --grep @guide` from a seeded server (`tests/browser/seed.ts`): 1440 px wide, light theme, default density. They are desktop only.

| File | Route shown | Used in | Status |
|---|---|---|---|
| `board.png` | `#/board` | `docs/USER_GUIDE.md`, `README.md`, `docs/DESIGN.md` | captured from the redesign |
| `dashboard.png` | `#/dashboard` | `docs/USER_GUIDE.md` | captured from the redesign |
| `flow-yaml.png` | `#/flows/:name`, YAML view | `docs/USER_GUIDE.md` | captured from the redesign |
| `flows.png` | `#/flows/:name`, editor | `docs/USER_GUIDE.md`, `README.md`, `docs/DESIGN.md` | captured from the redesign |
| `home.png` | `#/home` (admin) | `docs/USER_GUIDE.md`, `README.md`, `docs/DESIGN.md` | captured from the redesign |
| `library.png` | `#/library` | `docs/USER_GUIDE.md` | captured from the redesign |
| `models.png` | `#/models` | `docs/USER_GUIDE.md` | captured from the redesign |
| `repos.png` | `/user/#/repos` | `docs/USER_GUIDE.md` | captured from the redesign |
| `run-dialog.png` | the "Run <flow>" dialog | `docs/USER_GUIDE.md` | captured from the redesign |
| `run-diff.png` | `#/runs/:id`, Changes tab | `docs/USER_GUIDE.md` | captured from the redesign |
| `run-log.png` | `#/runs/:id`, Live log tab | `docs/USER_GUIDE.md` | captured from the redesign |
| `run-steps.png` | `#/runs/:id`, Steps tab | `docs/USER_GUIDE.md` | captured from the redesign |
| `run-waiting.png` | `#/runs/:id`, waiting for approval | `docs/USER_GUIDE.md`, `docs/DESIGN.md` | captured from the redesign |
| `runs.png` | `#/runs` | `docs/USER_GUIDE.md` | captured from the redesign |
| `settings.png` | `#/settings` | `docs/USER_GUIDE.md` | captured from the redesign |
| `sign-in.png` | the sign-in page | `docs/USER_GUIDE.md` | captured from the redesign |
| `user-home.png` | `/user/#/home` | `docs/USER_GUIDE.md` | captured from the redesign |
| `watcher-form.png` | the "Add a watcher" dialog | `docs/USER_GUIDE.md` | captured from the redesign |
| `watchers.png` | `#/watchers` | `docs/USER_GUIDE.md`, `docs/DESIGN.md` | captured from the redesign |

This is not a baseline for the four widths: there is no tablet or mobile image, and most routes and states are not shown.

## Capture list (open)

Every row at 1440, 1280, 768 and 390. The guide images cover 1440 only: `tests/browser/guide-shots.spec.ts` captures the 19 entries of `SHOTS` (`scripts/screenshots/shots.ts`). The other widths and the rows below are open.

| Shot | Route | Fixture state |
|---|---|---|
| admin-your-turn | `#/your-turn` | two items (approval, failed) |
| admin-board | `#/board`, `#/board/:id` | one repository |
| admin-refinement-list | `#/refinement` | one session |
| admin-refinement-session | `#/refinement/:id` | one story draft |
| admin-flows-welcome | `#/flows` | three flows |
| admin-flow-editor | `#/flows/:name`, `#/new` | `example-task` |
| admin-library | `#/library` | built-in blocks |
| admin-start | `#/start` | one published flow |
| admin-runs | `#/runs` | four runs |
| admin-run | `#/runs/:id` | one each of done, failed, waiting, running |
| admin-my-repos | `#/repos` | `example/app` |
| admin-all-repos | `#/all-repos` | two accounts |
| admin-credentials | `#/credentials` | one stored credential (fake) |
| admin-watchers | `#/watchers` | one repository watcher |
| admin-settings | `#/settings` | default config |
| admin-problems | `#/problems` | no findings; one finding |
| admin-models | `#/models` | default config |
| admin-dashboard | `#/dashboard` | four runs |
| admin-users | `#/users` | two accounts |
| admin-audit | `#/audit` | a few entries |
| user-start | `/user/#/start` | Empty variant |
| user-runs | `/user/#/runs` | four runs |
| user-run | `/user/#/runs/:id` | waiting; failed |
| user-repos | `/user/#/repos` | `example/app` |
| user-refinement | `/user/#/refinement`, `/user/#/refinement/:id` | one session |
| sign-in, first-setup, set-password | no route | signed out |
| change-password | dialog | signed in |
| health-bar, since-strip | no route | one problem; one change |
| preview-bar, preview-ended | `/user/?as=<id>` | admin preview; ended view |
| dialogs | all rows of `dialogs.md` | one shot each at 1440 and 390 |

## Privacy rules for captures

- The fixture data only: the accounts Test Admin (`admin@example.com`) and Ann (`ann@example.com`), the repository `acme/app`, and runs named "Seeded … run".
- Host paths (the temporary folder, the home folder, the checkout) are rewritten to demo paths before a capture, and the capture fails when one is still on the page.
- No real e-mail addresses, repository names, paths, logs, diffs or credentials.
- No other product's logo or screenshot.
- This repository is public; a capture is published when it is committed.

## The five tasks

Fixture and variants are in `journeys.md`. Viewport 1440×900. Counts are copied from there.

| # | Task | Role and start | End state that counts as done | Nav steps | Clicks | Fields |
|---|---|---|---|---|---|---|
| 1 | Start work | user, `/user/`, Empty variant | The run page of the new run is open | 1 | 2 | 1 |
| 2 | Approve a waiting run | admin, `/` | The waiting run is approved (dialog closed, toast "Done — continuing") | 1 | 2 | 0 |
| 3 | Diagnose a failed run | admin, `/` | The failing step is open (its transcript or error shown) | 2 | 3 | 0 |
| 4 | Add a repository | user, `/user/` | `example/new-app` (not in the fixture) shows in the list (toast "Repository added") | 2 | 5 | 2 |
| 5 | Refine an idea into a story draft | user, `/user/` | A story draft with a title is shown in the session | 3 | 5 | 2 |

## Modelled time

**Estimate, not measured.** Keystroke-level operators: K 0.28 s per keystroke (an average typist), P 1.1 s to point, H 0.4 s to move a hand between mouse and keyboard, M 1.35 s of thinking. System response is a stated assumption: R 1.0 s per navigation step (page or dialog), no network wait.

Rules:

- A click is M + P + K = 1.35 + 1.1 + 0.28 = 2.73 s.
- A typed field is H + n × K; n is the length of the text: 40 characters for a task, 34 for a repository address (`https://github.com/example/new-app`), 40 for a token, 80 for an idea, 30 for a title.
- Each navigation step adds R.

| # | Clicks | Fields | Navigation | Sum |
|---|---|---|---|---|
| 1 | 2 × 2.73 = 5.46 | 0.4 + 40 × 0.28 = 11.6 | 1 × 1.0 = 1.0 | 18.06 s |
| 2 | 2 × 2.73 = 5.46 | 0 | 1.0 | 6.46 s |
| 3 | 3 × 2.73 = 8.19 | 0 | 2 × 1.0 = 2.0 | 10.19 s |
| 4 | 5 × 2.73 = 13.65 | (0.4 + 9.52) + (0.4 + 11.2) = 21.52 | 2.0 | 37.17 s |
| 5 | 5 × 2.73 = 13.65 | (0.4 + 22.4) + (0.4 + 8.4) = 31.6 | 3.0 | 48.25 s |

## Protocol

In the style of `docs/USABILITY_CHECK.md`.

- **Who:** one person per session. A user for tasks 1, 4, 5 and an admin for tasks 2 and 3. Someone who has not seen the redesign.
- **What to say:** read the task and the end state, nothing more. Do not name a page or a button. Do not explain anything first.
- **Set up:** the fixture in `journeys.md`, signed in, at the start URL, at 1440×900. Reset the data between tasks.
- **What to record:** seconds from "go" to the end state, the pages opened in order, every error, and the confidence the person gives.
- **What counts as an error:** a wrong page opened, a wrong control used, or asking for help. Each is counted once.
- **Confidence:** ask "How sure were you that you did it right, 1 (not at all) to 5 (completely)?" after each task.

## Results

The last four columns are empty on purpose; the owner fills them in sessions.

| Task | Nav steps | Modelled s | Measured s | Errors | Confidence 1–5 | Note |
|---|---|---|---|---|---|---|
| 1 Start work | 1 | 18.1 | | | | |
| 2 Approve a waiting run | 1 | 6.5 | | | | |
| 3 Diagnose a failed run | 2 | 10.2 | | | | |
| 4 Add a repository | 2 | 37.2 | | | | |
| 5 Refine an idea into a story draft | 3 | 48.3 | | | | |

Measured time, errors and confidence are open; the owner runs the sessions in a follow-up issue (no `Factory_go`).
