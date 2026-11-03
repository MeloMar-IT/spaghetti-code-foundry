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
- `api` has one method per plugin point. None ships yet: the points come with the next parts.
- A plugin fails the start when it cannot be found or imported, has no `register`, throws, or does
  not finish `register` within 30 seconds. The server then does not start at all.
- Refused: a relative path, a URL, a built-in Node module, and a module inside a runs folder or a
  repository the Foundry works on. The list has at most 20 entries, and a module may be named once.
- Plugins are set in `config.yaml` only; the web API cannot change them. A change applies after a
  restart.

`scf plugins` and `GET /api/plugins` (admins) list the loaded plugins with their version and what
each registered. Options are never shown.

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
