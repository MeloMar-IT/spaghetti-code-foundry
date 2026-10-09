# UI states: loading, empty, error, permission and stale

Status: building blocks done; pages are converted in later parts. Part 1 of 8 of #266 (#342).

Every page should say in the same way whether it is loading, empty, failed, not allowed or showing old data. The shared code is in `ui/states.js`. It imports only `./dom.js`.

## Functions

| Function | What it draws |
|---|---|
| `explainError(e, { what, safe })` | Not a view. Turns an error into `{ kind, what, safe, next }` for `errorState` |
| `loadingState(label, { rows = 3, shape })` | A skeleton. `shape` is `"list"` (default), `"table"`, `"cards"` or `"detail"`. `aria-busy="true"` and one hidden label |
| `emptyState(text, action?)` | The `.empty` box with an optional primary button `{ label, onClick }` |
| `errorState(info, { onRetry, back, focus = "retry" })` | `role="alert"`, three lines (what happened, what is safe, what to do) and a Retry button and/or a back link `{ href, label }`. `focus` is the `data-focus` name of the Retry button |
| `permissionState(text, back)` | The same box for "you are not allowed", with a back link |
| `staleText(at, failed)` | Not a view. The text of the stale note: "Updated 12:03", or when `failed`, "Could not refresh. Showing data from 12:03." ("Could not refresh." with no valid time). "" for a good note with no valid time |
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

## Messages and confirmations

Part 2 of 8 (#343). `toast` and `confirmDialog` are in `ui/dom.js`; `banner` is in `ui/states.js`.

| Function | What it does |
|---|---|
| `toast(msg, kind = "info", { action, sticky })` | A short message. Info goes after 3.5 s. `kind === "error"` or `sticky` stays until the ✕ button is pressed. `action: { label, run }` draws one button (used for Undo); it runs once and closes the toast. A new toast replaces the old one. The live region uses `role="status"` (info) or `role="alert"` (error); the same text within 5 s is announced once |
| `confirmDialog({ title, text, confirm = "Delete", cancel, danger = true })` | `Promise<boolean>` on `modal()`. Focus starts on Cancel. `true` only from the confirm button; Escape, ✕ and the backdrop give `false` |
| `banner(kind, text, actions?)` | A message that stays on the page. `kind` is `error`, `warn` or `info`. `role="alert"` for `error`, else `role="status"` |

When to use which:

| Need | Use |
|---|---|
| Confirm that an action worked | Info toast |
| An action failed | Error toast (stays until read), or the inline pattern when it belongs to one field or row |
| A field is wrong | Inline validation next to the field |
| Required follow-up, stale data, a lost stream | `banner` or text on the page. A toast never carries the only copy of a required follow-up |
| A dangerous or hard-to-reverse action | `confirmDialog` |
| A reversible action | Do it, then a toast with Undo |

Undo is offered only where the server already has a reverse call: `api.restoreTurn(key)` (Dismiss on Home, restores only that item) and `api.restoreRefinement` (Drop in Refinement, own sessions only). Drop keeps its confirmation. The two Undo toasts are sticky.

## Where each state is planned

Every cell is "planned in part N" until the part converts that workspace. The parts are #343–#349.

| Workspace | Loading | Empty | Partial | Stale | Offline / provider failure | Permission | Success |
|---|---|---|---|---|---|---|---|
| Home | Done (#425): skeleton before the first answer, on Home and Your turn | planned in part N | Done (#425): a failed refresh keeps the items and shows the banner once | Done (#425): "Updated" note on the standalone Your turn page; an unchanged poll does not redraw | Done (#425): a first-load failure shows `errorState` with Retry; the page never rejects | planned in part N | planned in part N |
| Board | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Refinement | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Start work | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Runs | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Repositories | Done (#346): skeleton table on My repositories, All repositories and Credentials | Done (#346): `emptyState`, and the add prompt | Done (#346): a failed `repoMethods` call shows the list with a note that adding is not possible now | Done (#346): `staleNote` with Retry when a reload fails; the list stays | Done (#346): "Connection failed" with the reason stays on the row until the next test | Done (#346): `permissionState` on a 403; no action buttons in the read-only preview | Done (#346): "Repository added" toast; the deploy-key follow-up stays as a banner until the connection works |
| Build | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |
| Administration | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N | planned in part N |

## Background refresh (part 3, #344)

`ui/live.js` is the shared helper for pages that refresh themselves. No page uses it yet (part 3a); pages move to it in the next parts. It imports only `./dom.js` and `./states.js`.

| Export | What it does |
|---|---|
| `poller({ load, draw, every, onState, hold, wake })` | Returns `{ ready, refresh(), show(data), stop() }` |
| `keepScroll(box, fn)` | Runs `fn`, then restores the page scroll and the scroll of every `[data-scroll]` element in `box` (matched by attribute value) |
| `liveStates({ body, heading, label, rows, shape, what, quiet, retry, focus })` | Returns `{ alert, note, onState }`; give `onState` to the poller |
| `dialogOpen()` | True when `#modal-root` has children |

**Poller rules**

- One gate for every request (first request, tick, `refresh()`, `online` event, follow-up after a flight): not stopped, `document.visibilityState === "visible"`, and not offline. On a local address (`localhost`, `127.0.0.1`, `[::1]`) the offline signal is ignored, because the local server still answers without a network.
- One request at a time. A tick or `refresh()` during a flight gives exactly one follow-up; the gate is checked again before it is sent.
- On return to a visible tab: `wake()` is awaited (a rejection is ignored), visibility is checked again, then one request is made. A second `visibilitychange` during `wake()` starts nothing.
- A poller created in a hidden tab makes no request until the tab is visible. `ready` resolves after the first answer or failure, at once when the first request is deferred, and on `stop()`.
- `draw` is called only when `JSON.stringify(data)` differs from what was drawn. A `load` that resolves `undefined` gives no draw and no `onState`.
- Failure: no draw; `onState({ at, failed: true, error })` with the last good time (or `undefined`). Success: `onState({ at, failed: false })`, once per answer. `show(data)` does the same for an answer that came another way.
- `hold()` true keeps the newest answer; it is drawn within 250 ms after the hold ends, unless it equals what is drawn.
- `offline` event: `onState` failed and no requests (not on a local address). `online` event: one request, only if visible.
- `stop()`: no further requests, draws or `onState`; timers are cleared and the document and window listeners are removed.

**Live states.** At the start `body` holds `heading()` and `loadingState`. A first failure shows `heading()` and `errorState` with Retry (not re-mounted on a repeat). After data, `note` holds "Updated HH:MM" (nothing when `quiet`). A later failure fills `alert` with one `banner("error", staleText(at, true), [Retry])`, mounted once across repeats; the next success empties it. Retry buttons have `data-focus` `${focus}-retry` (first load) and `${focus}-refresh-retry` (banner); without `focus` they are `retry` and `refresh-retry`.

## Done in this part

- The catch-all error of the two routers (`route()` in `ui/app.js` and `ui/user/app.js`) shows `errorState(explainError(e, …), { onRetry: route })`. The `routeGen` and `generation` checks stay, so a late error does not replace a newer page.
- CSS in `ui/style.css`: `.skeleton` (no animation under `prefers-reduced-motion`), `.state-error`, `.stale-note`, `.sr-only`. `.empty`, `.errors` and `.spinner` stay.
- The three existing error-text helpers are not merged here. Pages keep them until their own part.
- If #251 or #252 deliver components with other names, the names recorded here win for parts 2–8, and this file is updated with the final names.
