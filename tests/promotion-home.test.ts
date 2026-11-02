import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { COMPONENTS_USAGE, componentsCommand } from "../src/promotion/cli.js";
import { coverPack } from "./fixtures/policy-pack.js";

const open = { dataClassification: "internal", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none" };
const profile = (id: string, targets = ["src/*"], extra: object = {}) => ({ version: 1, profile: { id, version: "1" }, grants: [{ kind: "files", operations: ["read"], targets, ...open }], ...extra });
const FLOW = "name: demo\nsteps:\n  - id: one\n    type: shell\n    run: echo one\n";
const SELECTOR = { budget: { maxSources: 10, maxSourceBytes: 1000, maxTotalBytes: 5000 } };

let home: string;
let builtin: string;
let saved: string | undefined;
const put = (rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const run = (args: string[] = [], o: { waitMs?: number } = {}) => {
  const lines: string[] = [];
  const code = componentsCommand(args, (l) => void lines.push(l), { builtinFlowsDir: builtin, ...o });
  return { code, lines };
};
const tree = (dir = home): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? [d.name + "/", ...tree(join(dir, d.name)).map((x) => `${d.name}/${x}`)] : [d.name]));

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  const base = mkdtempSync(join(tmpdir(), "components-home-"));
  home = join(base, "home");
  builtin = join(base, "builtin");
  mkdirSync(home);
  mkdirSync(builtin);
  writeFileSync(join(builtin, "base.yaml"), FLOW.replace("demo", "base"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  process.env.FACTORY_HOME = saved;
  rmSync(join(home, ".."), { recursive: true, force: true });
});

describe("scf components", () => {
  it("lists built-ins and model routes in an empty home, and writes nothing", () => {
    const { code, lines } = run();
    expect(code).toBe(0);
    expect(lines).toHaveLength(3);
    const gov = " owner=- risk=low lifecycle=active status=unapproved$";
    expect(lines[0]).toMatch(new RegExp(`^COMPONENT flow base v0 sha256:[0-9a-f]{64} builtin${gov}`));
    expect(lines[1]).toMatch(new RegExp(`^COMPONENT policy-pack foundry\\.baseline v\\S+ sha256:[0-9a-f]{64} builtin${gov}`));
    expect(lines[2]).toMatch(new RegExp(`^COMPONENT model-routes default v- sha256:[0-9a-f]{64} unrecorded${gov}`));
    expect(tree()).toEqual([]);
  });

  it("lists a home flow before the built-in flow of the same name", () => {
    put("flows/base.yaml", FLOW.replace("demo", "base").replace("echo one", "echo home"));
    const flows = run(["flow"]).lines;
    expect(flows).toHaveLength(2);
    expect(flows[0]).not.toContain("builtin");
    expect(flows[1]).toMatch(/ builtin /);
  });

  it("reports a pack whose file name differs from its id, and ignores the last-known-good folder and temp files", () => {
    put("policies/cover.json", JSON.stringify(coverPack("cover", "1.4.0")));
    put("policies/other.json", JSON.stringify(coverPack("cover", "1")));
    put("policies/last-known-good/cover.json", JSON.stringify(coverPack("cover", "1")));
    put("policies/.cover.json.abc.tmp", "{");
    const { code, lines } = run(["policy-pack"]);
    expect(code).toBe(1);
    expect(lines.filter((l) => l.startsWith("COMPONENT"))).toHaveLength(2);
    expect(lines.find((l) => l.includes("policy-pack cover "))).toMatch(/ v1\.4\.0 /);
    expect(lines).toContain("! policy-pack other: id differs from the file name");
    expect(lines.join("\n")).not.toContain(home);
  });

  it("gives a problem line for each bad tool profile, without file content or paths", () => {
    put("tool-profiles/good.yaml", stringify(profile("good")));
    put("tool-profiles/wrong.yaml", stringify(profile("other")));
    put("tool-profiles/broken.yaml", "grants: [SECRET-YAML\n  : : {");
    put("tool-profiles/Bad Id.yaml", stringify(profile("x")));
    put("tool-profiles/unknown.yaml", stringify({ ...profile("unknown"), SECRETKEY: 1 }));
    put("tool-profiles/nogrant.yaml", stringify(profile("nogrant", ["src/*"], { descriptions: { "shell.run": "SECRET-TEXT" } })));
    const { code, lines } = run(["tool-profile"]);
    const out = lines.join("\n");
    expect(code).toBe(1);
    expect(lines.filter((l) => l.startsWith("COMPONENT"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("!"))).toHaveLength(5);
    expect(out).toContain("! tool-profile wrong: profile id differs from the file name");
    expect(out).toContain("! tool-profile broken: is not valid YAML");
    expect(out).toContain("! tool-profile nogrant: descriptions: names a tool the profile does not grant");
    expect(out).toContain("! tool-profile unknown: (root): unknown field");
    for (const secret of ["SECRET", home, "Bad Id"]) expect(out).not.toContain(secret);
  });

  it("does not repeat flow content in a problem", () => {
    put("flows/bad.yaml", "name: SECRET-NAME\nsteps: [: SECRET-STEP");
    put("flows/odd.yaml", "name: odd\nSECRETFIELD: 1\nsteps: []\n");
    const out = run(["flow"]).lines.join("\n");
    expect(out).toContain("! flow bad: is not valid YAML");
    expect(out).toContain("! flow odd:");
    expect(out).not.toContain("SECRET");
  });

  it("does not repeat values from schema messages: bad variable defaults, duplicate choices, duplicate step ids", () => {
    const steps = "steps:\n  - id: SECRET-ID\n    type: shell\n    run: x\n  - id: SECRET-ID\n    type: shell\n    run: y\n";
    put("flows/dupe.yaml", `name: dupe\n${steps}`);
    put("flows/num.yaml", `name: num\nvars:\n  n: SECRET-DEFAULT\nvar_info:\n  n: { kind: number }\nsteps:\n  - { id: a, type: shell, run: x }\n`);
    put("flows/choice.yaml", `name: choice\nvars:\n  c: a\nvar_info:\n  c: { kind: choice, choices: [SECRET-CHOICE, SECRET-CHOICE] }\nsteps:\n  - { id: a, type: shell, run: x }\n`);
    const { lines } = run(["flow"]);
    const problems = lines.filter((l) => l.startsWith("! flow"));
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(lines.join("\n")).not.toContain("SECRET");
  });

  it("counts versions only when told to record, and keeps the number of a hash seen before", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    const line = (args: string[]) => run(args).lines.find((l) => l.startsWith("COMPONENT tool-profile"))!;
    expect(line(["tool-profile"])).toMatch(/ v- sha256:[0-9a-f]{64} unrecorded /);
    expect(tree()).toEqual(["tool-profiles/", "tool-profiles/p.yaml"]);
    expect(line(["record", "tool-profile"])).toMatch(/ v1 sha256:/);
    put("tool-profiles/p.yaml", stringify(profile("p", ["src/*", "docs/*"])));
    expect(line(["tool-profile"])).toMatch(/ v- .* unrecorded /);
    expect(line(["record", "tool-profile"])).toMatch(/ v2 sha256:/);
    put("tool-profiles/p.yaml", stringify(profile("p")));
    expect(line(["record", "tool-profile"])).toMatch(/ v1 sha256:/);
    expect(statSync(join(home, "promotions")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "promotions/versions.json")).mode & 0o777).toBe(0o600);
    expect(tree().filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the file alone when nothing is new", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    run(["record"]);
    const file = join(home, "promotions/versions.json");
    const before = readFileSync(file, "utf8");
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));
    const { code } = run(["record"]);
    expect(code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mtimeMs).toBe(1_000_000);
    expect(JSON.parse(before).components["model-routes/default"]).toHaveLength(1);
  });

  it("refuses to record a book it could not read back, and keeps the old file", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    // Every hash takes 74 bytes in the file; fill it to within 74 bytes of the limit, so one more key does not fit.
    const hashes = Array.from({ length: Math.floor((4 << 20) / 74) - 2 }, (_, i) => i.toString(16).padStart(64, "0"));
    const book = () => JSON.stringify({ version: 1, components: { "tool-profile/big": hashes } }, null, 2) + "\n";
    while (Buffer.byteLength(book()) + 74 < 4 << 20) hashes.push(hashes.length.toString(16).padStart(64, "0"));
    const text = book();
    expect(Buffer.byteLength(text)).toBeLessThan(4 << 20);
    put("promotions/versions.json", text);
    const r = run(["record", "tool-profile"]);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe("! tool-profile p: promotions/versions.json would be larger than 4 MiB; nothing was recorded");
    expect(readFileSync(join(home, "promotions/versions.json"), "utf8")).toBe(text);
  });

  it("does not overwrite an invalid versions.json; other kinds still print", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    put("promotions/versions.json", "{ not json SECRET");
    for (const args of [[], ["record"]]) {
      const { code, lines } = run(args);
      expect(code).toBe(1);
      expect(lines.some((l) => l.startsWith("COMPONENT policy-pack"))).toBe(true);
      expect(lines).toContain("! tool-profile p: promotions/versions.json is not valid; it is not changed, fix or restore it");
      expect(lines).toContain("! model-routes default: promotions/versions.json is not valid; it is not changed, fix or restore it");
    }
    expect(readFileSync(join(home, "promotions/versions.json"), "utf8")).toBe("{ not json SECRET");
  });

  it("refuses a linked promotions folder, also when it holds the hash already", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    run(["record"]);
    const real = join(home, "..", "elsewhere");
    mkdirSync(real);
    writeFileSync(join(real, "versions.json"), readFileSync(join(home, "promotions/versions.json")));
    rmSync(join(home, "promotions"), { recursive: true });
    symlinkSync(real, join(home, "promotions"));
    const before = readFileSync(join(real, "versions.json"), "utf8");
    for (const args of [["tool-profile"], ["record", "tool-profile"]]) {
      const { code, lines } = run(args);
      expect(code).toBe(1);
      expect(lines).toEqual(["! tool-profile p: promotions is a link or not a folder", "! promotions is a link or not a folder"]);
    }
    expect(readdirSync(real)).toEqual(["versions.json"]);
    expect(readFileSync(join(real, "versions.json"), "utf8")).toBe(before);
  });

  it("reports a held data-folder lock and writes nothing", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    put("auth.lock/pid", String(process.pid));
    const { code, lines } = run(["record", "tool-profile"], { waitMs: 0 });
    expect(code).toBe(1);
    expect(lines).toEqual(["! tool-profile p: another scf command holds the data-folder lock; try again"]);
    expect(tree()).not.toContain("promotions/");
  });

  it("lists only the kind asked for, and records only that kind", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    put("context-selectors/s.yaml", stringify(SELECTOR));
    const { lines } = run(["record", "tool-profile"]);
    expect(lines).toHaveLength(1);
    const book = JSON.parse(readFileSync(join(home, "promotions/versions.json"), "utf8"));
    expect(Object.keys(book.components)).toEqual(["tool-profile/p"]);
  });

  it("refuses a wrong call", () => {
    for (const args of [["bogus"], ["record", "record"], ["flow", "policy-pack"], ["record", "flow", "x"]]) expect(() => run(args), args.join(" ")).toThrow(COMPONENTS_USAGE);
  });

  it("gives a context selector the same line with a comment and another key order", () => {
    put("context-selectors/s.yaml", stringify(SELECTOR));
    const a = run(["context-selector"]).lines;
    put("context-selectors/s.yaml", "# note\nbudget:\n  maxTotalBytes: 5000 # total\n  maxSourceBytes: 1000\n  maxSources: 10\nclassification: internal\n");
    expect(run(["context-selector"]).lines).toEqual(a);
    put("context-selectors/s.yaml", "budget: { maxSources: 0, maxSourceBytes: 1, maxTotalBytes: 1 }\n");
    expect(run(["context-selector"]).lines).toEqual([expect.stringMatching(/^! context-selector s: budget\.maxSources: /)]);
  });

  it("reports a config.yaml that is not valid", () => {
    put("config.yaml", "router: 5\n");
    expect(run(["model-routes"]).lines).toEqual(["! model-routes default: config.yaml could not be read or is not valid"]);
  });
});
