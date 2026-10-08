# Decisions

Part of #248. Accepted and rejected design decisions for the shell and six pages, with reasons. Each reason names its evidence: rows of the Alternatives table in `walkthroughs.md` (S1, S2, S3, H1, H2, B1, B2, L1, L2, R1, R2, P1, P2, A1, A2) or findings in `findings.md` (F1 to F14).

The alternatives are:

- Shell: S1 sidebar with labels, S2 icon rail, S3 top tabs.
- Home: H1 list, H2 split.
- Board: B1 columns, B2 list.
- Runs: L1 table, L2 cards.
- Run: R1 tabs, R2 split.
- Repositories: P1 table with side panels, P2 cards.
- Administration: A1 section list, A2 one page.

## Decisions

| ID | Surface | Decision | Status | Reason | Evidence |
|---|---|---|---|---|---|
| D1 | Shell | S1: sidebar with labels, search and actions in the top bar | Accepted | Seven labelled links replace 17; no dead ends in the walkthroughs | S1 rows, F9 |
| D2 | Shell | S2: icon rail | Rejected | A first-time user may not know which icon is Repositories | S2 rows, F9 |
| D3 | Shell | S3: top tabs | Rejected | Seven tabs overflow at 390 px; Refinement is hidden by the scroll | S3 rows, F9 |
| D4 | Shell | Start work is a button and a panel, not a link | Accepted | One place for the main action on every page; the box takes focus, so one click less | S1 rows, F5 |
| D5 | Shell | Keep seventeen flat links, only grouped under headings | Rejected | Still 17 peers; the walkthroughs gain nothing | F9, F10 |
| D6 | Home | H1: "Needs you" first, then active and recent | Accepted | Waiting work is found in 1 click; the failed run in 1 click | H1 rows, F1 |
| D7 | Home | H2: split list and detail | Rejected | Saves one click only when the waiting item is first; at narrow the pane falls below the list | H2 rows |
| D8 | Home | The user gets a Home with its own address (`/user/#/home`), and no address opens Home | Accepted | One landing for both roles; today the landing depends on data (`homeHash`) | F10, F4 |
| D9 | Board | B1: columns, with a card panel and a Display menu | Accepted | Shows task states at a glance; the card opens in a panel without leaving the board | B1 rows, F1 |
| D10 | Board | B2: list as the default | Rejected | Same counts as B1, and the states are harder to compare; kept as the List view in Display | B2 rows, B1 rows |
| D11 | Runs | L1: table with chips and a Display menu | Accepted | Twelve rows per screen; owner and cost columns for admins; a scroll box at narrow | L1 rows, F3, F14 |
| D12 | Runs | L2: cards | Rejected | Five cards per screen; the failed card is not marked more than the others | L2 rows |
| D13 | Runs | A separate "Needs you" list next to Runs | Rejected | Home already shows it; two lists for the same items is F1 again | F1, F3 |
| D14 | Run | R1: header with the main button, tabs, failing step open | Accepted | Diagnose in 0 clicks; the old run shows status only | R1 rows, F3, F13 |
| D15 | Run | R2: split step list and detail | Rejected | Same counts as R1; at 390 px the detail falls below the step list | R2 rows |
| D16 | Run | One word for continuing a failed run: "Retry from the failing step" | Accepted | Three words today for the same thing | F13 |
| D17 | Repositories | P1: table with side panels for Add and Settings | Accepted | Add in 4 clicks; settings in 2; credentials column for admins | P1 rows, F2 |
| D18 | Repositories | P2: cards | Rejected | Credentials are not shown; fewer rows per screen | P2 rows |
| D19 | Repositories | One Repositories page with a scope switch for admins, instead of three pages | Accepted | Mine, All and Credentials were three nav links | F2, F4 |
| D20 | Administration | A1: section list and content, sections as disclosure | Accepted | Users in 1 click, Settings in 2; the list stays visible | A1 rows, F6, F7 |
| D21 | Administration | A2: one page with anchors and a "More" entry | Rejected | Five sections behind one entry cost an extra click | A2 rows |
| D22 | Administration | Watchers and Settings stay in one section | Rejected | The audit says to split them by task | F6 |

## Patterns

| Pattern | Used in | Status | Reason |
|---|---|---|---|
| Global session access | Account menu and Activity panel on every page | Accepted | Same place on every page; the since groups move into Activity (F1) |
| Task-state boards | B1, and "Needs you" first on Home | Accepted | Status was drawn in five places (F1) |
| Master-detail workspaces | H2 and R2 | Rejected | No gain in the walkthroughs; kept for the Board card panel only |
| Command search | Top bar on every page | Accepted | Reaches any run or page in 2 clicks; not needed for the five tasks |
| Focused side panels | Start work, Review request, Add repository, Settings, card | Accepted | Fewer page changes; focus goes to the first box |
| Display options | Display menu on Board, Runs and Repositories | Accepted | Compact and List without a new page |
| Progressive disclosure | Failing step open, sections closed | Accepted | The first screen shows the one thing to do |

## Open after the walkthroughs

- H2 saves one click for Approve when the waiting item is first (0 / 1 / 0 against 1 / 2 / 0). The default stays H1, because with several waiting items H2 needs the extra click again and at narrow widths its pane falls below the list. A real check should try both.
- B1 and B2 have the same counts. Which a person prefers is only known from a session with people. B1 is the default; B2 stays as a Display option.
- Command search was not part of any of the five tasks. It is a pattern with no measured gain here.
- Nothing was checked in a browser. The visual check sheet in `walkthroughs.md` is for that.
- The refinement session page, flow editor and sign-in were not prototyped.

## Owner approval

The direction is S1, H1, B1, L1, R1, P1 and A1, with the default decisions above (#248).

```
Status: proposed
Approved by: —
Where: plan approval on issue #248
Note: none
Checked on the pages: open
```

No approval step output was available to the run, so the status is `proposed`. The Foundry accepts `/approve` from any account with write access to the repository, so the record names the login but cannot prove it was the owner. #249 and #250 build the shell; hold them with the label `Factory_review_plan` if the pages should be looked at first. "Checked on the pages" is for the owner to fill in after opening the pages.
