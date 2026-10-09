# UI states: loading, empty, error, permission and stale

Status: building blocks done; pages are converted in later parts. Part 1 of 8 of #266 (#342).

Every page should say in the same way whether it is loading, empty, failed, not allowed or showing old data. The shared code is in `ui/states.js`. It imports only `./dom.js`.

## Functions

| Function | What it draws |
|---|---|
| `explainError(e, { what, safe })` | Not a view. Turns an error into `{ kind, what, safe, next }` for `errorState` |
| `loadingState(label, { rows = 3, shape })` | A skeleton. `shape` is `"list"` (default), `"table"`, `"cards"` or `"detail"`. `aria-busy="true"` and one hidden label |
| `emptyState(text, action?)` | The `.empty` box with an optional primary button `{ label, onClick }` |
| `errorState(info, { onRetry, back })` | `role="alert"`, three lines (what happened, what is safe, what to do) and a Retry button and/or a back link `{ href, label }` |
| `permissionState(text, back)` | The same box for "you are not allowed", with a back link |
| `staleNote(at, { failed, onRetry })` | "Updated 12:03", or "Could not refresh. Showing data from 12:03." with a Retry button |

### `explainError`

`kind` comes from `e.status`:

| `kind` | When |
|---|---|
| `offline` | No `e.status` (the fetch failed) |
| `permission` | 403 |
| `missing` | 404 |
| `conflict` | 409 |
| `server` | 5xx |
| `other` | Anything else |

`what` is the caller's sentence plus the server's `error` text. `safe` and `next` are short fixed sentences for each kind. A caller can replace `safe` when it knows better.

The client cannot know whether a request that got no answer took effect. The `offline` and `server` texts say so and tell the user to check the page before saving again.

## The six patterns

| Pattern | Use when | Drawn by |
|---|---|---|
| Page | The whole page loads, is empty or fails | `loadingState` with `rows` and a shape; `emptyState`; `errorState` with Retry |
| Section | One part of a page loads or fails and the rest works | `loadingState` and `errorState` inside that part. The rest stays usable |
| Inline | One field or one row fails, for example a failed save | The `errors` box or `errorState` next to the control. Keep what the user typed |
| Background refresh | Data refreshes on a timer or by event and the page already shows data | `staleNote`. On failure keep the old data and show the failed note with Retry |
| Optimistic | The change is shown at once and sent after | Show the new value; on failure put the old value back and use `errorState` inline |
| Blocking | The user must decide or wait before going on, or is not allowed | A dialog for the decision; `permissionState` when not allowed |

## Where each state is planned

Every cell is "planned in part N" until the part converts that workspace. The parts are #343–#349.

| Workspace | Loading | Empty | Partial | Stale | Offline / provider failure | Permission | Success |
|---|---|---|---|---|---|---|---|
| Home | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Board | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Refinement | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Start work | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Runs | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Repositories | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Build | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Administration | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |

## Done in this part

- The catch-all error of the two routers (`route()` in `ui/app.js` and `ui/user/app.js`) shows `errorState(explainError(e, …), { onRetry: route })`. The `routeGen` and `generation` checks stay, so a late error does not replace a newer page.
- CSS in `ui/style.css`: `.skeleton` (no animation under `prefers-reduced-motion`), `.state-error`, `.stale-note`, `.sr-only`. `.empty`, `.errors` and `.spinner` stay.
- The three existing error-text helpers are not merged here. Pages keep them until their own part.
- If #251 or #252 deliver components with other names, the names recorded here win for parts 2–8, and this file is updated with the final names.
