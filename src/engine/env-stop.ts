// A shell step whose test environment could not be used (Docker did not start, container tests did not run, the tests hung)
// says so in a file. tools/test-env writes it to FACTORY_ENV_STOP_FILE. Each visit of a step has a file of its own, so steps
// that run side by side never read or remove each other's. When such a step fails, the run ends there: `on_failure` (the
// AI fix step) is not followed, because an agent cannot repair the machine.
import { closeSync, lstatSync, openSync, readSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { redactText } from "../credentials/redact.js";
import { safeSentence } from "../failure.js";

/** The file of the step visit that writes `logFile`. */
export const envStopFile = (runDir: string, logFile: string): string => join(runDir, `env-stop.${basename(logFile).replace(/\.log$/, "")}.txt`);

/** Removes what an earlier try left. Never throws. */
export function clearEnvStop(file: string): void {
  try {
    rmSync(file, { recursive: true, force: true });
  } catch {
    // an old reason is read only when the step fails
  }
}

/** The reason in the file (its first line with text, from the first 4 KB), safe to show; undefined when there is none. Never throws. */
export function readEnvStop(file: string): string | undefined {
  let fd: number | undefined;
  try {
    if (!lstatSync(file).isFile()) return undefined;
    fd = openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const text = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
    const line = text.split("\n").find((l) => l.trim());
    return line ? safeSentence(redactText(line.trim()), 300) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
