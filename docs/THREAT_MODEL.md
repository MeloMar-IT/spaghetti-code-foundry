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

**Read this first.** A run is not held by the operating system yet (SR-O1). A run works as the Mac
account that runs the server. Give a user account only to people you would give an admin account.

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

**Still open.**
- A run is not held by the operating system yet (SR-O1): give a user account only to people you would give an admin account.
- Files in the data folder that every step can write (SR-O7).

## Credential leakage (to agents, logs, other users)

**Protected by.**
- The server's GitHub login is not put into a user's run (`ISOLATED_AGENT_ENV` in `src/engine/isolation.ts`).
- Secrets are redacted in logs and API answers (`src/credentials/redact.ts`, `src/server/http.ts`).
- Secrets never appear in API responses, and are not put into shell commands.
- A shell `run` renders only `vars`, `workdir` and `run`; `{{vars.<input>}}` is refused (`src/flow/schema.ts`).

**Fixed in #299.**
- SR-1: the diff reads changes without the server's environment and without any git setting of the workspace or the machine.
- SR-2: bare `{{vars}}` in a shell `run` is refused in a flow with a user input.
- SR-3: `agent_env` cannot be an input, so a user cannot set `NODE_OPTIONS`, `DYLD_*` or `BASH_ENV` for agent steps.

**Still open.**
- The run works as the Mac account and can read its files and Keychain (SR-O1).
- Global redaction uses every account's secrets on every answer. It is not only protection: a short token such as a common word is replaced in everyone's answers and confirms a guess of another account's secret (SR-O10).
- The Slack webhook is shown to admins, and `GET /api/since` uses the server's login (SR-O9).

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

## Open findings

Issues are filed without the label `Factory_go`. In this build `gh` was not available, so the
numbers say "not filed yet". The next build files them and writes the numbers here; it files
nothing twice.

| Id | Severity | Finding | Issue |
|---|---|---|---|
| SR-O1 | High | A run is not held by the operating system (issue "Platform 2d") | not filed yet |
| SR-O2 | — | Issue "Platform 2b" | not filed yet |
| SR-O3 | — | Issue "Platform 2c" | not filed yet |
| SR-O4 | Medium | Any commenter's answer resumes a needs-info run (`src/github.ts:273-279`), and all comments reach the agent | not filed yet |
| SR-O5 | Low | The connection test connects to any host and port, and git follows the first redirect | not filed yet |
| SR-O6 | Low | `POST /api/repos` answers 409 for a repository of another account and lets an unverified token claim a name first | not filed yet |
| SR-O7 | Low | Files in the data folder that every step can write: `hooks/pre-push`, `hooks/allow/<token>`, `<runDir>/sign-in/key`, the learnings files | not filed yet |
| SR-O8 | Low | `{{run.history}}` and watcher-set variables can be used in a shell `run` of an admin's flow | not filed yet |
| SR-O9 | Low | `GET /api/config` shows the Slack webhook to admins; `GET /api/since` uses the server's login; the repository pattern accepts `..` | not filed yet |
| SR-O10 | Medium | Redaction uses every account's stored secrets on every answer (`src/credentials/redact.ts`, `src/server/http.ts`) | not filed yet |
| SR-O11 | Low | The diff does its git work inside the server process | not filed yet |
