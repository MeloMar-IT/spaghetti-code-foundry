# Inventory of every screen

Read from the code at commit `27479e3`. Nothing here was measured in a browser. Dialogs are in `dialogs.md`.

How to read it:

- A route is a hash the router draws. List and detail routes have their own rows because they draw different pages.
- **Audience** comes from display routing, not from `RULES` in `src/server/permissions.ts` (that decides who may call an API route). `enterDisplay` in `ui/auth.js` sends an account to the display of its role. A hash is kept only when the user display has that page (`USER_HASH`, `ui/auth.js:223`). So "admin display only" means a user who opens it lands on `/user/`.
- **API handlers** are the files in `src/server/` that answer the `ui/api.js` calls the module makes. The order that decides who answers is the `ROUTES` array in `src/server/server.ts:112`. Handlers other than `api-*.ts` are named by file. `permissions.ts` is only the check, not a handler.
- Pain points cite a count or a `file:line`. They are judgement; the counts can be repeated with the commands under "Inline styles" and in `dialogs.md`.

## Admin display

The page at `/`. 23 route rows (19 sections in `route()` at `ui/app.js:375` and 4 detail forms).

| Route | Nav label | UI module | Renderer | API handlers | Audience | Primary task | Primary action | Pain points |
|---|---|---|---|---|---|---|---|---|
| `#/home` | Home | `ui/turn.js`, `ui/turn-act.js` | `renderYourTurn` | `your-turn.ts`, `turn-actions.ts`, `api-admin.ts` (tick) | admin display only | Answer, approve, reject or retry what waits for the owner | Show questions / Show plan / Retry (button per item) | Answers by dialog (5 kinds in `dialogs.md`); a second run list next to Runs; polls every 5 s (`turn.js:166`) and every 30 s for the badge (`turn.js:52`) |
| `#/board` | Board | `ui/board.js` | `renderBoard(main, arg)` | `board.ts`, `api-admin.ts` (tick) | admin display only | See where every story of one repository is | Pick a repository, then read the columns | Status shown here again (see F1); polls every 5 s (`board.js:156`) |
| `#/board/:id` | — | `ui/board.js` | `renderBoard(main, arg)` | `board.ts` | admin display only | Same board for the repository in the address | Read the columns | Same module as the list; the repository id is the only difference |
| `#/refinement` | Refinement | `ui/refinement.js` | `renderRefinement` (list) | `api-refinement.ts` | both displays | Find or start a refinement session | New session | Shares the renderer with the user display via `{ admin }`; 9 buttons in one module |
| `#/refinement/:id` | — | `ui/refinement.js`, `refinement-draft.js` (709 lines), `-talk.js`, `-suggest.js`, `-ready.js`, `-impact.js`, `-remarks.js` | `renderRefinement` (session) | `api-refinement.ts`, `api-refinement-publish.ts` | both displays | Turn an idea into story drafts and publish them | Ask the architect, answer, edit drafts | Longest page: 7 modules, 6 modal call sites, 6 native confirms; `refinement-draft.js` alone is 709 lines |
| `#/flows` | Flows | `ui/app.js` | `welcome()` | `api-flows.ts` (list), `api-admin.ts` (info) | admin display only | Start a flow: draft with Claude or blank; also the default page | Draft flow with Claude / Blank flow | The same two buttons are in the sidebar on every admin page (`app.js:78-79`) |
| `#/flows/:name` | — | `ui/app.js` (route), `ui/flow-page.js`, `ui/flow-shell.js`, `ui/flow-state.js`, `ui/editor.js`, `ui/graph.js`, `ui/step-types.js`, `ui/fields.js` | `openFlow` | `api-flows.ts`, `api-runs.ts` (run), `api-admin.ts` (info) | admin display only | Edit, validate, save and run one flow | Save (also Ctrl/Cmd+S, `app.js:432`) | `editor.js` 18 and `step-types.js` 5 inline styles; leaving with unsaved changes asks by native `confirm` (`app.js:90`) |
| `#/new` | — | `ui/app.js` (route), `ui/flow-page.js`, `ui/flow-shell.js`, `ui/flow-state.js` | `openNew` | `api-flows.ts` | admin display only | Write a new flow | Save | Nav highlights Flows (`app.js:390`); same editor as `#/flows/:name` |
| `#/library` | Library | `ui/library.js` | `renderLibrary` | `api-flows.ts` (blocks) | admin display only | Browse, save and delete reusable step blocks | Insert from library / Save step as block | A third entry point to flow editing (F8); 2 native confirms |
| `#/start` | Start work | `ui/user/start.js` | `renderStart` with `admin: true` | `api-flows.ts`, `api-repos.ts`, `api-runs.ts` | both displays | Start a run of a published flow on a repository | Start | The user page drawn for the admin (`app.js:410-417`); needs a published flow (`NO_FLOWS_ADMIN`) |
| `#/runs` | Runs | `ui/runs.js` | `renderRunsList` | `api-runs.ts`, `api-users.ts` (owner filter) | both displays | Find a run | Open a run (link) | Named "My runs" on the user display for the same hash; own list implementation (F3) |
| `#/runs/:id` | — | `ui/runs.js` | `renderRunDetail` | `api-runs.ts` (incl. event stream) | both displays | Follow one run, approve, cancel, re-run | Approve / Cancel / Re-run (by step) | Approve and Reject use `decisionDialog`; Cancel and Re-run use `confirmDialog` (`ui/run-dialogs.js`) |
| `#/repos` | My repositories | `ui/repos.js` | `renderRepos` | `api-repos.ts` | both displays | Add and manage the owner's own repositories | Add repository | One of three repository pages (F2) |
| `#/all-repos` | All repositories | `ui/admin-repos.js` | `renderAllRepos` | `api-repos.ts` (`/api/admin/repos`) | admin display only | Manage the repositories of all accounts | Repository settings (per row) | Name differs from "My repositories" by one word; 3 modal call sites |
| `#/credentials` | Credentials | `ui/admin-credentials.js` | `renderCredentials` | `api-credentials.ts` | admin display only | Read the stored credentials of all accounts | Read the table | Read-only, 40 lines; fits as a column of the repository page (F2) |
| `#/maintenance` | Maintenance | `ui/maintenance.js` | `renderMaintenance` | `api-admin.ts` | admin display only | Clean old run workspaces | Clean up | The clean action is a native confirm (`maintenance.js:12`) |
| `#/watchers` | Watchers | `ui/admin.js`, `ui/watcher-form.js` | `renderWatchers` | `api-admin.ts`, `api-monitor.ts`, `api-repos.ts`, `api-flows.ts` | admin display only | Add, edit, tick and delete watchers; switch the monitor on | Add a watcher | `admin.js` has 3 native confirms and two pages |
| `#/settings` | Settings | `ui/admin.js` | `renderSettings` | `api-admin.ts` | admin display only | Change server settings | Save | Shares a file with Watchers (F6) |
| `#/problems` | Problems | `ui/problems.js`, `ui/monitor.js` | `renderProblems` | `api-monitor.ts`, `api-admin.ts` (config) | admin display only | See what the monitor found; mute or retry | Retry / Mute | Same monitor confirm text as `admin.js:41` (`problems.js:88`) |
| `#/models` | Models | `ui/models.js` | `renderModels` | `api-admin.ts` (config, providers) | admin display only | Choose which model runs which step; test a model | Save | 3 tables, none inside `.table-box` |
| `#/dashboard` | Dashboard | `ui/dashboard.js` | `renderDashboard` | `api-admin.ts` (stats, evals), `clarity.ts`, `api-runs.ts` | admin display only | See the last 30 days of runs, cost and failing steps | Read (no action) | Run status again (F1); 7 tables, none inside `.table-box` |
| `#/users` | Users | `ui/users.js` | `renderUsers` | `api-users.ts`, `view-as.ts` | admin display only | Add, block and limit users; preview a user | Add user | One modal call site serves 11 dialogs (`users.js:113`) |
| `#/audit` | Audit | `ui/audit.js` | `renderAudit` | `api-audit.ts`, `api-users.ts` (filter) | admin display only | Find who did what; export | Filter / Export | Table without `.table-box` (`audit.js:79`) |

## User display

The page at `/user/`. 7 route rows. `USER_HASH` allows exactly these (`ui/auth.js:223`); any other hash is replaced by `#/runs` (`userHash`, `ui/auth.js:232`).

| Route | Nav label | UI module | Renderer | API handlers | Audience | Primary task | Primary action | Pain points |
|---|---|---|---|---|---|---|---|---|
| `/user/#/home` | Home | `ui/home.js` | `renderHome` | `api-runs.ts` | user; admin read-only preview | See what needs me, what is running and what finished | Follow the best next action (head button) | Polls every 30 s; groups come from each run's next-step record |
| `/user/#/start` | Start work | `ui/user/start.js` | `renderStart` | `api-flows.ts`, `api-repos.ts`, `api-runs.ts` | user; admin read-only preview | Start a run | Start | Needs a published flow and a GitHub repository (`NO_FLOWS`, `NO_REPOS`) |
| `/user/#/runs` | My runs | `ui/user/runs.js` | `renderMyRuns` | `api-runs.ts` | user; admin read-only preview | Find a run and its next step | Open a run (card link) | Polls every 30 s; Remove asks with `confirmDialog` |
| `/user/#/runs/:id` | — | `ui/user/runs.js` | `renderMyRun` | `api-runs.ts` (incl. event stream) | user; admin read-only preview | Follow one run, answer, approve, cancel | Send answer / Approve / Cancel | A second detail page for the same run (F3) |
| `/user/#/repos` | My repositories | `ui/repos.js` | `renderRepos` with `admin: false` | `api-repos.ts` | user; admin read-only preview | Add and manage own repositories | Add repository | Same module as the admin page, so the same 10 buttons |
| `/user/#/refinement` | Refinement | `ui/refinement.js` | `renderRefinement` (list) | `api-refinement.ts` | user; admin read-only preview | Find or start a session | New session | Shared with the admin display |
| `/user/#/refinement/:id` | — | `ui/refinement.js` and six `refinement-*.js` | `renderRefinement` (session) | `api-refinement.ts`, `api-refinement-publish.ts` | user; admin read-only preview | Refine an idea | Ask the architect | Longest page, see `#/refinement/:id` above |

Admin preview: `/user/?as=<id>` (`ui/view-as.js`) draws these pages for the chosen user with the buttons that change things hidden (`readOnly`).

## Special addresses

| Address | Display | What happens |
|---|---|---|
| `/` (no hash) | admin | With something waiting, `startHash` sets `#/your-turn` (`ui/turn.js:14`, `ui/app.js:452`); with nothing waiting `route()` draws `#/flows` (`app.js:379`). The address bar stays empty in that case. `#` and `#/` are not "no hash" here: they draw `welcome()` |
| `/` (unknown hash) | admin | Any section not in `route()` falls to the last `else`: `welcome()` (`app.js:422`); the hash is not changed |
| `/user/` (no hash) | user | Always `#/home` (`ui/user/app.js`); Home shows its own empty state with a Start work button. `#` and `#/` count as no hash (`isNoHash`, `ui/auth.js:226`) |
| `/user/` (unknown hash) | user | `userPage` replaces the address by `#/runs` (`ui/user/app.js:30`) |
| `#/set-password/:token` | both | A hash route (`linkToken`, `ui/auth.js:12`). The router reloads the page; the sign-in page then shows "Choose your password" (`auth.js:155`) |
| `/user/?as=<id>` | user | Admin only. Read-only preview of that user (`ui/view-as.js:86`). A user ignores `as`. An admin without `as` is sent to `/` |
| Wrong display | both | A user opening `/` goes to `/user/` and an admin opening `/user/` without `as` goes to `/`; a valid user hash is kept in both directions (`otherDisplay`, `ui/auth.js:241`) |
| Preview ended | user | The server ended the view: `beginView` calls `viewEndedCard`, which draws a card with "View again" and "Back to the admin display"; nothing else is drawn (`view-as.js:60-75`, `ui/user/app.js:66`) |

## Screens without a route

| Screen | File | States read from the code |
|---|---|---|
| Sign-in page | `ui/auth.js:155` | Sign in; error line; the top nav is hidden while signed out (`style.css:80`) |
| First setup | `ui/auth.js:155` | "Create the admin account": name, e-mail, password |
| Change-password dialog | `ui/auth.js:76` | Modal: current password, new password |
| Health bar | `ui/health.js` | Hidden until loaded; ok, bad, or "server does not answer"; every page change and every 30 s (`health.js:51-55`); Cancel run button with a native confirm (`health.js:44`) |
| "Since you last looked" strip | `ui/since.js`, started at `ui/app.js:455` | Hidden until there is something; checks every 30 s while the tab is visible (`since.js:134`); can be dismissed |
| Sidebar flow list | `renderSidebar`, `ui/app.js:73` | Draft and Blank buttons plus one link per flow, drawn on every admin page; under 760 px it stacks above `main` |
| Turn badge and tab title | `ui/turn.js:17` | Count on the Your turn link and in the title |
| Toast | `ui/dom.js` | One line at the bottom, error or info |
| Route error | `ui/app.js:425`, `ui/user/app.js:50` | `div.errors` with the error message, in both routers |

## States

Loading, empty, error and live update per route, from the code. "Errors" means the router's `errors` box unless another is named. A loading marker is drawn at once on `#/runs` (`runs.js:63`), `#/board` (`board.js:155`), `#/library` (`library.js:117`), `#/dashboard` (`dashboard.js:124`), `#/models` (`models.js:172`) and `/user/#/runs/:id` (`user/runs.js:340`); `#/audit` shows one when it reloads (`audit.js`). Since part 8 all six Administration pages (`#/users`, `#/watchers`, `#/problems`, `#/dashboard`, `#/audit`, `#/settings`) draw a skeleton (`loadingState`) at once and an `errorState` with Retry on failure; a failed reload of Users, Watchers or Problems keeps the list and shows a `staleNote`; a failed part of the Dashboard is a `partNote` on its section, and a failed monitor call on Watchers is an `errorState` in the monitor card. Save on Settings shows "Saving…", "Saved at …" or "Not saved." next to the button. All other routes leave `main` as it was until the first `await` ends.

| Route | Empty | Errors | Live update |
|---|---|---|---|
| `#/home` | `data.empty` text from the server (`turn.js`), or `EMPTY` when nothing exists | errors box | poll 5 s (Your turn) and 30 s (runs, queue, health) |
| `#/board` | `data.empty` (`board.js:77`) | errors box | poll 5 s |
| `#/board/:id` | `data.empty` | errors box | poll 5 s |
| `#/refinement` | "No refinement sessions yet..." (`refinement.js:472`) | errors box | none found |
| `#/refinement/:id` | per section: `NO_BRIEF`, `NO_MAP`, "No view yet." | errors box | none found |
| `#/flows` | welcome page is the empty state | errors box | none |
| `#/flows/:name` | "No steps yet" in the graph (`graph.js:37`) | errors box; validation errors in `ui.errors` | none |
| `#/new` | blank editor | errors box | none |
| `#/library` | none found | errors box | none |
| `#/start` | `NO_FLOWS_ADMIN`, `NO_REPOS` | errors box | none |
| `#/runs` | "No runs yet. Open a flow and press ▶ Run." (`runs.js:90`) | errors box | poll 30 s (`runs.js:93`) |
| `#/runs/:id` | "No steps" in the graph | skeleton, `NOT_FOUND`, `permissionState` or `errorState` with Retry on first load; stream loss gives a banner with Reconnect; transcript and diff failures give an inline `errorState` with Retry | event stream |
| `#/repos` | "No repositories yet..." (`repos.js:395`) | errors box | none |
| `#/all-repos` | "No repositories yet." (`admin-repos.js:222`) | errors box | cleanup returned |
| `#/credentials` | "No stored credentials yet." (`admin-credentials.js:36`) | errors box | cleanup returned |
| `#/maintenance` | no empty state | toast | none |
| `#/watchers` | `div.empty` (`admin.js:211`) | errors box | none found |
| `#/settings` | no empty state | errors box | none |
| `#/problems` | none found | `h1` plus `status bad` line (`problems.js:214`) | none |
| `#/models` | none found | errors box | none |
| `#/dashboard` | per table `list.length ?` | errors box | none |
| `#/users` | none found | errors box | none |
| `#/audit` | "No entries." (`audit.js:122`) | errors box | none |
| `/user/#/home` | `EMPTY` with Start work and My repositories (`home.js`), `ALL_CLEAR` | errors box | poll 30 s |
| `/user/#/start` | `NO_FLOWS` and `NO_REPOS` | errors box | none |
| `/user/#/runs` | `NO_RUNS` plus a Start work link (`user/runs.js:145`) | errors box | poll 30 s |
| `/user/#/runs/:id` | `NOT_FOUND` with a link back, `NO_STEPS`, `NO_CHANGES` | skeleton, `permissionState` or `errorState` with Retry on first load; stream loss gives a banner with Reconnect; a diff failure gives an inline `errorState` with Retry | stream and poll 30 s |
| `/user/#/repos` | "No repositories yet..." | errors box | none |
| `/user/#/refinement` | as admin | errors box | none found |
| `/user/#/refinement/:id` | as admin | errors box | none found |

## Responsive layout

From code, not measured. `ui/style.css` has two width rules. R1 is `max-width: 1100px` (line 288): `.editor`, `.run-grid` and `.dash-grid` become one column and `.graph-pane` stops sticking. R2 is `max-width: 760px` (lines 292 and 381): short brand, `.layout` one column (sidebar above main), main padding 16 px, `.repo` hidden, `.top` scrolls sideways, `.route` two columns; on the user display the top bar is no longer sticky. The checks at 768 and 390 are guesses to confirm with the overflow measure in `measurement.md`. `.table-box { overflow-x: auto }` (line 368) is used only by `runs.js:72`, `repos.js:392`, `refinement.js:469`.

| Route | At 768 (R1 only) | At 390 (R1 and R2) |
|---|---|---|
| `#/home` | Cards; 17-link nav is wider than 768 and has no wrap or scroll above 760 | Nav scrolls sideways; sidebar stacks above |
| `#/board` | Board columns probably wider than main | Probably clipped; no rule |
| `#/board/:id` | As `#/board` | As `#/board` |
| `#/refinement` | Table in `.table-box` scrolls | Same |
| `#/refinement/:id` | Single column from the shared styles; long text | Probably long; no rule |
| `#/flows` | Welcome page fits | Sidebar (all flows) takes the first screen |
| `#/flows/:name` | `.editor` and graph in one column (R1) | Same plus a stacked sidebar |
| `#/new` | As `#/flows/:name` | As `#/flows/:name` |
| `#/library` | Cards | Probably fits |
| `#/start` | Form, max 640 px | Fits |
| `#/runs` | `.table-box` scrolls | Same |
| `#/runs/:id` | `.run-grid` one column (R1) | Step graph above the log; long page |
| `#/repos` | `.table-box` scrolls | Same |
| `#/all-repos` | Table not in `.table-box`: probably overflows | Probably overflows |
| `#/credentials` | Table not in `.table-box` | Probably overflows |
| `#/maintenance` | Form | Probably fits |
| `#/watchers` | Cards | Probably fits |
| `#/settings` | Form | Probably fits |
| `#/problems` | Compact tables not in `.table-box` | Probably overflows |
| `#/models` | 3 tables not in `.table-box` | Probably overflows |
| `#/dashboard` | `.dash-grid` one column (R1); 7 tables | Probably overflows |
| `#/users` | Table not in `.table-box` | Probably overflows |
| `#/audit` | Table not in `.table-box` | Probably overflows |
| `/user/#/home` | Rows wrap (`.home-row`) | Fits |
| `/user/#/start` | Top bar wraps (`style.css:372`) | Fits |
| `/user/#/runs` | Cards | Fits |
| `/user/#/runs/:id` | `.run-grid` one column | Long page |
| `/user/#/repos` | `.table-box` scrolls | Same |
| `/user/#/refinement` | `.table-box` scrolls | Same |
| `/user/#/refinement/:id` | As admin | As admin |

## Inline styles

Count of `style:` occurrences per file (one line can hold more than one). Repeat with:

```
grep -o 'style *:' ui/*.js ui/user/*.js | sort | uniq -c
```

Total 5 in 2 files. Lines that contain one: 5.

| File | Uses |
|---|---|
| `ui/refinement-import.js` | 4 |
| `ui/dashboard.js` | 1 |

Three lines stay inline for good, all in `ui/dashboard.js`: `tip.style.left` and `tip.style.top` (the chart tip position, computed from the bar) and the `rate-fill` width (computed from the data). Only the last is a `style:` use, so the grep counts 1 for `ui/dashboard.js`. The runs, repositories and refinement pages (except `ui/refinement-import.js`) and the editor files are clean.
