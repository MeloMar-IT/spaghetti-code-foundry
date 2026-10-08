# Dialogs

Read from the code at commit `27479e3`. Part of the audit in `README.md`; the routes are in `inventory.md`.

Three mechanisms draw a dialog:

- **`modal(title, build, { busy })`** in `ui/dom.js:68`: the base. It draws a title, a close button (✕) and whatever `build(close)` returns. Called at 23 sites in 14 files.
- **Wrappers over `modal`:** `callDialog` (`ui/users.js:113`, 11 callers), `confirmDialog` and `decisionDialog` (`ui/user/runs.js:81` and `:94`), `withDialog` (`ui/user/runs.js:402`, guards against a second dialog), `openDetail` (`ui/turn-act.js:12`, loads the detail first).
- **Native `confirm` and `prompt`:** 24 calls in 12 files (second table).

The call-site count is only where to start. One site can serve several dialogs; each variant a person can see has its own row. A row is keyed by file and dialog name; the test checks that the rows are unique and that no call site is left out. It cannot see a new variant added inside a call site other than `callDialog`.

## Dialogs

| File | Dialog | Opened by | Fields | Primary action | Helper |
|---|---|---|---|---|---|
| `ui/admin-repos.js` | Repository settings | Settings button on a row of `#/all-repos` | test command, docs, protected branches, main branch, develop branch | Save | `modal` |
| `ui/admin-repos.js` | Definition of Ready | Button on a row of `#/all-repos` | checklist items | Save | `modal` |
| `ui/admin-repos.js` | Transfer repository | Transfer button on a row | new owner e-mail | Transfer | `modal` |
| `ui/app.js` | Run <flow> | Run button in the flow editor | task, repository, one input per flow variable | Run (also Cmd+Enter) | `modal` |
| `ui/app.js` | Draft a flow with Claude | Sidebar button, `welcome()` button | request text | Draft | `modal` (`generateDialog(false)`) |
| `ui/app.js` | Ask Claude to change this flow | Editor button | request text | Apply | `modal` (`generateDialog(true)`) |
| `ui/auth.js` | Change password | Change password button in the header | current password, new password | Change password | `modal` |
| `ui/library.js` | Insert from library | Insert from library button in the flow editor (`app.js:195`) | search; one card per block | Click a block card (closes with that block) | `modal` |
| `ui/library.js` | Save step as block | Button on a step | id, name, category, description, scope | Save | `modal` |
| `ui/monitor.js` | This is not a problem | Button on a finding | reason | Mute | `modal` |
| `ui/monitor.js` | Mute a finding | Button on a finding | reason, duration | Mute | `modal` |
| `ui/monitor.js` | Mute a detector | Button on a detector | detector (when picked here), reason, duration | Mute | `modal` |
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
| `ui/turn-act.js` | Show questions | Button on a Your turn item with questions | answer per question; Accept all recommendations; Use recommendation | Post answers | `openDetail` |
| `ui/turn-act.js` | Show plan | Button on an item that waits for plan approval | notes | Approve or Reject | `openDetail` |
| `ui/turn-act.js` | Show split | Button on an item that waits for split approval | notes | Approve or Reject | `openDetail` |
| `ui/turn-act.js` | Show request | Button on an approval item | notes | Approve or Reject | `openDetail` |
| `ui/turn-act.js` | Retry with a hint | Button on a failed item | hint | Retry | `openDetail` |
| `ui/user/runs.js` | Remove this run | Remove on a queued card of `/user/#/runs` | none | Remove the run | `confirmDialog` |
| `ui/user/runs.js` | Cancel this run | Cancel on `/user/#/runs/:id` | none | Cancel the run | `confirmDialog` through `withDialog` |
| `ui/user/runs.js` | Approve | Approve on `/user/#/runs/:id` | note (optional) | Approve | `decisionDialog` through `withDialog` |
| `ui/user/runs.js` | Reject | Reject on `/user/#/runs/:id` | reason (optional) | Reject | `decisionDialog` through `withDialog` |
| `ui/users.js` | Add user | Add user on `#/users` | the user form (`userForm`) | Add user | `callDialog` (`addDialog`) |
| `ui/users.js` | New link | Row action | none | New link | `callDialog` (`linkDialog`) |
| `ui/users.js` | Reset password | Row action | none | Reset password | `callDialog` (`resetDialog`) |
| `ui/users.js` | Unlock | Row action, for a locked account | none | Unlock | `callDialog` (`unlockDialog`) |
| `ui/users.js` | Edit | Row action | same form as Add user | Save | `callDialog` (`editDialog`) |
| `ui/users.js` | Block | Row action | checkbox "Also stop all their work now" | Block | `callDialog` (`blockDialog`) |
| `ui/users.js` | Unblock | Row action, for a blocked account | none | Unblock | `callDialog` (`unblockDialog`) |
| `ui/users.js` | Delete | Row action | none | Delete | `callDialog` (`deleteDialog`) |
| `ui/users.js` | Limits | Row action | runs at the same time, runs per day, daily budget | Save | `callDialog` (`limitsDialog`) |
| `ui/users.js` | Default limits | Button on `#/users` | same three fields | Save | `callDialog` (`defaultLimitsDialog`) |
| `ui/users.js` | App repositories | Row action | repository list | Save | `callDialog` (`appReposDialog`) |
| `ui/watcher-form.js` | Add a watcher | Add a watcher on `#/watchers` | id, repository, source, flow, label, every, max per tick, enabled, variables | Save watcher | `modal` (`repoWatcherDialog`) |
| `ui/watcher-form.js` | Edit watcher (repository) | Edit on a watcher card | same; id is fixed | Save watcher | `modal` (`repoWatcherDialog` with `existing`) |
| `ui/watcher-form.js` | Add the monitor | Add the monitor on `#/watchers` | id, every, enabled | Save watcher | `modal` (`monitorDialog`) |
| `ui/watcher-form.js` | Edit watcher (monitor) | Edit on the monitor card | same; id is fixed | Save watcher | `modal` (`monitorDialog` with `existing`) |

## Native dialogs

The browser's own `confirm` (yes or no) and `prompt` (one line of text). They cannot be styled and give no way to show a server error.

| File:line | Kind | Text | Action it guards |
|---|---|---|---|
| `ui/admin.js:45` | confirm | The state file cannot be read. Switching on keeps it as monitor-guard.json.broken ... | Switch the monitor on |
| `ui/admin.js:155` | confirm | Delete watcher <id>? | Delete a watcher (button) |
| `ui/admin.js:160` | confirm | Delete watcher <id>? | Delete a watcher (second path) |
| `ui/admin.js:228` | confirm | Remove these workspaces now? | Clean workspaces |
| `ui/app.js:94` | confirm | Discard unsaved changes to "<flow>"? | Leave an edited flow |
| `ui/app.js:257` | confirm | A flow named "<name>" already exists. Overwrite it? | Save over a flow |
| `ui/app.js:278` | confirm | Delete flow "<name>"? This removes the file. | Delete a flow |
| `ui/app.js:299` | confirm | Run without a task description? | Run (inside the Run dialog) |
| `ui/health.js:49` | confirm | Cancel this run? You can resume it later. | Cancel from the health bar |
| `ui/library.js:90` | confirm | Overwrite block "<id>"? | Save a block (inside a dialog) |
| `ui/library.js:128` | confirm | Delete block "<id>"? | Delete a block |
| `ui/problems.js:88` | confirm | The state file cannot be read ... (same text as `admin.js:44`) | Switch the monitor on |
| `ui/refinement-draft.js:437` | confirm | Remove this story draft? | Remove a draft |
| `ui/refinement-draft.js:543` | confirm | Move this text to the notes for the builder? It is taken out of its field. | Move a draft to notes |
| `ui/refinement-publish.js:269` | confirm | Some text has no place on the page any more and is not saved. Publish anyway? | Publish with text that is not saved |
| `ui/refinement-ready.js:105` | confirm | Remove this reason? The item then counts as not accepted. | Remove an accepted item |
| `ui/refinement-suggest.js:142` | confirm | Replace the text of this field with the suggestion? | Accept a suggestion over other text |
| `ui/refinement-talk.js:240` | confirm | Remove this entry from the map? | Remove a map entry |
| `ui/refinement.js:410` | confirm | Drop "<title>"? You can restore it for 30 days. | Drop a session |
| `ui/repos.js:325` | confirm | Generate a new key for <url>? The old key stops working ... | New deploy key |
| `ui/repos.js:379` | confirm | Remove <url>? (text depends on the method) | Remove a repository |
| `ui/runs.js:245` | prompt | Approve — note (optional) | Approve a run (admin) |
| `ui/runs.js:246` | prompt | Why reject? (optional) | Reject a run (admin) |
| `ui/runs.js:255` | confirm | Re-run this run from "<step>"? Earlier step outputs are kept. | Re-run from a step |
| `ui/runs.js:259` | confirm | Cancel this run? You can resume it later. | Cancel a run (admin) |
