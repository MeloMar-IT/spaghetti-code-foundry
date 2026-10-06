import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { ApprovalStepSchema, ClaudeStepSchema, DefaultsSchema, FlowSchema, FlowStepSchema, ParallelStepSchema, PublishSchema, PublishVarSchema, SandboxSchema, ShellStepSchema, StepSchema } from "../src/flow/schema.js";
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
