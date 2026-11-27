// The watchdog of `tools/test-env silence <command> [args…]`: a test run that prints nothing for too long is stopped and run
// once more; a second hang ends with exit 125 and a last line that starts with "test-silence: stopped". Output and exit
// code pass through. The command is meant to be tools/test-slot: it runs the tests in a process group of their own and
// names that group in FACTORY_TEST_SLOT_PGID_FILE. Time spent waiting for a test slot, or paused by the load governor,
// is not silence (the records in FACTORY_TEST_SLOT_WAIT_DIR). The second run starts only when every process of the first
// one that is known (the group, and the descendants seen with ps) is gone. A signal (the step is cancelled) ends it all.
// So does the loss of the parent process (checked twice a second): the watchdog never goes on without its caller.
// Env: FACTORY_VAR_TEST_SILENCE_MINUTES (0 to 720; default 20; 0 = off), FACTORY_TEST_SILENCE_SEC (seconds instead, for
//      tests), FACTORY_TEST_SILENCE_GRACE_MS (from SIGTERM to SIGKILL; 10000), FACTORY_TEST_SLOT_TRACK_MS (2000).
import { spawn } from "node:child_process";
import { fstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

const HUNG = 125;
const DEFAULT_MINUTES = 20;
const WAIT_FRESH_MS = 15_000;
const KILL_WAIT_MS = 5000;
/** After a cancel: the time the command has to end before it is killed. */
const CANCEL_GRACE_MS = 3000;
/** How often the watchdog looks whether its parent is still there. */
const PARENT_POLL_MS = 500;
/** Writing to the output of a parent that is gone. */
const PIPE_GONE = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

/** An output nobody reads must not end the watchdog before it has cleaned up. Any other error is thrown, as without a listener. */
export function ignoreClosedPipe(e) {
  if (!PIPE_GONE.has(e.code)) throw e;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/**
 * Calls `gone` once when the parent of this process goes away: the parent pid changed, or the first parent is no more.
 * A process that is already under pid 1 lost its parent before the watch began: `gone` is called at once.
 * Returns the function that ends the watch.
 */
export function watchParent(gone, everyMs = PARENT_POLL_MS, ppid = () => process.ppid) {
  const first = ppid();
  if (first <= 1) {
    gone();
    return () => {};
  }
  const timer = setInterval(() => {
    if (ppid() === first && pidAlive(first)) return;
    clearInterval(timer);
    gone();
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

const num = (v, d) => (/^\d+$/.test(v ?? "") ? Number(v) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => process.stdout.write(`\n${text}\n`);

function minutesSet() {
  const v = process.env.FACTORY_VAR_TEST_SILENCE_MINUTES ?? "";
  if (v === "") return DEFAULT_MINUTES;
  if (/^\d{1,3}$/.test(v) && Number(v) <= 720) return Number(v);
  console.log(`test-silence: test_silence_minutes is not a whole number from 0 to 720 — using ${DEFAULT_MINUTES}`);
  return DEFAULT_MINUTES;
}

/** The size of what was written, when stdout and stderr are files; undefined otherwise (their output is then piped). */
function fileSize() {
  try {
    const out = fstatSync(1);
    const err = fstatSync(2);
    return out.isFile() && err.isFile() ? `${out.size} ${err.size}` : undefined;
  } catch {
    return undefined;
  }
}

/** A test run that waits for a slot, or is paused: test-slot keeps its record fresh. */
function waiting(dir) {
  try {
    return readdirSync(dir).some((n) => {
      if (!n.endsWith(".wait")) return false;
      try {
        return Date.now() - statSync(join(dir, n)).mtimeMs <= WAIT_FRESH_MS;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/** One run of the command. Resolves to { code } or { hung: true, stuck } (stuck: a process of it is still there). */
async function once(cmd, args, env, o) {
  const piped = fileSize() === undefined;
  rmSync(o.pgidFile, { force: true });
  const child = spawn(cmd, args, { stdio: piped ? ["inherit", "pipe", "pipe"] : "inherit", env });
  let last = Date.now();
  if (piped) {
    for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      from.on("data", (d) => {
        last = Date.now();
        to.write(d);
      });
      from.on("error", () => {});
    }
  }
  let exit;
  const exited = new Promise((resolve) => {
    child.on("error", (e) => {
      console.error(`test-silence: cannot run ${cmd}: ${e.message}`);
      resolve((exit = 127));
    });
    child.on("exit", (code, signal) => resolve((exit = code ?? 128 + (constants.signals[signal] ?? 0))));
  });
  const closed = new Promise((resolve) => child.on("close", resolve));

  let tracker;
  if (o.pt && child.pid) {
    tracker = new o.pt.ProcessTracker(child.pid, { everyMs: num(process.env.FACTORY_TEST_SLOT_TRACK_MS, 2000) || 2000, tableAsync: () => o.pt.processTableAsync(2000) });
    tracker.start();
  }
  const group = () => {
    try {
      const n = Number(readFileSync(o.pgidFile, "utf8").trim());
      return Number.isSafeInteger(n) && n > 1 ? n : undefined;
    } catch {
      return undefined;
    }
  };

  /** Stops the whole tree: SIGTERM, then SIGKILL after `graceMs`. True when nothing known of it is left. */
  const stopTree = async (graceMs) => {
    if (tracker) await Promise.race([tracker.poll().catch(() => {}), sleep(1000)]);
    const pgid = group();
    const rows = () => tracker?.remembered() ?? [];
    const left = () => exit === undefined || (pgid !== undefined && groupAlive(pgid)) || (rows().length > 0 && o.pt.anyPidAlive(rows()));
    const signal = (sig) => {
      if (pgid !== undefined) {
        try {
          process.kill(-pgid, sig);
          if (sig === "SIGTERM") process.kill(-pgid, "SIGCONT"); // a paused group would never see the signal
        } catch { /* already gone */ }
      }
      if (rows().length) o.pt.signalRows(rows(), sig);
    };
    const until = async (ms) => {
      const from = Date.now();
      while (left() && Date.now() - from < ms) await sleep(50);
      return !left();
    };
    if (exit === undefined) child.kill("SIGTERM");
    signal("SIGTERM");
    if (await until(graceMs)) return true;
    if (tracker) await Promise.race([tracker.poll().catch(() => {}), sleep(1000)]);
    signal("SIGKILL");
    // the command itself gets a moment to free its slot before it is killed too
    if (await until(1000)) return true;
    if (exit === undefined) child.kill("SIGKILL");
    return until(KILL_WAIT_MS);
  };

  let cancelTimer;
  o.onCancel = (sig) => {
    if (exit === undefined) child.kill(sig);
    cancelTimer ??= setTimeout(() => void stopTree(0), CANCEL_GRACE_MS);
  };

  let size = fileSize();
  let hung;
  const silent = new Promise((resolve) => {
    if (o.limitMs <= 0) return;
    hung = setInterval(() => {
      const now = fileSize();
      if (now !== size || waiting(o.waitDir)) {
        size = now;
        last = Date.now();
      } else if (Date.now() - last >= o.limitMs && !o.cancelled) resolve("silent");
    }, Math.max(20, Math.min(1000, o.limitMs / 5)));
  });

  const first = await Promise.race([exited, silent]);
  clearInterval(hung);
  let result;
  if (first === "silent" && exit === undefined) {
    const gone = await stopTree(num(process.env.FACTORY_TEST_SILENCE_GRACE_MS, 10_000));
    result = { hung: true, stuck: !gone };
  } else {
    // cancelled: whatever of the tree is left goes too
    if (o.cancelled) await stopTree(CANCEL_GRACE_MS);
    result = { code: await exited };
  }
  clearTimeout(cancelTimer);
  tracker?.stop();
  o.onCancel = undefined;
  if (piped) {
    // a process left in the background may hold the pipe open: the output is not waited for longer than this
    let t;
    await Promise.race([closed, new Promise((r) => (t = setTimeout(r, 1000)))]);
    clearTimeout(t);
    child.stdout.destroy();
    child.stderr.destroy();
  }
  return result;
}

/** Runs the command under the watchdog and returns the exit code. */
export async function silence(cmd, args) {
  const minutes = minutesSet();
  const limitMs = minutes === 0 ? 0 : (num(process.env.FACTORY_TEST_SILENCE_SEC, 0) || minutes * 60) * 1000;
  const own = mkdtempSync(join(tmpdir(), "test-silence-"));
  const o = { limitMs, waitDir: process.env.FACTORY_TEST_SLOT_WAIT_DIR || own, pgidFile: join(own, "pgid"), cancelled: undefined, onCancel: undefined, pt: undefined };
  try {
    o.pt = await import(new URL("../dist/steps/proc-tree.js", import.meta.url).href);
  } catch (e) {
    console.error(`test-silence: cannot load the process tracker (${e.message})`);
  }
  const env = { ...process.env, FACTORY_TEST_SLOT_WAIT_DIR: o.waitDir, FACTORY_TEST_SLOT_PGID_FILE: o.pgidFile };
  delete env.FACTORY_ENV_STOP_FILE; // only the step's own tools may end the run
  const onSignal = (sig) => {
    o.cancelled ??= sig;
    o.onCancel?.(sig);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, onSignal);
  const outputs = [process.stdout, process.stderr];
  for (const s of outputs) s.on("error", ignoreClosedPipe);
  // SIGTERM, not SIGHUP: the same stop as a cancel, with SIGKILL after the grace time
  const unwatch = watchParent(() => onSignal("SIGTERM"));
  try {
    for (let attempt = 1; ; attempt++) {
      if (o.cancelled) return 128 + constants.signals[o.cancelled];
      const r = await once(cmd, args, env, o);
      if (o.cancelled) return r.code ?? 128 + constants.signals[o.cancelled];
      if (!r.hung) return r.code;
      if (r.stuck) {
        say(`test-silence: stopped — no output for ${minutes} min, and some processes of the tests could not be stopped`);
        return HUNG;
      }
      if (attempt === 2) {
        say(`test-silence: stopped — no output for ${minutes} min, twice`);
        return HUNG;
      }
      say(`test-silence: no output for ${minutes} min — the tests were stopped and run once more`);
    }
  } finally {
    unwatch();
    for (const s of signals) process.removeListener(s, onSignal);
    for (const s of outputs) s.removeListener("error", ignoreClosedPipe);
    rmSync(own, { recursive: true, force: true });
  }
}
