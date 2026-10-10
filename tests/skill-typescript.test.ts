import { cpSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSkillCandidates } from "../src/skills/candidates.js";
import { estimateTokens } from "../src/skills/catalogue.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { renderReviewPayload, renderSkillPayload } from "../src/skills/payload.js";
import { BUILTIN_SKILLS } from "../src/skills/registry.js";
import { skillContextTokens } from "../src/skills/resolve.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { SKILL_DIGEST_RE } from "../src/skills/schema.js";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "skillts-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tree = (files: Record<string, string>) => {
  const root = tmp();
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
};
const candidates = (files: Record<string, string>, opts: Parameters<typeof detectSkillCandidates>[1] = {}) =>
  detectSkillCandidates(buildRepoProfile(tree(files)), opts);
const ts = (r: ReturnType<typeof candidates>) => r.find((c) => c.skill === "typescript");

const dev = JSON.stringify({ devDependencies: { typescript: "^5.0.0", vitest: "^2.0.0" } });
const BROWSER = {
  "tsconfig.json": '{"compilerOptions":{"lib":["DOM","ES2022"]}}',
  "index.html": "<script type=module src=src/main.ts></script>",
  "src/main.ts": 'import { s } from "./state.js";\ndocument.title = s;\n',
  "src/state.ts": 'export const s = "x";\n',
};
const LIBRARY = {
  "package.json": dev,
  "tsconfig.json": "{}",
  "src/index.ts": "export const a = 1;\n",
  "test/index.test-d.ts": "export {};\n",
};
// One package holding both languages, and a checkJs project that has only declaration files besides JavaScript.
const MIXED = {
  "package.json": dev,
  "tsconfig.json": '{"compilerOptions":{"allowJs":true}}',
  "src/new.ts": "export const n = 1;\n",
  "src/legacy/old.js": "module.exports = 1;\n",
  "packages/legacy/package.json": "{}",
  "packages/legacy/index.js": "module.exports = 1;\n",
};
const CHECKJS = {
  "package.json": dev,
  "tsconfig.json": '{"compilerOptions":{"allowJs":true,"checkJs":true}}',
  "src/types.d.ts": "export type T = string;\n",
  "src/main.js": "export const m = 1;\n",
};
const JS_ONLY = { "package.json": "{}", "jsconfig.json": "{}", "index.js": "x\n", "lib/util.mjs": "x\n" };

const pkg = loadSkillPackage(join(BUILTIN_SKILLS, "typescript"));

describe("typescript skill: schema", () => {
  it("is a coder and reviewer language skill with a review file", () => {
    expect(pkg).toMatchObject({ id: "typescript", version: "1.0.0", category: "language", roles: ["coder", "reviewer"], risk: "low" });
    expect(pkg.review).toBeDefined();
    expect(pkg.files.scripts).toEqual([]);
  });
  it("fits the default budgets and keeps its capabilities TypeScript-only", () => {
    expect(skillContextTokens(pkg)).toBeLessThanOrEqual(1500);
    expect(estimateTokens(pkg.review!)).toBeLessThanOrEqual(500);
    for (const bad of ["promises", "errors", "async", "modules", "javascript", "nodejs"]) expect(pkg.capabilities).not.toContain(bad);
  });
  it("lists every TypeScript extension the profiler knows", () => {
    const manifest = readFileSync(join(BUILTIN_SKILLS, "typescript", "skill.yaml"), "utf8");
    for (const g of ["tsconfig.json", "*.ts", "*.tsx", "*.mts", "*.cts"]) expect(manifest).toContain(`**/${g}`);
  });
});

describe("typescript skill: integrity", () => {
  it("has a stable digest that changes when a file changes", () => {
    expect(pkg.digest).toMatch(SKILL_DIGEST_RE);
    expect(loadSkillPackage(join(BUILTIN_SKILLS, "typescript")).digest).toBe(pkg.digest);
    const copy = join(tmp(), "typescript");
    cpSync(join(BUILTIN_SKILLS, "typescript"), copy, { recursive: true });
    expect(loadSkillPackage(copy).digest).toBe(pkg.digest);
    appendFileSync(join(copy, "SKILL.md"), " ");
    expect(loadSkillPackage(copy).digest).not.toBe(pkg.digest);
  });
});

describe("typescript skill: selection", () => {
  it("is found in browser and library projects, without Node.js", () => {
    const b = candidates(BROWSER);
    expect(ts(b)).toMatchObject({ confidence: "medium", score: 45 });
    expect(b.map((c) => c.skill)).not.toContain("nodejs");
    const l = candidates(LIBRARY);
    expect(ts(l)?.confidence).toBe("high");
    expect(l.map((c) => c.skill)).not.toContain("nodejs");
  });
  it("is found for a mixed project and not for work in a JavaScript-only package", () => {
    expect(ts(candidates(MIXED))?.modules[0]?.path).toBe("");
    expect(ts(candidates(MIXED, { affectedPaths: ["packages/legacy/index.js"] }))).toBeUndefined();
  });
  it("is not selected for JavaScript-only files, even in a package with TypeScript", () => {
    expect(ts(candidates(MIXED, { affectedPaths: ["src/legacy/old.js"] }))).toBeUndefined();
    expect(ts(candidates(MIXED, { affectedPaths: ["src/legacy/old.js", "index.mjs"] }))).toBeUndefined();
    expect(ts(candidates(CHECKJS, { affectedPaths: ["src/main.js"] }))).toBeUndefined();
  });
  it("is selected when the work includes a TypeScript file or the task asks for it", () => {
    expect(ts(candidates(MIXED, { affectedPaths: ["src/legacy/old.js", "src/new.ts"] }))).toBeDefined();
    expect(ts(candidates(MIXED, { affectedPaths: ["src/legacy"] }))).toBeDefined();
    expect(ts(candidates(CHECKJS, { affectedPaths: ["src/types.d.ts"] }))).toBeDefined();
    expect(ts(candidates(MIXED, { affectedPaths: ["src/legacy/old.js"], task: "convert this to TypeScript" }))).toBeDefined();
    expect(ts(candidates(MIXED, { affectedPaths: ["src/legacy/old.js"], task: "fix tsconfig paths" }))).toBeDefined();
  });
  it("is never selected for a JavaScript-only repository", () => {
    expect(ts(candidates(JS_ONLY))).toBeUndefined();
    expect(ts(candidates(JS_ONLY, { task: "fix the javascript build" }))).toBeUndefined();
    expect(ts(candidates({ "tsconfig.json": "{}", "index.js": "x\n" }))).toBeUndefined();
  });
});

describe("typescript skill: behaviour of the rendered text", () => {
  const coder = { id: pkg.id, version: pkg.version, digest: pkg.digest, description: pkg.description, instructions: pkg.instructions };
  const payload = renderSkillPayload([{ ...coder, selection: "requested", requiredBy: [] }], { maxTokens: 2000 });

  it("loads within the budget", () => {
    expect(payload.loaded).toEqual(["typescript@1.0.0"]);
    expect(payload.omitted).toEqual([]);
    expect(payload.estimatedTokens).toBeLessThanOrEqual(2000);
  });
  it("forbids broad any, unsafe assertions and ignored compiler errors, with a documented exception", () => {
    const t = payload.text;
    for (const s of ["`any`", "`unknown`", "as unknown as", "@ts-ignore", "@ts-nocheck", "@ts-expect-error", "AbortSignal", "package manager", "type-level", "generated", "Do not assume Node.js", "JavaScript"])
      expect(t).toContain(s);
    expect(t.split("\n").some((l) => l.includes("existing boundary") && l.includes("comment"))).toBe(true);
  });
  it("allows @ts-expect-error in tests only as a narrow negative assertion", () => {
    const line = pkg.instructions.split("\n").find((l) => l.includes("In a type-level test"))!;
    expect(line).toMatch(/only as an intentional negative assertion/);
    expect(line).toMatch(/directly above the one expression/);
    expect(pkg.instructions).not.toMatch(/`@ts-expect-error` is allowed there/);
    expect(pkg.review).toMatch(/directly above the one expression under test/);
  });
  it("gives reviewers the runtime-validation check and not the coder text", () => {
    const r = renderReviewPayload([{ id: pkg.id, version: pkg.version, digest: pkg.digest, description: pkg.description, review: pkg.review! }], { maxTokens: 1500, maxSkillTokens: 800 });
    expect(r.loaded).toEqual(["typescript@1.0.0"]);
    expect(r.text).toMatch(/checked at runtime/);
    expect(r.text).toContain("Untyped boundaries");
    expect(r.text).not.toContain("## Promises and cancellation");
  });
});
