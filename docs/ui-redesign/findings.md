# Findings

Read from the code at commit `27479e3`, with the routes in `inventory.md`, the dialogs in `dialogs.md` and the counts in `journeys.md`. Every finding names the code it rests on. Proposals are for the later issues (#248–#250); they are not decisions.

**Structural** means the wrong place, name, grouping or number of pages or actions. **Visual** means spacing, colour, type, alignment or inline styles that do not change where things are.

### F1 Run status is drawn on five pages and two bars
**Structural**

- **Where:** `#/your-turn` (`ui/turn.js`), `#/board` (`ui/board.js`), `#/runs` (`ui/runs.js`), `#/dashboard` (`ui/dashboard.js`), the health bar (`ui/health.js`), the since strip (`ui/since.js`).
- **Evidence:** Each calls its own endpoint (`your-turn.ts`, `board.ts`, `api-runs.ts`, `api-admin.ts` stats, `health.ts`, `since.ts`). Three of them poll: Your turn every 5 s (`turn.js:166`), Board every 5 s (`board.js:156`), Runs, health and since every 30 s. To read "what is running" the admin has at least 4 places to look (J3).
- **Proposal:** Merge Your turn, Runs and Board into one run surface with filters (needs me, running, failed, done). Keep Dashboard for the 30-day numbers. Make the health bar link to that surface.

### F2 Three repository pages on the admin display
**Structural**

- **Where:** `#/repos` "My repositories" (`ui/repos.js`), `#/all-repos` "Repositories" (`ui/admin-repos.js`), `#/credentials` "Credentials" (`ui/admin-credentials.js`).
- **Evidence:** All three read the same records (`api-repos.ts`, `api-credentials.ts`). Credentials is a 40-line read-only table. The nav lists the three as separate links (3 of 17). Adding a repository (J6) works from only one of them.
- **Proposal:** One Repositories page with a scope switch (mine, all), and credentials as a column or a row detail.

### F3 Two list and two detail pages for runs
**Structural**

- **Where:** `ui/runs.js` (351 lines: `renderRunsList`, `renderRunDetail`) and `ui/user/runs.js` (493 lines: `renderMyRuns`, `renderMyRun`).
- **Evidence:** The user module imports helpers from the admin module (`ui/user/runs.js:7`: `diffView`, `failureCard`, `stepEntry`, ...), so the two are half shared. The list is a table on one display and cards on the other. The detail page differs in tabs (`Live log, Steps & transcripts, Changes` against `Log, Steps, Changes`), in cost (admin only), and in the dialogs used (F11).
- **Proposal:** One run page with a role flag, as `renderRepos` and `renderRefinement` already do.

### F4 One hash, two names
**Structural**

- **Where:** `ui/index.html:19` ("Runs") and `ui/user/index.html:14` ("My runs"), both `#/runs`. `ui/index.html:20` ("My repositories") against `ui/index.html:21` ("Repositories"), and `ui/user/index.html:15` ("My repositories") for the same hash as the admin's "My repositories".
- **Evidence:** The admin's `#/runs` shows all runs with an owner filter and a "Needs you (n)" group (`runs.js:89`); the user's shows only their own. "My repositories" on the admin display is the admin's own, and "Repositories" is everyone's.
- **Proposal:** Name by content, not by display: "Runs" with a scope filter, "Repositories" with a scope filter.

### F5 Start work on the admin display is the user module
**Structural**

- **Where:** `ui/app.js:410-417` calls `renderStart(box, { admin: true })` from `ui/user/start.js`.
- **Evidence:** The admin gets the user form, limited to published flows (`a.flows(true)`), and the empty text `NO_FLOWS_ADMIN` ("Publish one in the flow editor"). The admin also has "Run" in the flow editor (`ui/app.js:288`) for the same intent. J1 counts 2 navigation steps for the admin and 1–2 for the user.
- **Proposal:** Decide one starting point per role: Start work for the admin as for the user, and "Run" in the editor as a test run only, named so.

### F6 Watchers and Settings share one file and repeat text
**Structural**

- **Where:** `ui/admin.js` (366 lines) holds `renderWatchers` and `renderSettings`; `ui/problems.js` repeats a part.
- **Evidence:** The monitor confirm text is in `ui/admin.js:44` and `ui/problems.js:88` (the same sentence). `admin.js` has 19 inline styles and 4 native confirms, the most of any admin file.
- **Proposal:** Split by task: Watchers with the monitor switch; Settings with a section list. Move the monitor switch to one place.

### F7 Monitoring is in three places
**Structural**

- **Where:** Problems (`ui/problems.js`), the health bar (`ui/health.js:32`, link to `#/problems`) and the monitor card on Watchers (`ui/admin.js:38-46`, `monitorLists` from `ui/monitor.js`).
- **Evidence:** The monitor can be switched on or off from the Watchers card (`admin.js:46`) and from Problems (`problems.js:88`). Findings are listed on Problems and counted in the health bar. Mutes are managed in `ui/monitor.js`, used by both.
- **Proposal:** One Monitor page with state, findings and mutes. The health bar links to it; the Watchers page shows watchers only.

### F8 Three ways to a flow
**Structural**

- **Where:** Flows (`welcome()` and the sidebar, `ui/app.js:73`, `:364`), Library (`ui/library.js`), `#/new` (`ui/app.js`).
- **Evidence:** "Draft flow with Claude" and "+ Blank flow" are in `welcome()` and in the sidebar on every admin page (`app.js:78-79`). `#/new` is highlighted as Flows (`app.js:390`) and has no nav link. Library offers "Insert from library" inside the editor too (`app.js:195`).
- **Proposal:** Flows is one place: the list, new (draft, blank, from a block) and the library as a tab. `#/new` stays as an address only.

### F9 Seventeen flat links in the top bar
**Structural**

- **Where:** `ui/index.html:13-29`.
- **Evidence:** 17 `data-nav` links, no group. They mix daily work (Your turn, Runs), setup (Repositories, Credentials, Models, Users, Settings) and review (Dashboard, Audit). The user display has 4 (`ui/user/index.html`). The bar has no wrap above 760 px and scrolls sideways below (`style.css:65`, `:299`).
- **Proposal:** Group by task (Work, Refine, Flows, Admin) and keep at most 5–7 items on the first level.

### F10 The brand goes to Flows; the default goes to a decision
**Structural**

- **Where:** `ui/index.html:11` (brand `href="#/flows"`), `ui/user/index.html:11` (brand `href="#/runs"`), `ui/turn.js:14` (`startHash`), `ui/user/start.js:14` (`homeHash`).
- **Evidence:** On the admin display the brand and the no-hash default can differ: with something waiting, `/` lands on Your turn but the brand always goes to `#/flows`. On the user display the no-hash default is `#/start` or `#/runs` and the brand is always `#/runs`. In J1 and J8 the admin lands on Your turn and needs 1–2 steps to reach the Flows page. `#/flows` itself offers two actions (Draft flow with Claude, Blank flow), so it is a place to act for flow work, not for runs.
- **Proposal:** Make the brand and the no-hash default the same page per display.

### F11 Three dialog mechanisms, and the same action in two of them
**Structural**

- **Where:** Native `confirm`/`prompt` (24 calls), `modal` (23 call sites), and the wrappers `callDialog`, `confirmDialog`, `decisionDialog`, `withDialog`, `openDetail` (see `dialogs.md`).
- **Evidence:** Approve and reject use native `prompt()` on the admin run page (`ui/runs.js:244-245`) but `decisionDialog` on the user display (`ui/user/runs.js:94`) and a panel on Your turn (`turn-act.js`). Cancel uses `confirm` at `ui/runs.js:258` and `ui/health.js:49` but `confirmDialog` on the user display (`ui/user/runs.js:430`). Native dialogs cannot show a server error and cannot be styled.
- **Proposal:** One confirm helper and one decision helper over `modal`; move the 24 native calls onto them in #249.

### F12 Inline styles are spread over 22 files
**Visual**

- **Where:** `ui/admin.js` 19, `ui/editor.js` 18, `ui/models.js` 17, `ui/runs.js` 13, `ui/app.js` 11, `ui/watcher-form.js` 10 (full list in `inventory.md`).
- **Evidence:** 157 `style:` uses in 22 files. The same values repeat: `style: { margin: 0 }` on the error line of most dialogs, `style: { display: "grid", gap: "12px" }` on dialog bodies.
- **Proposal:** Put those values in classes in `ui/style.css`; start with the two repeated ones.

### F13 Same thing, different words
**Structural**

- **Where:** `ui/runs.js:89` ("Needs you (n)") against the nav "Your turn". "Retry", "Retry with a hint…" (`turn-act.js`), "Resume at …" and "Retry from step…" (`ui/runs.js:248-255`), "Retry" (`ui/user/runs.js:185`). "Start work", "Start" (form), "Start session" (`ui/refinement.js`), "Run" (`ui/app.js:288`).
- **Evidence:** J2, J4 and J7 list the words on each path.
- **Proposal:** One word per action: choose "Retry" for run recovery and "Start" for beginning work.

### F14 Wide tables are not wrapped on most pages
**Visual**

- **Where:** `h("table"` appears at 21 sites; only `ui/runs.js:72`, `ui/repos.js:392` and `ui/refinement.js:469` wrap it in `.table-box` (`style.css:368`, `overflow-x: auto`). The other 18 sites (Users, Audit, Credentials, Repositories, Models, Dashboard, Problems, monitor tables) do not.
- **Evidence:** From code. Whether they overflow at 768 or 390 is not measured (see Candidates).
- **Proposal:** Wrap every table in the same box, or restyle tables as cards under 760 px.

## Candidates (not measured)

These are guesses from code. Each says what observation would confirm it. They need the measures in `measurement.md`, which are open.

| Candidate | From | Observation that confirms it |
|---|---|---|
| Layout shift on pages that draw after `await` | Routes with no loading marker keep the old page until data arrives (Your turn, Refinement, Repos, All repos, Credentials, Watchers, Settings, Problems, Users and the user Start, My runs, Repos and Refinement pages); routes with one (see States in `inventory.md`) shift when it is replaced | Layout-shift entries over the first 10 s of each route; a large entry at first draw |
| Layout shift on polls | `#/your-turn` and `#/board` redraw every 5 s; `#/runs`, `/user/#/runs` and the health bar every 30 s; the run page redraws on stream events (`runs.js:336`) | Layout-shift entries across one polling tick with an unchanged fixture; expected near zero, anything else is a defect |
| Layout shift from the since strip and health bar | They are inserted above `.layout` after the first draw (`ui/index.html:34-35`) | A shift entry on every admin route when the strip appears |
| Header overflow at 768 | 17 links, no wrap or scroll above 760 px (`style.css:65`) | `scrollWidth > clientWidth` on `.top` at 768 |
| Table overflow at 768 and 390 | F14 | `scrollWidth > clientWidth` on `document.documentElement` on each route whose table has no `.table-box` |
| Flow editor and graph at 390 | One column under 1100 px (`style.css:288`), no other rule | Clipped controls in the step list at 390 |
| Sidebar pushes content at 390 | `.layout` is one column under 760 px, so the flow list comes first (`style.css:292`) | Position of the first heading of `main` at 390 on every admin route |

## Consolidation candidates

For #248–#250.

| What | With what | Kind | Evidence |
|---|---|---|---|
| Your turn, Runs, Board | one run surface | Structural | F1 |
| My repositories, Repositories, Credentials | one Repositories page | Structural | F2 |
| `ui/runs.js` and `ui/user/runs.js` | one run page with a role flag | Structural | F3 |
| "Runs" and "My runs", "Repositories" and "My repositories" | names by content | Structural | F4 |
| Admin Start work and "Run" in the editor | one starting point | Structural | F5 |
| Watchers and Settings | split by task | Structural | F6 |
| Problems, health bar, monitor card | one Monitor page | Structural | F7 |
| Flows, Library, `#/new` | one Flows place | Structural | F8 |
| 17 flat nav links | grouped nav | Structural | F9 |
| Brand and default page | same target | Structural | F10 |
| native `confirm`/`prompt`, `confirmDialog`, `decisionDialog` | two helpers over `modal` | Structural | F11 |
| Retry, Resume, Start, Run, Needs you | one word each | Structural | F13 |
| Inline styles | classes in `ui/style.css` | Visual | F12 |
| Tables | one wrapper | Visual | F14 |
