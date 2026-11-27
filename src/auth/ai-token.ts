import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Target } from "../agents/targets.js";
import { addItem, deleteItem, findItem, KeyError } from "../credentials/keychain.js";
import { hideValueSource } from "../credentials/redact.js";
import { TOKEN_MIN } from "../credentials/store.js";
import { inheritedEnv } from "../steps/process.js";
import { appendAuditLocked, type EventAction, prepareAuditLocked } from "./audit.js";
import { dataHome, withAuthLock, writeJsonFile } from "./store.js";

/**
 * The Foundry's Claude token in the macOS Keychain (`scf auth set-token`). Claude steps on `anthropic` get it when no
 * key variable is set. The value never goes into `process.env`, a file, the audit log, a log line or an error.
 */
export const AI_TOKEN_SERVICE = "spaghetti-code-foundry";
export const AI_TOKEN_ACCOUNT = "claude-oauth-token";
export const AI_TOKEN_MAX = 4096;
/** Any of these wins over the Keychain. */
export const AI_TOKEN_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export type AiTokenSource = "environment" | "keychain" | "none";
type Log = (message: string) => void;

/** The values this process has read or stored. Add-only until restart, so a replaced or removed token stays hidden. */
const seen = new Set<string>();

/** Registers the values with the redactor. The redactor never asks the Keychain itself. */
export function hideAiToken(): void {
  hideValueSource("ai-token", () => seen);
}

/** The file with the time the token was set. It holds no secret. */
export const aiTokenPath = () => join(dataHome(), "ai-token.json");

/** Throws when the text cannot be a token. The message never holds it. */
export function checkAiToken(value: string): void {
  if (value.length < TOKEN_MIN) throw new Error(`the token must be at least ${TOKEN_MIN} characters`);
  if (value.length > AI_TOKEN_MAX) throw new Error(`the token must be at most ${AI_TOKEN_MAX} characters`);
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error("the token must not hold spaces, line breaks or control characters");
}

/** The first of the three variables that is set (not empty). */
export function envAiTokenVar(env: NodeJS.ProcessEnv): string | undefined {
  return AI_TOKEN_VARS.find((name) => Boolean(env[name]));
}

/** When the token was set, if that is known. Never throws. */
export function aiTokenSetAt(): string | undefined {
  try {
    const { setAt } = JSON.parse(readFileSync(aiTokenPath(), "utf8")) as { setAt?: unknown };
    return typeof setAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(setAt) ? setAt : undefined;
  } catch {
    return undefined;
  }
}

function lookUp(log?: Log): { token?: string; unreadable?: true } {
  let value: string | undefined;
  try {
    value = findItem(AI_TOKEN_SERVICE, AI_TOKEN_ACCOUNT);
  } catch (e) {
    // no Keychain on this system: there is simply no token
    if (e instanceof KeyError && e.code === "unsupported") return {};
    log?.(`AI sign-in: the Keychain could not be read (${e instanceof KeyError ? e.message : "unexpected error"}); going on without it`);
    return { unreadable: true };
  }
  if (value === undefined) return {};
  try {
    checkAiToken(value);
  } catch {
    log?.("AI sign-in: the Keychain item is not valid; going on without it");
    return {};
  }
  seen.add(value);
  return { token: value };
}

/** The token of the Keychain, read now. Never throws: a problem is one line in `log`, and there is no token. */
export function readAiToken(log?: Log): string | undefined {
  return lookUp(log).token;
}

/** Where the sign-in comes from. `unreadable`: the Keychain could not be read, which counts as `none`. */
export function aiTokenSource(log?: Log): { source: AiTokenSource; setAt?: string; variable?: string; unreadable?: true } {
  const variable = envAiTokenVar(inheritedEnv());
  const setAt = aiTokenSetAt();
  const time = setAt !== undefined ? { setAt } : {};
  if (variable) return { source: "environment", variable, ...time };
  const found = lookUp(log);
  if (found.token !== undefined) return { source: "keychain", ...time };
  return { source: "none", ...(found.unreadable ? { unreadable: true as const } : {}) };
}

/** The line a server prints at its start: the source only. */
export function aiTokenStartLine(log?: Log): string {
  const { source } = aiTokenSource(log);
  return `AI sign-in: ${source === "none" ? "none" : `from the ${source}`}`;
}

/**
 * Gives a Claude step on `anthropic` the token, when the step would have none of the three variables. `short`: `env` is
 * the whole environment of the step; otherwise the step also inherits the server's.
 */
export function addAiToken(env: Record<string, string | undefined>, target: Pick<Target, "agent" | "provider">, short: boolean, log: Log): void {
  if (target.agent !== "claude" || target.provider.kind !== "anthropic") return;
  if (envAiTokenVar(short ? env : { ...inheritedEnv(), ...env })) return;
  const token = readAiToken(log);
  if (token !== undefined) env.CLAUDE_CODE_OAUTH_TOKEN = token;
}

const entry = (action: EventAction, result: "ok" | "failed") => ({ action, result, target: AI_TOKEN_ACCOUNT });

/** Removes the time file; false when that failed. */
function removeSetTime(): boolean {
  try {
    rmSync(aiTokenPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * One Keychain change with its audit line. The log is opened first, so a log that cannot be opened stops the change.
 * Once the Keychain has changed, the audit line and `after` are both tried, whatever the other does; `after` returns
 * what it could not do. Only inside withAuthLock.
 */
function audited<T>(by: string, action: EventAction, change: () => T, done: (result: T) => string, after: () => string[]): T {
  const audit = prepareAuditLocked(by, entry(action, "ok"));
  try {
    let result: T;
    try {
      result = change();
    } catch (e) {
      try {
        appendAuditLocked(by, entry(action, "failed"));
      } catch {
        // the Keychain error is the one to report
      }
      throw e;
    }
    const problems: string[] = [];
    try {
      audit.write();
    } catch {
      problems.push("the change is not in the audit log");
    }
    problems.push(...after());
    if (problems.length) throw new Error(`${done(result)}, but ${problems.join(", and ")}`);
    return result;
  } finally {
    audit.close();
  }
}

/** Stores the token in the Keychain, notes the time and writes the audit line. */
export function setAiToken(value: string, by = "cli"): void {
  checkAiToken(value);
  const store = () => {
    try {
      addItem(AI_TOKEN_SERVICE, AI_TOKEN_ACCOUNT, value);
    } catch (e) {
      // a bad read-back removes the item: then there is no time to keep
      try {
        if (findItem(AI_TOKEN_SERVICE, AI_TOKEN_ACCOUNT) === undefined) removeSetTime();
      } catch {
        // not known: the time stays
      }
      throw e;
    }
    seen.add(value);
  };
  const noteTime = () => {
    try {
      writeJsonFile(aiTokenPath(), { version: 1, setAt: new Date().toISOString() });
      return [];
    } catch {
      return [removeSetTime() ? "the time it was set was not saved" : "the time it was set was not saved (the old time file could not be removed, so status may show an old time)"];
    }
  };
  withAuthLock(() => audited(by, "ai-token-set", store, () => "the token was stored in the Keychain", noteTime));
}

/** Removes the token. Returns false when there was none. Running it again finishes a clean-up that failed. */
export function clearAiToken(by = "cli"): boolean {
  return withAuthLock(() =>
    audited(
      by,
      "ai-token-clear",
      () => deleteItem(AI_TOKEN_SERVICE, AI_TOKEN_ACCOUNT),
      (removed) => (removed ? "the token was removed from the Keychain" : "there was no token in the Keychain"),
      () => (removeSetTime() ? [] : ["the file with the time it was set could not be removed"]),
    ),
  );
}
