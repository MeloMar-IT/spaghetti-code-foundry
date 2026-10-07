# Journeys

Nine journeys, counted against one fixture, by reading the click handlers and the `location.hash =` assignments. Nothing was run in a browser. The counts can be repeated by reading the code named in each step. The fixture is described in prose, not seeded: a count is "what the code draws for these answers".

## Fixture

Synthetic names only. Viewport 1440×900. Counting starts after sign-in at the stated URL.

- Accounts: one admin, one user (`example@example.test`). Repository `example/app`, connected for both.
- Flows (`GET /api/flows`): three flows. One of them, `example-task`, is published (`published: true`, which comes from `publish.enabled: true` in the flow). Built-in flows are not all published, so "all built-in flows, published" would leave the user's Start work page empty (`NO_FLOWS`). For the user the list holds only `example-task`, with `usesTask: true` and one field `github_repo` (`mode: "input"`, required).
- Repository methods (`GET /api/repos/methods`): `{ methods: ["github-token", "ssh-deploy-key"], githubApp: { available: false } }`. The first method, `github-token`, has one secret field: the token.
- Four runs of the user: done, failed, waiting for approval, running. The queue is empty.
- Your turn (admin): two items: the run waiting for approval (kind `approval`) and the failed run (kind `failed`).
- One refinement session with one story draft, one repository watcher, no monitor findings.
- Variant **Empty**: the same accounts, no runs, empty queue.

## Counting rules

- One **navigation step** is one hash change or one dialog opened (a native `confirm` or `prompt` counts as a dialog).
- One **click** is one pointer activation, including a click that only puts the cursor in a box. Typing and Tab are not clicks.
- One **field** is one input typed or chosen when the default is not what the task needs.
- **Competing controls** are the visible `button`, `a` and form controls that are not the one needed, in four groups: header (brand, nav, account buttons), sidebar, page-local, and dialog. The header is the same on every page: admin 20 (brand, 17 nav links, Change password, Sign out), user 7 (brand, 4 nav links, the same two buttons). The admin sidebar adds 5 (Draft flow with Claude, Blank flow, three flow links). The health bar and the since strip are assumed hidden in the fixture (each can add controls: Cancel run, a findings link, Dismiss).
- Page-local counts are static reads of the render code. Where a control is conditional the count is a range (low–high). A count marked "not counted" depends on data the fixture does not fix.

## Landing

| Role | Start URL | Variant | Lands on | Code |
|---|---|---|---|---|
| admin | `/` | Base (something waits) | `#/your-turn` | `startHash` (`ui/turn.js:14`), `ui/app.js:452` |
| admin | `/` | nothing waits | `#/flows` (`welcome()`), address bar stays empty | `ui/app.js:379` |
| user | `/user/` | Base | `#/runs` | `homeHash` (`ui/user/start.js:14`) |
| user | `/user/` | Empty | `#/start` | `homeHash` |

The landing is not a step. It is the first screen.

## J1. Start work

| # | Role and route | Control | Handler |
|---|---|---|---|
| 1a | admin: `#/your-turn` (landing) | click nav "Start work" | nav link, `ui/index.html:18` |
| 2a | `#/start` | click the Task box, type the task | `taskBox`, `ui/user/start.js:94` |
| 3a | `#/start` → `#/runs/:id` | click "Start" | `submit`, `ui/user/start.js:205` (`go("#/runs/" + id)`, line 226) |

User, Base: lands on `#/runs`; click "Start work" (toolbar link, `ui/user/runs.js:168`) → `#/start`; task; Start. User, Empty: lands on `#/start`; task; Start.

| Variant | Navigation steps | Clicks | Fields |
|---|---|---|---|
| admin, Base | 2 | 3 | 1 |
| user, Base | 2 | 3 | 1 |
| user, Empty | 1 | 2 | 1 |

Flow and repository are chosen by default (first flow, `pickRepo`). The admin page sends `likeUser: true` (`start.js:224`).

Competing controls: `#/your-turn` page-local 4–6 (see J2), header 20, sidebar 5. `#/runs` page-local 4 (four run cards; "Start work" is the one needed). `#/start` page-local 3 form controls besides Start: the flow radio, the repository select, Add repository (the task box is the field typed), header 7 or 20.

Other names for the same thing: "Start work" (nav and page), "Run" (button in the flow editor and the "Run <flow>" dialog, `ui/app.js:288`), "New session" and "Start session" in Refinement.

## J2. Answer or approve

| Variant | Route | Steps | Nav steps | Clicks | Fields |
|---|---|---|---|---|---|
| admin via Your turn | `#/your-turn` | click "Show request" (dialog, `turn-act.js:21`); click "Approve" (`proposalPanel`) | 1 | 2 | 0 |
| admin via Runs | `#/runs`, `#/runs/:id` | nav "Runs"; click the waiting row; click "Approve"; native `prompt` opens; click OK | 3 | 4 | 0 |
| user | `#/runs`, `#/runs/:id` | click the waiting card; click "Approve" (`decisionDialog`); click "Approve" in the dialog | 2 | 3 | 0 |

The note is optional in all three.

Competing controls:

- Admin, `#/your-turn`: page-local 4–6 (approval item: where link, Dismiss if dismissable; failed item: Retry, Retry with a hint…, where link, Dismiss if dismissable); the dialog: Reject, Cancel, ✕ = 3.
- Admin, `#/runs/:id` for a waiting run: Reject, Cancel, Open flow, back, 3 tabs = 7.
- User, `#/runs`: 3 other cards. `#/runs/:id`: Reject, Cancel, back, 3 tabs = 6. Dialog: "Not now", ✕ = 2.

Other names: the admin Runs page groups the same items under "Needs you (n)" (`ui/runs.js:89`) while the nav calls them "Your turn". Approve is a dialog titled "Approve" for the user (`decisionDialog`), a native `prompt` on the admin run page (`ui/runs.js:244`), and a panel in "Show request" on Your turn.

## J3. Monitor progress

| Variant | Steps | Nav steps | Clicks |
|---|---|---|---|
| admin: read the status of the running run | nav "Runs" (the status column shows it) | 1 | 1 |
| admin: follow it live | the above, then click the row (live log) | 2 | 2 |
| user: read the status | landing `#/runs` already shows cards with status and next step | 0 | 0 |
| user: follow it live | click the card | 1 | 1 |

Competing controls: admin `#/runs` page-local: owner filter plus the other rows (1 + 3, assuming one link per row); user `#/runs` 4 cards.

Other places the same status is drawn: Your turn, Board (`#/board`), Dashboard, the health bar and the since strip (F1). The admin Board needs a repository picked first (`board.js:77`).

## J4. Diagnose a failure

| Variant | Steps | Nav steps | Clicks |
|---|---|---|---|
| admin | nav "Runs"; click the failed row (the page opens on Steps with the failure card, `ui/runs.js:328`); click the failing step | 2 | 3 |
| user | click the failed card (failure card at top, `ui/user/runs.js:352`); click the "Steps" tab | 1 | 2 |

Fields: 0. Competing controls: admin run page for a failed run: Resume at <step>, Retry from step… (select), Open flow, back, 3 tabs = 7; user: Retry, back, 3 tabs = 5.

Other names: three words for continuing a failed run: "Retry" and "Retry with a hint…" (Your turn), "↻ Resume at <step>" and "Retry from step…" (admin run page, `ui/runs.js:248-255`), "Retry" (user run page, `runActions`, `ui/user/runs.js:51`).

## J5. Review output

| Variant | Steps | Nav steps | Clicks |
|---|---|---|---|
| admin | nav "Runs"; click the done row; click "Changes" | 2 | 3 |
| user | click the done card; click "Changes" | 1 | 2 |

Fields: 0. Competing controls: admin run page for a done run: Retry from step… (select), Open flow, back, 2 other tabs = 5; user: back and 2 other tabs = 3. The same view is called "Changes" in the tab, `diff` in the API (`api.diff`) and "run-diff" in the screenshots.

## J6. Manage repositories (add one)

User: nav "My repositories" → `/user/#/repos`; click "Add repository" (`ui/repos.js`, dialog `repoDialog`); click the URL box and type the address of a repository that is not yet connected (`example/new-app`; `example/app` is in the fixture and the server refuses a duplicate with 409); click the token box and type the token; click "Add repository" in the dialog.

| Variant | Navigation steps | Clicks | Fields |
|---|---|---|---|
| user | 2 | 5 | 2 |
| admin, via `#/repos` | 2 | 5 | 2 |

The method is `github-token` by default. A different method changes the fields: SSH deploy key 0 secret fields (the address must be SSH), HTTPS user name and token 2.

Competing controls: header nav has three repository-like links on the admin display ("My repositories", "Repositories", "Credentials"); user nav has 1. `#/repos` page-local: Add repository plus per-row buttons (0 rows in the Empty variant; 10 `button` calls in `ui/repos.js`). Dialog: ✕ and the method select.

Other names: "Repository", "repo", "GitHub repository" (`NO_REPOS`), "connection", "authentication" (dialog "Change authentication"), "credentials" (admin page).

## J7. Refine an idea

User, Base: lands on `#/runs`; click nav "Refinement" → `#/refinement`; click "New session" (dialog); click the idea box and type; click "Start session" → `#/refinement/:id`; click "New draft" (the title box takes focus, `refinement-draft.js:667-680`); type the title (saved after a short pause).

Totals: navigation steps 3, clicks 5, fields 2. Assumes the "New draft" button is shown on a session before the architect has looked; not confirmed in code.

Competing controls: `#/refinement` page-local: New session, Open sessions, Dropped, row links (1 session) = 4 besides the needed one; dialog: ✕ and the repository select; `#/refinement/:id`: not counted (depends on session state; the page holds 6 modals and 6 native confirms).

Other names: "session", "idea", "story", "story draft", "draft" ("New draft", and "Add draft" for a dependency, `refinement-draft.js:413`). "Start session" here, "Start work" elsewhere.

## J8. Edit a flow

Admin, Base: lands on `#/your-turn`; click the flow in the sidebar → `#/flows/example-task` (`ui/app.js:84`); click a field and type; click "Save" (or Ctrl/Cmd+S, `ui/app.js:432`).

Totals: navigation steps 1, clicks 3, fields 1. Via the nav "Flows" link first: 2 steps (it only shows `welcome()`). From `#/library`: Insert from library opens a dialog and adds a block (`ui/app.js:195`).

Competing controls: not counted; the editor draws one set of controls per step (`ui/editor.js`, 18 inline styles) so the number depends on the flow. Header 20, sidebar 5.

Other names: "Flow", "Library", "Block", "step", "Draft flow with Claude", "Ask Claude to change this flow", "Blank flow", "New" (`#/new`).

## J9. Administer the system (add a user, change a setting)

Admin: nav "Users" → `#/users`; click "+ Add user" (`ui/users.js:445`, dialog); click the Name box and type; click the E-mail box and type; role is "user" by default; click "Add user" in the dialog (a one-time link is shown); click to close it; nav "Settings" → `#/settings`; click "Daily budget ($)" and type; click "Save".

Totals: navigation steps 3, clicks 9, fields 3.

Competing controls: `#/users` page-local: Default limits plus the row buttons of `actionsFor(u)` (`ui/users.js:441`; which ones show depends on the account's state, up to the 9 labels in `LABELS`, `users.js:364`) and "+ Add user"; dialog ✕. `#/settings`: one long form with a single Save, so page-local controls are the form controls (not counted).

Other names: "Settings", "Models", "Watchers", "Problems" and "Credentials" all hold admin configuration; "Limits" (per user), "Default limits" and "Budget & capacity" (Settings) name the same limits.

## Summary of the counts

| Journey | Role | Navigation steps | Clicks | Fields |
|---|---|---|---|---|
| J1 Start work | user, Empty | 1 | 2 | 1 |
| J2 Approve | admin, Your turn | 1 | 2 | 0 |
| J2 Approve | user | 2 | 3 | 0 |
| J3 Follow a run | user | 1 | 1 | 0 |
| J4 Diagnose | admin | 2 | 3 | 0 |
| J5 Review | user | 1 | 2 | 0 |
| J6 Add repository | user | 2 | 5 | 2 |
| J7 Refine | user | 3 | 5 | 2 |
| J8 Edit a flow | admin | 1 | 3 | 1 |
| J9 Administer | admin | 3 | 9 | 3 |
