# Threat model — the multi-user setup

This is the result of the security review of the multi-user Spaghetti Code Foundry (#21, part 2a is
#299). It says what is protected, what #299 fixed, and what is still open. The review was done by
reading the code. `src/refinement/draft.ts`, `src/refinement/talk.ts` and most of `ui/*.js` were
covered by pattern search only, not read line by line.

## Scope and roles

- **Admin.** Can make every API call. Is trusted like the owner of the machine.
- **User.** Has an account with the role `user`. Can use Refinement, Runs and My repositories, and
  can start published flows. Is not trusted with the machine.
- **Outside commenter on GitHub.** Anyone who can comment on an issue of a watched repository.
- **Another machine on the network.** Can reach the server's port if the server listens beyond
  localhost.

**Read this first.** Shell steps and agent steps of a user's run are held by a macOS sandbox profile (#304, #305). SR-O1 is fixed in #302. A step cannot read the Mac account's files, the Keychain or the agent login, and agent steps sign in by a token variable of the server only. This holds on macOS only, with `sandbox.user_runs: required` (default), and `sandbox-exec` is a deprecated tool. With `sandbox.user_runs: off` (or `SCF_USER_SANDBOX=off`) nothing is held, and an admin's run is never held. The limits that remain are under "OS sandbox for steps of a user's run". Still give a user account only to people you trust with the token the server sets for the agents.

## User isolation

**Protected by.**
- `api()` in `src/server/server.ts` answers 404 for a route without a rule.
- `authorize()` in `src/server/permissions.ts` reads the owner from the run, never from the request.
- A user starts flows by name from `publishedFlows()` only (`src/server/api-flows.ts`).
- Repositories, credentials and refinement take the owner from the session; a foreign id is 404.

**Fixed in #299.**
- SR-4: `POST /api/runs/:id/resume` with `from` is 403 for a user.
- SR-5: a user's run of an `inplace` flow never runs a step (`src/engine/runner.ts`, `src/engine/isolation.ts`); the start, the flow list and the diff refuse it (`src/server/api-runs.ts`, `src/server/api-flows.ts`).
- SR-6: a user's run without `github_repo` has its own learnings file, so one user's lessons do not reach another user's prompt.

**Fixed in #303.**
- A user's run of a `worktree` flow never runs a step and never calls `git worktree add`; it fails with "This flow works in a branch of the server's folder, so only an admin can run it." This holds on start, resume, approve, reject, answer and the queue, like `inplace` (`src/engine/runner.ts`, `src/engine/isolation.ts`). `POST /api/runs` answers 403 and the flow is not listed for users (`src/server/api-runs.ts`, `src/server/api-flows.ts`).
- The server's git calls for a workspace (`prepareWorkspace`, `repoRoot` in `src/engine/workspace.ts`) run with a clean environment and `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, so a hook or `fsmonitor` setting in the repository does not run.

**Fixed in #817.**
- A user's run, repository, watcher and refinement session outside their workspaces answers 404, the same as an unknown id, on every route that names one, and the lists, search, board, outcomes, usage and epics leave them out. The check is `authorize()` plus `src/server/workspace-scope.ts`, with a scope on every route rule in `src/server/permissions.ts`; a `yes` rule without a scope does not load. An admin is not limited, and the admin-only routes do not change. Plugin routes stay role-only. Tests: `tests/permissions.test.ts`, `tests/workspace-scope.test.ts`.
- Limit: the check covers the API only. Files in the data folder are not split by workspace (SR-O7 still applies). A repository added by a team member lands in `default` until an admin moves it.

**Still open.**
- SR-O1 is fixed in #302; the limits that remain are under "OS sandbox for steps of a user's run".
- Files in the data folder that every step can write (SR-O7).

## OS sandbox for steps of a user's run

Every shell step and every Claude or Codex step of a user's run starts under `/usr/bin/sandbox-exec` with a profile made for that step (`src/engine/os-sandbox.ts`, `src/agents/run.ts`, `src/agents/boxed.ts`). Whatever the agent starts is held too.
- **Reads denied:** the Mac account's home, the data folder, the runs folder and the server's temp folder. Allowed again: the run's own folder, tools, hooks, lock folder, the step's `gh` folder, the folders of `node`, `git`, `claude` and `codex`, and `sandbox.user_read`.
- **Writes** only in the run's folder (not `run.json`, `live.log`, `logs/`), `<runDir>/tmp`, the learnings file, the lock folder and the step's `gh` folder.
- **Also denied:** Keychain lookups (`com.apple.SecurityServer`, `com.apple.securityd`), hard links and clones, unix sockets, `lsopen`, Apple events and launchd job creation. A step cannot call `docker` itself; steps with `sandbox: true` and an image are started by the server.
- **Refusal:** with `sandbox.user_runs: required` (default) a user's run does not start where no sandbox works. `sandbox.user_runs: off` or `SCF_USER_SANDBOX=off` switches it off.
- **Agent steps (#305):**
  - The agent's own sandbox is off, because profiles do not nest. Claude gets no `--settings` sandbox entry (one log line when the flow asked for it). Codex gets `sandbox_mode="danger-full-access"`. A Codex step that would have been `read-only` (plan, review) gets a profile that writes only in `<runDir>/home` and `<runDir>/tmp`.
  - Each run has private agent folders, `CLAUDE_CONFIG_DIR=<runDir>/home/.claude` and `CODEX_HOME=<runDir>/home/.codex`, set by the server. They start empty, so the admin's settings, MCP servers, skills and `config.toml` do not reach the run. A later step can still resume a session.
  - Sign-in is by token variable only. Claude on `anthropic` needs `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. Codex on `openai` needs `OPENAI_API_KEY` or `CODEX_API_KEY` (a lone `OPENAI_API_KEY` is also passed as `CODEX_API_KEY`). An `anthropic-compatible` provider needs its `api_key_env`. Local providers need none. Without one the step is refused at once, with no fallback try. A signed-out or 401 answer gives the same sentence. A key in a flow's `agent_env` is ignored.
  - The agent program and its install folder are readable; the agent folders in the Mac account's home are not.
- **Area locks:** a running run has a marker in the lock folder, so `tools/area-lock` need not read other runs' `run.json`.

**Limits.**
- macOS only. Where no sandbox works, a user's run is refused (or, with the setting off, not held). `sandbox-exec` is marked deprecated by Apple.
- The lock folder and the hooks folder (`hooks/allow/<token>`) are readable by every user's run.
- `ssh` can still be called, but without keys.
- The token is visible to the agent's shell tool, which can send it over the open network.
- A Codex read-only step is held by the outer profile only, not by Codex.
- Docker steps (`sandbox: true` with an image) are held by the container, not by the profile.
- The real `claude` and `codex` were not run in the tests, only the fake agents. Before release, check by hand on a Mac that the real `claude` (with `CLAUDE_CODE_OAUTH_TOKEN`) and `codex` (with an API key) finish a step inside the profile. Result: not recorded yet.
- The network is open: a step can send what it may read to any host.
- Profiles do not nest: `sandbox-exec` started inside a sandboxed step fails.
- With the setting off, and for admin runs, nothing is held. The one exception is the read-only copies of reference repositories, held by file modes and checked before each agent step (see "Reference repositories").

## Credential leakage (to agents, logs, other users)

**Protected by.**
- The server's GitHub login is not put into a user's run (`ISOLATED_AGENT_ENV` in `src/engine/isolation.ts`).
- Secrets are redacted in logs and API answers (`src/credentials/redact.ts`, `src/server/http.ts`).
- Secrets never appear in API responses, and are not put into shell commands.
- A shell `run` renders only `vars`, `workdir` and `run`; `{{vars.<input>}}` is refused (`src/flow/schema.ts`).

**Fixed in #300.**
- SR-O2: the steps of a user's run start with a short environment (`src/engine/short-env.ts`), not a copy of the server's. A shell step gets a fixed short list, the `FACTORY_…` variables, the isolation variables and the names an admin lists in `step_env.pass`. An agent step also gets the exact variables its own agent and provider need, and `step_env.agent_pass`. Keys of other providers are not passed. The values of the keys named in the config (`api_key_env`) and of five well-known key variables are hidden in logs, live output and API answers (`src/credentials/redact.ts`).

**Fixed in #299.**
- SR-1: the diff reads changes without the server's environment and without any git setting of the workspace or the machine.
- SR-2: bare `{{vars}}` in a shell `run` is refused in a flow with a user input.
- SR-3: `agent_env` cannot be an input, so a user cannot set `NODE_OPTIONS`, `DYLD_*` or `BASH_ENV` for agent steps.

**Still open.**
- The Mac account's agent login, files and Keychain are out of reach of a user's run (SR-O1, fixed in #302). The server's token variable is visible to the agent's shell tool (see "OS sandbox for steps of a user's run").
- The Claude token kept by `scf auth set-token` (#977) is a generic password item of the Mac account, service `spaghetti-code-foundry`, account `claude-oauth-token`. Anyone who runs commands as that account can read it (for example with `security find-generic-password -w`). The Keychain lookups of a sandboxed step are denied, but every Claude step on `anthropic` still gets the value as `CLAUDE_CODE_OAUTH_TOKEN` when no variable is set, so the agent's shell tool can read it, as it can read a token variable. The value is never written to a file, the audit log, a log line or an error; the time it was set is in `ai-token.json` and holds no secret. A Keychain problem gives no token and one log line. Do not set the token for a user account you do not trust with it.
- Global redaction uses every account's secrets on every answer. It is not only protection: a short token such as a common word is replaced in everyone's answers and confirms a guess of another account's secret (SR-O10).
- The Slack webhook is shown to admins, and `GET /api/since` uses the server's login (SR-O9).
- The agent's own provider key is still visible to the agent's shell tool unless the agent CLI hides it (left open from SR-O2).
- A name an admin lists in `step_env.pass` is readable by the shell steps of every user's run; `agent_pass` limits a name to agent steps.
- A value shorter than 8 characters is not hidden in output. The server logs a line for such a key variable.
- Only the exact variable names above are known to be enough for the agents; the fake agents cannot show what the real Claude Code and Codex CLIs need. Setups the built-in provider list does not know (such as Bedrock with `AWS_…` keys) need `agent_pass`.
- Runs that keep the machine's login (an admin's run, or a run without an owner) still get the server's whole environment.

## Prompt injection from repositories and issues

**Protected by.**
- Untrusted text (task, issue text, step output) never goes into a shell command; flows read it through `$FACTORY_…` variables.
- Approval messages of a published flow may use only a small set of placeholders (`src/flow/schema.ts`).

**Fixed in #299.**
- SR-5 and SR-3 close two ways a user could run code outside a clean workspace or change the agent's environment.
- The flow rules are written down: "Security rules for published flows" in `docs/FLOW_AUTHORING.md` and the user guide.

**Still open.**
- Any commenter's answer resumes a needs-info run, and all comments reach the agent (SR-O4).
- `{{run.history}}` and watcher-set variables can be used in a shell `run` of an admin's flow (SR-O8).
- Text in a repository or an issue can steer an agent. Only the tools given to a step limit the damage.

## Path traversal via run and flow ids

**Protected by.**
- `loadRun` (`src/engine/state.ts`) and `src/server/api-runs.ts` accept only `/^[\w-]+$/` for a run id.
- Flow and block names pass `NAME_RE`.

**Fixed in #299.**
- SR-7: `serveStatic` (`src/server/http.ts`) refuses a path in a sibling folder whose name starts with the root's name; `USER_RE` in `src/auth/repo-url.ts` refuses a user name that starts with `-` or `.`. Neither was exploitable.

**Still open.**
- The repository pattern in `turn-actions.ts`, `since.ts` and `health.ts` accepts `..` (SR-O9).

## SSE and log access

**Protected by.**
- `runs/:id/events` is `own`: a user sees only their runs.
- A user's log lines are rebuilt (`userLogLine`), paths are hidden (`hidePaths`) and secrets redacted. Transcripts are admin-only.

**Fixed in #299.**
- SR-5: a user gets 403 for the diff of an `inplace` run; an admin still sees it.
- SR-1: the diff has a time limit.

**Still open.**
- The diff does its git work inside the server process, so a large or slow workspace holds up other requests until the limit (SR-O11).
- Redaction side effects (SR-O10).

## CSRF

**Protected by.**
- `requireSession` wants `X-CSRF-Token` on every request that is not GET (`src/server/api-auth.ts`).
- `access()` in `src/server/net.ts` checks Host and Origin.
- No GET changes state. The cookie is `HttpOnly; SameSite=Strict`.
- No HTML sink in `ui/`: `h()` in `ui/dom.js` writes text nodes, and the CSP blocks inline script.

**Fixed in #299.** Nothing; no hole was found.

**Still open.** Nothing found. The review of `ui/*.js` was by pattern search.

## Session fixation

**Protected by.**
- A new token at every sign-in (`src/server/api-auth.ts`); only a SHA-256 of it is stored.
- The cookie is `HttpOnly; SameSite=Strict`.

**Fixed in #299.** Nothing; no hole was found.

**Still open.** Nothing found.

## Skill integrity

**Protected by.**
- Each skill package has a SHA-256 digest over all its files. Administrator and built-in skills can only be selected when the digest matches the pin in `skills.lock.json` (exact `id@version`, no fallback to another version).
- Repository skills are `unapproved` and cannot be pinned.
- The lock is written with the guarded store code (mode 0600, no symlinks); an unreadable lock makes every skill `unverified` instead of trusted. Health shows changes and lock problems without paths.
- A library source with `trust: community` is used only when it is enabled, has a `review` of its maintainer and licence, and the review names the approved commit. A repository on the shipped community list cannot be given another trust tier. Both are checked when `skill-sources.yaml` is read, before `scf skills import` fetches or `scf skills scan` reads anything.
- A private first-party source (`access: { repo }`) is fetched only with a token for that one registered GitHub App repository, `contents: read`. The token is made fresh for each fetch and is not in argv, the environment of other processes, logs, stop reasons or API responses; it reaches git only through a one-shot `GIT_ASKPASS` file (mode 0600) that is removed afterwards. Git keeps its own empty HOME, https only, no redirects, and the same fsck and size limits. `update` uses the token only for a candidate with the same repository and access as the approved source; a changed destination stops with a fixed message and nothing is fetched.

**Limits.**
- The lock detects a change after the pin, not a bad first copy. A person must check the package before `scf skills pin`.
- Built-in skills are pinned at server start without a person, because they ship with the release.
- Whoever can write the data folder can rewrite the lock.
- The `review` is a person's record in `skill-sources.yaml`. The check is offline: it cannot verify the maintainer, the licence or the content of the commit.
- The token sits in a file in the fetch's temporary folder while git runs. Anyone who can read that folder of the server during the fetch can read it. The token is limited to one repository and to reading it, and it expires.

## Skill tools and connectors

**Protected by.**
- A skill package is scanned when it is loaded, before any file is parsed, for credentials, credential files and live connection endpoints. A hit stops the parse, so no later message repeats a value.
- Findings name the rule only. File names, the folder name and the registry problem are covered too (a credential-looking folder shows as `(name not shown)`).
- `connectors` are slugs, not endpoints, and a package that names them needs `risk: medium` or `high`.

**Limits.**
- The scan is pattern matching. Encoded or split secrets and unusual formats pass, also a YAML escape that only becomes a token after parsing.
- An Oracle TNS descriptor (`@(DESCRIPTION=…)`) and `http(s)` endpoints are not seen. A single-label host such as `kafka` counts as real.
- A skill that names a connector stops the run at the plan gate. Under `skills.tools.missing: degrade` it stops only when the skill is mandatory or is required, directly or transitively, by a mandatory skill; otherwise the run goes on with a warning and the skill's text can still reach sessions. `skills.tools` does not limit what a session can do.
- Before every Claude coder session the locked skills are checked again against the current `skills.tools` and the real step. A skill that needs a shell is not loaded into a step without one. A skill the policy no longer allows, or a locked version with `network` that the gate never saw, refuses the session (under `degrade` it is left out with its dependants). `allowed-tools` in a SKILL.md is never passed on. The step record has `skills.grant`.
- The grant is an estimate from the mode, rule names and sandbox. It decides only which skills are loaded. The repository's `.claude/settings.json` can approve more tools than the record lists. Codex sessions and reviewer steps are not checked.

## Plugins from config

**Trust.** A plugin is code that runs inside the server process with the server's rights, so the
trust is that of whoever can edit `config.yaml`. Admins cannot add one from the browser or the API:
`PUT /api/config` refuses a `plugins` key and keeps the stored list, and the settings page only shows
it. The list is read once at start.

**Protected by.**
- A relative path, a URL and a built-in Node module are refused before anything is imported.
- The real path (symlinks followed) of a module must not be inside a runs folder or a repository the
  Foundry works on, so a run's own files cannot be loaded as a plugin.
- A plugin that fails, or does not finish `register` in 30 s, stops the start with a message that
  names it. No watcher or queue starts first.
- `api.options` is a frozen copy. The options and the module path are not in `GET /api/plugins`,
  `scf plugins` or the health line; the health line gets labels and reasons only.

**Limits.**
- No sandbox and no digest pin: a plugin has the server's full access, and a package it imports can
  change on disk. The check is at start only; a change takes effect at the next restart.
- A plugin can read the server's environment and the data folder, which holds the stored
  credentials. Do not add a plugin you have not reviewed.
- A timed-out `import` or `register` cannot be cancelled; it keeps running until the process exits.
- The check that the module is outside the runs folders compares real paths of the module file, not
  of its dependencies: a plugin may import code from anywhere.

## Identity provider (#833)

**Trust.** A plugin that calls `api.identityProvider` decides who is signed in, with which role and
which workspace. Its answer is trusted as to identity: the Foundry checks only the form of the answer.
Whoever can add a plugin can therefore make anyone an admin, as with any plugin ([Plugins from config](#plugins-from-config)).

**Protected by.**
- The provider gets a copy of the request without the Foundry session cookie, so it cannot read the
  Foundry's session token from the request it is given. The copy is frozen.
- The answer is checked strictly (UUID id, name of 1 to 100 characters, roles `admin` or `user` only,
  a workspace id, no other keys). Anything else signs nobody in.
- A throw, a timeout (5 s) or an invalid answer signs nobody in, and no provider text reaches logs,
  problems or responses: only fixed sentences are shown.
- At most 8 provider calls wait at once; further calls are refused without being made, so a slow
  provider cannot pile up work.
- Each API call of a provider session asks the provider again. A changed id or a null answer ends the
  session at once; a provider error answers 503 and does not end it. A session cannot outlive the
  provider's answer by more than one call.
- A provider account is a mirror in `users.json` with no password. Password sign-in, password setting,
  links, resets and edits of the account are refused (409), so a local password cannot be used for an
  account the provider owns. A blocked account cannot sign in, and a recheck never creates an account.
- A local account with the same id or e-mail is never taken over: the provider's sign-in is refused.
- A provider user's workspace scope is its one workspace (or `default`), and an unreadable account gives
  an empty scope (fail closed).

**Limits.**
- The provider's answer is not verified by the Foundry. A compromised or buggy provider is trusted.
- A timed-out `resolve` cannot be cancelled; it keeps running in the provider, and the call still counts
  against the 8 waiting calls until it settles.
- A provider that is slow adds up to 5 s to each API call of a provider session.
- Only one provider is allowed, and the Foundry does not say which one is in use beyond the plugin's name in `GET /api/plugins`.
- A provider-only install with no account may listen on a non-local address; the provider is then the only way in.

**Break-glass account (#834).** While a provider is active, one local admin can still sign in with a
password. This is a deliberate second way in, so it is a standing credential.

*Protected by.*
- The mark is set only on the machine (`scf user break-glass`); no API route or UI sets it. There is one
  mark, and a file with a mark on a provider record or two marks cannot be read.
- Only an active local admin with a password can be marked. A mark is removed by `off`, a reset
  password, a new set-password link, a change to `user`, and a block. A local session counts under a
  provider only while its account is marked (`isBreakGlass`, checked again under the lock).
- Each break-glass sign-in writes its `sign-in` audit line (`target:"break-glass"`) before the session is
  written. If that line cannot be written, the sign-in fails with 500 and no cookie is set.
- Every other local account gets "wrong e-mail or password" while a provider is active, and such failures are audited.

*Limits.*
- The break-glass password works whenever the Foundry is reachable, provider up or not. Anyone who knows it
  can use it while the provider is up too.
- A break-glass session is not rechecked with the provider and lasts up to 7 days; a block or a clearing
  of the mark ends it at once.
- Changing the mark is logged as an account `edit` line, not as a separate action.
- A failed session write after the audit line leaves an `ok` line without a session. The audit is kept
  as the safer side: every attempt that could have succeeded is in the log.
- A broken audit log shuts the break-glass admin out until the log is fixed. The log line says why.

## Service accounts (#866)

**Protected by.**
- A bearer token is read only from a connection on this computer (`requestAccess` in `src/server/net.ts`). The public sign-in routes (`session`, `setup`, `set-password`) refuse it with 403 (`src/server/service-requests.ts`).
- A cookie is ignored when a bearer is present (`sessionUser`, `sessionAlive` and view-as in `src/server/api-auth.ts`, `src/server/view-as.ts`). A bearer plus a stolen cookie never acts as the cookie's account.
- Only the SHA-256 of the token is stored (`token.id`). The token is shown once, at creation and at rotation. The audit line names the account and the route, never the token.
- A scope cannot hold a route in `NEVER_GRANTED` (`src/server/permissions.ts`). It is refused when the scope is saved and again on every request, so an edited `users.json` does not help. A service account has no admin role and no password.
- Every bearer request is audited, refused ones too. A read's line is written before the handler runs; if it cannot be written, the request answers 503 and the handler does not run. A change (`POST`, `PUT`, `PATCH`, `DELETE`) is checked the same way before the handler (live token, audit log can be opened), but its one line, with the status, is written when the response is done (#877). If that late write fails, or the process is killed before it, the change has happened without its line; the server log says so (`auth: … (service-request late)`). This is the one place the 503 promise does not hold for changes.
- The optional `X-SCF-Client` header adds a client label to the line (`client <label>`, last in the detail). The label is chosen by the program: it is cleaned (control and invisible characters removed, cut to 64 characters) and a value that looks like a service token is written as `hidden`. It says which device or client the program says it acted for; it is not proof of the device, and a program holding the token can send any label. The line never holds a body, an answer text or a token.
- A token ends 30 days after its last request, and an admin can revoke it at once. A refused request does not renew a token.
- Data classes (#869, `src/server/data-classes.ts`): `secret` is the set of never-granted routes, so a scope cannot hold it. A `class:<name>` entry covers GET routes only, so a service account cannot change data through a class. A class that is not known is refused when the scope is saved, and `serviceAllows` checks the class again on every request.
- A repository set to `services: none` is closed to every service account (`checkServiceRepos` in `src/server/service-requests.ts`). A refusal is a 403 and is audited. Admin-only routes that name no repository stay open only when they hold no repository data (`REPO_FREE`), and Ask Foundry is closed while any repository is closed, since it reads repository text.
- Acting for a person (#876): `actsFor` swaps only the id the request acts as (`resolveActing` in `src/server/service-requests.ts`). The account keeps `kind: service`, role `user`, its scope and its data classes, so it is never an admin and every request is still checked against them. The link is read on every request, so a person who is blocked, removed or cannot sign in gets 403 with a fixed reason at once, and an open stream ends when the link changes. The audit line names the person by id.
- The link can only point at a person's account, not at another service account (`checkActsFor`, `src/auth/service-accounts.ts`). A managed service's `acts_for` is resolved by name or e-mail at its start, and a name that matches no person or several is refused before anything runs.

**Still open.**
- A token is a bearer secret. Whoever holds it can use it on this computer until it is revoked or expires, within its scope.
- The loopback check does not tell programs on the computer apart. Any program that can read the token can use it.
- A class grant covers every GET route of the class, so a scope with `class:summary` also reads what each summary route shows, including the run list of every repository the account can see. Use `services: none` on a repository that must stay out of reach.
- A route whose admin check sits in its handler and not in the role table was found only for `GET help/usage` and `GET/PUT runs/:id/issue-limit`, which now use `adminOrGranted()`. The other such routes were not reviewed.
- Tokens are not renewed by the server on their own: a program that is not used for 30 days must be given a new token by an admin.
- With `actsFor`, the token sees everything the person can see, within the scope: a scope with `class:summary` reads every run and repository of that person. Link a service account only to a person whose work the program may read and answer.
- A service account's own audit lines (#884, `POST /api/audit/service-line`, `src/server/api-service-line.ts`) hold text the program chose. The Foundry checks only its shape: the words of `event` and `code`, the length and printability of `detail`, and that no token is in it. The text is the program's claim, not something the Foundry verified. The Audit page and `GET /api/audit` do not mark these lines apart from others; the action `service-line` and the account name show where a line came from. A program can write a false line; the line names the account, its person and its client label, so it can be traced, but not proven right. The text is JSON-quoted in the line, so it cannot pose as the `acts for` or `client` parts. Only a service account whose scope lists the route by its own key may write these lines; a person gets 403 and `class:` does not grant it. The route is `admin` data, not a read.
- Flooding: an account may write at most 120 lines a minute (429 with `Retry-After` above that). One `service-line-dropped` line a minute records the overflow, so the log cannot be filled by the program, and the count is kept in memory, so a restart resets it. The limit bounds only the program's own lines; each call still gets its `service-request` line.
- The line is written even under `services: none`, since it names no repository. This does not let the account read a closed repository.

## Managed services (#867)

**Trust.** A managed service is a program the server starts as the same operating-system user, so
the trust is that of whoever can edit `config.yaml`. Admins cannot add one from the browser or the
API: `PUT /api/config` refuses a `services` key and keeps the stored list, and the settings page only
shows the setting. The list is read at start; a change takes effect at the next restart.

**Protected by.**
- The program is started with `spawn` and an argument array, never through a shell. `command` is an
  absolute path with no `.` or `..` parts and no URL (`serviceCommandProblem` in `src/config.ts`), and its
  real path (symlinks followed) must be a file that can be run and must not be inside a runs or
  workspaces folder (`programProblem` in `src/services/setup.ts`).
- The environment is a fixed list of system variables, the configured `env` and two Foundry variables.
  The server's own secrets (credentials, the GitHub and Slack settings) are not passed. `SCF_` and
  `FACTORY_` names cannot be set in `env`, so a config cannot override the Foundry's variables.
- The service token goes in the environment (`SCF_SERVICE_TOKEN`), never on the command line, so `ps`
  does not show it as an argument (another process of the same user can still read the environment). It is a fresh token of the service's own account on each start (only its SHA-256
  is stored), and the account has the scope the config names and nothing more (see Service accounts above).
  The token of a run is revoked when the run stops, and leftovers are revoked at the next start.
- With `public_key`, `<command>.sig` must be a valid Ed25519 signature of the program file, checked
  before every start; a file that does not match is not started, and the reason is a fixed sentence on
  Health. The signature file and the program are read with a size limit (1 KB and 256 MB).
- The token and the values of `env` are removed from the program's output before it is written to
  `<data folder>/services/<name>.log`, including when a secret is split between a line and the next
  one. The log is not shown in the API or on the Health page.

**Limits.**
- No sandbox: the program has the server user's file access, including the data folder with the stored
  credentials, as any plugin does. Do not add a program you have not reviewed.
- The signature is checked against the file at each start, not while the program runs. A file that is
  changed while it runs goes on until the next restart.
- Without `public_key` nothing checks the program file.
- The token is a bearer secret for its scope. The program holds it and can use it on this computer
  until it is revoked, expires or the program stops. Any other program on the computer can use it once it
  is read; the loopback check does not tell programs apart (see Service accounts above).
- Redaction is by exact value: a secret that the program changes (for example encodes it) is not
  removed from the log.
- A program that ignores the stop signal is killed after 5 s; a program that starts its own detached
  processes outside its process group may outlive the stop.

## Shared metrics push (#889)

The install sends its daily report to a receiver (`metrics_sharing.endpoint`). The report is numbers only
(the schema of #893 has no free text), so the risk is where it goes and what the receiver can learn from it.

**Protected by.**
- One network call, the report (`POST`) or one delete (`DELETE <endpoint>/<install>`). It uses `node:http`/`node:https`
  with no connection reuse, no cookie, no redirect, and only `User-Agent: spaghetti-code-foundry/<version>`
  and the content headers (`src/metrics-share/push.ts`). The answer is read only for its status and an
  integer `retry_after` from 1 to 86400 in a body of at most 4 KB; a 2xx body is never read. Nothing from
  the answer is stored or logged.
- The address is checked when the config is read and again before each request (`isShareEndpoint`): https
  only, or plain http to exactly `localhost` or `127.0.0.1`; no user name, password, `?`, `#`, whitespace or
  control characters; at most 2048 characters.
- Consent is checked again after the report is built and right before it is sent (`stillActive`), so a
  yes that is taken back during the build sends nothing. An unreadable `config.yaml` or `users.json` ends the
  tick without a send and without a stop; it is never read as a no.
- A stop (last yes taken back, or sharing switched off) and the new install id are saved before the DELETE
  goes out. A crash in between leaves a delete to send later; a new id is never reused for old data.
- The install id is 128 random bits, not derived from an account, a machine or a repository. It is stored in
  `metrics-share.json` (mode 0600). A DELETE uses only an id that matches 32 lower-case hex characters.
- The DELETE goes to the endpoint the POSTs of that id went to, not to the one now in the settings.
- Failure output is one fixed line per run of failures, with no values, no endpoint and no answer text.
  The last answer (status and kind) is kept in the state file and the preview, never the body.
- One writer: the lock `metrics-share.lock` is held by the tick and by `scf metrics send`. Nothing waits for it.
  A lock whose time is old is taken over.

**Still open.**
- **The endpoint can be changed through the API.** `PUT /api/config` refuses `plugins` and `services` with
  a 400, but it does not refuse `metrics_sharing.endpoint` or `metrics_sharing.timeout_ms`
  (`src/server/api-admin.ts`). An admin can point the reports to another https address, and whoever can edit
  `config.yaml` can too. The comment in `src/settings/exceptions.ts` says these keys are "set in config.yaml
  only"; the code does not enforce that. The fix is to refuse the two keys in `PUT /api/config` the same way
  as `services`.
- The install id is the same from day to day until a stop. The receiver can link one install's reports over
  time. A stop gives a new id. The id is also the key of the DELETE, so it is a secret for the receiver's
  data; it is in the URL of the DELETE, so the access log in front of the receiver records it unless that log
  is off (see `collector/README.md`, #890).
- TLS is trusted through the system's certificate store. There is no pin of the receiver's certificate.
- With `http://localhost` or `http://127.0.0.1` (for tests), the report goes in clear to whatever listens on
  that port. Anyone who can edit `config.yaml` can set it; the address is only accepted for those two hosts.
- Any program that runs as the same user can hold the lock and stop the push for as long as it holds it. This
  only delays the push; it sends nothing.

## Reference repositories (#878, #894)

A watcher can give its runs read-only copies of other repositories of its owner (`src/engine/reference-repos.ts`, `src/engine/reference-check.ts`). The agents read the copies; nothing may change them or put them in the pull request.

**Protected by.**
- A copy sits in the run folder next to the checkout, so it is never part of the pull request. It has no remote, its files are 0444 and its folders 0555 (`.git` too), and Claude's Edit and Write are denied there.
- In a sandboxed run the OS sandbox also refuses writes and `chmod` there. In an admin's run without the sandbox, file modes are the only hold, since a shell step can `chmod`. Before each agent step every copy is checked against its commit: `HEAD`, a clean `git status` (ignored files included, `core.fileMode` off) and the modes. A copy that changed is removed, and the step's reference block leaves it out. The run goes on.
- The check runs before each agent step, and each copy is checked once per step even when several steps start together.
- A user's run without the OS sandbox gets no copy at all (`sandbox.user_runs: off`).
- Each copy records what held it (`held: sandbox` or `held: file modes`) in the run log and in `run.json`.

**Limits.**
- Between two agent steps, a shell step of an admin's run can read and change a copy. The change is seen, and the copy removed, only when the next agent step starts.
- The agent's own shell tool is not held by the file modes. A change it makes can be read by the same agent step, and it is removed before the next agent step.
- The check compares `HEAD`, the working tree and the modes. It does not look at `.git/config` or the refs. A shell step of an admin's run can add a remote to a copy, and nothing in the check sees it.
- A copy whose removal fails is kept, marked unavailable, and stays denied to Claude's write tools.
- The privacy rule (a private reference only for a target known to be private, or `reference_private_ok`) is a separate guard and not covered here; see the USER_GUIDE.

## Depends on across repositories (#976)

**Protected by.** A watcher reads the issue of another repository named in **Depends on** only as follows (`src/queue/cross-deps.ts`, `src/queue/watcher.ts`).
- Only a GitHub repository the watcher's account added counts. A repository another user added is never read, with any sign-in.
- A non-admin's repository with no sign-in of its own (method `none`) is refused before any sign-in is chosen.
- An admin's `none` repository is read with the server's own access. Otherwise its own sign-in is tried first.
- When both repositories have the same GitHub account or organisation (case ignored), the sign-in of the watcher's own repository is tried next. The same sign-in is never asked twice for one read.
- Only the state of the issue is read and kept. The first readable issue is the answer. A 403 or 404 is "cannot read", never "done".
- Nothing is written to the other repository.

**Limit.** The watcher's own sign-in can read the issues of another repository under the same GitHub owner, when it has access to them. This is the intended same-owner case; no other repository is reached with it.

## Shared metrics receiver (#890)

The receiver is a separate Node.js process on the public site (`collector/`, see `collector/README.md`). It takes
the daily reports of #889, keeps them per install and day, serves the public totals and answers the `DELETE` of an
install. It has no access to the site's files.

**What a report reveals.** A report is numbers only: the #893 schema has no free text, and flow, step and model
names are kept only when they are built-in ones (otherwise `custom`). A report names no account, repository, path
or address. Its one identifier is the install id, a random 128-bit value, so the reports of one install can be
linked from day to day until the install stops sharing. Only whoever runs the receiver can read per-install
reports (the data folder, mode 0600). The public `GET /metrics.json` gives totals only, but every number is shown, also one that a
single install gives (`minInstalls` is 1, the owner's choice), so while few installs share, one install's numbers
can be read from it. They are still only counts, durations and tokens, with no account, repository, path or address.

**What an attacker with the install id can do.** The id is the key of `DELETE /api/metrics/<install>`: whoever
holds it can remove that install's stored reports. It does not stop the install's later pushes. The id is also
the key of a report: a new report for the same install and day replaces the one kept, so the day's numbers can be
changed. Guessing an id is not practical (128 random bits), and an id is seen only by the install, its data folder
and a request that carries it. The id is in the URL of the `DELETE`, so the access log of the web server in front
of the receiver must be off for these paths (`collector/README.md`); the Foundry cannot check that from the code.

**Forged reports.** The receiver cannot tell a real install from a program that sends valid reports for random ids.
Such reports change the public totals. The limits bound them: the schema, a body of at most 64 KB, a day within the
last 7 days, 20 requests an hour per install id and 1000 an hour in total. There is no minimum number of installs, so
even one forged id changes the totals.

**Why the receiver cannot reach an install.** The install only makes outbound HTTPS calls to the configured
endpoint (`src/metrics-share/push.ts`) and does not listen for metrics. The report holds no address of the
install, and the receiver stores no IP address and no header other than the content type, so it has no route back
to the install. The answer of the receiver is read only for its status and an integer `retry_after` (1 to 86400
seconds). No URL, command or redirect in an answer is followed, and no cookie is kept. So the receiver can only
move the install's retries, and only until the 7-day limit of the push. Nothing it sends changes a run.

**Protected by.**
- The schema, size, day window and rate checks above, with fixed refusal reasons that never repeat the body.
- No IP address, no header other than the content type and no line per request in the receiver's own log; only a
  failure name is logged.
- One file per install and day, mode 0600; reports older than 400 days are removed.
- The receiver runs as its own process, listens on `127.0.0.1` by default, and stops within 10 seconds on a signal.

**Still open.**
- Forged reports can move the public totals (see above). A signed install id or a proof of a real install would
  close this, and it would cost the anonymity of the install id.
- There is no minimum number of installs: a total can be the numbers of a single install, and someone who reads
  the totals over time can see which changes come from one install while few installs share.
- The access log of the web server in front of the receiver is a deployment setting that the code cannot check.
- The endpoint can still be changed through `PUT /api/config` (see "Shared metrics push (#889)" above).

## Ask Foundry investigation (#970)

Ask Foundry can look up the asker's runs while it answers (`src/help/investigate.ts`, `src/help/tools.ts`, `src/server/help-tools.ts`).

- **No tools in a model call.** A model call never has a tool of its own. The model can only write a short JSON request for one of the four look-ups; the server checks it and carries it out, or refuses it.
- **A fixed, read-only list.** Only `list_runs`, `show_run`, `step_log` and `failing_tests` exist. The first two map to the `GET` route for runs; the log look-ups are in "Ask Foundry log look-ups (#971)" below. The server checks the route rule (`findRule`, `authorize`) for the account that asks now, not for the account that asked earlier, and uses the same scoping as `GET runs`. A request with another name, an extra key, a bad id or a bad date is refused before anything is read. Refused names are never repeated to the model: the next prompt holds fixed words only.
- **One answer for no access.** An unknown run and another account's run give the same result, so a look-up cannot tell them apart. The result leaves out the cost, the model, the run folder and the owner.
- **Guarded, capped results.** Each value from a run (step errors, issue titles, task lines) is guarded on its own before it reaches the model: a secret is removed, and text that reads like an instruction is held back. The note in the tool log is guarded again and cut to a fixed length. A source that a read limit cuts or drops is named as such. Excerpts stay in the JSON part of the prompt; a reply may cite only the sources the server gave it.
- **Cost, time and daily budget.** The per-call cost (`max_cost_usd_per_turn`), the time of one call (`timeout_seconds`), the question's limits (`max_rounds`, `max_seconds`, `max_cost_usd`) and the daily budget (`daily_budget_usd`) are checked before every model call. The cap of each call is the smaller of what is left of the question and of the day. Spend of another source between two calls counts. A used-up daily budget ends the question; the last call that has to answer is not made in that case.
- **Stop and pause.** A stop or a pause ends the answer: no further model call, no further look-up and no accepted answer, and the temporary folder of each call is removed.
- **Remaining risk.** Turns that run at the same time can each see the same daily amount left and go past it together, and the model CLI can go slightly past its own cap. Model-chosen look-ups cross the permission boundary only inside the asker's own rights; a misled model can read only the runs that the asker may read.

## Ask Foundry log look-ups (#971)

Ask Foundry can read the log of one step (`step_log`) and the failing tests of a run (`failing_tests`) while it answers (`src/server/help-log-tools.ts`, `src/help/log-read.ts`). **Log text now goes to the model**, which it did not do before: this is the new exposure.

- **Same rule as the transcript route.** A log look-up passes the rule of `GET runs/:id/transcript/:n` for the account as it is now. A role that may not read a transcript gets the fixed sentence "Refused: your role may not read the logs of a run." The asker must also own the run (archived runs included), also for an administrator; another account's run gets the same answer as an unknown one.
- **Path inside the run folder.** The log path is checked as written and again after it is resolved (real path, and the file actually opened). A log outside the run folder is refused with a fixed sentence, and a missing log gets a fixed answer.
- **Bounded reads.** A tail reads at most 128 KB from the end; a search or a test log streams at most 4 MB and stops at the cap. A read never loads a whole log, and the window is the only text the look-up sees.
- **Guard before cut and numbering.** Lines are made readable, private key blocks are masked over the whole window, and secrets are removed (`guard.ts`, with `help.sensitive_patterns`, and the `keepLines` option so removals keep the line numbers) before any line is cut or numbered. Lines that read like an order are held back. A window that is cut at its edge is checked with the context beside the edge, so a secret split by the cap is still removed.
- **Fixed notes.** The tool note holds only fixed words and numbers; the search text is guarded before it is used. A line is cut to a fixed length.
- **Remaining risk.** The guard recognises known kinds of secret and the patterns that the administrator configured. A secret of a kind it does not know, in a log the asker may read, reaches the model and the model provider as text. Lines that an answer cites are only those the server gave it.

## Open findings

Issues are filed without the label `Factory_go`. In this build `gh` was not available, so the
numbers say "not filed yet". The next build files them and writes the numbers here; it files
nothing twice.

| Id | Severity | Finding | Issue |
|---|---|---|---|
| SR-O1 | Fixed | Agent steps were not held by the operating system. Fixed in #302 (shell steps in #304, agent steps in #305). Limits: macOS only and a deprecated tool; the token is visible to the agent's shell tool; the lock and hooks folders can be read; Codex read-only steps are held by the outer profile only; Docker steps are held by the container; with `sandbox.user_runs: off` nothing is held; the real CLIs were not run in tests | #302 |
| SR-O2 | Fixed | The steps of a user's run saw the server's whole environment. Fixed in #300; what stays open is listed under "Credential leakage" | #300 |
| SR-O3 | Fixed | Any user could connect any repository the GitHub App is installed on. Fixed in #301: each account has a list of app repositories, an admin is not limited, and existing connections are marked, not cut off | #301 |
| SR-O4 | Medium | Any commenter's answer resumes a needs-info run (`src/github.ts:273-279`), and all comments reach the agent | not filed yet |
| SR-O5 | Low | The connection test connects to any host and port, and git follows the first redirect | not filed yet |
| SR-O6 | Low | `POST /api/repos` answers 409 for a repository of another account and lets an unverified token claim a name first | not filed yet |
| SR-O7 | Low | Files in the data folder that every step can write: `hooks/pre-push`, `hooks/allow/<token>`, `<runDir>/sign-in/key`, the learnings files | not filed yet |
| SR-O8 | Low | `{{run.history}}` and watcher-set variables can be used in a shell `run` of an admin's flow | not filed yet |
| SR-O9 | Low | `GET /api/config` shows the Slack webhook to admins; `GET /api/since` uses the server's login; the repository pattern accepts `..` | not filed yet |
| SR-O10 | Medium | Redaction uses every account's stored secrets on every answer (`src/credentials/redact.ts`, `src/server/http.ts`) | not filed yet |
| SR-O11 | Low | The diff does its git work inside the server process | not filed yet |
