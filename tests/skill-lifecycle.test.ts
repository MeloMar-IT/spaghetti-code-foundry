import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  effectiveLifecycle, lifecycleReasonProblem, lifecycleTransitionProblem, readSkillLifecycle, recordLifecycleTransition, recordRunAllowance,
  skillLifecyclePath, type SkillLifecycleStatus,
} from "../src/skills/lifecycle.js";

// Built at run time: a credential-looking literal in a test file stops the secret scan before a push.
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const K = "kafka@1.0.0";
const ADMIN = "11111111-1111-4111-8111-111111111111";

let home: string;
const saved = process.env.FACTORY_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lifecycle-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const file = () => skillLifecyclePath();
const bytes = () => readFileSync(file());
const set = (to: Parameters<typeof recordLifecycleTransition>[0]["to"], extra: Partial<Parameters<typeof recordLifecycleTransition>[0]> = {}) =>
  recordLifecycleTransition({ key: K, to, reason: "because", by: "cli", ...extra });
const line = (o: Record<string, unknown>) => JSON.stringify({ at: "2026-01-01T00:00:00.000Z", by: "cli", reason: "r", ...o });
const write = (...lines: string[]) => writeFileSync(file(), lines.join("\n") + "\n");
const t = (seq: number, from: string, to: string, key = K) => line({ type: "transition", seq, key, from, to });

describe("readSkillLifecycle", () => {
  it("reads a missing file as empty", () => {
    const r = readSkillLifecycle();
    expect(r).toMatchObject({ ok: true, lines: [], bytes: 0 });
    expect(r.ok && r.statuses.size).toBe(0);
  });

  it("fails closed, with a reason that holds no content or path", () => {
    const cases: Record<string, () => void> = {
      "invalid json": () => write(t(1, "active", "retired"), "{not json " + TOKEN),
      "unknown field": () => write(line({ type: "transition", seq: 1, key: K, from: "active", to: "retired", extra: 1 })),
      "seq gap": () => write(t(1, "active", "retired"), t(3, "retired", "deprecated")),
      "from mismatch": () => write(t(1, "active", "quarantined"), t(2, "active", "retired")),
      "revoked to active": () => write(t(1, "active", "revoked"), t(2, "revoked", "active")),
      "same state": () => write(t(1, "active", "retired"), t(2, "retired", "retired")),
      "allowance without quarantine": () => write(line({ type: "allow-run", seq: 1, key: K, runId: "run-1" })),
      "replacement on active": () => write(t(1, "active", "retired"), line({ type: "transition", seq: 2, key: K, from: "retired", to: "active", replacement: "a@1.0.0" })),
      "replacement is the key": () => write(line({ type: "transition", seq: 1, key: K, from: "active", to: "retired", replacement: K })),
      "bad utf-8": () => writeFileSync(file(), Buffer.from([0xff, 0xfe, 0x0a])),
      "symlink": () => {
        writeFileSync(join(home, "elsewhere"), t(1, "active", "retired") + "\n");
        symlinkSync(join(home, "elsewhere"), file());
      },
    };
    for (const [name, make] of Object.entries(cases)) {
      rmSync(file(), { force: true });
      make();
      const r = readSkillLifecycle();
      expect(r.ok, name).toBe(false);
      const reason = r.ok ? "" : r.reason;
      expect(reason, name).not.toContain(TOKEN);
      expect(reason, name).not.toContain(home);
      expect(reason, name).not.toContain("kafka");
    }
    rmSync(file(), { force: true });
    write(t(1, "active", "retired"), "oops");
    expect(readSkillLifecycle()).toEqual({ ok: false, reason: "has a line that is not valid (line 2)" });
  });

  it("refuses a file over the size limit", () => {
    write(t(1, "active", "retired"));
    const r = readSkillLifecycle(home, 10);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain("larger than 10 bytes");
  });
});

describe("recordLifecycleTransition", () => {
  it("appends one line per change with seq 1, 2, … and leaves the earlier bytes alone", () => {
    const a = set("deprecated", { by: ADMIN });
    expect(a).toMatchObject({ status: "ok", line: { seq: 1, from: "active", to: "deprecated", by: ADMIN } });
    const first = bytes();
    expect(first.toString().split("\n").filter(Boolean)).toHaveLength(1);
    expect(set("quarantined", { replacement: "kafka@2.0.0" })).toMatchObject({ status: "ok", line: { seq: 2, from: "deprecated" } });
    expect(bytes().subarray(0, first.length).equals(first)).toBe(true);
    expect(bytes().toString().split("\n").filter(Boolean)).toHaveLength(2);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("folds to the newest state, and allowances belong to the current quarantine only", () => {
    set("quarantined");
    expect(recordRunAllowance({ key: K, runId: "run-1", reason: "ok", by: "cli" })).toMatchObject({ status: "ok", added: true });
    let r = readSkillLifecycle();
    expect(r.ok && r.statuses.get(K)).toMatchObject({ state: "quarantined", allowedRuns: [{ runId: "run-1", seq: 2 }] });
    set("active");
    set("quarantined");
    r = readSkillLifecycle();
    expect(r.ok && r.statuses.get(K)).toMatchObject({ state: "quarantined", seq: 4, allowedRuns: [] });
  });

  it("refuses what the rules do not allow", () => {
    expect(set("active")).toMatchObject({ status: "bad-transition" });
    set("retired");
    expect(set("retired")).toMatchObject({ status: "bad-transition" });
    set("revoked");
    expect(set("active")).toMatchObject({ status: "bad-transition" });
    expect(set("quarantined")).toMatchObject({ status: "bad-transition" });
    const before = bytes();
    expect(set("deprecated", { key: "other@1.0.0", replacement: "other@1.0.0" })).toMatchObject({ status: "bad-input" });
    expect(set("active", { key: "other@1.0.0", replacement: "x@1.0.0" })).toMatchObject({ status: "bad-input" });
    expect(set("deprecated", { key: "nokey" })).toMatchObject({ status: "bad-input" });
    expect(set("deprecated", { key: "other@1.0.0", by: "someone" })).toMatchObject({ status: "bad-input" });
    expect(bytes().equals(before)).toBe(true);
  });

  it("refuses bad reasons", () => {
    for (const reason of ["", "x".repeat(201), " padded", "tab\there", "line\nbreak", TOKEN]) {
      expect(set("deprecated", { reason }), JSON.stringify(reason.slice(0, 20))).toMatchObject({ status: "bad-input" });
    }
    expect(lifecycleReasonProblem("x".repeat(200))).toBeUndefined();
    expect(lifecycleReasonProblem(TOKEN)).not.toContain(TOKEN);
  });

  it("refuses to write over a record that cannot be read", () => {
    write("oops");
    expect(set("retired")).toMatchObject({ status: "unreadable" });
    expect(readFileSync(file(), "utf8")).toBe("oops\n");
  });

  it("checks the transition rules in one place", () => {
    expect(lifecycleTransitionProblem("active", "retired")).toBeUndefined();
    expect(lifecycleTransitionProblem("retired", "retired")).toBeDefined();
    expect(lifecycleTransitionProblem("revoked", "active")).toBeDefined();
  });
});

describe("recordRunAllowance", () => {
  it("is refused when the version is not quarantined, and twice is a no-op", () => {
    expect(recordRunAllowance({ key: K, runId: "run-1", reason: "ok", by: "cli" })).toMatchObject({ status: "not-quarantined" });
    set("deprecated");
    expect(recordRunAllowance({ key: K, runId: "run-1", reason: "ok", by: "cli" })).toMatchObject({ status: "not-quarantined" });
    set("quarantined");
    const a = recordRunAllowance({ key: K, runId: "run-1", reason: "ok", by: "cli" });
    const before = bytes();
    const b = recordRunAllowance({ key: K, runId: "run-1", reason: "again", by: "cli" });
    expect(a).toMatchObject({ status: "ok", added: true });
    expect(b).toMatchObject({ status: "ok", added: false, line: { seq: 3 } });
    expect(bytes().equals(before)).toBe(true);
    expect(recordRunAllowance({ key: K, runId: "bad id!", reason: "ok", by: "cli" })).toMatchObject({ status: "bad-input" });
  });
});

describe("the size check", () => {
  it("writes up to the limit exactly and refuses one byte more, leaving a record that reads", () => {
    const probe = set("quarantined");
    if (probe.status !== "ok") throw new Error("setup");
    const size = bytes().length;
    rmSync(file());
    // exactly at the limit
    expect(set("quarantined", { maxBytes: size })).toMatchObject({ status: "ok" });
    expect(bytes().length).toBe(size);
    rmSync(file());
    // one byte over
    const over = set("quarantined", { maxBytes: size - 1 });
    expect(over).toMatchObject({ status: "full" });
    expect(over.status === "full" && over.reason).toContain("every skill version counts as active again");
    expect(over.status === "full" && over.reason).not.toContain("archive");

    // allowance: at the limit, then one byte over
    set("quarantined");
    const base = bytes().length;
    const allow = (maxBytes: number) => recordRunAllowance({ key: K, runId: "run-1", reason: "ok", by: "cli", maxBytes });
    const text = JSON.stringify({ type: "allow-run", seq: 2, key: K, runId: "run-1", at: "2026-01-01T00:00:00.000Z", by: "cli", reason: "ok" });
    const need = base + Buffer.byteLength(text) + 1;
    const before = bytes();
    expect(allow(need - 1)).toMatchObject({ status: "full" });
    expect(bytes().equals(before)).toBe(true);
    expect(readSkillLifecycle().ok).toBe(true);
    expect(allow(need)).toMatchObject({ status: "ok" });
    expect(bytes().length).toBe(need);
    expect(readSkillLifecycle(home, need).ok).toBe(true);
  });

  it("counts the newline that ends a cut-off last line", () => {
    write(t(1, "active", "retired", "a@1.0.0"));
    writeFileSync(file(), readFileSync(file(), "utf8").trimEnd());
    const size = bytes().length;
    const next = JSON.stringify({ type: "transition", seq: 2, key: K, from: "active", to: "retired", at: "2026-01-01T00:00:00.000Z", by: "cli", reason: "because" });
    const need = size + 1 + Buffer.byteLength(next) + 1;
    expect(set("retired", { maxBytes: need - 1 })).toMatchObject({ status: "full" });
    expect(set("retired", { maxBytes: need })).toMatchObject({ status: "ok" });
    expect(readSkillLifecycle().ok).toBe(true);
    appendFileSync(file(), "");
  });
});

describe("effectiveLifecycle", () => {
  const local: SkillLifecycleStatus = {
    state: "quarantined", seq: 4, since: "2026-01-01T00:00:00.000Z", by: "cli", reason: "local", replacement: "kafka@2.0.0",
    allowedRuns: [{ seq: 5, runId: "run-1", at: "2026-01-02T00:00:00.000Z", by: "cli", reason: "ok" }],
  };
  it("lets a release revocation win over a local state, keeping only the local replacement", () => {
    const reg = { lifecycle: new Map([[K, local]]), revoked: new Map([[K, { by: "acme@1.0.0", on: "2026-03-04", reason: "bad" }]]) };
    expect(effectiveLifecycle(reg, K)).toEqual({
      state: "revoked", seq: 4, since: "2026-03-04", by: "acme@1.0.0", reason: "bad", replacement: "kafka@2.0.0", allowedRuns: [], release: "acme@1.0.0",
    });
  });
  it("gives the local state, and nothing for active or unknown keys", () => {
    expect(effectiveLifecycle({ lifecycle: new Map([[K, local]]) }, K)).toBe(local);
    expect(effectiveLifecycle({ lifecycle: new Map([[K, { ...local, state: "active" }]]) }, K)).toBeUndefined();
    expect(effectiveLifecycle({}, K)).toBeUndefined();
  });
});
