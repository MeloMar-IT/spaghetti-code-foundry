#!/usr/bin/env node
// The test gate of agent steps. The folder of this file is first on the PATH of an agent step, with a small wrapper per
// command (npm, npx, pytest, …). A wrapper calls: _gate.mjs <name> [args…].
// A test command runs through tools/test-slot, so a test run an agent starts itself counts against the machine's test
// slots and runs at low priority, like the test steps of a flow. Every other command runs unchanged.
// Inside a slot (FACTORY_IN_TEST_SLOT is set, e.g. `npm test` calling `npx vitest`) nothing is gated again.
// `java` is gated too: a wrapper (./gradlew, ./mvnw) started by its path never looks up a command name, but it ends in
// `java` with the Gradle or Maven main class. The agent's JAVA_HOME points to a stand-in JDK (src/agents/java-gate.ts)
// whose bin/java calls this gate with `--real <real java>`, started by its real path. A `java` found on the PATH is not
// redirected: it keeps the PATH's own resolution.
// A Gradle test run gets -Dorg.gradle.priority=low (also inside a slot), so it never lands in a normal-priority daemon.
// Env: FACTORY_TEST_SLOTS_DIR (the slots folder; without it nothing is gated), FACTORY_AGENT_TEST_WAIT_SEC (longest wait
//      for a slot; default 300, then the tests run anyway), FACTORY_VAR_TEST_SLOTS (slots; see test-slot).
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(here, "..");

/** The runners and words that start tests. */
const JS_RUNNERS = /^(vitest|jest|mocha|ava|tap|playwright|karma|cypress)$/;
const SCRIPT_TEST = /^test(:|$)|^(e2e|unit|integration)(:|$)/;
const BUILD_TEST = /^(test|check|build|verify|integrationTest|connectedCheck|install)$/;

/** The mark file of a stand-in JDK folder; src/agents/java-gate.ts uses the same name (a test checks it). */
export const STAND_IN_MARK = "factory-java-stand-in";

const GRADLE_MAINS = new Set(["org.gradle.wrapper.GradleWrapperMain", "org.gradle.launcher.GradleMain"]);
const MAVEN_MAINS = new Set(["org.apache.maven.wrapper.MavenWrapperMain", "org.codehaus.plexus.classworlds.launcher.Launcher"]);
/** Java launcher options that take their value as the next argument. */
const JAVA_OPERAND_OPTS = new Set([
  "-cp", "-classpath", "--class-path", "-p", "--module-path", "--upgrade-module-path", "--add-modules", "--limit-modules",
  "--add-reads", "--add-exports", "--add-opens", "--patch-module", "--describe-module", "-d", "--enable-native-access", "--source",
]);

/**
 * The Gradle or Maven start of a `java` call: the tool and the index where its own arguments begin. The launcher options
 * are parsed up to the entry point, so a class name in the application's arguments or in a classpath does not count.
 * Undefined for any other program (also a module, a source file, an @argfile). Exported for the tests.
 */
export function javaLaunch(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-jar") return /^gradle-wrapper.*\.jar$/.test(basename(args[i + 1] ?? "")) ? { tool: "gradle", at: i + 2 } : undefined;
    if (a === "-m" || a === "--module" || a.startsWith("@")) return undefined;
    if (a.startsWith("-")) { if (JAVA_OPERAND_OPTS.has(a)) i++; continue; }
    if (GRADLE_MAINS.has(a)) return { tool: "gradle", at: i + 1 };
    if (MAVEN_MAINS.has(a)) return { tool: "mvn", at: i + 1 };
    return undefined;
  }
  return undefined;
}

/** The arguments a test command is started with: a Gradle run gets a low-priority daemon, unless the call sets a priority. */
export function gatedArgs(name, args) {
  let at = -1;
  if (name === "gradle") at = 0;
  else if (name === "java") { const l = javaLaunch(args); if (l?.tool === "gradle") at = l.at; }
  if (at < 0 || args.some((a) => a.startsWith("-Dorg.gradle.priority=") || a === "--priority" || a.startsWith("--priority="))) return args;
  return [...args.slice(0, at), "-Dorg.gradle.priority=low", ...args.slice(at)];
}

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
    case "java": {
      const l = javaLaunch(args);
      return !!l && isTestCommand(l.tool, args.slice(l.at));
    }
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
    if (existsSync(join(rd, "..", STAND_IN_MARK))) continue; // the bin/ of a stand-in JDK: it calls this gate
    const p = join(d, name);
    try {
      if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; }
    } catch { /* not here */ }
  }
  return undefined;
}

/**
 * The real java. A call through a stand-in JDK names its real java with `--real <path>` (first arguments of the gate);
 * a call through the PATH keeps the PATH's own resolution, so a java on the PATH is not swapped for the JAVA_HOME one.
 */
function realJava(viaStandIn) {
  if (viaStandIn) {
    try { accessSync(viaStandIn, constants.X_OK); return viaStandIn; } catch { /* fall back to the PATH */ }
  }
  return realCommand("java");
}

function run(cmd, args, env) {
  const child = spawn(cmd, args, { stdio: "inherit", env });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { child.kill(sig); });
  child.on("error", (e) => { console.error(`${args[0] ?? cmd}: ${e.message}`); process.exit(127); });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let rest = process.argv.slice(2);
  let standInJava;
  if (rest[0] === "--real") { standInJava = rest[1]; rest = rest.slice(2); }
  const [name, ...args] = rest;
  const real = name ? (name === "java" ? realJava(standInJava) : realCommand(name)) : undefined;
  if (!real) {
    console.error(`${name ?? "_gate"}: command not found`);
    process.exit(127);
  }
  const dir = process.env.FACTORY_TEST_SLOTS_DIR;
  if (!dir || !isTestCommand(name, args)) run(real, args, process.env);
  else if (process.env.FACTORY_IN_TEST_SLOT) run(real, gatedArgs(name, args), process.env); // no second slot, but the same daemon priority
  else {
    const wait = /^\d+$/.test(process.env.FACTORY_AGENT_TEST_WAIT_SEC ?? "") ? process.env.FACTORY_AGENT_TEST_WAIT_SEC : "300";
    run(process.execPath, [join(TOOLS, "test-slot"), dir, real, ...gatedArgs(name, args)],{ ...process.env, FACTORY_TEST_SLOT_WAIT_SEC: wait });
  }
}
