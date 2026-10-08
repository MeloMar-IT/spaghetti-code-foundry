# Walkthroughs

Part of #248. Written walkthroughs of the five tasks in the prototype pages (`prototype/`), for both roles and for every alternative. They are counts made by reading the finished pages, not sessions with people. The owner can run a real check with the sheets at the end.

## Method

The counting rules are those of `journeys.md`:

- One **navigation step** is one page change or one panel or dialog opened.
- One **click** is one pointer activation, including a click that only puts the cursor in a box. Typing and Tab are not clicks. A box that takes focus when its panel opens costs no click.
- One **field** is one input typed or chosen when the default is not what the task needs.

Fixture: the one of `journeys.md` (one admin, one user, repository `example/app`; four runs of the user: done, failed, waiting for approval, running). **Base** has those runs; **Empty** has none. "Starts on" says where the count begins. A count of 0 means the target is already on screen.

## The five tasks

Each row is walked in the prototype and compared with the baseline of `journeys.md` (the audit, #247). The baseline is the count in the current UI.

| Task | Role | Variant | Path in the prototype | Nav | Clicks | Fields | Baseline | Source |
|---|---|---|---|---|---|---|---|---|
| 1 Start work | user | Empty | Home shows the form inline: click the box, type, Start | 1 | 2 | 1 | 1 / 2 / 1 | `journeys.md` J1 |
| 1 Start work | user | Base | Start work (panel, box focused), type, Start | 2 | 2 | 1 | 2 / 3 / 1 | `journeys.md` J1 |
| 1 Start work | admin | Base | Start work (panel, box focused), type, Start | 2 | 2 | 1 | 2 / 3 / 1 | `journeys.md` J1 |
| 2 Approve | admin | — | Home, Review request (panel), Approve | 1 | 2 | 0 | 1 / 2 / 0 | `journeys.md` J2 |
| 2 Approve | user | — | Home, Review request (panel), Approve | 1 | 2 | 0 | 2 / 3 / 0 | `journeys.md` J2 |
| 3 Diagnose | admin | — | Home, "See what failed" (run page, failing step open) | 1 | 1 | 0 | 2 / 3 / 0 | `journeys.md` J4 |
| 3 Diagnose | user | — | Same; the error shows, no transcript | 1 | 1 | 0 | 1 / 2 / 0 | `journeys.md` J4 |
| 4 Add repository | user | — | Repositories, Add repository (panel, URL focused), type, click token, type, Add | 2 | 4 | 2 | 2 / 5 / 2 | `journeys.md` J6 |
| 4 Add repository | admin | — | Same | 2 | 4 | 2 | 2 / 5 / 2 | `journeys.md` J6 |
| 5 Refine | user | — | Refinement, New idea (panel, box focused), type, Start, session page (unchanged): New draft, type | 3 | 4 | 2 | 3 / 5 / 2 | `journeys.md` J7 |
| 5 Refine | admin | — | Same | 3 | 4 | 2 | 3 / 5 / 2 | counted here from `ui/refinement.js` (line 467, "New session") and `ui/index.html` (nav "Refinement"): the admin display uses the same renderer as the user's, so the path is the same as J7 |

Result: no task is longer than its baseline. Approve for the user and Diagnose for both roles are shorter, because Home puts the item first and the failed run opens on its failing step.

## Alternatives

Every alternative walked through the tasks it changes, for both roles. Counts are nav / clicks / fields. "no access" means the page is not shown to that role (the product sends a user to the user display).

| Alt | Task | Role | Nav | Clicks | Fields | Dead ends | What the user may not see |
|---|---|---|---|---|---|---|---|
| S1 | 1 Start work | admin | 2 | 2 | 1 | none; the button is in the top bar | — |
| S1 | 1 Start work | user | 2 | 2 | 1 | none | Board, Flows, Administration |
| S1 | 4 Add repository | admin | 2 | 4 | 2 | none; "Repositories" has a label | — |
| S1 | 4 Add repository | user | 2 | 4 | 2 | none | Board, Flows, Administration |
| S1 | 5 Refine | admin | 3 | 4 | 2 | none | — |
| S1 | 5 Refine | user | 3 | 4 | 2 | none | Board, Flows, Administration |
| S2 | 1 Start work | admin | 2 | 2 | 1 | none | — |
| S2 | 1 Start work | user | 2 | 2 | 1 | none | Board, Flows, Administration |
| S2 | 4 Add repository | admin | 2 | 4 | 2 | icons only: a first-time user may not know which icon is Repositories | — |
| S2 | 4 Add repository | user | 2 | 4 | 2 | same icon problem | Board, Flows, Administration |
| S2 | 5 Refine | admin | 3 | 4 | 2 | same icon problem | — |
| S2 | 5 Refine | user | 3 | 4 | 2 | same icon problem | Board, Flows, Administration |
| S3 | 1 Start work | admin | 2 | 2 | 1 | none | — |
| S3 | 1 Start work | user | 2 | 2 | 1 | none | Board, Flows, Administration |
| S3 | 4 Add repository | admin | 2 | 4 | 2 | seven tabs overflow at 390 px; the last ones need a sideways scroll | — |
| S3 | 4 Add repository | user | 2 | 4 | 2 | none (four tabs fit) | Board, Flows, Administration |
| S3 | 5 Refine | admin | 3 | 4 | 2 | Refinement is the fifth tab; at 390 px it is hidden by the scroll | — |
| S3 | 5 Refine | user | 3 | 4 | 2 | none | Board, Flows, Administration |
| H1 | 1 Start work | admin | 2 | 2 | 1 | none | — |
| H1 | 1 Start work | user | 2 | 2 | 1 | none | Board, Flows, Administration |
| H1 | 2 Approve | admin | 1 | 2 | 0 | none; "Review request" is the filled button | — |
| H1 | 2 Approve | user | 1 | 2 | 0 | none | Other users' runs |
| H1 | 3 Diagnose | admin | 1 | 1 | 0 | none | — |
| H1 | 3 Diagnose | user | 1 | 1 | 0 | none | Transcripts |
| H2 | 1 Start work | admin | 2 | 2 | 1 | none | — |
| H2 | 1 Start work | user | 2 | 2 | 1 | none | Board, Flows, Administration |
| H2 | 2 Approve | admin | 0 | 1 | 0 | the detail pane shows the first request only; with several waiting, one more click | — |
| H2 | 2 Approve | user | 0 | 1 | 0 | same | Other users' runs |
| H2 | 3 Diagnose | admin | 1 | 1 | 0 | at 390 px the detail pane falls below the list | — |
| H2 | 3 Diagnose | user | 1 | 1 | 0 | same | Transcripts |
| B1 | 2 Approve | admin | 2 | 3 | 0 | starts on the Board: card (panel), Open run, Approve; the panel cannot approve | — |
| B1 | 3 Diagnose | admin | 2 | 2 | 0 | starts on the Board: card, Open run; nine columns need a sideways scroll | — |
| B1 | 2 Approve, 3 Diagnose | user | no access | no access | no access | the note sends the user to Home | Board |
| B2 | 2 Approve | admin | 2 | 3 | 0 | starts on the Board list: Open, Open run, Approve | — |
| B2 | 3 Diagnose | admin | 2 | 2 | 0 | none; no sideways scroll | — |
| B2 | 2 Approve, 3 Diagnose | user | no access | no access | no access | the note sends the user to Home | Board |
| L1 | 2 Approve | admin | 1 | 2 | 0 | starts on Runs: click the row, Approve; owner and cost make the table wide at 390 px | — |
| L1 | 2 Approve | user | 1 | 2 | 0 | none | Owner, cost |
| L1 | 3 Diagnose | admin | 1 | 1 | 0 | none | — |
| L1 | 3 Diagnose | user | 1 | 1 | 0 | none | Transcripts |
| L2 | 2 Approve | admin | 1 | 2 | 0 | starts on Runs: five cards per screen instead of twelve rows | — |
| L2 | 2 Approve | user | 1 | 2 | 0 | none | Owner, cost |
| L2 | 3 Diagnose | admin | 1 | 1 | 0 | the failed card is not marked more than the others | — |
| L2 | 3 Diagnose | user | 1 | 1 | 0 | same | Transcripts |
| R1 | 2 Approve | admin | 0 | 1 | 0 | starts on the run page: the filled button is in the header | — |
| R1 | 2 Approve | user | 0 | 1 | 0 | none | Owner, cost |
| R1 | 3 Diagnose | admin | 0 | 0 | 0 | failure card and failing step open on arrival | — |
| R1 | 3 Diagnose | user | 0 | 0 | 0 | none; the error shows | Transcripts |
| R2 | 2 Approve | admin | 0 | 1 | 0 | none | — |
| R2 | 2 Approve | user | 0 | 1 | 0 | none | Owner, cost |
| R2 | 3 Diagnose | admin | 0 | 0 | 0 | at 390 px the detail falls below the step list | — |
| R2 | 3 Diagnose | user | 0 | 0 | 0 | same | Transcripts |
| P1 | 4 Add repository | admin | 2 | 4 | 2 | none | — |
| P1 | 4 Add repository | user | 2 | 4 | 2 | none | Credentials, scope switch |
| P1 | Find repository settings | admin | 2 | 2 | 0 | none; Settings is on every row | — |
| P1 | Find repository settings | user | 2 | 2 | 0 | none | Credentials, scope switch |
| P2 | 4 Add repository | admin | 2 | 4 | 2 | none | — |
| P2 | 4 Add repository | user | 2 | 4 | 2 | none | Credentials, scope switch |
| P2 | Find repository settings | admin | 2 | 2 | 0 | credentials are not shown on the card | — |
| P2 | Find repository settings | user | 2 | 2 | 0 | none | Credentials, scope switch |
| A1 | Reach Users | admin | 1 | 1 | 0 | none; Users is open first | — |
| A1 | Reach Settings | admin | 1 | 2 | 0 | none; the section list stays visible | — |
| A1 | Reach Users, Reach Settings | user | no access | no access | no access | the note sends the user to Home | Administration |
| A2 | Reach Users | admin | 1 | 1 | 0 | none | — |
| A2 | Reach Settings | admin | 1 | 2 | 0 | five sections sit behind one "More" entry; one more click to reach Watchers | — |
| A2 | Reach Users, Reach Settings | user | no access | no access | no access | the note sends the user to Home | Administration |

## Locate

Can a person with no prior SCF knowledge find these? Clicks to open the item, counted from the landing page.

| Looking for | Role | Start | Path | Clicks |
|---|---|---|---|---|
| Waiting work | admin | Home | "Needs you" is the first block; click Review request | 1 |
| Waiting work | user | Home | Same | 1 |
| An active run | admin | Home | "Active and recent"; click Follow | 1 |
| An active run | user | Home | Same | 1 |
| A failed run | admin | Home | "Needs you" shows it; click See what failed | 1 |
| A failed run | user | Home | Same | 1 |
| Repository settings | admin | Home | Repositories in the sidebar; Settings on the row | 2 |
| Repository settings | user | Home | Same | 2 |

## Primary action

The filled button on each page. Every page has one, and only one, in each state.

| Page | Admin | User |
|---|---|---|
| `index.html` | Open Home; Start work when empty | Open Home; Start work when empty |
| `home.html` | Review request; Start when empty; Retry on error | Review request; Start when empty; Retry on error |
| `board.html` | Start work; Add repository when empty | no access |
| `runs.html` | Start work | Start work |
| `run.html` | Approve (waiting), Follow live (running), Retry from the failing step (failed), Review changes (done), none for an old run | Same |
| `repositories.html` | Add repository | Add repository |
| `admin.html` | Add user; Add watcher when empty | no access |

## Peer-level navigation

| Display | Before (first-level links) | After |
|---|---|---|
| Admin | 17 (`ui/index.html`) | 7: Home, Board, Runs, Repositories, Refinement, Flows, Administration |
| User | 4 (`ui/user/index.html`) | 4: Home, Runs, Repositories, Refinement |

Start work is a button in the top bar and a panel, not a link. The user's count stays at 4; the reduction is on the admin display.

## Usability check sheet

For the owner, in the style of `docs/USABILITY_CHECK.md`. Open `prototype/index.html`, set the role, give the person the task without telling them where to click, and write down the result. Leave a cell empty if not run.

| Task | Role | Alt | Start | Time (s) | Errors | Confidence |
|---|---|---|---|---|---|---|
| 1 Start work | user | S1, H1 | Home | | | |
| 2 Approve a waiting run | admin | S1, H1 | Home | | | |
| 2 Approve a waiting run | user | S1, H1 | Home | | | |
| 3 Diagnose a failed run | admin | S1, H1, R1 | Home | | | |
| 3 Diagnose a failed run | user | S1, H1, R1 | Home | | | |
| 4 Add a repository | admin | S1, P1 | Home | | | |
| 4 Add a repository | user | S1, P1 | Home | | | |
| 5 Refine an idea | user | S1 | Home | | | |

## Visual check sheet

For the owner, in a browser. For each page, set Role, Theme (light, dark), Width (wide, narrow), every State and every Alternative from `prototypes.md`, and mark what is wrong.

| Page | What to look at | Admin | User | Notes |
|---|---|---|---|---|
| `index.html` | S1, S2, S3; drawer at narrow; search, activity, account, health panels; error and problem bands | | | |
| `home.html` | H1, H2; review and start panels; empty form; loading; error | | | |
| `board.html` | B1, B2; nine columns; display menu; card panel; dense; user note | | | |
| `runs.html` | L1, L2; chips; display menu; old run row; dense | | | |
| `run.html` | R1, R2; all five runs; failing step open; old run has no filled button; not found | | | |
| `repositories.html` | P1, P2; add and settings panels; scope switch; dense | | | |
| `admin.html` | A1, A2; sections; dense users; empty watchers; user note | | | |
