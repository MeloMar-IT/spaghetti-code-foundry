import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PREFIX = "UI_TEST_SEED ";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface Launched { seed: string; stop(): Promise<void> }

/** Starts one seeded server as a child process with `env` and resolves with its seed line and a teardown. */
async function launch(env: NodeJS.ProcessEnv): Promise<Launched> {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/browser/server.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(kill);
  };

  const seed = await new Promise<string>((resolve, reject) => {
    const fail = (msg: string) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail("the seeded server did not start within 60 seconds"), 60_000);
    child.once("exit", () => fail("the seeded server stopped before it was ready"));
    child.once("error", (e) => fail(`the seeded server could not be started: ${e.message}`));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.startsWith(PREFIX)) return;
      clearTimeout(timer);
      resolve(line.slice(PREFIX.length));
    });
  });
  return { seed, stop };
}

/**
 * Starts two seeded servers as child processes and publishes their seeds in UI_TEST_SEED (the default data) and
 * UI_TEST_SEED_LARGE (500 runs, a long log, a large diff; only the performance spec uses it). Returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const plain = { ...process.env };
  delete plain.UI_TEST_LARGE;
  const results = await Promise.allSettled([launch(plain), launch({ ...process.env, UI_TEST_LARGE: "1" })]);
  const started = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    await Promise.all(started.map((l) => l.stop()));
    throw failed.reason;
  }
  const [defaultOne, largeOne] = started;
  if (!defaultOne || !largeOne) throw new Error("the seeded servers did not start");
  process.env.UI_TEST_SEED = defaultOne.seed;
  process.env.UI_TEST_SEED_LARGE = largeOne.seed;

  return async () => {
    await Promise.all(started.map((l) => l.stop()));
  };
}
