# Node.js review checks

Check the files of the change that run on Node.js, and the `package.json`, lockfile and entry point it touches. Leave browser-only files and framework or database rules to their own skills.

- Conventions: are the detected package manager and the existing scripts used, with one lockfile, no dependency the task did not ask for, and no API or syntax newer than the supported Node.js version?
- Modules: does each new file use the module system of its package (ESM or CommonJS)? Is `exports`, `main` or `bin` changed in a way that breaks consumers? Does an import start a server, a connection or a timer?
- Asynchronous failure paths: is every promise awaited, returned or caught? Do `async` listeners, timers and callbacks catch their own errors? Does every stream and `EventEmitter` have an `error` listener or run in `pipeline`? Is a callback called twice, or a rejection swallowed without a reason?
- Process handlers: do `unhandledRejection` and `uncaughtException` handlers log and exit, instead of keeping the process running?
- Blocking work: is there a `*Sync` call, heavy CPU work, unbounded `JSON` handling or a risky regular expression on a request or message path? Is concurrency bounded?
- Lifecycle: on `SIGTERM` and `SIGINT`, does the service stop taking work, finish work in progress within a time limit, and close servers, pools, clients, file handles and timers? Does `process.exit()` cut off pending writes? Does start-up fail fast on bad configuration?
- Resource cleanup: are timers cleared, listeners removed, streams destroyed and handles closed on every path, also on failure?
- Timeouts and cancellation: does each outbound call have a timeout, and is an existing `AbortSignal` passed on?
- Streams: is backpressure respected, and is input of unknown size limited instead of collected in memory?
- Configuration and logs: is `process.env` read and checked in one place? Can a secret reach a log, an error message or a response?
- Child processes: is a shell command built from input?
- Tests: do they cover a failure path (rejection, timeout, abort, shutdown), close what they open, and avoid fixed sleeps and fixed ports?
