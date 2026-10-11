import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { ApprovalStepSchema, ClaudeStepSchema, DefaultsSchema, FlowSchema, FlowStepSchema, ParallelStepSchema, PublishSchema, PublishVarSchema, SandboxSchema, ShellStepSchema, StepSchema } from "../src/flow/schema.js";
import { ConfigSchema } from "../src/config.js";
import { SKILL_BLOCKED_PREFIX, SKILL_INTEGRITY_PREFIX } from "../src/engine/skill-lock.js";
import type { StepRecord } from "../src/engine/state.js";
import { classifyFailure } from "../src/failure.js";
import { CATALOGUE_DEFAULTS } from "../src/skills/catalogue-rules.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { resolveSkills } from "../src/skills/resolve.js";
import { RESOLVE_DEFAULTS, RESOLVE_REJECT_CODES, UNRESOLVED_HIGH_RISK_DEFAULT, UNRESOLVED_KIND } from "../src/skills/resolve-rules.js";
import { FLOW_SKILL_MODES, REVIEW_DEFAULTS, STEP_SKILL_MODES } from "../src/skills/schema.js";
import { assessSkills } from "../src/skills/unresolved.js";
import { detectorInfo } from "../src/monitor/work-detectors.js";
import { flowGuide } from "../src/server/generate.js";
import { statusName } from "../src/words.js";

// docs/FLOW_AUTHORING.md is what AI assistants (and "Draft flow with Claude") write flows from,
// so every example in it must be valid.
const guide = readFileSync("docs/FLOW_AUTHORING.md", "utf8");
const blocks = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);

describe("flow authoring guide", () => {
  it("is what the flow drafter and `factory flow-guide` use", () => {
    expect(flowGuide()).toBe(guide);
  });

  it("has a complete example flow that is valid", () => {
    const flows = blocks.filter((b) => /^name: /m.test(b) && /^steps:\n/m.test(b)); // not the field outline (steps: [...])
    expect(flows.length).toBeGreaterThan(0);
    for (const f of flows) expect(() => parseFlow(f)).not.toThrow();
  });

  it("has step snippets that are valid steps", () => {
    const snippets = blocks.filter((b) => /^- id: /m.test(b) || /^steps:\n\s+- id:/m.test(b));
    expect(snippets.length).toBeGreaterThan(5);
    for (const b of snippets) {
      const doc = parse(b) as unknown;
      const list = Array.isArray(doc) ? doc : (doc as { steps: unknown[] }).steps;
      for (const step of list) {
        const r = StepSchema.safeParse(step);
        expect(r.success, `${JSON.stringify(step).slice(0, 80)}: ${r.error?.message}`).toBe(true);
      }
    }
  });
});

// ── The documents match the code ──

/** The text under a heading, up to the next heading of the same or a higher level. */
function section(doc: string, heading: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const level = /^#+/.exec(heading)![0].length;
  let fence = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("```")) fence = !fence;
    const m = !fence && /^(#+) /.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape);
const yamlBlocks = (text: string) => [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);

const STEP_SCHEMAS = { claude: ClaudeStepSchema, shell: ShellStepSchema, approval: ApprovalStepSchema, parallel: ParallelStepSchema, flow: FlowStepSchema };
const SHARED = keysOf(ClaudeStepSchema).filter((k) => Object.values(STEP_SCHEMAS).every((s) => k in s.shape));
const STEP_HEADINGS: Record<string, string> = {
  claude: "### `claude` — an agent step", shell: "### `shell` — a command", approval: "### `approval` — wait for a human",
  parallel: "### `parallel` — run steps at the same time", flow: "### `flow` — run another flow inline",
};

describe("flow authoring guide matches the schema", () => {
  it("names every top-level field, and the fields of defaults, limits and sandbox", () => {
    const block = yamlBlocks(section(guide, "## Top-level fields"))[0]!;
    const top: string[] = [];
    const under: Record<string, string[]> = {};
    let parent = "";
    // Line by line: the block holds placeholders such as {...} and [...], so it is not parsed as YAML.
    for (const line of block.split("\n")) {
      const m = /^( *)([a-z_]+):/.exec(line);
      if (!m) continue;
      if (m[1] === "") {
        top.push(m[2]!);
        parent = m[2]!;
      } else if (m[1]!.length === 2) (under[parent] ??= []).push(m[2]!);
    }
    expect(sorted(top)).toEqual(sorted(keysOf(FlowSchema)));
    expect(sorted(under.defaults ?? [])).toEqual(sorted(keysOf(DefaultsSchema)));
    expect(sorted(under.sandbox ?? [])).toEqual(sorted(keysOf(SandboxSchema)));
    expect(sorted(under.limits ?? [])).toEqual(sorted(Object.keys(FlowSchema.shape.limits.unwrap().shape)));
  });

  it("names every skill mode in backticks", () => {
    const text = section(guide, "## Skills");
    for (const m of [...FLOW_SKILL_MODES, ...STEP_SKILL_MODES]) expect(text).toContain(`\`${m}\``);
  });

  it("lists the fields every step has", () => {
    const table = section(guide, "## Step fields (every type)");
    const names = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
    expect(sorted(names)).toEqual(sorted(SHARED));
  });

  it.each(Object.keys(STEP_SCHEMAS))("shows the own fields of a %s step in its own section", (type) => {
    const text = section(guide, STEP_HEADINGS[type]!);
    const used = new Set<string>();
    for (const b of yamlBlocks(text)) {
      for (const step of parse(b) as { type?: string }[]) if (step.type === type) for (const k of Object.keys(step)) used.add(k);
    }
    const own = Object.keys(STEP_SCHEMAS[type as keyof typeof STEP_SCHEMAS].shape).filter((k) => !SHARED.includes(k));
    expect(sorted([...used].filter((k) => !SHARED.includes(k)))).toEqual(sorted(own));
  });

  it("shows every field of publish and of its variables, and the three modes", () => {
    const text = section(guide, "## Publishing a flow to users");
    const flow = parse(yamlBlocks(text)[0]!) as { publish: Record<string, unknown> & { vars: Record<string, Record<string, unknown>> } };
    expect(sorted([...Object.keys(flow.publish), "version"])).toEqual(sorted(keysOf(PublishSchema)));
    expect(text).toContain("`version`");
    const varKeys = PublishVarSchema.options.flatMap((o) => Object.keys(o.shape));
    const used = Object.values(flow.publish.vars).flatMap((v) => Object.keys(v));
    expect(sorted(used)).toEqual(sorted(varKeys));
    for (const mode of ["hidden", "fixed", "input"]) expect(text).toContain(`\`${mode}\``);
  });

  it("names where the monitor reads the fix commit", () => {
    const text = section(guide, "## Templates and environment variables");
    const paragraph = text.split("\n\n").find((p) => p.includes("COMMIT:")) ?? "";
    for (const word of ["`push_develop`", "`COMMIT: <40 characters>`", "`hotfix_done`", "`MAIN: <40 characters>`", "`fix_wait_days`"]) expect(paragraph, word).toContain(word);
  });
});

describe("user guide: self-repair", () => {
  const manual = readFileSync("docs/USER_GUIDE.md", "utf8");
  const chapter = section(manual, "## 13. Self-repair (for admins)");

  it("is in the contents list and has exactly its eight sections, in order", () => {
    expect(manual).toContain("- [13. Self-repair (for admins)](#13-self-repair-for-admins)");
    const topics = [...chapter.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(topics).toEqual([
      "What the monitor looks for", "What a bug story looks like", "How bug stories go first", "The hotfix path",
      "The guard rails", "Switch it on and off", 'When it says "needs you"', "The incidents that are replayed in tests",
    ]);
  });

  it("names every detector of the monitor and every heading of a bug story", () => {
    for (const { name } of detectorInfo()) expect(chapter, name).toContain(`\`${name}\``);
    const story = readFileSync("src/monitor/story.ts", "utf8");
    const headings = [...story.matchAll(/"## ([A-Z][^"]+)"/g)].map((m) => m[1]!);
    expect(headings).toHaveLength(9);
    const flat = chapter.replace(/\s+/g, " "); // a heading may wrap onto the next line
    for (const h of headings) expect(flat, h).toContain(h);
  });

  it("has links that lead to a heading of the guide", () => {
    const slug = (h: string) => h.toLowerCase().replace(/[^a-z0-9_ -]/g, "").replace(/ /g, "-");
    const slugs = new Set([...manual.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!.replace(/`/g, ""))));
    for (const [, anchor] of chapter.matchAll(/\]\(#([^)]+)\)/g)) expect(slugs.has(anchor!), anchor).toBe(true);
  });

  it("says in chapter 6 that label and run disagree is major, and links to the chapter", () => {
    expect(manual).toMatch(/^\| Label and run disagree \|.*\| major \|/m);
    expect(section(manual, "### The monitor: the Foundry checks itself")).toContain("(#13-self-repair-for-admins)");
  });

  it('explains in "Why is nothing happening?" that a bug story goes first', () => {
    expect(section(manual, "#### Why is nothing happening?")).toContain(statusName("bug_first", {}));
  });
});

describe("user guide: automatic skills", () => {
  const manual = readFileSync("docs/USER_GUIDE.md", "utf8");
  const auto = section(manual, "### Automatic skills");
  const row = (code: string) => auto.split("\n").find((l) => l.startsWith(`| \`${code}\` |`));

  it("sits in chapter 7, before the skill sections, and is in the contents list", () => {
    expect(manual).toContain("  - [Automatic skills](#automatic-skills)");
    const at = manual.indexOf("### Automatic skills");
    expect(at).toBeGreaterThan(manual.indexOf("## 7. Settings and safety"));
    expect(at).toBeLessThan(manual.indexOf("### Skill sources"));
  });

  it("has its sub-sections in order", () => {
    expect([...auto.matchAll(/^#### (.+)$/gm)].map((m) => m[1])).toEqual([
      "What happens by itself", "What policy decides", "Write a skill", "Context budgets", "Trust",
      "The two pipelines and skills", "Find out why a run stopped",
    ]);
  });

  it("names the policy keys and the stages", () => {
    for (const k of ["catalogue", "selection", "unresolved", "review"]) expect(auto).toContain(`\`skills.${k}\``);
    for (const w of ["Profile", "Catalogue", "Request", "Resolution", "Lock", "Loading", "Review checks"]) expect(auto).toContain(`| ${w} |`);
  });

  it("shows the defaults of the code", () => {
    const doc = parse(/```yaml\n([\s\S]*?)```/.exec(auto)![1]!) as { skills: unknown };
    const want = ConfigSchema.parse({}).skills;
    const s = doc.skills as typeof want;
    expect(s.builtin).toBe(want.builtin);
    expect(s.roots).toEqual(want.roots);
    expect(s.repository).toBe(want.repository);
    expect(s.catalogue).toEqual(want.catalogue);
    expect(s.selection).toEqual(want.selection);
    expect(s.review).toEqual(want.review);
    expect(s.unresolved).toEqual(want.unresolved);
    expect(s.catalogue.max_candidates).toBe(CATALOGUE_DEFAULTS.maxCandidates);
    expect(s.selection.max_tokens).toBe(RESOLVE_DEFAULTS.maxTokens);
    expect(s.review.max_tokens).toBe(REVIEW_DEFAULTS.maxTokens);
    expect(s.unresolved.high_risk).toEqual([...UNRESOLVED_HIGH_RISK_DEFAULT]);
  });

  it("has a row for every reason code, with the kind of the code", () => {
    for (const code of RESOLVE_REJECT_CODES) {
      const cells = row(code)?.split("|").map((c) => c.trim());
      expect(cells, code).toBeTruthy();
      expect(cells![2]!.startsWith(UNRESOLVED_KIND[code]), code).toBe(true);
    }
  });

  it("says that a failing dependency follows the kind of its own problem", () => {
    const sk = (id: string, o: { pin?: string; instructions?: string; deps?: { id: string }[] } = {}) => {
      const pkg = { id, version: "1.0.0", description: "d", instructions: o.instructions ?? "x", roles: [], dependencies: o.deps ?? [], conflicts: [], category: "general", capabilities: [], risk: "low" };
      return { key: `${id}@1.0.0`, id, version: "1.0.0", source: "admin", label: "x", dir: "/d", active: true, trust: "approved", pin: o.pin ?? "pinned", digest: `sha256:${"a".repeat(64)}`, pkg } as unknown as RegisteredSkill;
    };
    const first = (dep?: RegisteredSkill, limits?: { maxSkillTokens: number }) => {
      const skills = [sk("a", { deps: [{ id: "d" }] }), ...(dep ? [dep] : [])];
      const reg = { skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] };
      return assessSkills(resolveSkills(reg, ["a"], limits ? { limits } : {}), reg, ConfigSchema.parse({}).skills.unresolved).unresolved[0]!;
    };
    expect(first()).toMatchObject({ code: "dependency-unavailable", kind: "missing" });
    expect(first(sk("d", { pin: "unpinned" }))).toMatchObject({ code: "dependency-unavailable", kind: "untrusted" });
    expect(first(sk("d", { instructions: "x".repeat(4000) }), { maxSkillTokens: 1000 })).toMatchObject({ code: "dependency-unavailable", kind: "oversized" });
    const cell = row("dependency-unavailable")!;
    expect(cell).toContain("untrusted");
    expect(cell).toContain("oversized");
  });

  it("has the fixes of the failure classifier and the reasons of the plan record", () => {
    const flat = auto.replace(/\s+/g, " ");
    for (const error of [
      "skill integrity: a@1.0.0 is missing; this run locked it (sha256:x)",
      "skill selection is blocked: a@1.0.0 does not fit the skill context budget (skills.selection.max_tokens)",
      "skill selection is blocked: a (unpinned)",
      "planning failed: the skill request of the plan is not valid",
    ]) {
      const history = [{ id: "marked", type: "shell", visit: 1, ok: false, output: error, error, startedAt: "x", durationMs: 1, logFile: "l" }] as unknown as StepRecord[];
      const f = classifyFailure({ status: "failed", reason: `step "marked" failed: ${error}`, history });
      expect(f.fix, error).toBeTruthy();
      expect(flat, error).toContain(f.fix!);
    }
    for (const p of [SKILL_INTEGRITY_PREFIX, SKILL_BLOCKED_PREFIX, "skills not resolved:"]) expect(auto).toContain(p.trim());
    for (const r of ["the plan records of this issue are not valid", "the plan record could not be written", "the plan record could not be checked"]) expect(auto).toContain(r);
  });

  it("shows both pipelines", () => {
    for (const w of ["issue-gitflow", "issue-plan", "issue-code-daily", "plan", "plan_review", "risk_gate", "post_plan", "plan_check", "implement", "review_1"]) expect(auto).toContain(`\`${w}\``);
  });

  it("has links that lead to a heading of the guide", () => {
    const slug = (h: string) => h.toLowerCase().replace(/[^a-z0-9_ -]/g, "").replace(/ /g, "-");
    const slugs = new Set([...manual.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!.replace(/`/g, ""))));
    for (const [, anchor] of auto.matchAll(/\]\(#([^)]+)\)/g)) expect(slugs.has(anchor!), anchor).toBe(true);
  });

  it("no longer says that nothing loads or uses skills", () => {
    expect(manual).not.toContain("Nothing uses the list yet");
    expect(manual).not.toContain("Nothing loads the skills yet");
    expect(manual).not.toContain("Checked, not loaded");
    expect(manual).not.toContain("(`issue-plan`: the plan step)");
  });

  it("is matched in the flow guide and the design", () => {
    expect(section(guide, "## Skills")).toContain("### Skills in your own flow");
    const design = readFileSync("docs/DESIGN.md", "utf8");
    expect(design).toContain("### The skill path");
    expect(design).toContain("ensureSkillLock");
    expect(design).toContain("carryRunSkills");
  });
});
