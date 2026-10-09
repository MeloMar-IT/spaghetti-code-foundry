# UI redesign: rollout

## Status

The redesign is the only interface served.

- Built: the route compatibility test `tests/ui-rollout.test.ts`.
- Not built: the `ui.version` setting, the `ui-classic/` copy, the Settings switch, the gate checklist.

If the switch is built later, that change updates this page and "Old and new interface" in `../USER_GUIDE.md`.

## What moved where

| Address | Before | Now |
|---|---|---|
| `#/your-turn` | Your turn | Home (Needs you) |
| `#/library` | Library | Flows → Library |
| `#/repos` | My repositories | Repositories → My repositories |
| `#/all-repos` | All repositories | Repositories → All repositories |
| `#/credentials` | Credentials | Repositories → Credentials |
| `#/users` | Users | Administration → Users |
| `#/watchers` | Watchers | Administration → Watchers |
| `#/models` | Models | Administration → Models |
| `#/problems` | Problems | Administration → Problems |
| `#/dashboard` | Dashboard | Administration → Dashboard |
| `#/audit` | Audit | Administration → Audit |
| `#/settings` | Settings | Administration → Settings |

Start work (`#/start`) is now a button in the top bar. Home, Board, Refinement, Runs and Flows kept their names and addresses.

## Old addresses

All old addresses resolve to a page. `#/your-turn` opens Home. The source is `ui/ia.js`.
