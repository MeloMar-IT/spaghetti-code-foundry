import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PREFIX = "UI_TEST_SEED ";

/** Starts the seeded server as a child process, publishes its seed in UI_TEST_SEED, and returns the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", "tests/browser/server.ts"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

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
  process.env.UI_TEST_SEED = seed;

  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(kill);
  };
}
