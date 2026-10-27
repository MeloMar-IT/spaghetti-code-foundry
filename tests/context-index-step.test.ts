import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/evidence/identity.js";
import { stepContextIndex, type StepContextIndexDeps } from "../src/engine/context-index.js";
import { boundAgentPrompt } from "../src/engine/untrusted.js";
import { contextSourceId } from "../src/context/uri.js";

const C1 = "a".repeat(40);
const T = "2026-01-31T12:00:00.000Z";
const RUN = "/runs/r1";
const ISSUE_TEXT = "# #12: Add a button\nISSUE-BODY";

function source(uri: string, more: Record<string, unknown> = {}) {
  const id = contextSourceId(uri);
  return {
    id,
    kind: uri.startsWith("repo:") ? "repository-file" : "issue",
    uri,
    revision: uri.startsWith("repo:") ? { commit: C1 } : { version: "v1" },
    content: { path: `context/${id}`, sha256: sha256Hex(uri), bytes: 10 },
    owners: [],
    classification: "internal",
    retrievedAt: "2026-01-31T11:59:00.000Z",
    freshness: { maxAgeSeconds: null },
    selection: { reason: uri.startsWith("repo:") ? "instructions" : "task" },
    consumers: ["planner", "coder"],
    ...more,
  };
}

const bundleText = (sources = [source("issue:12"), source("repo:a.md")]) =>
  JSON.stringify({
    version: 1,
    runId: "20260131-120000-abc",
    createdAt: T,
    repository: { repository: "acme/shop", commit: C1 },
    budget: { maxSources: 20, maxSourceBytes: 1000, maxTotalBytes: 10_000 },
    policies: [],
    sources,
    omitted: [],
  });

const record = (id: string, startedAt: string, more: Record<string, unknown> = {}) => ({ id, type: "shell", visit: 1, ok: true, output: "", startedAt, ...more }) as never;
const history = (startedAt = "2026-01-31T11:58:00.000Z") => [record("pull_ticket", startedAt)];

const PROMPT = "Plan it.\n\n{{context.index}}\n\nEnd.";
const run = (deps: StepContextIndexDeps, o: { prompt?: string; runDir?: string; hist?: any[]; role?: "reviewer" } = {}) =>
  stepContextIndex(
    {
      summary: { runDir: o.runDir ?? RUN, history: o.hist ?? history() },
      step: { prompt: o.prompt ?? PROMPT, ...(o.role ? { skill_role: o.role } : {}) },
      ctx: { task: "", steps: { pull_ticket: { ok: true, output: ISSUE_TEXT, error: "", visit: 1 } } },
    },
    { now: () => T, isFile: () => true, real: (p) => p, ...deps },
  );

const withBundle = (text: string): StepContextIndexDeps => ({ read: () => text });
const stepTypes = { pull_ticket: "shell" } as const;

describe("stepContextIndex", () => {
  it("returns a prompt without the placeholder unchanged and reads nothing", () => {
    let reads = 0;
    const r = run({ read: () => (reads++, undefined) }, { prompt: "Just {{steps.pull_ticket.output}}" });
    expect(r).toMatchObject({ prompt: "Just {{steps.pull_ticket.output}}" });
    expect(reads).toBe(0);
    expect((r as { log?: string }).log).toBeUndefined();
  });

  it("falls back to the pasted issue when there is no bundle, as today", () => {
    for (const p of ["{{context.index}}", "{{ context.index }}"]) {
      const prompt = `Plan it.\n\n${p}\n\nEnd.`;
      const r = run({ read: () => undefined }, { prompt });
      if ("refuse" in r) throw new Error(r.refuse);
      expect(r.readOnlyDirs).toBeUndefined();
      expect(r.log).toBe("· context: no context bundle; the prompt has the issue text");
      const bound = boundAgentPrompt({ prompt: r.prompt }, r.ctx, { stepTypes });
      const today = boundAgentPrompt({ prompt: "Plan it.\n\n{{steps.pull_ticket.output}}\n\nEnd." }, r.ctx, { stepTypes });
      expect(bound.prompt).toBe(today.prompt);
      expect(bound.prompt).toContain("ISSUE-BODY");
    }
  });

  it("falls back when the issue was fetched again after the bundle was made", () => {
    const r = run(withBundle(bundleText()), { hist: [...history(), record("pull_ticket", "2026-01-31T12:30:00.000Z")] });
    if ("refuse" in r) throw new Error(r.refuse);
    expect(r.prompt).toContain("{{steps.pull_ticket.output}}");
    expect(r.log).toMatch(/^! context: the issue was fetched again/);
  });

  it("does not fall back for a fetch before the bundle, or a nested or failed one", () => {
    const hist = [...history(), record("pull_ticket", "2026-01-31T12:30:00.000Z", { parent: "x" }), record("pull_ticket", "2026-01-31T12:30:00.000Z", { ok: false })];
    const r = run(withBundle(bundleText()), { hist });
    if ("refuse" in r) throw new Error(r.refuse);
    expect(r.prompt).toBe(PROMPT);
  });

  it("refuses an unusable bundle and never pastes the issue", () => {
    const bad = ["{}", JSON.stringify({ version: 2 }), "not json"];
    for (const text of bad) {
      const r = run(withBundle(text));
      expect(r).toHaveProperty("refuse");
      const line = (r as { refuse: string }).refuse;
      expect(line).toMatch(/^CONTEXT_UNUSABLE bundle-invalid \(\w[\w-]*\): .*; the step did not start$/);
      expect(line).not.toContain("steps.pull_ticket");
      expect(line).not.toContain("ISSUE-BODY");
    }
  });

  it("refuses a source that is not at context/<id>", () => {
    const s = source("issue:12");
    (s.content as { path: string }).path = "context/other";
    const r = run(withBundle(bundleText([s])));
    expect(r).toEqual({ refuse: "CONTEXT_UNUSABLE path: a source in the context bundle is not at context/<id>; the step did not start" });
  });

  it.each(["/runs/[x]", "/runs/a*b", "/runs/(x)"])("refuses a run folder path %s that a rule cannot name", (runDir) => {
    const r = run(withBundle(bundleText()), { runDir });
    expect(r).toHaveProperty("refuse");
    expect((r as { refuse: string }).refuse).toContain("CONTEXT_UNUSABLE run-path");
  });

  it("refuses, with code internal, when reading throws", () => {
    const r = run({
      read: () => {
        throw new Error("boom /secret/path");
      },
    });
    expect(r).toHaveProperty("refuse");
    expect((r as { refuse: string }).refuse).toMatch(/^CONTEXT_UNUSABLE internal: /);
    expect((r as { refuse: string }).refuse).not.toContain("/secret/path");
  });

  it("lists a source whose file is gone as missing and keeps the others", () => {
    const gone = contextSourceId("repo:a.md");
    const r = run({ ...withBundle(bundleText()), isFile: (p) => !p.endsWith(gone) });
    if ("refuse" in r) throw new Error(r.refuse);
    const text = (r.ctx.context as { index: string }).index;
    expect(text).toContain("repo:a.md | repository-file | missing:");
    expect(text).toContain(`${RUN}/context/${contextSourceId("issue:12")}`);
    expect(r.log).toBe("· context: 1 sources for coder, 1 left out");
  });

  it("sets the index, the read-only folder and its distinct real path, and uses the step's role", () => {
    const r = run({ ...withBundle(bundleText()), real: () => "/real/runs/r1/context" });
    if ("refuse" in r) throw new Error(r.refuse);
    expect(r.readOnlyDirs).toEqual([`${RUN}/context`, "/real/runs/r1/context"]);
    expect(r.log).toBe("· context: 2 sources for coder, 0 left out");
    expect((r.ctx.context as { index: string }).index).toContain("(role: coder)");
    const rev = run(withBundle(bundleText([source("issue:12", { consumers: ["coder"] })])), { role: "reviewer" });
    if ("refuse" in rev) throw new Error(rev.refuse);
    expect((rev.ctx.context as { index: string }).index).toContain("(role: reviewer)");
    expect(rev.log).toBe("· context: 0 sources for reviewer, 1 left out");
    expect(run(withBundle(bundleText())) as { readOnlyDirs: string[] }).toMatchObject({ readOnlyDirs: [`${RUN}/context`] });
  });

  it("renders inline in the prompt, with no data envelope", () => {
    const r = run(withBundle(bundleText()));
    if ("refuse" in r) throw new Error(r.refuse);
    const bound = boundAgentPrompt({ prompt: r.prompt }, r.ctx, { stepTypes });
    expect(bound.prompt).toContain("=== CONTEXT (role: coder) ===");
    expect(bound.prompt).not.toContain("<untrusted-data");
    expect(bound.items).toHaveLength(0);
  });
});
