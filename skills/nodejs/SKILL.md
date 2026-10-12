---
name: nodejs
description: "Node.js services: modules, event loop, streams, shutdown, config, logging, tests. Use for code that runs on Node.js; not browser-only or non-Node work."
metadata:
  budget-planner-chars: "160"
  budget-coder-tokens: "2300"
  budget-reviewer-tokens: "650"
---

# Node.js services

## When this applies

- Use it for code that runs on the Node.js runtime: servers, workers, command-line tools and scripts, in JavaScript or TypeScript.
- Do not use it for code that runs only in a browser, or for packages on another runtime (Deno, Bun, edge workers) unless they also target Node.js. In a browser project, only the files Node.js itself runs (build and tool configuration, scripts) are in scope.
- Language rules for TypeScript and rules for a web framework, a database or a message broker live in their own skills.

## Follow the repository first

- Find the runtime version in `engines.node`, `.nvmrc`, `.node-version`, the Dockerfile and CI. Use only APIs and syntax of the lowest version the project supports. Do not raise it.
- Use the package manager of the lockfile that exists (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) and the `packageManager` field. Do not add a second lockfile. Install with the frozen command the project uses (`npm ci` and the like).
- Run the scripts in `package.json` (`test`, `lint`, `build`, `typecheck`) instead of calling tools directly. In a workspace, run them for the package you changed, the way the repository does.
- Do not add a dependency unless the task asks for it. Look first at the Node.js built-ins of the supported version (`node:fs/promises`, `node:stream/promises`, `node:timers/promises`, `node:test`, `fetch`, `AbortController`, `node:util` `parseArgs`) and at what is already installed.

## Modules: ESM and CommonJS

- Read `"type"` in the nearest `package.json` and the file extension (`.mjs`, `.cjs`, `.mts`, `.cts`) to know the module system of a file. Write new files in the system the package uses; do not mix them or convert files on the side.
- In ESM: write relative imports with the file extension, use `import.meta.url` or `import.meta.dirname` instead of `__dirname`, and read JSON the way the package already does. There is no `require` unless it is made with `createRequire`.
- In CommonJS: load an ESM-only package with `await import()`; `require` of ESM works only on recent Node.js versions, so check the supported version first.
- Import built-ins with the `node:` prefix where the package does.
- `main`, `exports`, `types` and `bin` in `package.json` are the public interface of a package. Changing an export path, or the default against named exports, breaks consumers: treat it as an API change. Do not import files of another package that its `exports` does not list.
- Keep imports free of side effects: no listening server, open connection or timer at import time. Start those in one entry point.

## Event loop and blocking work

- Do not block the event loop on a request or message path: no `*Sync` calls from `fs`, `child_process`, `crypto` or `zlib` there, no long loop over large input, no `JSON.parse` or `JSON.stringify` of unbounded data, no regular expression that can backtrack badly on user input. Synchronous calls are fine at start-up and in command-line tools.
- Move heavy CPU work to `worker_threads` or a child process, or do it in chunks, in the way the repository already does.
- Bound concurrency. Do not start one promise per item of an unbounded list with `Promise.all`; use a fixed pool or the queue the project has.
- Do not start a child process with a shell string built from input. Use `execFile` or `spawn` with an argument array, and handle its `error` and `close` events and its exit code.

## Asynchronous failures

- Every promise is awaited, returned or given a `catch`. A rejection nobody handles ends the process on current Node.js versions.
- An `async` function passed where the caller ignores the result (`EventEmitter` listeners, `setInterval`, `forEach`, callback-style middleware) needs its own `try`/`catch`.
- An `EventEmitter` or stream with no `error` listener throws when it emits `error`. Add the listener when you create the object.
- Do not mix a callback and a promise for the same result, and never call a callback twice.
- `process.on('unhandledRejection')` and `process.on('uncaughtException')` are for the last log line and an exit with a failure code, in the entry point only. Do not use them to keep running: the state is unknown after an uncaught exception.
- Throw `Error` objects, keep the `cause` when wrapping, and tell expected failures (bad input, missing record) from bugs.

## Streams and backpressure

- Connect streams with `pipeline` from `node:stream/promises`, not with bare `.pipe()`: it forwards errors and destroys every stream on failure.
- Respect backpressure: when `write()` returns `false`, wait for `drain`. Do not collect a stream of unknown size in memory; set a size limit on request bodies and uploads.
- Destroy a stream you stop reading early. Close file handles, sockets and readers in `finally`.

## Timeouts and cancellation

- Every outbound call (HTTP, database, queue, child process) has a timeout. Use the mechanism the client has, or `AbortSignal.timeout()`.
- Pass an existing `AbortSignal` on to the calls you make, and stop work when the caller is gone (request aborted, socket closed).
- Clear timers and remove listeners on every path, also on failure. Use `unref()` on a timer that must not keep the process alive, and only on such a timer.
- Retry only operations that are safe to repeat, with a limit and a growing delay.

## Start-up and shutdown

- Start in order: read and check the configuration, connect to what the service needs, then listen. Fail fast with a clear message and a failure exit code when start-up cannot finish.
- Handle `SIGTERM` and `SIGINT` once: stop taking new work (`server.close()`, pause consumers), let work in progress finish within a time limit, close pools, clients, file handles and timers, then let the process end.
- Close idle keep-alive connections where the supported Node.js version allows (`server.closeIdleConnections()`), or the server does not close in time.
- Prefer `process.exitCode` and a natural end. A direct `process.exit()` can cut off logs and writes that are not flushed; keep it for the forced exit after the time limit.
- Keep readiness in step: report not ready as soon as shutdown starts, where the service has a readiness check.
- Every resource a module opens has an owner that closes it. Tests close what they open, so the test runner ends without a forced exit.

## Configuration

- Read `process.env` in one place at start-up, check and convert the values there (numbers, booleans, URLs), and hand a typed, frozen object to the rest of the code. Use the configuration module the project has.
- A missing required value stops start-up. Do not fall back in silence to a development default in production.
- Secrets come from the environment or the project's secret store: never from the code, never into logs, error messages or responses.
- Do not change `process.env` or the working directory at runtime outside tests.

## Dependency boundaries

- Put a new package in the right group: `dependencies` for what runs in production, `devDependencies` for build and test tools. Change `package.json` and the lockfile together, with the package manager.
- Do not import a package the `package.json` of this package does not declare, even when a workspace or hoisting makes it resolvable.
- Keep the layers the project has: handlers do not reach around a service or repository module, and shared code does not import from an application.

## Logging

- Use the project's logger with its levels and structured fields. No `console.log` in service code where a logger exists.
- Log an error once, where it is handled, with the error object and the request or job id. Do not log and rethrow.
- Do not log secrets, tokens, full request bodies or personal data.

## Tests

- Use the test runner and helpers already in the repository (`node:test`, Vitest, Jest, Mocha). Do not add another.
- Test the failure paths too: a rejected call, a timeout, an aborted signal, a stream error, shutdown while work is in progress.
- No fixed sleeps: wait for the event or use the runner's fake timers. Listen on port `0` and read the port back. Do not depend on the wall clock, the network or test order.
- Reset what a test changes: environment variables, timers, listeners, servers, temporary files.
- Finish only when the project's own checks pass (tests, lint, type check where present). Report what you ran.
