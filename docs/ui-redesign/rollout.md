# UI redesign: rollout

## Status

The redesign is the only interface served.

- Built: the route compatibility test `tests/ui-rollout.test.ts`.
- Not built: the `ui.version` setting, the `ui-classic/` copy, the Settings switch, the gate checklist.

If the switch is built later, that change updates this page and "Old and new interface" in `../USER_GUIDE.md`.

## What moved where

| Address | Before | Now |
|---|---|---|
| `#/home` | Home | Today |
| `#/your-turn` | Your turn | Today (Needs you) |
| `#/runs` | Runs, My runs | Changes |
| `#/refinement` | Refinement | Ideas |
| `#/epics` | Epics | Releases |
| `#/start` | Start work (button) | + New change (button in the top bar) |
| `#/library` | Library | Flows → Library |
| `#/repos` | My repositories | Repositories → My repositories |
| `#/all-repos` | All repositories | Administration → All repositories |
| `#/credentials` | Credentials | Administration → Credentials |
| `#/users` | Users | Administration → Users |
| `#/watchers` | Watchers | Administration → Watchers |
| `#/models` | Models | Administration → Models |
| `#/problems` | Problems | Administration → Problems |
| `#/dashboard` | Dashboard | Administration → Dashboard |
| `#/audit` | Audit | Administration → Audit |
| `#/settings` | Settings | Administration → Settings |

"Now" is the name in the sidebar (`SIDEBAR_MAIN` and `SIDEBAR_EXTRA` in `ui/ia.js`) or the top bar (`NEW_CHANGE`).
The pages keep their names (`DESTINATIONS` and `PAGES`), which show in the top bar, the breadcrumbs and Search.
Every address above is unchanged. Board and Flows kept their names and addresses.

## Old addresses

All old addresses resolve to a page. `#/your-turn` opens Home (Today in the sidebar). The source is `ui/ia.js`.
