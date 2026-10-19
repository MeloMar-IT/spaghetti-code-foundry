import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../credentials/redact.js";
import { readPlainFile } from "./os-sandbox.js";

/** A step may write this file in the run folder: an object of short strings that ends up in `run.json` as `outputs`. */
export const OUTPUTS_FILE = "outputs.json";
const MAX_BYTES = 64 * 1024;
const MAX_KEYS = 20;
const MAX_VALUE = 2000;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Checks a set of outputs; returns the first problem, or undefined. */
function problem(values: unknown): string | undefined {
  if (!values || typeof values !== "object" || Array.isArray(values)) return "it is not an object";
  const entries = Object.entries(values);
  if (entries.length > MAX_KEYS) return `more than ${MAX_KEYS} keys`;
  for (const [k, v] of entries) {
    if (!KEY_RE.test(k)) return `the key "${k.slice(0, 40)}" is not a-z, 0-9 and _ (1–40 characters, starting with a letter)`;
    if (typeof v !== "string") return `the value of "${k}" is not a string`;
    if (v.length > MAX_VALUE) return `the value of "${k}" is longer than ${MAX_VALUE} characters`;
    if (CONTROL_RE.test(v)) return `the value of "${k}" has control characters`;
  }
  return undefined;
}

/** The outputs a step wrote (redacted), or undefined when there is no file or it is not valid (one log line says why). */
export function readRunOutputs(runDir: string, log?: (line: string) => void): Record<string, string> | undefined {
  const text = readPlainFile(join(runDir, OUTPUTS_FILE), MAX_BYTES);
  if (!text) return undefined;
  let values: unknown;
  try {
    values = JSON.parse(text);
  } catch {
    log?.(`  outputs.json ignored: it is not valid JSON (or longer than ${MAX_BYTES / 1024} KB)`);
    return undefined;
  }
  const bad = problem(values);
  if (bad) {
    log?.(`  outputs.json ignored: ${bad}`);
    return undefined;
  }
  return Object.fromEntries(Object.entries(values as Record<string, string>).map(([k, v]) => [k, redactText(v)]));
}

/** Adds values to the outputs file of a run (existing keys are kept); throws on a bad key or value. */
export function writeRunOutputs(runDir: string, values: Record<string, string>): void {
  const bad = problem(values);
  if (bad) throw new Error(`outputs: ${bad}`);
  const old = (() => {
    try {
      const o = JSON.parse(readPlainFile(join(runDir, OUTPUTS_FILE), MAX_BYTES));
      return problem(o) ? {} : (o as Record<string, string>);
    } catch {
      return {};
    }
  })();
  const merged = { ...old, ...values };
  const bad2 = problem(merged);
  if (bad2) throw new Error(`outputs: ${bad2}`);
  const file = join(runDir, OUTPUTS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, file);
}
