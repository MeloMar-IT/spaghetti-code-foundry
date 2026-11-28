import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { recordRepair, resetRepairMemory, type RepairInput } from "../src/monitor/repair-log.js";
import { runDigest } from "../src/ops/cli.js";

// The "Automatic repairs" section of the daily digest. Unit tests: a temporary folder, no child process.

const NOW = new Date("2026-10-02T08:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

describe("automatic repairs in the digest", () => {
  let home: string;
  let file: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "digest-repairs-"));
    file = join(home, "monitor-repairs.jsonl");
    resetRepairMemory();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const repair = (key: string, over: Partial<RepairInput> = {}, hours = 1) =>
    recordRepair({ repair: "correct-labels", what: "label of #12 set to working to match its newest run", where: "acme/app", result: "done", key, ...over }, { file, now: ago(hours) });
  const digest = (runs: RunSummary[] = []) => runDigest({ runs, home, now: NOW });
  const section = (text: string) => (text.split("## Automatic repairs\n\n")[1]?.split("\n\n")[0] ?? "").split("\n").filter(Boolean);

  it("one repair gives exactly one line and nothing that waits for you", () => {
    repair("x");
    const d = digest();
    expect(section(d.text)).toEqual(["- label of #12 set to working to match its newest run (acme/app): done"]);
    expect(d.text).not.toContain("## Waits for you");
    expect(d.line).toContain("0 wait for you");
  });

  it("gives every entry of the last 24 hours its own line, also when there are many, and leaves older and asked ones out", () => {
    for (let i = 0; i < 60; i++) repair(`k${i}`);
    repair("old", { what: "too old" }, 25);
    const asked = { at: ago(1).toISOString(), repair: "bug-story", class: "ask", what: "asks first", where: "acme/app", result: "done", key: "a" };
    writeFileSync(file, JSON.stringify(asked) + "\n", { flag: "a" });
    const { text } = digest();
    expect(section(text)).toHaveLength(60);
    expect(text).not.toContain("too old");
    expect(text).not.toContain("asks first");
  });

  it("has no section, and does not fail, without a log or with a broken one", () => {
    expect(digest().text).not.toContain("Automatic repairs");
    writeFileSync(file, "\u0000garbage\n{\n42\n");
    const { text } = digest();
    expect(text).toContain("# Foundry digest");
    expect(text).not.toContain("Automatic repairs");
  });

  it("keeps the summary line of the retries after a time limit", () => {
    repair("r", { repair: "retry-after-time-limit", what: "retry 1 of 2 after a time limit in implement (issue #7)" });
    const run = {
      runId: "20261002-000000-aaaa", flow: "f", status: "succeeded", vars: { github_repo: "acme/app", issue: "7" }, history: [],
      startedAt: ago(2).toISOString(), finishedAt: ago(1).toISOString(),
      timeLimits: [{ at: ago(2).toISOString(), startedAt: ago(2).toISOString(), step: "implement", attempt: 1, of: 2 }],
    } as unknown as RunSummary;
    const { text } = digest([run]);
    expect(text).toContain("## Automatic retries after a time limit\n\n- 1 story, 1 retry: 1 finished");
    expect(section(text)).toHaveLength(1);
  });
});
