# UI redesign research 1: audit of every screen

Status: partial. Part of #247.

An audit of the web UI, as a base for #248–#250. Taken on 2026-10-07 from commit `27479e3`. It was made by reading the code, not by measuring in a browser.

## Files

| File | What |
|---|---|
| `inventory.md` | Every route, special address and screen without a route; states; responsive layout read from `ui/style.css`; inline-style counts |
| `dialogs.md` | Every dialog variant and every native `confirm` and `prompt` |
| `journeys.md` | The fixture, the counting rules and nine journeys with step counts |
| `findings.md` | Findings split into structural and visual, candidates that need a measure, and consolidation candidates |
| `measurement.md` | Widths, measures, existing screenshots, capture list, five tasks with modelled times, protocol, empty results table |
| `prototype/` | Research 2 (#248): static pages with fake data (`index.html`, `home.html`, `board.html`, `runs.html`, `run.html`, `repositories.html`, `admin.html`), `proto.css` and `proto.js` |
| `prototypes.md` | The seven patterns, pages and alternatives, state matrix, route table, health and since mapping, the old run |
| `walkthroughs.md` | Walkthroughs of the five tasks for both roles and every alternative; locate and primary-action tables; usability and visual check sheets |
| `decisions.md` | Accepted and rejected decisions with reasons and evidence; owner approval record |

## What the test checks

`tests/ui-redesign-audit.test.ts` compares the tables with the code, in both directions: the admin routes in `route()` (`ui/app.js`), the user routes in `USER_HASH` (`ui/auth.js`), the nav links of both displays, the call sites of `modal(`, the native `confirm(` and `prompt(` calls and the files with 10 or more inline styles. It also checks that the findings are typed, that the results table has five empty rows, and that every image in `docs/images/` is named.

What it does not check: the wording, the counts inside the journeys, and whether a dialog variant was added inside a call site other than `callDialog`. Review those by hand when the UI changes. A new or removed route or nav link fails the test. Native dialogs are matched one row per call, with the line checked. Modal rows are only counted per file (at least one row per call site), so a call site added to a file that already has spare rows (for example `ui/app.js`, 3 rows for 2 sites) can go unnoticed.

## Research 2 (#248): prototypes

Low-fidelity pages for the shell, home, board, runs, run, repositories and administration, with alternatives, states and both roles. Open `prototype/index.html` in a browser; the switch bar at the top sets role, theme, width, state and alternative. The pages are not served by the server and not wired to the API. `walkthroughs.md` counts the five tasks in them. `decisions.md` records what was accepted and rejected, and the owner approval of the direction (status `proposed` until an approval is recorded there).

What is not checked: how the pages look, and the wiring in a real browser. The run that made them had no browser. `tests/ui-redesign-prototype.test.ts` checks the markup, the documents against the code and `proto.js` logic. The visual check sheet in `walkthroughs.md` covers both roles, the three themes, both widths, every state and every alternative; the owner fills it in.

## What is open

- Measured time, errors and confidence for the five tasks. The owner runs the sessions with people (protocol in `measurement.md`).
- Screenshots at 1440, 1280, 768 and 390. The 19 images in `docs/images/` are desktop only and are not a baseline.
- Overflow and layout-shift observations. The responsive and layout-shift notes are guesses from code, each with the observation that would confirm it.

Two follow-up issues are for the owner to open: (1) the sessions for measured time, errors and confidence; (2) a capture runner for the four widths, which is a new dependency and needs its own decision. They are not opened here, and neither carries `Factory_go`.

Issue #247 is not complete with this change. If the Foundry closes it on merge, reopen it or open the two follow-ups.
