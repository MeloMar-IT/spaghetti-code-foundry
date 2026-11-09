# Plugin API and the public package

The Foundry is published as the npm package `@melomar-it/scf-core` on GitHub Packages. Code that
builds on the Foundry should depend on a release of this package, not on a copy of the source.
The CLI (`scf`, `factory`) keeps working from a git checkout as before.

```bash
npm install @melomar-it/scf-core
```

Install from GitHub Packages: add `@melomar-it:registry=https://npm.pkg.github.com` to `.npmrc`
and sign in with a token that can read packages.

## What is public

The package has one entry point, `@melomar-it/scf-core`. Nothing else is importable: the
`exports` map in `package.json` lists only that entry. A deep import such as
`@melomar-it/scf-core/dist/config.js` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

The public names are (plugin API `0.4`):

| Name | Kind | What it is |
|---|---|---|
| `PLUGIN_API_VERSION` | string | The plugin API version of this release (`"0.4"`) |
| `startServer(options)` | function | Starts the Foundry HTTP server; resolves to its URL, port, `close()` and context |
| `ServerOptions` | type | Options of `startServer` |
| `ConfigSchema` | object | The zod schema of the configuration |
| `Config` | type | A checked configuration |
| `loadConfig(path?)` | function | Reads and checks the configuration file (default: this machine's) |
| `parseConfigText(text, path?)` | function | Checks configuration text the same way |
| `ConfigIssuesError` | class | Thrown when the configuration is not valid |
| `FlowSchema` | object | The zod schema of a flow |
| `Flow`, `FlowStep`, `Step`, `ClaudeStep`, `ShellStep`, `ApprovalStep`, `ParallelStep` | types | The shape of a flow and its steps |
| `parseFlow(text, source?)` | function | Checks flow text and returns the flow |
| `loadFlow(nameOrPath, repo)` | function | Loads a flow by name or path for a repository; returns `{ flow, path }` |
| `listFlows(repo)` | function | Lists the flows a repository can run |
| `FlowParseError` | class | Thrown when a flow is not valid |
| `FlowIssue`, `FlowListing`, `FlowScope` | types | Results of flow checks and listings |
| `runFlow(flow, options)` | function | Runs a flow and resolves to a `RunSummary` |
| `resumeRun(options)` | function | Continues a run at the step where it stopped |
| `RunOptions`, `ResumeOptions`, `RunSummary`, `StepRecord`, `RunStatus` | types | Options and results of a run |
| `PluginApi` | type | The object `register(api)` gets |
| `UsageEvent`, `UsageHandler` | types | A usage event, and the function `api.onUsage` takes |

Plugin points are added to this list and this file when they ship, and the plugin API version rises
with them. Version `0.2` added `api.onUsage` (see [Usage events](#usage-events)). Version `0.3` added
`api.workspaces(store)` (see [Workspaces](#workspaces)) and `api.check(point, fn)` (see
[Checks before a run or a step](#checks-before-a-run-or-a-step)). Version `0.4` added
`api.identityProvider({ resolve })` (see [Identity provider](#identity-provider)).

The arguments and results of these names are the types in the package's `.d.ts` files. The
exported names and their kinds are kept in `tests/public-api.snapshot.json`; a test fails when
they change without the version changing.

## Plugin modules (`config.yaml`)

A plugin is a module named in `config.yaml`. It runs inside the server process with the same
rights as the Foundry, so only add a plugin you trust.

```yaml
plugins:
  - module: "@your-org/scf-plugin-audit"   # a package name, or an absolute path
    options: { level: info }               # any map; given to the plugin as api.options
```

The module exports `register(api)`, as a named export or as the default export's `register`.
It may be sync or async. The Foundry calls it once, at server start, in the order of the list,
before the queue and the watchers start.

```js
// plugin.mjs
export function register(api) {
  if (api.version !== "0.4") throw new Error("needs plugin API 0.3");
  console.log("audit plugin", api.options.level);
}
```

- `api.version` is the plugin API version (`PLUGIN_API_VERSION`, `"0.4"` in this release). A
  plugin that cannot work with it throws; the start stops with a message that names the plugin.
- `api.options` is a frozen copy of the `options` map of the entry.
- `api.ui(spec)` adds pages, menu items and a settings section to the web interface. See
  [The ui point](#the-ui-point).
- `api.onUsage(handler)` gets the usage events of the runs. See [Usage events](#usage-events).
- `api.workspaces(store)` supplies the list of workspaces. See [Workspaces](#workspaces).
- `api.check(point, fn)` adds a check before a run or a step. See [Checks before a run or a step](#checks-before-a-run-or-a-step).
- `api.identityProvider({ resolve })` supplies the identity provider: who signs in, with their role and workspace. See [Identity provider](#identity-provider).
- A plugin fails the start when it cannot be found or imported, has no `register`, throws, or does
  not finish `register` within 30 seconds. The server then does not start at all.
- Refused: a relative path, a URL, a built-in Node module, and a module inside a runs folder or a
  repository the Foundry works on. The list has at most 20 entries, and a module may be named once.
- Plugins are set in `config.yaml` only; the web API cannot change them. A change applies after a
  restart.

`scf plugins` and `GET /api/plugins` (admins) list the loaded plugins with their version and what
each registered. Options are never shown.

## The ui point

`api.ui(spec)` adds pages, menu items and a settings section. It may be called once, and only while
`register(api)` runs; a second call, or a call later, throws. Two plugins with the same web address
name stop the start. The address name is the label in lower case, with `@`, `/`, `.` and `_` as `-`.

```js
import { fileURLToPath } from "node:url";

export function register(api) {
  const ui = api.ui({
    dir: fileURLToPath(new URL("./ui", import.meta.url)),   // the plugin's folder: pages and files live here
    pages: [{ id: "report", title: "Report", module: "report.js", roles: ["admin", "user"], files: ["style.css"] }],
    menu: [{ page: "report", label: "Report", roles: ["admin"] }],
    settings: {
      title: "Report",
      fields: [{ key: "days", kind: "number", label: "Days to show", default: 7, integer: true, min: 1, max: 90 }],
    },
  });
  console.log(ui.name, ui.settings().days);            // the current values, defaults filled in
}
```

- **`dir`** is the folder the files are read from. It must not lie inside a folder where runs write.
- **`pages`** (at most 20): `id` (lower case, letters, digits and `-`, at most 40), `title` (at most 80),
  `module` (a `.js` file in `dir`), `roles` (`admin` and/or `user`) and optional `files` (at most 20 files
  of `.js`, `.css` or `.svg`). A file must exist and be at most 1 MB.
- **`menu`** (at most 20): `page` (an `id` above), `label` (at most 40) and `roles`. The roles must be a
  subset of the page's roles.
- **`settings`** (optional): a `title` (at most 60) and `fields` (at most 50). A field has `key`, `kind`,
  `label` and optional `help`, `default`. Kinds: `number` (`integer`, `min`, `max`), `yes-no`, `text`,
  `list` (`maxItems`) and `choice` (`choices`). A value that does not fit the field is refused.
- Anything else in the spec, a wrong type or an unknown key, is refused with a message; the start stops
  and names the plugin.

What the page gets. The module must export `render(box, ctx)`; it may return a cleanup function. `ctx`
has `kit` (the UI kit, see [UI_COMPONENTS.md](UI_COMPONENTS.md)), `h` and `mount` (the DOM helpers),
`role`, `readOnly`, `plugin` and `user` (`id`, `name`, `role`). Text is added as text, never as HTML.

Addresses and access. A page is at `#/plugins/<name>/<id>`, and its module at `/plugins/<name>/<module>`.
Each file has its own rule, listing the roles of every page that uses it. A file no rule lists is refused:
404 with no rule, 401 without a session, 403 for a role not listed. Admins pass all rules. The menu item
and the page appear only for the roles they name.

Settings. `api.ui(...).settings()` returns the values in `config.yaml` under `plugin_settings.<name>`, with
the defaults filled in. The settings page shows one card per section; a save goes through
`PUT /api/config`, which checks each key against the fields of the loaded plugin.

The public package names do not change with this point: `ui` is a member of the plugin `api` object, and
its types are not exported from `@melomar-it/scf-core`. `PLUGIN_API_VERSION` is `"0.4"` in this release.

## Usage events

`api.onUsage(handler)` gets one event for each fact of a run. It may be called at most 10 times per
plugin, and only while `register(api)` runs. A later call, or a value that is not a function, throws.

```js
export function register(api) {
  api.onUsage((event) => {
    if (event.name === "run.finished") console.log(event.runId, event.status, event.costUsd);
  });
}
```

The events are the type `UsageEvent`, told apart by `name`. Each has `id`, `time` (ISO 8601), `runId`
and `workspace` (the id of the run's workspace, `default` when it has none). When known, it also has
`repository` (`owner/name`) and `issue` (a number).

| Name | When | Fields besides the common ones |
|---|---|---|
| `run.started` | a run starts; never again on resume | none |
| `step.finished` | once for each step record of a run | `step`, `stepType`, `ok`, `agent`, `provider`, `model`, `tokensIn`, `tokensCached`, `tokensOut`, `costUsd` (`null` when the price is unknown), `durationMs`, `earlierCostUsd` |
| `run.finished` | a run ends as succeeded, failed or cancelled | `status`, `reason`, `durationMs`, `costUsd` |
| `issue.done` | a story run succeeded | none |
| `issue.split` | a story run whose last step is a successful split | `parent` (optional), `parts` (the numbers of the parts) |
| `issue.failed` | a story run failed | none |

A run that is stopped or waiting sends no `run.finished`. A cancelled run sends `run.finished`, and no
issue event. `reason` is `none` when the run succeeded; otherwise it is the kind of failure: `code`,
`factory`, `limit` or `decision`. `costUsd` of a run is its total, the one in the run summary. `earlierCostUsd`
is the cost of paid tries that came before the one the record shows (a retry or a fallback model);
the total already counts them, so do not add them again.

**Ids and once.** Each id names one fact: `<runId>:started`, `<runId>:step:<index in the history>`,
`<runId>:finished:<resumes>` and `<runId>:issue:<resumes>`. The Foundry sends each event once, as far
as it can tell. Delivery is best effort with no outbox: if the process stops after `run.json` is saved
and before an event is sent, that event is lost and is not replayed. A reader can drop duplicates by
`id`.

**Privacy.** Events hold only ids, numbers and fixed words. They never hold task or issue text, step
output, error text, secrets, paths or file content. A step id, provider or model that looks like a
secret or an absolute path is sent as `redacted`. Other characters than letters, digits and `_ . / : -`
become `_`, and the value is cut at 200 characters. The flow name is not in any event.

**Handlers.**

- A handler gets a frozen copy of each event. Each handler has its own queue of at most 1000 events. When
  the queue is full, further events for that handler are dropped and the drop is reported.
- Handlers run outside the run's own call stack. The run never waits for a handler, and its result and
  timing do not change because of one.
- A call that takes more than 5 seconds is reported. After 3 calls of one handler are still running, the
  handler is skipped and its events are dropped (reported).
- A handler that throws, or whose call times out, is reported. A report is logged once per plugin and
  reason, and is listed as a plugin problem by `scf plugins` and `GET /api/plugins`.
- A synchronous loop inside a handler cannot be stopped. It blocks the server process, so keep the
  synchronous part of a handler short, and do slow work in a queue of your own with a limit.

**Where the events are kept.** Every valid event is also appended to
`<data folder>/usage/usage-YYYY-MM.jsonl`, one JSON object per line, in the UTC month of the event.
The file and its folder are private to the user (mode 0700 and 0600). A symbolic link, a file that is
not a plain file, and a named pipe are refused.

**Lifetime.** A subscription belongs to the set of plugins that loaded it. `close()` of the server
removes the handlers, so no later event reaches a plugin; events still queued are dropped. When a
plugin fails to start, the handlers of the plugins loaded before it are removed too. Two servers in
one process deliver events only to their own plugins.

## Workspaces

`api.workspaces(store)` supplies the list of workspaces: teams with members and limits, each repository,
watcher and run in exactly one of them. `store.list()` returns the whole list at once, not a promise, in the
shape of the `workspaces` list of `config.yaml`: each entry has `id`, `name`, `members` (account ids) and `limits`.
When a plugin supplies the list, it replaces the `workspaces` of `config.yaml`, and it is checked the same way.

```js
export function register(api) {
  api.workspaces({
    list: () => [
      { id: "team-api", name: "API team", members: ["6f1c2a3e-0000-4000-8000-000000000001"], limits: { max_concurrent: 2 } },
    ],
  });
}
```

- It may be called once per plugin, and only while `register(api)` runs. A later call, or a `store` without
  a `list` function, throws.
- Only one plugin may supply the list. A second plugin that calls it gets a line in the problem list
  (`scf plugins`, `GET /api/plugins`) and its list is not used; the first one stays.
- A `list()` that throws, returns a promise or returns a list that is not valid puts every account in
  `default`. The reason is reported once, in the problem list.
- A plugin that does not supply the list leaves `config.yaml` in charge.

## Checks before a run or a step

`api.check(point, fn)` asks your function before work starts. `point` is `"run.before"` (once per run
start, before the run's workspace is made) or `"step.before"` (before each step). It may be called
at most 10 times per plugin, and only while `register(api)` runs.

```js
export function register(api) {
  api.check("step.before", (input) => {
    if (input.runCostUsd > 5 && input.stepType === "claude") {
      return { outcome: "warn", reason: "this run has cost over $5" };
    }
    return "allow";
  });
}
```

- `fn` gets a frozen copy of: `point`, `runId`, `flow`, `workspace`, `owner` (`admin`, `user` or `none`),
  and, when known, `repository`, `issue`, `step`, `stepType`, `visit`, and `runCostUsd` (the cost of the
  run so far). It gets no text of the issue, the prompt or the output.
- The answer is `"allow"` (or nothing), or `{ outcome, reason }` where `outcome` is `"allow"`, `"warn"` or
  `"stop"`. `reason` is one line of up to 200 characters.
- `stop` ends the run at that point, with the reason in the run log. A `run.before` stop at the start of a
  new run ends it as `failed`; a resume asks again and stops the run at its step. `warn` and `allow` let it go on.
  The first `stop` of all checks wins.
- The answer appears in the run log the same way as a policy decision: `· plugin <name> · step.before <step>: stop — <reason>`.
- **Fail open.** A check that throws, takes longer than 5 seconds, or answers something that is not valid
  is logged (`the check failed`) and listed in the problem list (`scf plugins`, `GET /api/plugins`); the
  run goes on. A check that still has three calls running is not asked again; the call is skipped, with the same log line.
- The built-in limits (`limits.issue_cost_usd`, `limits.monthly_budget_usd`) are not plugin checks: they
  fail closed, see [the user guide](USER_GUIDE.md#8-costs-dashboard-and-evals).

## Identity provider

`api.identityProvider({ resolve })` makes your account system the source of sign-in, roles and
workspaces (#833). It may be called once, and only while `register(api)` runs. With no provider,
nothing changes: the Foundry's own accounts sign people in. Detect it with
`typeof api.identityProvider === "function"`.

```js
export function register(api) {
  api.identityProvider({
    resolve(request, signal) {                       // sync or async; returns null or an answer
      const id = myAccounts.fromCookies(request.headers.cookie);   // your own lookup
      if (!id) return null;                          // nobody is signed in
      return { id: id.uuid, name: id.displayName, roles: [id.isAdmin ? "admin" : "user"], workspace: id.workspace };
    },
  });
}
```

- **`request`** is a frozen copy of the request: `method`, `url`, `headers` (lower-case names) and
  `remoteAddress`. The Foundry session cookie is removed; other cookies stay.
- **`signal`** is an `AbortSignal` that is aborted at the deadline. Stop your work when it fires.
- **The answer** is `null` (nobody) or an object with exactly these keys: `id` (a UUID; it is lower-cased),
  `name` (1 to 100 characters), `roles` (`"admin"` and/or `"user"`; any other role is refused), and
  optional `workspace` (a workspace id; an unknown one becomes `default`). No other key is allowed.
- **Limits.** `resolve` has 5 seconds. At most 8 calls can be waiting at once; a call beyond that is
  refused without asking. A rejection after the deadline is handled, and nothing is logged twice.
- **Failure.** A throw, a rejection, a timeout or an invalid answer signs nobody in. The problem is listed
  once, in fixed words (`scf plugins`, `GET /api/plugins`). No text from your provider reaches logs,
  problems or responses.
- **Wrong use stops the start.** A second `identityProvider` call (in this plugin or another), a call after
  `register(api)` has ended, or a provider without `resolve` gives a `PluginLoadError` that names the plugin.
  A call after the whole start has finished is only listed as a problem.

**What the Foundry does with an answer.** On `GET /api/session` the Foundry signs the person in, sets the
session cookie and creates or updates a mirror record in `users.json` (`source: "provider"`, with the
name, role and `workspace`). The record has no password. Every later API call asks `resolve` again:

- a different id, or `null`, ends the session (401);
- a provider error answers 503 and keeps the session;
- a changed name, role or workspace applies on the next call;
- a blocked or deleted account is refused, and a recheck never creates an account.

While a provider is active, the Foundry's own password sign-in answers 401, `POST /api/setup` answers 409,
and password and profile changes of provider accounts answer 409. Blocking and deleting still work. A
provider user sees only its one workspace (or `default`) and cannot read `GET /api/info`; an admin can.
Each sign-in is audited as `sign-in` with `target: "identity-provider"`, and later actions carry the
account's id as `by`.

## Semantic versioning

The version of the package is `MAJOR.MINOR.PATCH`. The plugin API version `x.y` names the
public surface that the release has.

- **Patch** (`0.1.1`): fixes only. No names are added, removed or changed.
- **Minor** (`0.2.0`): names may be added. Before 1.0, a minor release may also remove or change
  names; say so in the release notes.
- **Major** (`1.0.0`, `2.0.0`): needed for any removal or change of a name from 1.0 on.

The plugin API version follows the same rule: its `y` part rises with a minor release, and its `x`
part with a major one. The release notes of every release carry a line
`Plugin API: x.y (see docs/PLUGIN_API.md)`. The release workflow adds it.

Behaviour that is not in the table above (log text, file layout under the data folder, the
web interface, the flows built into the Foundry) is not part of the promise. The built-in flows
can change in any release.

## Releases

A release is a git tag `vMAJOR.MINOR.PATCH` that matches `version` in `package.json`. The
workflow `.github/workflows/publish.yml` runs on each such tag. It stops if the tag and the
version differ, runs the build and the public API test, checks that the package imports under its
name and that deep imports are blocked, and publishes with the repository's `GITHUB_TOKEN`
(`packages: write`). No other secret is needed. A second job then writes the plugin API line into
the release notes.
