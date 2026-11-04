import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { skillGapSweeper, GAP_NOT_LIBRARY, GAP_NO_SIGN_IN } from "../src/server/skill-gap-sweep.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOW = Date.parse("2026-11-04T12:00:00Z");
const DAY = 86_400_000;
const tmp = mkdtempSync(join(tmpdir(), "gap-sweep-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

const cfg = (authoring: Record<string, unknown>) => ConfigSchema.parse({ skills: { authoring } });
const record = (o: any = {}): any => ({ id: "rec1", owner: "", url: "https://github.com/lib/skills", settings: { kind: "skill-library" }, ...o });
const stoppedRun = (id = "r1"): any => ({
  runId: id, status: "stopped", reason: 'step "plan_check" failed: skills not resolved', vars: { github_repo: "acme/app" },
  startedAt: new Date(NOW - DAY).toISOString(), history: [],
  skillPlan: { action: "stop", reason: "skills not resolved: rust-async is unknown", unresolved: [{ id: "rust-async", code: "unknown", mandatory: false }] },
});

function setup(o: { authoring?: any; repos?: any[]; runs?: any[]; busy?: boolean; issues?: any[] } = {}) {
  const logs: string[] = [];
  const created: any[] = [];
  const saved: any[] = [];
  const store: any = {
    listAll: async () => ({ issues: o.issues ?? [], cut: false }),
    createLabelIfMissing: async () => {},
    create: async (x: any) => { created.push(x); return { number: 50 + created.length, html_url: `https://github.com/lib/skills/issues/${50 + created.length}` }; },
  };
  let signIns = 0;
  const runs = o.runs ?? [stoppedRun()];
  const sweeper = skillGapSweeper({
    config: () => cfg(o.authoring ?? { repository: "lib/skills" }) as any,
    runs: () => runs,
    skills: () => [],
    repos: () => o.repos ?? [record()],
    signIn: async () => { signIns++; return { run: (fn) => fn(), dispose() {} }; },
    store: () => store,
    isBusy: () => o.busy === true,
    load: (id) => structuredClone(runs.find((r) => r.runId === id)),
    save: (r) => void saved.push(r),
    log: (l) => void logs.push(l),
    now: () => NOW,
    ledgerFile: join(tmp, `ledger-${++seq}.json`),
  });
  return { sweeper, logs, created, saved, signIns: () => signIns };
}

describe("skill gap sweeper", () => {
  it("makes no call when off", async () => {
    const s = setup({ authoring: { repository: "" } });
    await s.sweeper.tick();
    expect(s.signIns()).toBe(0);
    expect(s.created).toEqual([]);
    expect(s.logs).toEqual([]);
  });
  it("logs once when the repository is not a skill library", async () => {
    const s = setup({ repos: [record({ settings: {} })] });
    await s.sweeper.tick();
    await s.sweeper.tick();
    expect(s.logs).toEqual([`skill-gaps: ${GAP_NOT_LIBRARY}`]);
    expect(s.signIns()).toBe(0);
    expect(s.created).toEqual([]);
  });
  it("opens nothing for a record owned by a user account", async () => {
    const s = setup({ repos: [record({ owner: "some-user" })] });
    await s.sweeper.tick();
    expect(s.logs).toEqual([`skill-gaps: ${GAP_NO_SIGN_IN}`]);
    expect(s.created).toEqual([]);
  });
  it("opens the issue and links the stopped run once", async () => {
    const s = setup();
    await s.sweeper.tick();
    expect(s.created).toHaveLength(1);
    expect(s.created[0].title).toBe("Skill gap: rust-async");
    expect(s.created[0].labels).toEqual(["Factory_go"]);
    expect(s.saved).toHaveLength(1);
    const r = s.saved[0];
    expect(r.skillGap).toEqual([{ topic: "rust-async", issue: 51, url: "https://github.com/lib/skills/issues/51" }]);
    expect(r.reason).toContain("Skill gap issue: https://github.com/lib/skills/issues/51");
    expect(r.skillPlan.reason).toContain("Skill gap issue: ");
    expect(s.logs.join("\n")).not.toMatch(/acme|lib\/skills|\/tmp/);
  });
  it("does not change a busy run", async () => {
    const s = setup({ busy: true });
    await s.sweeper.tick();
    expect(s.created).toHaveLength(1);
    expect(s.saved).toEqual([]);
  });
  it("opens a new issue (no reopen) when the old one was closed over 30 days ago", async () => {
    const issue = { number: 7, state: "closed", title: "t", html_url: "https://github.com/lib/skills/issues/7", created_at: new Date(NOW - 90 * DAY).toISOString(), closed_at: new Date(NOW - 40 * DAY).toISOString(), labels: [], body: "<!-- scf skill-gap=rust-async -->" };
    const s = setup({ issues: [issue] });
    await s.sweeper.tick();
    // closed over 30 days ago: a new issue is opened, never a reopen
    expect(s.created).toHaveLength(1);
    expect(s.saved[0].skillGap[0].issue).toBe(51);
  });
});
