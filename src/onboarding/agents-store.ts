import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { YAMLParseError } from "yaml";
import { ZodError } from "zod";
import { authLockHeld, dataHome, readJsonFile, StoreError, withAuthLock } from "../auth/store.js";
import { CONFIG_PATH, ConfigIssuesError, configVersion, readConfigText, type Config } from "../config.js";
import { writeAtomic } from "../engine/policy-store.js";
import { releaseLock } from "../home-migrate.js";
import { jobDir } from "../ops/schedule.js";
import { applyAnswers, StoredAgentsSchema, type AgentAnswers, type AgentSettingKey, type StoredAgents } from "./agents.js";

/** `<data>/onboarding/agents.json`: the answers about Claude Code and Codex, and what they applied (#769). Mode 0600, in a 0700 folder. */
export const agentsFile = () => join(dataHome(), "onboarding", "agents.json");

/** The stored record; null when there is none. A broken file is a StoreError. A leftover `pending` is still in it: use `settle`. */
export function readAgentAnswers(): StoredAgents | null {
  return readJsonFile(agentsFile(), StoredAgentsSchema.nullable(), null);
}

/** Writes the record through a temp file and a rename. Only inside withAuthLock. */
export function writeAgentAnswersLocked(s: StoredAgents): void {
  if (!authLockHeld()) throw new Error("writeAgentAnswersLocked must run inside withAuthLock");
  const file = agentsFile();
  const dir = dirname(file);
  const fail = (e: unknown): never => {
    if (e instanceof StoreError) throw e;
    throw new StoreError("cannot-write", file, `cannot be written (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new StoreError("cannot-write", dir, "is not a folder");
    chmodSync(dir, 0o700);
    writeAtomic(file, JSON.stringify(s, null, 2) + "\n");
  } catch (e) {
    fail(e);
  }
}

/** What the usage limits helper knows, best effort: automation on, and the tools with a reading of at least 5% (the forecast needs more, see `scf limits`). Never throws. */
export function readLimitsStatus(): { auto: boolean; readings: ("claude" | "codex")[] } {
  try {
    const state = JSON.parse(readFileSync(join(jobDir("limits"), "state.json"), "utf8")) as { auto?: unknown; calibrations?: Record<string, { percent?: unknown } | undefined> };
    const readings = (["claude", "codex"] as const).filter((f) => typeof state.calibrations?.[f]?.percent === "number" && (state.calibrations[f]!.percent as number) >= 5);
    return { auto: state.auto === true, readings };
  } catch {
    return { auto: false, readings: [] };
  }
}

/** The settings changed since the sender loaded them. */
export class StaleConfigError extends Error {}
/** config.yaml is not valid, or the answers cannot be written into it. The message is safe to show. */
export class AgentsConfigError extends Error {}
/** config.yaml could not be written. */
export class ConfigWriteError extends Error {}
/** config.yaml could not be read. */
export class ConfigReadError extends Error {}

/** Why config.yaml cannot take the answers, safe to show: never the YAML parser's own words (they quote lines of the file). */
function configProblem(e: unknown): string {
  if (e instanceof ConfigIssuesError) return e.message;
  if (e instanceof YAMLParseError) return `config.yaml is not valid YAML${e.linePos?.[0] ? ` (line ${e.linePos[0].line})` : ""}; fix the file by hand`;
  if (e instanceof ZodError) return "the settings would not be valid";
  return e instanceof Error ? e.message : "the answers cannot be applied";
}

export interface AgentsIo {
  lock<T>(fn: () => T): T;
  readConfig(): string;
  writeConfig(text: string): void;
  writeStore(s: StoredAgents): void;
  /** Best effort, after a lock that failed to release. */
  release?(): void;
}

export const readConfigSafely = (): string => {
  try {
    return readConfigText();
  } catch (e) {
    throw new ConfigReadError(`config.yaml could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}); try again`);
  }
};

export const realIo: AgentsIo = {
  lock: (fn) => withAuthLock(fn),
  readConfig: readConfigSafely,
  writeConfig(text) {
    mkdirSync(dirname(CONFIG_PATH()), { recursive: true });
    writeAtomic(CONFIG_PATH(), text);
  },
  writeStore: writeAgentAnswersLocked,
  release() {
    releaseLock(join(dataHome(), "auth.lock"));
  },
};

export interface SaveResult {
  before: Config;
  config: Config;
  text: string;
  changed: AgentSettingKey[];
  kept: AgentSettingKey[];
  stored: StoredAgents;
  configWritten: boolean;
  warnings: ("store" | "unlock")[];
}

/**
 * Applies the answers. Inside the lock, with no await: the record is written with a `pending` entry first, then
 * config.yaml (atomically), then the final record. A crash or error at any point leaves a state `settle` reads right.
 * Errors: StaleConfigError, AgentsConfigError, StoreError, ConfigReadError, ConfigWriteError. A failure after config.yaml
 * was written (the final record, the unlock) is a warning, not an error: the save counts.
 */
export function saveAgentAnswers(i: { answers: AgentAnswers; replace: readonly AgentSettingKey[]; sentVersion?: string; now: Date; io?: AgentsIo }): SaveResult {
  const io = i.io ?? realIo;
  let result: SaveResult | undefined;
  const inLock = (): void => {
    const text = io.readConfig();
    if (typeof i.sentVersion === "string" && i.sentVersion !== configVersion(text)) throw new StaleConfigError("stale");
    const raw = readAgentAnswers();
    let applied: ReturnType<typeof applyAnswers>;
    try {
      applied = applyAnswers({ text, stored: raw, answers: i.answers, replace: i.replace, now: i.now });
    } catch (e) {
      throw new AgentsConfigError(configProblem(e), { cause: e });
    }
    const warnings: SaveResult["warnings"] = [];
    let configWritten = false;
    if (applied.text !== text) {
      const base = applied.settled ?? { version: 1 as const, answers: null, applied: {}, at: applied.record.at };
      io.writeStore({ ...base, pending: { answers: i.answers, applied: applied.record.applied, at: applied.record.at, to: configVersion(applied.text) } });
      try {
        io.writeConfig(applied.text);
      } catch (e) {
        // A known failure: the record goes back to what it was, so no later edit is read as this save.
        // If this write fails too, the pending entry stays and settles to "not written" (its version never matches).
        try {
          io.writeStore(base);
        } catch {
          // see above
        }
        throw new ConfigWriteError("config.yaml could not be written", { cause: e });
      }
      configWritten = true;
      try {
        io.writeStore(applied.record);
      } catch {
        warnings.push("store"); // `pending` settles forward the next time
      }
    } else if (!isDeepStrictEqual(raw, applied.record)) {
      io.writeStore(applied.record);
    }
    result = { before: applied.before, config: applied.config, text: applied.text, changed: applied.changed, kept: applied.kept, stored: applied.record, configWritten, warnings };
  };
  try {
    io.lock(inLock);
  } catch (e) {
    if (!result) throw e;
    result.warnings.push("unlock");
    try {
      io.release?.();
    } catch {
      // the lock stays; a later save waits for it like for any busy lock
    }
  }
  return result!;
}
