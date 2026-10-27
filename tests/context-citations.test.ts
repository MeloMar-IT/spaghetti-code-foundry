import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planCitations } from "../src/context/citations.js";
import { contextSourceId } from "../src/context/uri.js";
import { sha256Hex } from "../src/evidence/identity.js";
import { stepContextUncited } from "../src/engine/context-index.js";
import { parseFlow } from "../src/flow/load.js";

const A = contextSourceId("issue:12");
const B = contextSourceId("repo:a.md");
const X = contextSourceId("repo:other.md");
const known = new Set([A, B]);

const plan = (req: string, con: string, acc: string) => `## Goal\nx\n## Requirements\n${req}\n## Constraints\n${con}\n## Acceptance criteria\n${acc}\n## Design\nd\n`;
const cite = (...ids: string[]) => `- thing [source: ${ids.join(", ")}]`;

describe("planCitations", () => {
  it("counts no uncited section when all three cite a known id, in order of first appearance", () => {
    const r = planCitations(plan(cite(B, A), cite(A), cite(B, B)), known);
    expect(r.uncited).toBe(0);
    expect(r.sections.map((s) => s.name)).toEqual(["requirements", "constraints", "acceptance-criteria"]);
    expect(r.sections[0]).toMatchObject({ present: true, cited: [B, A], unknown: [] });
    expect(r.sections[2]!.cited).toEqual([B]);
  });

  it("counts a section without citations", () => {
    const r = planCitations(plan(cite(A), "- none", cite(A)), known);
    expect(r.uncited).toBe(1);
    expect(r.sections[1]).toMatchObject({ present: true, cited: [] });
  });

  it("does not count unknown ids, but a mix with a known id counts", () => {
    const r = planCitations(plan(cite(X), cite(X, A), cite(A)), known);
    expect(r.sections[0]).toMatchObject({ cited: [], unknown: [X] });
    expect(r.sections[1]).toMatchObject({ cited: [A], unknown: [X] });
    expect(r.uncited).toBe(1);
  });

  it("counts a missing section", () => {
    const r = planCitations(`## Requirements\n${cite(A)}\n## Acceptance criteria\n${cite(A)}\n`, known);
    expect(r.sections[1]).toMatchObject({ present: false, cited: [] });
    expect(r.uncited).toBe(1);
  });

  it("reads several ids in one bracket, with extra spaces, once each", () => {
    const r = planCitations(`## Requirements\n- a [source:   ${A} ,${B},  ${A}]\n- b [source: ${B}]\n`, known);
    expect(r.sections[0]!.cited).toEqual([A, B]);
  });

  it("accepts other heading levels and case, a trailing colon or text", () => {
    const text = `### REQUIREMENTS\n${cite(A)}\n# acceptance criteria:\n${cite(B)}\n## Constraints — what holds\n${cite(A)}\n`;
    expect(planCitations(text, known).uncited).toBe(0);
    expect(planCitations(`## Requirementsx\n${cite(A)}\n`, known).sections[0]!.present).toBe(false);
  });

  it("keeps sub-headings inside the section and ends it at the next heading of the same level", () => {
    const sub = planCitations(`## Requirements\n### Detail\n${cite(A)}\n## Design\n`, known);
    expect(sub.sections[0]!.cited).toEqual([A]);
    const after = planCitations(`## Requirements\n- none\n## Design\n${cite(A)}\n`, known);
    expect(after.sections[0]!.cited).toEqual([]);
  });

  it("ignores headings and citations inside code fences", () => {
    const text = "```\n## Requirements\n" + cite(A) + "\n```\n## Constraints\n" + cite(A) + "\n";
    const r = planCitations(text, known);
    expect(r.sections[0]!.present).toBe(false);
    expect(r.sections[1]!.cited).toEqual([A]);
  });

  it("keeps a longer fence open over a nested shorter one, and closes it only with a fence of its own length", () => {
    // The inner ``` lines are part of the four-backtick example; the heading and citation inside it must not count.
    const text = "````\n```\n## Requirements\n" + cite(A) + "\n```\n````\n## Constraints\n" + cite(A) + "\n";
    const r = planCitations(text, known);
    expect(r.sections[0]!.present).toBe(false);
    expect(r.sections[1]).toMatchObject({ present: true, cited: [A] });
    // a closing fence with other text after it does not close the block
    const open = planCitations("```\n````x\n## Requirements\n" + cite(A) + "\n```\n", known);
    expect(open.sections[0]!.present).toBe(false);
  });

  it("ignores malformed ids and accepts any case of the word source", () => {
    const bad = ["s-XYZ", A.toUpperCase().replace("S-", "s-"), A.slice(0, -1)];
    const r = planCitations(`## Requirements\n- a [source: ${bad.join(", ")}]\n- b [SOURCE: ${A}]\n`, known);
    expect(r.sections[0]).toMatchObject({ cited: [A], unknown: [] });
  });

  it("counts 3 for empty output and for an empty known set", () => {
    expect(planCitations("", known).uncited).toBe(3);
    expect(planCitations(plan(cite(A), cite(A), cite(A)), new Set()).uncited).toBe(3);
  });
});

const T = "2026-01-31T12:00:00.000Z";
function source(uri: string, consumers: string[] = ["planner", "coder"]) {
  const id = contextSourceId(uri);
  return {
    id,
    kind: uri.startsWith("repo:") ? "repository-file" : "issue",
    uri,
    revision: uri.startsWith("repo:") ? { commit: "a".repeat(40) } : { version: "v1" },
    content: { path: `context/${id}`, sha256: sha256Hex(uri), bytes: 10 },
    owners: [],
    classification: "internal",
    retrievedAt: "2026-01-31T11:59:00.000Z",
    freshness: { maxAgeSeconds: null },
    selection: { reason: uri.startsWith("repo:") ? "instructions" : "task" },
    consumers,
  };
}
const bundle = (sources: unknown[]) =>
  JSON.stringify({
    version: 1,
    runId: "20260131-120000-abc",
    createdAt: T,
    repository: { repository: "acme/shop", commit: "a".repeat(40) },
    budget: { maxSources: 20, maxSourceBytes: 1000, maxTotalBytes: 10_000 },
    policies: [],
    sources,
    omitted: [],
  });

describe("stepContextUncited", () => {
  const text = bundle([source("issue:12"), source("repo:a.md", ["reviewer"])]);
  const READY = "PLAN_STATUS: READY";
  const cited = `${plan(cite(A), cite(A), cite(A))}\n${READY}\n`;
  const run = (o: { output?: string | undefined; topLevel?: boolean; step?: Record<string, unknown>; read?: (p: string) => string | undefined } = {}) =>
    stepContextUncited(
      {
        summary: { runDir: "/runs/r1" },
        step: { id: "plan", type: "claude", prompt: "Plan.\n{{context.index}}", ...o.step } as never,
        topLevel: o.topLevel ?? true,
        output: "output" in o ? o.output : cited,
      },
      { read: o.read ?? (() => text) },
    );

  it("gives 0 for a fully cited READY plan and 3 for one without citations", () => {
    expect(run()).toBe(0);
    expect(run({ output: `${plan("- a", "- b", "- c")}\n${READY}\n` })).toBe(3);
  });

  it("counts only sources the role may consume", () => {
    const only = plan(cite(B), cite(B), cite(B)) + `\n${READY}\n`;
    expect(run({ output: only })).toBe(3);
    expect(run({ output: only, step: { skill_role: "reviewer" } })).toBe(0);
  });

  it("gives no fact in the other cases", () => {
    expect(run({ topLevel: false })).toBeUndefined();
    expect(run({ step: { type: "shell", run: "x", prompt: undefined } })).toBeUndefined();
    expect(run({ step: { prompt: "No placeholder" } })).toBeUndefined();
    expect(run({ output: cited.replace(READY, "PLAN_STATUS: NEEDS_INFO") })).toBeUndefined();
    expect(run({ output: cited.replace(READY, `see ${READY} here`) })).toBeUndefined();
    expect(run({ output: undefined })).toBeUndefined();
    expect(run({ read: () => undefined })).toBeUndefined();
    expect(run({ read: () => "{}" })).toBeUndefined();
    expect(run({ read: () => "not json" })).toBeUndefined();
    expect(run({ read: () => { throw new Error("x"); } })).toBeUndefined();
  });

  it("gives 3 when no source may be consumed (nothing could be cited)", () => {
    expect(run({ read: () => bundle([source("issue:12", ["reviewer"])]) })).toBe(3);
  });
});

describe("planner prompts of the built flows", () => {
  for (const file of ["flows/issue-plan.yaml", "flows/issue-gitflow.yaml"]) {
    for (const id of ["plan", "revise_plan"]) {
      it(`${file} ${id} asks for citations and missing context`, () => {
        const flow = parseFlow(readFileSync(file, "utf8"));
        const step = flow.steps.find((s) => s.id === id);
        expect(step?.type).toBe("claude");
        const prompt = (step as { prompt: string }).prompt;
        for (const part of [
          "## Requirements",
          "## Constraints",
          "## Acceptance criteria",
          "[source: s-<16 hex>]",
          "[source: s-…, s-…]",
          "## Missing context",
          "Use only ids from that list",
          "Without a CONTEXT list",
        ]) {
          expect(prompt).toContain(part);
        }
      });
    }
  }
});
