// The check at the end of the suite: it fails the run when a process the tests started is still alive, lists it and kills
// it. The suite's processes are followed while it runs, so one that lost its parents is still known. It also knows the
// stubborn fixtures by this run's tag. Processes of another run on this machine are never touched.
import { randomBytes } from "node:crypto";
import type { TestProject } from "vitest/node";
import { formatStrays, listWithRetry, Owned, processRows, processRowsAsync, strayRows } from "./helpers/stray-procs.js";

declare module "vitest" {
  interface ProvidedContext {
    strayTag: string;
  }
}

const POLL_MS = 500;
/** How long processes get to go away after the last test. */
const SETTLE_MS = 5000;

export default function setup(project: TestProject): (() => Promise<void>) | undefined {
  const tag = `scf-stray-${randomBytes(6).toString("hex")}`;
  project.provide("strayTag", tag);
  if (process.platform === "win32") return undefined;
  const owned = new Owned(process.pid);
  let polling = false;
  let ended = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    const rows = await processRowsAsync();
    if (rows && !ended) owned.fold(rows);
    polling = false;
  }, POLL_MS);
  timer.unref();

  return async () => {
    ended = true;
    clearInterval(timer);
    const look = async () => {
      const rows = await listWithRetry(processRows);
      owned.fold(rows);
      return strayRows(rows, { tag, owned, self: process.pid });
    };
    const until = Date.now() + SETTLE_MS;
    let strays = await look();
    while (strays.length && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      strays = await look();
    }
    if (!strays.length) return;
    const text = `${strays.length} processes started by the tests were still running:\n${formatStrays(strays)}`;
    console.error(text);
    for (const r of strays) {
      try {
        process.kill(r.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    process.exitCode = 1;
    throw new Error(text);
  };
}
