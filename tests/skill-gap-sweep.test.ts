import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function setup(o: { authoring?: any; repos?: any[]; runs?: any[]; busy?: boolean; issues?: any[]; skills?: any[]; effects?: any; library?: any } = {}) {
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
    skills: () => o.skills ?? [],
    ...(o.effects ? { effects: o.effects } : {}),
    libraryNames: () => o.library ?? { names: [], digests: new Map(), qualify: (n: string) => n },
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
  return { sweeper, logs, created, saved, signIns: () => signIns, ledger: join(tmp, `ledger-${seq}.json`), store };
}

describe("improve issues (#777)", () => {
  const installed = { key: "src-demo-1@1.0.0", id: "src-demo-1", version: "1.0.0", digest: "sha256:aa", active: true, pkg: {}, trust: "approved" };
  const harms = { state: "ok", file: "x", record: { verdict: { verdict: "no-measurable-effect", with: { passed: 4, runs: 12 }, without: { passed: 4, runs: 12 } } } };
  const library = { names: ["demo"], digests: new Map(), qualify: (n: string) => `src-${n}-1` };
  it("opens one 'Improve skill' issue for a library skill without a verdict of help, and not again", async () => {
    const s = setup({ runs: [], skills: [installed], effects: () => harms, library });
    await s.sweeper.tick();
    expect(s.created).toHaveLength(1);
    expect(s.created[0].title).toBe("Improve skill demo");
    expect(s.created[0].labels).toEqual(["Factory_go"]);
    expect(s.created[0].body).toContain("`src-demo-1@1.0.0`");
    expect(s.created[0].body.trimEnd().split("\n").at(-1)).toBe("<!-- scf skill-improve=demo -->");
  });
  it("does not open a second issue while one is open", async () => {
    const open = { number: 9, state: "open", title: "t", html_url: "https://github.com/lib/skills/issues/9", created_at: new Date(NOW - 5 * DAY).toISOString(), labels: [], body: "<!-- scf skill-improve=demo -->" };
    const s = setup({ runs: [], skills: [installed], effects: () => harms, library, issues: [open] });
    await s.sweeper.tick();
    expect(s.created).toEqual([]);
  });
  it("opens nothing for a skill outside the library", async () => {
    const s = setup({ runs: [], skills: [{ ...installed, id: "other", key: "other@1.0.0" }], effects: () => harms, library });
    await s.sweeper.tick();
    expect(s.created).toEqual([]);
  });
  it("knows a skill published by skill-write from the ledger even without a selection, and keeps the name in the ledger file", async () => {
    const published = { runId: "w1", flow: "skill-write", status: "succeeded", startedAt: new Date(NOW - DAY).toISOString(), vars: { github_repo: "lib/skills" }, history: [{ id: "pick", output: "SKILL_NAME: demo" }, { id: "publish", output: "PUBLISHED: abcdef1234567" }] };
    const s = setup({ runs: [published], skills: [{ ...installed, id: "demo", key: "demo@1.0.0" }], effects: () => harms });
    await s.sweeper.tick();
    expect(s.created.map((c: any) => c.title)).toEqual(["Improve skill demo"]);
    expect(Object.keys(JSON.parse(readFileSync(s.ledger, "utf8")).library)).toEqual(["demo"]);
  });
});

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
