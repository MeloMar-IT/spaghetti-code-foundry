# Prototypes

Part of #248. Static pages in `prototype/` with fake data. They are not served by the server, not wired to the API and use no framework. Open `prototype/index.html` in a browser (from the folder, or with `file://`).

Nothing here was checked in a browser. The run that built it had none. See "What is not checked" in `README.md` and the visual check sheet in `walkthroughs.md`.

## How to use the pages

Every page has a switch bar at the top (drawn by `proto.js`):

- **Role**: `admin` or `user`. The same pages show what each role sees.
- **Theme**: `auto` (the browser), `light`, `dark`.
- **Width**: `wide`, or `narrow` (a 390 px frame; the sidebar becomes a drawer behind a menu button).
- **Alternative**: `a`, `b` (and `c` on the shell page). One layout idea each.
- **State**: `data`, `empty`, `loading`, `error`, `dense` (40 rows), and page specific ones. States other than `data` exist for alternative `a` only; picking another alternative shows `data`.
- **Run** (run page only): `waiting`, `running`, `failed`, `done`, `old`.

The values are also in the address (`?role=user&theme=dark&width=narrow&state=empty&alt=a`), so a view can be shared. Links between pages carry role, theme and width. Press ⌘K, Ctrl+K or `/` for command search, Escape closes a panel.

In the dense states a few sample rows are repeated to 40 by `proto.js`.

## Seven patterns and where they are used

Generic patterns. Web access is not available to the run, so nothing was checked against a named product, and no product names or logos appear.

| Pattern | Where it is used |
|---|---|
| Global session access | Account menu and Activity panel in the top bar of every page |
| Task-state boards | `board.html` B1, and Home "Needs you" first |
| Master-detail workspaces | `home.html` H2, `run.html` R2 |
| Command search | Top bar search on every page (⌘K, Ctrl+K, `/`) |
| Focused side panels | Start work, Review request, Add repository, repository settings, board card |
| Display options | "Display" menu on Board, Runs and Repositories (compact, view) |
| Progressive disclosure | Failing step open and others closed; Administration sections; Details below the steps |

## Pages

| Page | What | Alternatives |
|---|---|---|
| `index.html` | Application shell and the page list | S1 sidebar, S2 icon rail, S3 top tabs |
| `home.html` | Home: what needs you, what runs | H1 list, H2 split |
| `board.html` | Board of task states (admin) | B1 columns, B2 list |
| `runs.html` | Runs list | L1 table, L2 cards |
| `run.html` | Run detail | R1 tabs, R2 split |
| `repositories.html` | Repositories | P1 table, P2 cards |
| `admin.html` | Administration (admin) | A1 sections, A2 one page |

On `index.html` the alternatives are the shell: `a` = S1, `b` = S2, `c` = S3. On the other pages the shell is always S1 and the alternative `a` or `b` is the layout of the page (H1/H2, B1/B2, L1/L2, R1/R2, P1/P2, A1/A2).

## State matrix

| Page | Alternatives | States | Runs |
|---|---|---|---|
| `index.html` | a b c | data empty loading error problem | — |
| `home.html` | a b | data empty loading error | — |
| `board.html` | a b | data empty loading error dense | — |
| `runs.html` | a b | data empty loading error dense | — |
| `run.html` | a b | data loading error notfound | waiting running failed done old |
| `repositories.html` | a b | data empty loading error dense | — |
| `admin.html` | a b | data empty loading error dense | — |

Permission-limited examples: Role `user` on `board.html` and `admin.html` shows a note about the prototype (the product sends a user to the user display, and an unknown address becomes the Runs list). Role `user` on any page hides Board, Flows, Administration, health, "Since you last looked", owner, cost and transcripts. `run.html` state `notfound` is one card for both a missing run and a run the user may not see, because the server answers 404 for both.

## Routes

Every address of the audit (`inventory.md`) still works. New places get new addresses; old ones open the new place.

| Existing address | Display | Place in the prototype | Still works | Note |
|---|---|---|---|---|
| `#/home` | admin | Home, "Needs you" (`home.html`) | yes | Your turn becomes Home; the old address `#/your-turn` is now an alias of `#/home` (`ui/ia.js`) |
| `#/board` | admin | Board (`board.html`) | yes | |
| `#/board/:id` | admin | Board with the repository picked | yes | |
| `#/refinement` | both | Refinement in the nav | yes | Not prototyped; list unchanged |
| `#/refinement/:id` | both | Session page | yes | Not prototyped; unchanged |
| `#/flows` | admin | Flows in the nav | yes | Not prototyped |
| `#/flows/:name` | admin | Flows | yes | Not prototyped |
| `#/new` | admin | Flows, new flow | yes | Not prototyped |
| `#/library` | admin | Flows (library as part of Flows) | yes | Not prototyped |
| `#/start` | both | Start work panel, any page | yes | A panel, not a page |
| `#/runs` | both | Runs (`runs.html`) | yes | |
| `#/runs/:id` | both | Run (`run.html`) | yes | |
| `#/repos` | both | Repositories, scope Mine (`repositories.html`) | yes | |
| `#/all-repos` | admin | Repositories, scope All | yes | |
| `#/credentials` | admin | Repositories, Credentials column and settings panel | yes | |
| `#/maintenance` | admin | Administration, Maintenance (title only) | yes | |
| `#/watchers` | admin | Administration, Watchers (title only) | yes | |
| `#/watchers/:id` | admin | Administration, Watchers (title only) | yes | |
| `#/settings` | admin | Administration, Settings | yes | |
| `#/problems` | admin | Health band and panel; Administration, Problems (title only) | yes | |
| `#/problems/:id` | admin | Administration, Problems (title only) | yes | |
| `#/models` | admin | Administration, Models (title only) | yes | |
| `#/dashboard` | admin | Administration, Dashboard (title only) | yes | |
| `#/users` | admin | Administration, Users | yes | |
| `#/audit` | admin | Administration, Audit (title only) | yes | |
| `/user/#/start` | user | Start work panel, any page | yes | |
| `/user/#/runs` | user | Runs | yes | |
| `/user/#/runs/:id` | user | Run | yes | |
| `/user/#/repos` | user | Repositories | yes | |
| `/user/#/refinement` | user | Refinement in the nav | yes | Not prototyped |
| `/user/#/refinement/:id` | user | Session page | yes | Not prototyped |
| `/` (no hash) | admin | Home | yes | Nothing waiting: Home, empty state (was Flows) |
| `/` (unknown hash) | admin | Home | yes | Was the Flows welcome page |
| `/user/` (no hash) | user | Home | yes | Was Start work or My runs |
| `/user/` (unknown hash) | user | Runs | yes | Unchanged |
| `#/set-password/:token` | both | Sign-in page | yes | Not prototyped |
| `/user/?as=<id>` | user | Admin preview of a user | yes | Not prototyped |
| Wrong display | both | Other display, valid hash kept | yes | Unchanged |
| Preview ended | user | Preview ended card | yes | Not prototyped |
| `/user/#/home` | user | Home | yes | new: the user's Home needs an address; #249 and #250 build it |

## Health and since

The health band and the "Since you last looked" strip are admin only (`GET health` and `GET since`). The band stays above the page; the since groups move into the Activity panel.

| Name | Source | Where in the prototype | Role | Note |
|---|---|---|---|---|
| `summary` | `src/server/health.ts` | Band text "All good" or "2 problems" | admin | |
| `problems` | `src/server/health.ts` | Band, state `problem` on `index.html` | admin | One sentence each |
| `closed_elsewhere` | `ui/health.js` | Cancel run button in the band | admin | Cancel asks first in the product |
| `monitorFindings` | `src/server/health.ts` | Health panel, "Monitor findings" | admin | |
| `repos` | `src/server/health.ts` | Health panel, "Last check of" | admin | |
| `version` | `src/server/health.ts` | Health panel | admin | |
| `update` | `src/server/health.ts` | Health panel, "An update is waiting" | admin | Not a problem |
| `does not answer` | `ui/health.js` | State `error` on `index.html` | admin | Shown as the page error |
| `done` | `src/since.ts` | Activity panel, Done | admin | |
| `develop` | `src/since.ts` | Activity panel, On develop | admin | |
| `released` | `src/since.ts` | Activity panel, Released | admin | |
| `failed` | `src/since.ts` | Activity panel, Failed | admin | |
| `waiting` | `src/since.ts` | Activity panel, Waiting | admin | |
| `notes` | `src/since.ts` | Activity panel, Notes | admin | |
| `Dismiss` | `ui/since.js` | Activity panel, Dismiss | admin | |

The user's Activity panel lists the user's own runs that need them or failed.

## The old run

An old run is one made before steps and cost were recorded. In `runs.html` it is the row with `data-run="old"`. In `run.html` (run `old`):

- Status only. No filled button; only "Back to Runs".
- Details show "—" for the start time, flow and cost.
- "No changes recorded." No steps and no transcript tab.
- No action that the data cannot support.

## What is not prototyped

- The refinement session page and the refinement list. Task 5 ends on the unchanged session page.
- The flow editor and Library.
- Sign-in, first setup and change password.
- The admin preview `/user/?as=<id>` and the "preview ended" card.
