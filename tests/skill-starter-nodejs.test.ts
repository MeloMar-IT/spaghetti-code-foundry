import { cpSync, mkdirSync, mkdtempSync, appendFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { detectSkillCandidates } from "../src/skills/candidates.js";
import { buildSkillCatalogue } from "../src/skills/catalogue.js";
import { CATALOGUE_DETAIL } from "../src/skills/catalogue-rules.js";
import { evaluateSkillRun, SkillExpectSchema, type SkillEvalRun } from "../src/skills/eval.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { renderReviewPayload, renderSkillPayload } from "../src/skills/payload.js";
import {
  BUILTIN_SKILLS,
  clearSkillRegistryCache,
  discoverSkills,
  findSkill,
  pinBuiltinSkills,
  selectSkill,
  SkillIntegrityError,
  SkillSelectError,
} from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { resolveSkills, skillContextTokens } from "../src/skills/resolve.js";
import { RESOLVE_DEFAULTS } from "../src/skills/resolve-rules.js";
import { REVIEW_DEFAULTS, SKILL_DIGEST_RE } from "../src/skills/schema.js";

const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillnode-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const ID = "nodejs";
const skillsCfg = ConfigSchema.parse({}).skills;
const pkg = loadSkillPackage(join(BUILTIN_SKILLS, ID));
const registry = () => discoverSkills(skillsCfg, { env: {}, userHome: tmp() });
const budget = (key: string): number => {
  const v = Number(pkg.metadata?.[key]);
  expect(Number.isInteger(v) && v > 0).toBe(true);
  return v;
};

function profileOf(files: Record<string, string>) {
  const root = tmp();
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return buildRepoProfile(root);
}
type Opts = { task?: string; modules?: string[] };
function entry(files: Record<string, string>, opts: Opts = {}) {
  const cat = buildSkillCatalogue(registry(), { profile: profileOf(files), ...opts });
  return { entry: cat.entries.find((e) => e.id === ID), entries: cat.entries };
}
const npm = (deps: Record<string, string>, dev: Record<string, string> = {}, more: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "x", version: "1.0.0", ...more, dependencies: deps, devDependencies: dev });

describe("nodejs skill: schema", () => {
  it("loads with the declared manifest", () => {
    expect(pkg.id).toBe(ID);
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.category).toBe("platform");
    expect([...pkg.roles].sort()).toEqual(["coder", "reviewer"]);
    expect(pkg.risk).toBe("low");
    expect(pkg.tool_profile).toEqual({ shell: false, network: false, filesystem: "read" });
    expect(pkg.files.scripts).toEqual([]);
    expect(pkg.dependencies).toEqual([]);
    expect(pkg.conflicts).toEqual([]);
    expect(pkg.review).toBeDefined();
  });

  it("keeps its capabilities to Node.js: no language or framework name", () => {
    expect([...pkg.capabilities].sort()).toEqual(["esm-commonjs", "node-process-lifecycle", "node-runtime", "node-service", "node-streams"]);
    for (const bad of ["typescript", "javascript", "express", "streams", "logging", "tests"]) expect(pkg.capabilities).not.toContain(bad);
  });

  it("names only Node.js runtime evidence in its detectors, no TypeScript file", () => {
    const manifest = readFileSync(join(BUILTIN_SKILLS, ID, "skill.yaml"), "utf8");
    for (const g of ["package.json", ".nvmrc", ".node-version"]) expect(manifest).toContain(`**/${g}`);
    expect(manifest).not.toMatch(/\*\.(?:ts|tsx|js)\b|tsconfig/);
  });

  it("the real registry has no problems and the skill is active and built in", () => {
    const reg = registry();
    expect(reg.problems).toEqual([]);
    const s = findSkill(reg, ID);
    expect(s?.active).toBe(true);
    expect(s?.trust).toBe("builtin");
    expect(s?.label).toBe("built-in");
  });
});

describe("nodejs skill: description", () => {
  it("says what it does and when it must and must not activate", () => {
    const d = pkg.description;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).toMatch(/node\.js/i);
    expect(d).toMatch(/use for code that runs on node\.js/i);
    expect(d).toMatch(/not browser-only or non-node work/i);
    expect(d.toLowerCase()).not.toContain("typescript");
  });

  it("is shown whole in the catalogue", () => {
    const e = entry({ "package.json": npm({ express: "4" }), "index.js": "require('node:http');\n" }).entry;
    expect(e?.description).toBe(pkg.description);
    expect(e?.description).not.toContain("…");
  });
});

describe("nodejs skill: budgets", () => {
  it("planner: the description fits its character budget and the catalogue", () => {
    expect(pkg.description.length).toBeLessThanOrEqual(budget("budget-planner-chars"));
    expect(budget("budget-planner-chars")).toBeLessThanOrEqual(CATALOGUE_DETAIL.full.descriptionChars);
  });

  it("coder: the context fits its budget, and the delivered block adds only the wrapper", () => {
    const b = budget("budget-coder-tokens");
    expect(skillContextTokens(pkg)).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(RESOLVE_DEFAULTS.maxSkillTokens);
    const p = renderSkillPayload(
      [{ id: pkg.id, version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
      { maxTokens: b + 300 },
    );
    expect(p.loaded).toEqual([`${ID}@1.0.0`]);
    expect(p.estimatedTokens).toBeLessThanOrEqual(b + 300);
  });

  it("reviewer: the delivered section is loaded under the declared per-skill budget", () => {
    const b = budget("budget-reviewer-tokens");
    expect(b).toBeLessThan(REVIEW_DEFAULTS.maxSkillTokens);
    const p = renderReviewPayload(
      [{ id: pkg.id, version: pkg.version, digest: pkg.digest, description: pkg.description, review: pkg.review! }],
      { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: b },
    );
    expect(p.loaded).toEqual([`${ID}@1.0.0`]);
    expect(p.omitted).toEqual([]);
  });

  it("keeps to the conventions and covers every topic", () => {
    expect(pkg.instructions).toMatch(/Do not add a dependency unless the task asks for it/);
    expect(pkg.instructions).toMatch(/package manager of the lockfile that exists/);
    expect(pkg.instructions).toMatch(/Run the scripts in `package\.json`/);
    expect(pkg.instructions).toMatch(/own skills/);
    for (const h of [
      "When this applies", "Follow the repository first", "Modules: ESM and CommonJS", "Event loop and blocking work", "Asynchronous failures",
      "Streams and backpressure", "Timeouts and cancellation", "Start-up and shutdown", "Configuration", "Dependency boundaries", "Logging", "Tests",
    ]) expect(pkg.instructions).toContain(`## ${h}`);
  });
});

// A JavaScript (CommonJS) service, a TypeScript (ESM) service, and packages that are not Node.js.
const JS_SERVICE = {
  "package.json": npm({ express: "^4.19.0" }, {}, { engines: { node: ">=20" }, scripts: { start: "node server.js", test: "node --test" } }),
  "package-lock.json": "{}",
  "server.js": 'const http = require("node:http");\nconst express = require("express");\nhttp.createServer(express()).listen(0);\n',
};
const TS_SERVICE = {
  "package.json": npm({ fastify: "^4.0.0" }, { typescript: "^5.0.0", "@types/node": "^20.0.0" }, { type: "module" }),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "tsconfig.json": '{"compilerOptions":{"module":"NodeNext"}}',
  "src/main.ts": 'import { createServer } from "node:http";\nimport { pipeline } from "node:stream/promises";\nexport const s = createServer();\nvoid pipeline;\n',
};
const BROWSER_TS = {
  "package.json": npm({ react: "^18.0.0", "react-dom": "^18.0.0" }, { typescript: "^5.0.0", vite: "^5.0.0" }),
  "tsconfig.json": '{"compilerOptions":{"lib":["DOM","ES2022"],"jsx":"react-jsx"}}',
  "index.html": "<script type=module src=src/main.tsx></script>",
  "src/main.tsx": 'import React from "react";\nimport { createRoot } from "react-dom/client";\ncreateRoot(document.body).render(React.createElement("p"));\n',
  "src/state.ts": 'export const title = () => document.title;\n',
};
const MONO = {
  "services/api/package.json": npm({ express: "4" }),
  "services/api/src/index.js": 'const fs = require("fs");\nmodule.exports = fs;\n',
  "apps/web/package.json": npm({ react: "18" }, { typescript: "5" }),
  "apps/web/tsconfig.json": "{}",
  "apps/web/src/main.tsx": 'import React from "react";\nexport default React;\n',
};
const POSITIVE: [string, Record<string, string>, Opts, "high" | "medium" | "low" | undefined][] = [
  ["javascript-commonjs-service", JS_SERVICE, {}, "high"],
  ["typescript-esm-service", TS_SERVICE, {}, "high"],
  ["javascript-no-dependencies", { "package.json": JSON.stringify({ engines: { node: ">=18" } }), "index.mjs": "console.log(1);\n" }, {}, "medium"],
  ["javascript-built-in-imports-only", { "cli.mjs": 'import { readFile } from "node:fs/promises";\nawait readFile("x");\n' }, {}, "medium"],
  ["monorepo-api-module", MONO, { modules: ["services/api"] }, undefined],
];
const NEGATIVE: [string, Record<string, string>, Opts][] = [
  ["browser-only-typescript", BROWSER_TS, {}],
  ["browser-only-typescript-with-task", BROWSER_TS, { task: "Fix the TypeScript types of the React title component and its promise handling" }],
  ["browser-only-plain-typescript", { "tsconfig.json": '{"compilerOptions":{"lib":["DOM"]}}', "src/a.ts": "document.title = 'x';\n" }, {}],
  ["monorepo-web-module", MONO, { modules: ["apps/web"] }],
  ["browser-javascript-package", { "package.json": npm({ lodash: "4" }), "src/app.js": 'import _ from "lodash";\nwindow.x = _;\n' }, {}],
  ["java-maven", { "pom.xml": "<project/>", "src/main/java/App.java": "class App {}" }, { task: "Close the stream on shutdown" }],
  ["python-docs", { "README.md": "# Docs", "pyproject.toml": '[project]\nname = "x"\n', "app.py": "import os\nprint(1)\n" }, { task: "Update the docs" }],
  ["deno-package", { "deno.json": "{}", "main.ts": 'import { serve } from "https://deno.land/std/http/server.ts";\nserve(() => new Response("x"));\n' }, {}],
];

describe("nodejs skill: selection fixtures", () => {
  it.each(POSITIVE)("positive: %s", (_n, files, opts, conf) => {
    const { entry: e, entries } = entry(files, opts);
    expect(e?.evidence.length).toBeGreaterThan(0);
    expect(e?.evidence[0]).toMatch(/^nodejs: (high|medium|low) confidence/);
    if (conf) expect(e?.evidence[0]).toContain(`nodejs: ${conf} confidence`);
  });

  it.each(NEGATIVE)("negative: %s", (_n, files, opts) => {
    expect(entry(files, opts).entry?.evidence).toEqual([]);
    const c = detectSkillCandidates(profileOf(files), { ...(opts.task ? { task: opts.task } : {}), ...(opts.modules ? { affectedPaths: opts.modules } : {}) });
    expect(c.map((x) => x.skill)).not.toContain(ID);
  });

  it("browser-only TypeScript still gets the typescript candidate, so the two are independent", () => {
    expect(detectSkillCandidates(profileOf(BROWSER_TS)).map((c) => c.skill)).toEqual(["typescript"]);
  });

  it("a JavaScript service is found without any TypeScript evidence", () => {
    const c = detectSkillCandidates(profileOf(JS_SERVICE));
    expect(c.map((x) => x.skill)).toEqual([ID]);
    expect(c[0]!.evidence.map((e) => e.signal).sort()).toEqual(["node-dependency", "node-import"]);
  });

  it("a TypeScript service gets both, each on its own evidence", () => {
    const c = detectSkillCandidates(profileOf(TS_SERVICE));
    expect(c.map((x) => x.skill).sort()).toEqual([ID, "typescript"]);
    expect(c.find((x) => x.skill === ID)!.evidence.every((e) => e.signal.startsWith("node-"))).toBe(true);
  });

  it("in a mono-repository only the Node.js module counts", () => {
    const c = detectSkillCandidates(profileOf(MONO)).find((x) => x.skill === ID)!;
    expect(c.modules.map((m) => m.path)).toEqual(["services/api"]);
  });
});

describe("nodejs skill: integrity and resolve", () => {
  it("is pinned with the digest of the package; loading twice agrees", () => {
    expect(pkg.digest).toMatch(SKILL_DIGEST_RE);
    pinBuiltinSkills(registry());
    expect(selectSkill(registry(), ID, pkg.version).digest).toBe(pkg.digest);
    expect(loadSkillPackage(join(BUILTIN_SKILLS, ID)).digest).toBe(pkg.digest);
  });

  it("resolves when requested, and refuses other roles", () => {
    pinBuiltinSkills(registry());
    const r = resolveSkills(registry(), [ID]);
    expect(r.selected.map((s) => [s.id, s.reason])).toEqual([[ID, "requested"]]);
    const t = resolveSkills(registry(), [ID], { role: "tester" });
    expect(t.decisions.find((d) => d.id === ID)?.code).toBe("role");
  });

  it("a changed file is a mismatch", () => {
    const root = tmp();
    cpSync(join(BUILTIN_SKILLS, ID), join(root, ID), { recursive: true });
    cpSync(join(BUILTIN_SKILLS, "small-changes"), join(root, "small-changes"), { recursive: true });
    pinBuiltinSkills(registry());
    appendFileSync(join(root, ID, "REVIEW.md"), "\n- extra\n");
    const reg = discoverSkills(skillsCfg, { env: {}, userHome: tmp(), builtinRoot: root });
    expect(findSkill(reg, ID)?.pin).toBe("mismatch");
    expect(() => selectSkill(reg, ID, "1.0.0")).toThrow(SkillIntegrityError);
    expect(resolveSkills(reg, [ID]).decisions.find((d) => d.id === ID)?.code).toBe("mismatch");
  });

  it("without a pin it is refused as unpinned", () => {
    const reg = discoverSkills(skillsCfg, { env: {}, userHome: tmp(), home: tmp() });
    try {
      selectSkill(reg, ID, "1.0.0");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SkillSelectError);
      expect((e as SkillSelectError).code).toBe("unpinned");
    }
  });
});

describe("nodejs skill: behaviour", () => {
  const coder = renderSkillPayload(
    [{ id: ID, version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
    { maxTokens: RESOLVE_DEFAULTS.maxTokens },
  );
  const reviewer = renderReviewPayload(
    [{ id: ID, version: pkg.version, digest: pkg.digest, description: pkg.description, review: pkg.review! }],
    { maxTokens: REVIEW_DEFAULTS.maxTokens, maxSkillTokens: REVIEW_DEFAULTS.maxSkillTokens },
  );

  it("the coder gets the instructions, the reviewer gets the checks only", () => {
    expect(coder.loaded).toEqual([`${ID}@1.0.0`]);
    expect(coder.omitted).toEqual([]);
    expect(coder.text).toContain("Follow the repository first");
    expect(coder.text).not.toContain("# Node.js review checks");
    expect(reviewer.loaded).toEqual([`${ID}@1.0.0`]);
    expect(reviewer.text).toContain(`role="reviewer"`);
    expect(reviewer.text).toContain("Asynchronous failure paths");
    expect(reviewer.text).toContain("Lifecycle");
    expect(reviewer.text).not.toContain("## Start-up and shutdown");
  });

  // The skill is guidance only; these scenarios check that each Node.js concern is covered by an instruction and a review check.
  const SCENARIOS: [string, RegExp, RegExp][] = [
    ["unhandled rejection", /Every promise is awaited, returned or given a `catch`\. A rejection nobody handles ends the process/, /every promise awaited, returned or caught/],
    ["async listener", /`async` function passed where the caller ignores the result[^]*own `try`\/`catch`/, /`async` listeners, timers and callbacks catch their own errors/],
    ["emitter without error listener", /no `error` listener throws/, /`error` listener or run in `pipeline`/],
    ["process-level handlers", /`process\.on\('unhandledRejection'\)`[^]*Do not use them to keep running/, /log and exit, instead of keeping the process running/],
    ["resource cleanup", /Clear timers and remove listeners on every path, also on failure/, /timers cleared, listeners removed, streams destroyed and handles closed on every path/],
    ["owned resources", /Every resource a module opens has an owner that closes it/, /close servers, pools, clients, file handles and timers/],
    ["blocking work", /Do not block the event loop on a request or message path: no `\*Sync` calls/, /`\*Sync` call, heavy CPU work/],
    ["cpu work", /`worker_threads` or a child process/, /heavy CPU work/],
    ["unbounded concurrency", /Bound concurrency/, /Is concurrency bounded/],
    ["graceful shutdown", /Handle `SIGTERM` and `SIGINT` once: stop taking new work[^]*within a time limit/, /`SIGTERM` and `SIGINT`[^]*finish work in progress within a time limit/],
    ["process.exit", /`process\.exit\(\)` can cut off logs and writes/, /`process\.exit\(\)` cut off pending writes/],
    ["streams", /`pipeline` from `node:stream\/promises`, not with bare `\.pipe\(\)`/, /backpressure respected/],
    ["cancellation", /Pass an existing `AbortSignal` on/, /existing `AbortSignal` passed on/],
    ["timeouts", /Every outbound call[^]*has a timeout/, /each outbound call have a timeout/],
    ["module system", /Write new files in the system the package uses/, /module system of its package \(ESM or CommonJS\)/],
    ["package exports", /`main`, `exports`, `types` and `bin`[^]*API change/, /`exports`, `main` or `bin` changed in a way that breaks consumers/],
    ["configuration", /Read `process\.env` in one place at start-up/, /`process\.env` read and checked in one place/],
    ["secrets in logs", /Do not log secrets/, /secret reach a log/],
    ["package manager and scripts", /Do not add a second lockfile/, /detected package manager and the existing scripts/],
    ["new dependency", /Do not add a dependency unless the task asks for it/, /no dependency the task did not ask for/],
    ["undeclared import", /Do not import a package the `package\.json` of this package does not declare/, /dependency/],
    ["shell injection", /`execFile` or `spawn` with an argument array/, /shell command built from input/],
    ["tests of failure paths", /Test the failure paths too/, /cover a failure path \(rejection, timeout, abort, shutdown\)/],
    ["sleeping test", /No fixed sleeps/, /fixed sleeps and fixed ports/],
    ["browser code", /Do not use it for code that runs only in a browser/, /Leave browser-only files/],
  ];
  it.each(SCENARIOS)("covers: %s", (_n, rule, check) => {
    expect(pkg.instructions).toMatch(rule);
    expect(pkg.review).toMatch(check);
  });

  it("a package without a rule fails the same check", () => {
    const trimmed = pkg.instructions.replace(/^- Every promise is awaited.*$/m, "");
    expect(trimmed).not.toMatch(/A rejection nobody handles ends the process/);
  });

  const lock = { version: 1 as const, lockDigest: pkg.digest, planHash: pkg.digest, createdAt: "2026-10-01T00:00:00.000Z", estimatedTokens: coder.estimatedTokens,
    skills: [{ id: ID, version: pkg.version, digest: pkg.digest, selection: "requested" as const }] };
  const nodeRun: SkillEvalRun = {
    status: "succeeded",
    skillLock: lock,
    history: [{ id: "impl", type: "claude", ok: true, output: "", skills: { loaded: coder.loaded, bytes: coder.bytes, estimatedTokens: coder.estimatedTokens, state: "loaded" } }] as unknown as SkillEvalRun["history"],
  };

  it("a Node.js run is selected, loaded and within the budget", () => {
    const r = evaluateSkillRun(nodeRun, SkillExpectSchema.parse({ selected: [ID], absent: ["java"], max_tokens: budget("budget-coder-tokens") + 300 }));
    expect(r.ok).toBe(true);
    expect(r.activation.status).toBe("loaded");
  });

  it("failure: a Node.js run fails an expectation that nodejs is absent", () => {
    expect(evaluateSkillRun(nodeRun, SkillExpectSchema.parse({ absent: [ID] })).ok).toBe(false);
  });

  it("browser-only work: no lock, nodejs absent is fine", () => {
    const r = evaluateSkillRun({ status: "succeeded", history: [] }, SkillExpectSchema.parse({ absent: [ID] }));
    expect(r.ok).toBe(true);
    expect(r.activation.status).toBe("none");
  });
});
