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

The public names are (plugin API `0.1`):

| Name | Kind | What it is |
|---|---|---|
| `PLUGIN_API_VERSION` | string | The plugin API version of this release (`"0.1"`) |
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

Plugin points (the plugin API proper) come with the next part of #779. They are added to this
list and this file when they ship, and the plugin API version rises with them.

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
  if (api.version !== "0.1") throw new Error("needs plugin API 0.1");
  console.log("audit plugin", api.options.level);
}
```

- `api.version` is the plugin API version (`PLUGIN_API_VERSION`, `"0.1"` in this release). A
  plugin that cannot work with it throws; the start stops with a message that names the plugin.
- `api.options` is a frozen copy of the `options` map of the entry.
- `api.ui(spec)` adds pages, menu items and a settings section to the web interface. See
  [The ui point](#the-ui-point). Other plugin points come with the next parts.
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
its types are not exported from `@melomar-it/scf-core`. `PLUGIN_API_VERSION` stays `"0.1"` in this release.

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
