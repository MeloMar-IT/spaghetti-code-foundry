import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scenarioOffers } from "../src/skill-eval/effect.js";
import { credentialProblem } from "../src/skills/credential-scan.js";
import type { CollisionCandidate } from "../src/skills/collisions.js";
import { EVALUATION_THRESHOLDS } from "../src/skills/evaluation-rules.js";
import { instructionFixtureHash } from "../src/skills/evaluation-instructions.js";
import { scoreSelection } from "../src/skills/evaluation-score.js";
import { readEvaluationSuite } from "../src/skills/evaluation-suite.js";
import { buildSkillIdentity } from "../src/skills/identity.js";
import type { NormalizedSkill } from "../src/skills/normalize.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { BUILTIN_SKILLS, clearSkillRegistryCache, type RegisteredSkill } from "../src/skills/registry.js";

const ROOT = resolve("evals/skill-gate/typescript-node");
const FIXTURES = ["ts-service", "js-package", "java-library"];

const read = readEvaluationSuite(join(ROOT, "suite.yaml"));
if (read.state !== "ok") throw new Error(JSON.stringify(read));

/** A built-in skill as an import candidate, built as in the "shipped example suite" test. */
function builtin(name: string): CollisionCandidate {
  const dir = join(BUILTIN_SKILLS, name);
  const files = ["REVIEW.md", "SKILL.md", "skill.yaml"].map((p) => ({ path: p, content: new Uint8Array(readFileSync(join(dir, p))) }));
  const pkg = loadSkillPackage(dir);
  const identity = buildSkillIdentity({
    id: pkg.id, source: "scf", repositoryKey: "github.com/example/skills", name, version: pkg.version, versionDeclared: true, digest: pkg.digest, files,
  });
  const provenance = {
    schema: 1 as const, source: "scf", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40),
    root: `skills/${name}`, name, layout: "skill-md" as never, versionDeclared: true, dependencies: [], technologies: [], requiredTools: [],
    entryPoints: { instructions: "SKILL.md" as const, scripts: [], documents: [] }, context: { instructions: 0, text: 0 }, upstream: {},
  };
  const skill: NormalizedSkill = { package: pkg, provenance, extraFiles: [], identity };
  return { skill, approved: true, trust: "community", licencesAllowed: ["MIT"] };
}

const made: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillsuite-tsnode-")));
  made.push(d);
  return d;
};
const copy = (name: string) => {
  const d = temp();
  cpSync(join(ROOT, "fixtures", name), d, { recursive: true });
  return d;
};
const run = (cwd: string, cmd: string, env: Record<string, string> = {}) =>
  spawnSync("sh", ["-c", cmd], {
    cwd, timeout: 30000, encoding: "utf8",
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, ...env },
  });
const why = (r: ReturnType<typeof run>) => `status ${r.status}\n${r.stdout}\n${r.stderr}`;
const scripts = (dir: string) => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

describe("the TypeScript and Node.js suite file", () => {
  it("is valid and has the four offline sections and instructions", () => {
    // the parser gives `modules: []` when a case names none
    expect(read.suite.selection.map((s) => ({ id: s.id, repo: s.repo, task: s.task, modules: s.modules, expect: s.expect })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "java-build-release", repo: "fixtures/java-library", task: "Raise the Java release in the build to 21 and fix the compiler warnings.", modules: [], expect: "not-offered" },
      { id: "java-null-check", repo: "fixtures/java-library", task: "Make insert reject null values and describe the exception in the Javadoc.", modules: [], expect: "not-offered" },
      { id: "java-remove-node", repo: "fixtures/java-library", task: "Add a method that removes a node from the tree and keep the types of the public methods.", modules: [], expect: "not-offered" },
      { id: "js-package-to-typescript", repo: "fixtures/js-package", task: "Convert src/notify.js to TypeScript.", modules: [], expect: "offered" },
      { id: "ts-service-config", repo: "fixtures/ts-service", task: "Read the port from the environment and refuse a value that is not a port number.", modules: [], expect: "offered" },
      { id: "ts-service-endpoint", repo: "fixtures/ts-service", task: "Add an endpoint that lists every item that is out of stock.", modules: [], expect: "offered" },
      { id: "ts-service-module", repo: "fixtures/ts-service", task: "Split the report writer into a formatter and a writer.", modules: ["src"], expect: "offered" },
      { id: "ts-service-types", repo: "fixtures/ts-service", task: "Replace the type assertion in the stock event parser with a check that runs.", modules: [], expect: "offered" },
    ]);
    expect(read.suite.conflicts).toEqual([{ id: "against-approved", with: "all" }]);
    expect(read.suite.tools).toEqual([{ id: "read-only", policy: { shell: false, network: false, filesystem: "read" } }]);
    expect([...read.profiles.keys()].sort()).toEqual(["fixtures/java-library", "fixtures/js-package", "fixtures/ts-service"]);
  });

  it("has the same context limits as the example suite", () => {
    const example = readEvaluationSuite(resolve("evals/skill-gate/suite.yaml"));
    if (example.state !== "ok") throw new Error(JSON.stringify(example));
    expect(read.suite.context).toEqual(example.suite.context);
  });
});

describe("selection", () => {
  for (const name of ["typescript", "nodejs"]) {
    it(`scores 1 for the built-in ${name} skill`, () => {
      expect(scoreSelection(builtin(name), read.suite.selection, read.profiles, [])).toEqual({ sample: 1, findings: [] });
    });
  }

  it("fails a skill outside the area", () => {
    const r = scoreSelection(builtin("kafka"), read.suite.selection, read.profiles, []);
    expect(r.sample).toBeLessThan(EVALUATION_THRESHOLDS.selection);
    expect(r.findings.length).toBeGreaterThan(0);
  });
});

describe("the fixtures", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

  for (const name of FIXTURES) {
    it(`${name} has no links, executables, endpoints or credentials`, () => {
      const dir = join(ROOT, "fixtures", name);
      expect(instructionFixtureHash(dir)).toHaveProperty("hash");
      for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        expect(e.isFile() || e.isDirectory(), `${e.name} is a file or folder`).toBe(true);
      }
      for (const file of walk(dir)) {
        expect(statSync(file).mode & 0o111, `${file} is not executable`).toBe(0);
        const text = readFileSync(file, "utf8");
        expect(credentialProblem(text), file).toBeUndefined();
        expect(text, file).not.toMatch(/https?:\/\//);
      }
    });
  }
});

describe("the fixtures' own tests", () => {
  it.skipIf(!process.features.typescript)("pass for ts-service", () => {
    const dir = copy("ts-service");
    expect(scripts(dir).test).toBe('node --test "test/*.test.ts"');
    const r = run(dir, scripts(dir).test!);
    expect(r.status, why(r)).toBe(0);
  });

  it("pass for js-package", () => {
    const dir = copy("js-package");
    expect(scripts(dir).test).toBe("node --test");
    const r = run(dir, scripts(dir).test!);
    expect(r.status, why(r)).toBe(0);
  });

  it("fail for js-package when send is not called", () => {
    const dir = copy("js-package");
    const file = join(dir, "src/notify.js");
    writeFileSync(file, readFileSync(file, "utf8").replace("await send(id);", "void id;"));
    expect(run(dir, "node --test").status).not.toBe(0);
  });

  const hasJavac = spawnSync("sh", ["-c", "javac -version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!hasJavac)("pass for java-library", () => {
    const dir = copy("java-library");
    const out = temp();
    const r = run(
      dir,
      'javac -d "$OUT" src/main/java/org/example/tree/Tree.java src/test/java/org/example/tree/TreeCheck.java && java -cp "$OUT" org.example.tree.TreeCheck',
      { OUT: out },
    );
    expect(r.status, why(r)).toBe(0);
  });
});

const IDS = ["await-notifications", "config-validation", "graceful-shutdown", "parse-stock-event", "report-stream-errors"];
const TS_IDS = IDS.filter((id) => id !== "await-notifications");
const src = (...lines: string[]) => lines.join("\n") + "\n";

const STOCK_HEAD = [
  'export interface StockEvent { type: "restock" | "sale"; sku: string; quantity: number }',
  'export type ParseResult = { ok: true; event: StockEvent } | { ok: false; error: string };',
];
const STOCK_TAIL = [
  "export function applyEvent(stock: Map<string, number>, event: StockEvent): Map<string, number> {",
  "  const next = new Map(stock);",
  '  next.set(event.sku, (next.get(event.sku) ?? 0) + (event.type === "restock" ? event.quantity : -event.quantity));',
  "  return next;",
  "}",
];
const REF_STOCK = src(
  ...STOCK_HEAD,
  "export function parseStockEvent(input: unknown): ParseResult {",
  '  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "not an object" };',
  "  const o = input as Record<string, unknown>;",
  '  if (o.type !== "restock" && o.type !== "sale") return { ok: false, error: "bad type" };',
  '  if (typeof o.sku !== "string" || o.sku === "") return { ok: false, error: "bad sku" };',
  '  if (typeof o.quantity !== "number" || !Number.isInteger(o.quantity) || o.quantity <= 0) return { ok: false, error: "bad quantity" };',
  "  return { ok: true, event: { type: o.type, sku: o.sku, quantity: o.quantity } };",
  "}",
  ...STOCK_TAIL,
);
const WRONG_STOCK = src(
  ...STOCK_HEAD,
  "export function parseStockEvent(input: unknown): ParseResult {",
  '  const o = input as StockEvent;',
  '  if (o.type !== "restock" && o.type !== "sale") throw new Error("bad type");',
  '  if (typeof o.sku !== "string" || o.sku === "") throw new Error("bad sku");',
  '  if (!Number.isInteger(o.quantity) || o.quantity <= 0) throw new Error("bad quantity");',
  "  return { ok: true, event: { type: o.type, sku: o.sku, quantity: o.quantity } };",
  "}",
  ...STOCK_TAIL,
);

const CONFIG_HEAD = [
  "export interface Config { host: string; port: number }",
  "export function loadConfig(env: Record<string, string | undefined>): Config {",
];
const REF_CONFIG = src(
  ...CONFIG_HEAD,
  '  let port = 8080;',
  "  if (env.PORT !== undefined) {",
  "    const n = Number(env.PORT);",
  "    if (!/^\\d{1,5}$/.test(env.PORT) || n < 1 || n > 65535) throw new Error(\"PORT must be a port number\");",
  "    port = n;",
  "  }",
  '  if (env.HOST === "") throw new Error("HOST must not be empty");',
  '  return { host: env.HOST ?? "127.0.0.1", port };',
  "}",
);
const WRONG_CONFIG = src(
  ...CONFIG_HEAD,
  '  const port = Number.parseInt(env.PORT ?? "8080", 10);',
  '  if (!(port >= 1 && port <= 65535)) throw new Error("PORT must be a port number");',
  '  if (env.HOST === "") throw new Error("HOST must not be empty");',
  '  return { host: env.HOST ?? "127.0.0.1", port };',
  "}",
);

const SHUTDOWN_HEAD = [
  'export interface SignalSource { on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown; exit(code: number): void }',
  "export interface Closable { close(callback: (err?: Error) => void): unknown }",
  "export function handleSignals(proc: SignalSource, server: Closable): void {",
  "  let closing = false;",
];
const REF_SHUTDOWN = src(
  ...SHUTDOWN_HEAD,
  "  const stop = () => {",
  "    if (closing) return;",
  "    closing = true;",
  "    server.close((err) => proc.exit(err ? 1 : 0));",
  "  };",
  '  proc.on("SIGTERM", stop);',
  '  proc.on("SIGINT", stop);',
  "}",
);
const WRONG_SHUTDOWN = src(
  ...SHUTDOWN_HEAD,
  "  const stop = () => {",
  "    if (closing) return;",
  "    closing = true;",
  "    server.close(() => {});",
  "    proc.exit(0);",
  "  };",
  '  proc.on("SIGTERM", stop);',
  '  proc.on("SIGINT", stop);',
  "}",
);

const REPORT_HEAD = [
  'import type { Writable } from "node:stream";',
  'import { pipeline } from "node:stream/promises";',
  "export interface Row { sku: string; quantity: number }",
  "export function formatRow(row: Row): string {",
  "  return row.sku + \",\" + row.quantity + \"\\n\";",
  "}",
];
const REF_REPORT = src(
  ...REPORT_HEAD,
  "export async function writeReport(rows: AsyncIterable<Row>, out: Writable): Promise<void> {",
  "  async function* lines() {",
  '    yield "sku,quantity\\n";',
  "    for await (const row of rows) yield formatRow(row);",
  "  }",
  "  await pipeline(lines(), out);",
  "}",
);
const WRONG_REPORT = src(
  ...REPORT_HEAD,
  "export async function writeReport(rows: AsyncIterable<Row>, out: Writable): Promise<void> {",
  "  try {",
  '    out.write("sku,quantity\\n");',
  "    for await (const row of rows) out.write(formatRow(row));",
  "  } finally {",
  "    out.end();",
  "  }",
  "  await new Promise((resolve, reject) => { out.on(\"finish\", resolve); out.on(\"error\", reject); });",
  "}",
);
// resolves before the sink has finished
const EARLY_REPORT = src(
  ...REPORT_HEAD,
  "export async function writeReport(rows: AsyncIterable<Row>, out: Writable): Promise<void> {",
  '  out.write("sku,quantity\\n");',
  "  for await (const row of rows) out.write(formatRow(row));",
  "  out.end();",
  "  await new Promise((resolve) => setImmediate(resolve));",
  "}",
);

const REF_NOTIFY = src(
  "export async function notifyAll(ids, send) {",
  "  let next = 0;",
  "  const worker = async () => {",
  "    while (next < ids.length) await send(ids[next++]);",
  "  };",
  "  await Promise.all([worker(), worker()]);",
  "}",
);
const WRONG_NOTIFY = src("export async function notifyAll(ids, send) {", "  await Promise.all(ids.map((id) => send(id)));", "}");

const checks = () => read.suite.instructions!.scenarios.map((s) => ({ id: s.id, fixture: s.repo.replace("fixtures/", ""), check: s.check }));
const statuses = (dirs: Record<string, string>) => checks().map((c) => ({ id: c.id, status: run(dirs[c.fixture]!, c.check).status }));
const fixtures = (files: Record<string, string>) => {
  const dirs = { "ts-service": copy("ts-service"), "js-package": copy("js-package") };
  for (const [name, text] of Object.entries(files)) {
    const [fixture, ...rest] = name.split("/");
    writeFileSync(join(dirs[fixture as keyof typeof dirs], ...rest), text);
  }
  return dirs;
};

describe("instructions", () => {
  const ins = read.suite.instructions!;

  it("has five offline scenarios that are not mandatory", () => {
    expect(ins.mandatory).toBe(false);
    expect(ins.repeat).toBe(4);
    expect(ins.scenarios.map((s) => s.id).sort()).toEqual(IDS);
    expect(ins.scenarios.length).toBeGreaterThanOrEqual(3);
    expect(ins.scenarios.length).toBeLessThanOrEqual(6);
    for (const s of ins.scenarios) {
      expect(s.policy, s.id).toEqual({ shell: false, network: false, filesystem: "write" });
      expect(s.timeout_sec, s.id).toBe(600);
      expect(s.repo, s.id).toBe(s.id === "await-notifications" ? "fixtures/js-package" : "fixtures/ts-service");
    }
  });

  it("has checks that are one folded node line", () => {
    for (const s of ins.scenarios) {
      expect(s.check.startsWith("node --input-type=module -e '"), s.id).toBe(true);
      expect(s.check.endsWith("'"), s.id).toBe(true);
      expect(s.check.split("'").length - 1, s.id).toBe(2);
      expect(s.check.length, s.id).toBeLessThan(2000);
      expect(s.check, s.id).not.toContain("\n");
    }
  });

  const offers = (name: string) => {
    const pkg = loadSkillPackage(join(BUILTIN_SKILLS, name));
    const entry: RegisteredSkill = { key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: "admin", label: "test", dir: "", active: true, trust: "approved", pin: "pinned", digest: pkg.digest, pkg };
    return scenarioOffers(entry, ROOT, ins);
  };

  it("offers the built-in nodejs skill in every scenario", () => {
    const o = offers("nodejs");
    expect(o).toHaveLength(5);
    expect(o.every((x) => x.offered)).toBe(true);
  });

  it("offers the built-in typescript skill in the four ts-service scenarios only", () => {
    expect(offers("typescript").filter((x) => x.offered).map((x) => x.id).sort()).toEqual(TS_IDS);
  });
});

describe.skipIf(!process.features.typescript)("the instructions checks", () => {
  it("fail on the unchanged fixtures, also with keywords in comments", () => {
    const dirs = fixtures({});
    expect(statuses(dirs).filter((x) => x.status !== 1)).toEqual([]);
    const words = "\n// ok: true event error closing proc.exit(0) server.close pipeline finished destroy Promise.all /^\\d{1,5}$/ 65535 SIGINT\n";
    for (const dir of Object.values(dirs)) {
      for (const f of readdirSync(join(dir, "src"))) appendFileSync(join(dir, "src", f), words);
    }
    expect(statuses(dirs).filter((x) => x.status !== 1)).toEqual([]);
  });

  it("pass on a reference solution", () => {
    const dirs = fixtures({
      "ts-service/src/stock.ts": REF_STOCK, "ts-service/src/config.ts": REF_CONFIG, "ts-service/src/shutdown.ts": REF_SHUTDOWN,
      "ts-service/src/report.ts": REF_REPORT, "js-package/src/notify.js": REF_NOTIFY,
    });
    expect(statuses(dirs).filter((x) => x.status !== 0)).toEqual([]);
    const r = run(dirs["ts-service"], scripts(dirs["ts-service"]).test!);
    expect(r.status, why(r)).toBe(0);
  });

  it("fail on typical wrong solutions", () => {
    const wrong = {
      "ts-service/src/stock.ts": WRONG_STOCK, "ts-service/src/config.ts": WRONG_CONFIG, "ts-service/src/shutdown.ts": WRONG_SHUTDOWN,
      "ts-service/src/report.ts": WRONG_REPORT, "js-package/src/notify.js": WRONG_NOTIFY,
    };
    expect(statuses(fixtures(wrong)).filter((x) => x.status !== 1)).toEqual([]);
    const early = statuses(fixtures({ ...wrong, "ts-service/src/report.ts": EARLY_REPORT }));
    expect(early.find((x) => x.id === "report-stream-errors")?.status).toBe(1);
  });

  it("exit 2 when the code under test never settles", () => {
    const dirs = fixtures({
      "ts-service/src/report.ts": src("export function writeReport() { return new Promise(() => {}); }"),
      "js-package/src/notify.js": src("export function notifyAll() { return new Promise(() => {}); }"),
    });
    const got = statuses(dirs).filter((x) => x.id === "report-stream-errors" || x.id === "await-notifications");
    expect(got.map((x) => x.status)).toEqual([2, 2]);
  });
});
