# Dialogs

Read from the code at commit `27479e3`. Part of the audit in `README.md`; the routes are in `inventory.md`.

Three mechanisms draw a dialog:

- **`modal(title, build, { busy })`** in `ui/dom.js:161`: the base. It draws a title, a close button (✕) and whatever `build(close)` returns. Called at 26 sites in 18 files.
- **Wrappers over `modal`:** `callDialog` (`ui/users.js:113`, 11 callers), `confirmDialog` in `ui/dom.js` (the shared yes/no dialog, used by `ui/flow-page.js`, `ui/library.js`, the refinement pages and `adminRunActions`), `confirmDialog` in `ui/user/runs.js` (`:76`; a separate helper of the same name), `decisionDialog` in `ui/run-dialogs.js` (`:12`, re-exported by `ui/user/runs.js`), `withDialog` (`ui/user/runs.js:374`, guards against a second dialog), `openDetail` (`ui/turn-act.js:12`, loads the detail first).
- **Native `confirm` and `prompt`:** 0 calls (the second table is empty).

The call-site count is only where to start. One site can serve several dialogs; each variant a person can see has its own row. A row is keyed by file and dialog name; the test checks that the rows are unique and that no call site is left out. It cannot see a new variant added inside a call site other than `callDialog`.

## Dialogs

| File | Dialog | Opened by | Fields | Primary action | Helper |
|---|---|---|---|---|---|
| `ui/admin-repos.js` | Repository settings | Settings button on a row of `#/all-repos` | test command, docs, protected branches, main branch, develop branch | Save | `modal` |
| `ui/admin-repos.js` | Definition of Ready | Button on a row of `#/all-repos` | checklist items | Save | `modal` |
| `ui/admin-repos.js` | Transfer repository | Transfer button on a row | new owner e-mail | Transfer | `modal` |
| `ui/admin.js` | Delete watcher | Delete button on a watcher card of `#/watchers` (repository, monitor and not-connected paths) | none | Delete watcher | `confirmDialog` |
| `ui/operations.js` | Cancel this run | Cancel run in the Health card of the Overview | none | Cancel the run | `confirmDialog` (`ui/health.js`) |
| `ui/maintenance.js` | Remove workspaces | Clean up button on `#/maintenance` | none | Clean up | `confirmDialog` |
| `ui/monitor.js` | Switch on with a fresh state file | Switch on button when the state file cannot be read (`#/watchers` and `#/problems`, through `confirmUnreadable`) | none | Switch on | `confirmDialog` |
| `ui/flow-page.js` | Run <flow> | Test run button in the flow editor | task, repository, one input per flow variable | Run (also Cmd+Enter); with an empty task the first click only warns and the button becomes "Run without a task" (inline, no second dialog) | `modal` |
| `ui/flow-page.js` | Draft a flow with Claude | Sidebar button, `welcome()` button | request text | Draft | `modal` (`generateDialog(false)`) |
| `ui/flow-page.js` | Ask Claude to change this flow | More menu in the flow editor | request text | Apply | `modal` (`generateDialog(true)`) |
| `ui/flow-page.js` | Discard unsaved changes | Open another flow, Blank flow or Draft a flow with an edited flow | none | Discard | `confirmDialog` |
| `ui/flow-page.js` | Overwrite flow | Save under the name of another flow | none | Overwrite | `confirmDialog` |
| `ui/flow-page.js` | Delete flow | Delete in the More menu of the flow editor | none | Delete | `confirmDialog` |
| `ui/auth.js` | Change password | Change password button in the header | current password, new password | Change password | `modal` |
| `ui/health.js` | Cancel this run | Cancel run on a problem of the health line | none | Cancel the run | `confirmDialog` (`ui/dom.js`) |
| `ui/prefs.js` | Appearance | Appearance button in the header | theme (System, Light, Dark), density (Comfortable, Compact) | none; a click applies at once, the ✕ closes it | `modal` |
| `ui/library.js` | Insert from library | Insert from library button in the flow editor (`flow-page.js`, `onLibrary`) | search; category; one card per block with its scope. Then a preview: steps, variables added, renamed ids | **Insert** in the preview (closes with that block); **Back** returns to the list. An invalid block cannot be picked | `modal` |
| `ui/library.js` | Save step as block | Button on a step | id, name, category, description, scope | Save | `modal` |
| `ui/library.js` | Overwrite block | Save a step as a block under an id that exists | none | Overwrite | `confirmDialog` |
| `ui/library.js` | Delete block | Delete on a block of the Library page | none | Delete | `confirmDialog` |
| `ui/monitor.js` | This is not a problem | Button on a finding | reason | Mute | `modal` |
| `ui/monitor.js` | Mute a finding | Button on a finding | reason, duration | Mute | `modal` |
| `ui/monitor.js` | Mute a detector | Button on a detector | detector (when picked here), reason, duration | Mute | `modal` |
| `ui/refinement-draft.js` | Remove draft | Remove draft on a story draft | none | Remove draft | `confirmDialog` (`ui/dom.js`) |
| `ui/refinement-draft.js` | Move to notes | Move to notes on a remark | none | Move | `confirmDialog` (`ui/dom.js`) |
| `ui/refinement-parts.js` | Merge drafts | Merge on a story draft | none | Merge | `confirmDialog` (`ui/dom.js`) |
| `ui/refinement-publish.js` | Publish anyway | Publish while some text has no place on the page | none | Publish anyway | `confirmDialog` (`ui/dom.js`) |
| `ui/refinement-ready.js` | Remove reason | Remove reason on an accepted item | none | Remove reason | `confirmDialog` (`ui/dom.js`) |
| `ui/refinement-suggest.js` | Replace text | Accept on a suggestion for a field that has text | none | Replace | `confirmDialog` (`ui/dom.js`) |
| `ui/refinement-talk.js` | Remove entry | Remove on a map entry | none | Remove | `confirmDialog` (`ui/dom.js`) |
| `ui/refinement.js` | Drop this session | Drop on the session page | none | Drop | `confirmDialog` (`ui/dom.js`) |
| `ui/refinement-import.js` | Refine an existing issue | Refine an existing issue on `#/refinement` | repository, issue number; with no repository it shows a link to `#/repos` | Refine issue | `modal` |
| `ui/refinement-publish.js` | Publish to GitHub | Publish on the session page | per ready draft: labels, "Start building this story" | Create the issues | `modal` |
| `ui/refinement-ready.js` | Accept anyway | Button on a failed ready check | reason (required) | Accept | `modal` |
| `ui/refinement-suggest.js` | Edit and accept | Button on a suggestion | edited text | Accept | `modal` |
| `ui/refinement-suggest.js` | Reject suggestion | Button on a suggestion | reason (optional) | Reject | `modal` |
| `ui/refinement-talk.js` | Edit entry | Edit on a map entry | text | Save | `modal` |
| `ui/refinement.js` | New refinement session | New session on `#/refinement` | repository, title (optional), idea; with no repository it shows a link to `#/repos` | Start session | `modal` |
| `ui/refinement.js` | Rename session | Rename on the session page | title | Save | `modal` |
| `ui/repos.js` | Add repository | Add repository on `#/repos` | address; method list from `methodsFor` (varies with admin and GitHub App); fields change with the method | Add | `modal` (`repoDialog`) |
| `ui/repos.js` | Change authentication | Change button on a row | method; fields change with the method | Save | `modal` (`repoDialog` with `repo`) |
| `ui/repos.js` | Definition of Ready | Button on a row of `#/repos` | none (read-only list) | none; the ✕ closes it | `modal` |
| `ui/repos.js` | Remove repository | Remove on a row | none | Remove | `confirmDialog` (`ui/dom.js`) |
| `ui/repos.js` | Generate a new key | Generate a new key on a deploy-key row | none | Generate a new key | `confirmDialog` (`ui/dom.js`) |
| `ui/turn-act.js` | Show questions | Button on a Your turn item with questions | answer per question; Accept all recommendations; Use recommendation | Post answers | `openDetail` |
| `ui/turn-act.js` | Show plan | Button on an item that waits for plan approval | notes | Approve or Reject | `openDetail` |
| `ui/turn-act.js` | Show split | Button on an item that waits for split approval | notes | Approve or Reject | `openDetail` |
| `ui/turn-act.js` | Show request | Button on an approval item | notes | Approve or Reject | `openDetail` |
| `ui/turn-act.js` | Retry with a hint | Button on a failed item | hint | Retry | `openDetail` |
| `ui/run-dialogs.js` | Cancel this run? | Cancel on `#/runs/:id` | none | Cancel the run | `confirmDialog` (`ui/dom.js`) |
| `ui/run-dialogs.js` | Re-run from this step? | "Retry from step…" on `#/runs/:id` | none | Re-run | `confirmDialog` (`ui/dom.js`) |
| `ui/run-dialogs.js` | Approve | Approve on `#/runs/:id` | note (optional) | Approve | `decisionDialog` |
| `ui/run-dialogs.js` | Reject | Reject on `#/runs/:id` | reason (optional) | Reject | `decisionDialog` |
| `ui/user/runs.js` | Remove this run | Remove on a queued card of `/user/#/runs` | none | Remove the run | `confirmDialog` |
| `ui/user/runs.js` | Cancel this run | Cancel on `/user/#/runs/:id` | none | Cancel the run | `confirmDialog` through `withDialog` |
| `ui/user/runs.js` | Approve | Approve on `/user/#/runs/:id` | note (optional) | Approve | `decisionDialog` (`ui/run-dialogs.js`) through `withDialog` |
| `ui/user/runs.js` | Reject | Reject on `/user/#/runs/:id` | reason (optional) | Reject | `decisionDialog` (`ui/run-dialogs.js`) through `withDialog` |
| `ui/users.js` | Add user | Add user on `#/users` | the user form (`userForm`) | Add user | `callDialog` (`addDialog`) |
| `ui/users.js` | New link | Action on `#/users/:id` | none | New link | `callDialog` (`linkDialog`) |
| `ui/users.js` | Reset password | Action on `#/users/:id` | none | Reset password | `callDialog` (`resetDialog`) |
| `ui/users.js` | Unlock | Action on `#/users/:id`, for a locked account | none | Unlock | `callDialog` (`unlockDialog`) |
| `ui/users.js` | Edit | Action on `#/users/:id` | same form as Add user | Save | `callDialog` (`editDialog`) |
| `ui/users.js` | Block | Action on `#/users/:id` | checkbox "Also stop all their work now" | Block | `callDialog` (`blockDialog`) |
| `ui/users.js` | Unblock | Action on `#/users/:id`, for a blocked account | none | Unblock | `callDialog` (`unblockDialog`) |
| `ui/users.js` | Delete | Action on `#/users/:id` | none | Delete | `callDialog` (`deleteDialog`) |
| `ui/users.js` | Limits | Action on `#/users/:id` | runs at the same time, runs per day, daily budget | Save | `callDialog` (`limitsDialog`) |
| `ui/users.js` | Default limits | Button on `#/users` | same three fields | Save | `callDialog` (`defaultLimitsDialog`) |
| `ui/users.js` | App repositories | Action on `#/users/:id` | repository list | Save | `callDialog` (`appReposDialog`) |
| `ui/watcher-form.js` | Add a watcher | Add a watcher on `#/watchers` | id, repository, source, flow, label, every, max per tick, enabled, variables | Save watcher | `modal` (`repoWatcherDialog`) |
| `ui/watcher-form.js` | Edit watcher (repository) | Edit on a watcher card | same; id is fixed | Save watcher | `modal` (`repoWatcherDialog` with `existing`) |
| `ui/watcher-form.js` | Add the monitor | Add the monitor on `#/watchers` | id, every, enabled | Save watcher | `modal` (`monitorDialog`) |
| `ui/watcher-form.js` | Edit watcher (monitor) | Edit on the monitor card | same; id is fixed | Save watcher | `modal` (`monitorDialog` with `existing`) |

## Native dialogs

The browser's own `confirm` (yes or no) and `prompt` (one line of text). They cannot be styled and give no way to show a server error.

| File:line | Kind | Text | Action it guards |
|---|---|---|---|
