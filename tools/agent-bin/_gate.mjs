#!/usr/bin/env node
// The test gate of agent steps. The folder of this file is first on the PATH of an agent step, with a small wrapper per
// command (npm, npx, pytest, …). A wrapper calls: _gate.mjs <name> [args…].
// A test command runs through tools/test-slot, so a test run an agent starts itself counts against the machine's test
// slots and runs at low priority, like the test steps of a flow. Every other command runs unchanged.
// Inside a slot (FACTORY_IN_TEST_SLOT is set, e.g. `npm test` calling `npx vitest`) nothing is gated again.
// Env: FACTORY_TEST_SLOTS_DIR (the slots folder; without it nothing is gated), FACTORY_AGENT_TEST_WAIT_SEC (longest wait
//      for a slot; default 300, then the tests run anyway), FACTORY_VAR_TEST_SLOTS (slots; see test-slot).
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(here, "..");

/** The runners and words that start tests. */
const JS_RUNNERS = /^(vitest|jest|mocha|ava|tap|playwright|karma|cypress)$/;
const SCRIPT_TEST = /^test(:|$)|^(e2e|unit|integration)(:|$)/;
const BUILD_TEST = /^(test|check|build|verify|integrationTest|connectedCheck|install)$/;

/** True when `name args` starts a test run. Exported for the tests. */
export function isTestCommand(name, args) {
  const words = args.filter((a) => !a.startsWith("-"));
  const first = words[0] ?? "";
  switch (name) {
    case "npm": case "pnpm": case "yarn": case "bun":
      if (first === "test" || first === "t" || first === "tst") return true;
      if ((first === "run" || first === "run-script") && SCRIPT_TEST.test(words[1] ?? "")) return true;
      if (first === "exec" || first === "dlx" || first === "x") return JS_RUNNERS.test(words[1] ?? "");
      return name !== "npm" && SCRIPT_TEST.test(first); // `yarn test:unit`, `pnpm test`
    case "npx": case "bunx":
      return JS_RUNNERS.test(first);
    case "pytest": case "py.test":
      return true;
    case "python": case "python3": {
      const m = args.indexOf("-m");
      return m >= 0 && /^(pytest|unittest)$/.test(args[m + 1] ?? "");
    }
    case "gradle": case "mvn":
      return words.some((w) => BUILD_TEST.test(w.split(":").pop() ?? w));
    case "go": case "cargo":
      return first === "test";
    default:
      return false;
  }
}

/** The command `name` on the PATH, leaving out this folder. */
function realCommand(name) {
  let me;
  try { me = realpathSync(here); } catch { me = here; }
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    let rd;
    try { rd = realpathSync(d); } catch { continue; }
    if (rd === me) continue;
    const p = join(d, name);
    try {
      if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; }
    } catch { /* not here */ }
  }
  return undefined;
}

function run(cmd, args, env) {
  const child = spawn(cmd, args, { stdio: "inherit", env });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { child.kill(sig); });
  child.on("error", (e) => { console.error(`${args[0] ?? cmd}: ${e.message}`); process.exit(127); });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...args] = process.argv.slice(2);
  const real = name ? realCommand(name) : undefined;
  if (!real) {
    console.error(`${name ?? "_gate"}: command not found`);
    process.exit(127);
  }
  const dir = process.env.FACTORY_TEST_SLOTS_DIR;
  if (!dir || process.env.FACTORY_IN_TEST_SLOT || !isTestCommand(name, args)) run(real, args, process.env);
  else {
    const wait = /^\d+$/.test(process.env.FACTORY_AGENT_TEST_WAIT_SEC ?? "") ? process.env.FACTORY_AGENT_TEST_WAIT_SEC : "300";
    run(process.execPath, [join(TOOLS, "test-slot"), dir, real, ...args], { ...process.env, FACTORY_TEST_SLOT_WAIT_SEC: wait });
  }
}
