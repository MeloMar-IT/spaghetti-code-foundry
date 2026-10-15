import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { effectVerdict, type EffectRecord, type EffectRun, type EffectScenario } from "../../src/skills/effect.js";
import { effectsDir, writeEffectRecord } from "../../src/skills/evaluation-store.js";

// Effect records written directly for the promotion tests: no model is run. Six runs per arm give a clear verdict.
export type EffectKind = "helps" | "harms" | "no-effect";
const PASS: Record<EffectKind, [number, number]> = { helps: [6, 0], harms: [0, 6], "no-effect": [3, 3] };

const runs = (passed: number, loaded: boolean, prefix: string): EffectRun[] =>
  Array.from({ length: 6 }, (_, i) => ({ scenario: "a", attempt: i + 1, runId: `${prefix}-a-${i + 1}`, pass: i < passed, loaded, tokens: 100, durationMs: 1000 }));

export function effectRecord(skill: { id: string; version: string; digest: string }, kind: EffectKind, ranAt = "2026-10-15T10:00:00Z"): EffectRecord {
  const scenarios: EffectScenario[] = [{ id: "a", task: "Task a.", offered: true }];
  const [w, n] = PASS[kind];
  const withRuns = runs(w, true, "w");
  const withoutRuns = runs(n, false, "n");
  return {
    schema: 1,
    skill,
    suite: { digest: "sha256:" + "3".repeat(64), repeat: 6 },
    runtime: { foundry: "test", node: "v20.11.0", agent: "claude", model: "default" },
    ranAt,
    scenarios,
    runs: { with: withRuns, without: withoutRuns },
    verdict: effectVerdict({ scenarios, with: withRuns, without: withoutRuns }),
  };
}

/** Stores a record of the given kind for one skill digest. */
export function writeEffect(home: string, skill: { id: string; version: string; digest: string }, kind: EffectKind): void {
  writeEffectRecord(effectRecord(skill, kind), { home });
}

/** Makes the newest record of a skill unreadable (wrong file mode). */
export function breakEffect(home: string, id: string, digest: string): void {
  const dir = effectsDir(id, digest, home);
  const newest = readdirSync(dir).sort().at(-1)!;
  chmodSync(join(dir, newest), 0o644);
}
