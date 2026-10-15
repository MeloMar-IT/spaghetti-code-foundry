import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialProblem } from "../src/skills/credential-scan.js";
import { parseSourceProfiles, readSourceProfiles } from "../src/skills/source-profiles.js";
import { hasUnsafeChar } from "../src/skills/sources.js";

// Samples are built from pieces so that tools/secret-scan finds nothing in this file.
const TOKEN = "sk-" + "ant-" + "abcdefghijklmnopqrst";
const LONG_TOKEN = "sk-" + "ant-" + "a".repeat(120);
const AT = "@";
const PW = "hunter" + "22pass";
const URL_USER = "https://user" + AT + "example.com/x";
const URL_USER_PW = "https://user:pw" + AT + "example.com";
const URL_CHANGEME = "https://user:changeme" + AT + "example.com/x";
const URL_HUNTER = "https://user:" + PW + AT + "host.io/x";
const DB_URL = "postgres" + "://user:" + PW + AT + "db/x";
const ESC = "\u001b[2J";
const RLO = "‮";
const SHIPPED = resolve(import.meta.dirname, "..", "skill-source-profiles.yaml");

const skill = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "pdf-reader",
  class: "portable",
  capabilities: ["pdf-read", "pdf-write"],
  high_risk: ["pdf-write"],
  requires: { config: ["DATABASE_URL", "feature-flag"], tools: ["shell", "write"], connectors: ["github"], live_services: ["SUPABASE_ACCESS_TOKEN"] },
  evaluations: ["selection"],
  ...o,
});
const source = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "example-skills", skills: [skill()], ...o });
const file = (...sources: Record<string, unknown>[]): Record<string, unknown> => ({ schema: 1, sources, exclusive: ["pdf-write"] });
const check = (raw: unknown) => parseSourceProfiles(raw).problems;
const text = (ps: { where: string; message: string }[]) => ps.map((p) => `${p.where}: ${p.message}`).join("\n");
const withSkill = (o: Record<string, unknown>) => file(source({ skills: [skill(o)] }));
const withRequires = (r: Record<string, unknown>) => withSkill({ requires: r });
const SK = "sources[0] (example-skills) skills[0] (pdf-reader)";

describe("parseSourceProfiles: accepted", () => {
  it("accepts a full valid file and keeps the values", () => {
    const r = parseSourceProfiles(file(source()));
    expect(r.problems).toEqual([]);
    const s = r.profiles!.sources[0]!.skills[0]!;
    expect(s.class).toBe("portable");
    expect(s.high_risk).toEqual(["pdf-write"]);
    expect(s.requires.config).toEqual(["DATABASE_URL", "feature-flag"]);
    expect(s.requires.live_services).toEqual(["SUPABASE_ACCESS_TOKEN"]);
    expect(r.profiles!.exclusive).toEqual(["pdf-write"]);
  });
  it("defaults left-out lists to empty", () => {
    const r = parseSourceProfiles({ schema: 1, sources: [{ id: "a", skills: [{ name: "b", class: "vendor", capabilities: ["c"] }] }] });
    expect(r.problems).toEqual([]);
    expect(r.profiles!.exclusive).toEqual([]);
    const s = r.profiles!.sources[0]!.skills[0]!;
    expect(s.high_risk).toEqual([]);
    expect(s.evaluations).toEqual([]);
    expect(s.requires).toEqual({ config: [], tools: [], connectors: [], live_services: [] });
  });
  it("accepts an empty list of sources, with and without exclusive", () => {
    expect(parseSourceProfiles({ schema: 1, sources: [] }).profiles!.sources).toEqual([]);
    expect(check({ schema: 1, sources: [], exclusive: [] })).toEqual([]);
  });
  it("accepts the same skill name in two sources and one capability in two vendor skills", () => {
    const v = (name: string) => skill({ name, class: "vendor" });
    expect(check(file(source({ skills: [v("a"), v("b")] }), source({ id: "other", skills: [v("a")] })))).toEqual([]);
  });
});

describe("parseSourceProfiles: rejected", () => {
  it.each<[string, unknown, string, string]>([
    ["root not a map", [], "file", "must be a map"],
    ["root unknown key", { ...file(source()), extra: 1 }, "file", 'unknown key "extra"'],
    ["schema 2", { schema: 2, sources: [] }, "schema", "schema must be 1"],
    ["sources missing", { schema: 1 }, "sources", "must be a list of sources"],
    ["sources not a list", { schema: 1, sources: {} }, "sources", "must be a list of sources"],
    ["201 sources", { schema: 1, sources: Array.from({ length: 201 }, () => ({})) }, "sources", "at most 200"],
    ["source not a map", file("x" as never), "sources[0]", "must be a map"],
    ["source unknown key", file(source({ extra: 1 })), "sources[0] (example-skills)", 'unknown key "extra"'],
    ["source id missing", file(source({ id: undefined })), "sources[0] id", "is required"],
    ["source id bad", file(source({ id: "Bad_Id" })), "sources[0] id", "lower-case slug"],
    ["source id twice", file(source(), source()), "sources[1] (example-skills) id", "already used by sources[0]"],
    ["skills missing", file(source({ skills: undefined })), "sources[0] (example-skills) skills", "is required"],
    ["skills empty", file(source({ skills: [] })), "sources[0] (example-skills) skills", "1 to 100"],
    ["101 skills", file(source({ skills: Array.from({ length: 101 }, () => skill()) })), "sources[0] (example-skills) skills", "1 to 100"],
    ["skill not a map", file(source({ skills: [3] })), "sources[0] (example-skills) skills[0]", "must be a map"],
    ["skill unknown key", withSkill({ extra: 1 }), SK, 'unknown key "extra"'],
    ["name missing", withSkill({ name: undefined }), "sources[0] (example-skills) skills[0] name", "is required"],
    ["name bad", withSkill({ name: "Bad Name" }), "sources[0] (example-skills) skills[0] name", "lower-case slug"],
    ["name twice", file(source({ skills: [skill(), skill()] })), "sources[0] (example-skills) skills[1] (pdf-reader) name", "already used by skills[0]"],
    ["class missing", withSkill({ class: undefined }), `${SK} class`, "is required"],
    ["class official", withSkill({ class: "official" }), `${SK} class`, "must be one of portable, vendor"],
    ["class number", withSkill({ class: 3 }), `${SK} class`, "must be one of portable, vendor"],
    ["capabilities missing", withSkill({ capabilities: undefined, high_risk: [] }), `${SK} capabilities`, "is required"],
    ["capabilities empty", withSkill({ capabilities: [], high_risk: [] }), `${SK} capabilities`, "1 to 32"],
    ["33 capabilities", withSkill({ capabilities: Array.from({ length: 33 }, (_, i) => `c${i}`), high_risk: [] }), `${SK} capabilities`, "1 to 32"],
    ["capability not a slug", withSkill({ capabilities: ["Bad_Cap"], high_risk: [] }), `${SK} capabilities[0]`, "lower-case slug"],
    ["capability twice", withSkill({ capabilities: ["a", "a"], high_risk: [] }), `${SK} capabilities[1]`, '"a" is listed twice'],
    ["capability number", withSkill({ capabilities: [3], high_risk: [] }), `${SK} capabilities[0]`, "must be text"],
    ["capability null", withSkill({ capabilities: [null], high_risk: [] }), `${SK} capabilities[0]`, "must not be blank"],
    ["high_risk outside", withSkill({ high_risk: ["other"] }), `${SK} high_risk[0]`, "not one of the skill's capabilities"],
    ["high_risk twice", withSkill({ high_risk: ["pdf-write", "pdf-write"] }), `${SK} high_risk[1]`, "listed twice"],
    ["requires not a map", withSkill({ requires: [] }), `${SK} requires`, "must be a map"],
    ["requires unknown key", withRequires({ extra: [] }), `${SK} requires`, 'unknown key "extra"'],
    ["tool exec", withRequires({ tools: ["exec"] }), `${SK} requires tools[0]`, 'unknown tool "exec"; allowed: shell, network, write'],
    ["tool twice", withRequires({ tools: ["shell", "shell"] }), `${SK} requires tools[1]`, "listed twice"],
    ["17 connectors", withRequires({ connectors: Array.from({ length: 17 }, (_, i) => `c${i}`) }), `${SK} requires connectors`, "at most 16"],
    ["connector not a slug", withRequires({ connectors: ["Bad_One"] }), `${SK} requires connectors[0]`, "lower-case slug"],
    ["config twice", withRequires({ config: ["DATABASE_URL", "DATABASE_URL"] }), `${SK} requires config[1]`, "is listed twice"],
    ["evaluation not a slug", withSkill({ evaluations: ["Bad_One"] }), `${SK} evaluations[0]`, "lower-case slug"],
    ["evaluation twice", withSkill({ evaluations: ["a", "a"] }), `${SK} evaluations[1]`, "listed twice"],
    ["17 evaluations", withSkill({ evaluations: Array.from({ length: 17 }, (_, i) => `e${i}`) }), `${SK} evaluations`, "at most 16"],
    ["exclusive not a list", { ...file(source()), exclusive: "a" }, "exclusive", "at most 200"],
    ["exclusive bad slug", { ...file(source()), exclusive: ["Bad_One"] }, "exclusive[0]", "lower-case slug"],
    ["exclusive twice", { ...file(source()), exclusive: ["a", "a"] }, "exclusive[1]", "listed twice"],
    ["201 exclusive", { ...file(source()), exclusive: Array.from({ length: 201 }, (_, i) => `e${i}`) }, "exclusive", "at most 200"],
  ])("%s", (_name, raw, where, part) => {
    const ps = check(raw);
    expect(ps.some((p) => p.where === where && p.message.includes(part)), text(ps)).toBe(true);
  });

  it.each([
    ["a database address", "postgres://db.internal.corp:5432/x"],
    ["a url with user info", URL_HUNTER],
    ["a key=value", "KEY=value"],
    ["a name with a space", "a b"],
    ["a lower snake name", "lower_snake"],
    ["a 65 character name", "A".repeat(65)],
  ])("config and live_services refuse %s and never show it", (_n, value) => {
    for (const field of ["config", "live_services"]) {
      const ps = check(withRequires({ [field]: [value] }));
      expect(ps.length).toBeGreaterThan(0);
      expect(text(ps)).not.toContain(value);
    }
  });

  it("names the first place when portable and vendor skills share a capability", () => {
    const same = file(source({ skills: [skill(), skill({ name: "other", class: "vendor" })] }));
    expect(text(check(same))).toContain("sources[0] (example-skills) skills[1] (other) capabilities[0]: capability \"pdf-read\" is also used by a portable skill (sources[0] (example-skills) skills[0] (pdf-reader))");
    const across = file(source(), source({ id: "second", skills: [skill({ class: "vendor" })] }));
    expect(text(check(across))).toContain("is also used by a portable skill (sources[0] (example-skills) skills[0] (pdf-reader))");
  });

  it("points to the original index after an invalid or repeated entry", () => {
    const risk = check(withSkill({ capabilities: ["a"], high_risk: [42, "other"] }));
    expect(risk.some((p) => p.where === `${SK} high_risk[1]` && p.message.includes("not one of"))).toBe(true);
    const two = file(source({ skills: [skill({ capabilities: ["x"], high_risk: [] }), skill({ name: "other", class: "vendor", capabilities: [3, "y", "y", "x"], high_risk: [] })] }));
    expect(check(two).some((p) => p.where.endsWith("skills[1] (other) capabilities[3]") && p.message.includes("also used by a portable"))).toBe(true);
  });

  it("reports several faults at once", () => {
    const ps = check({ schema: 3, sources: [source({ id: "Bad_Id", skills: [skill({ class: "x", capabilities: [] })] })] });
    expect(ps.length).toBeGreaterThanOrEqual(3);
  });

  it("answers quickly on a large invalid scalar", () => {
    const start = Date.now();
    const ps = check(withRequires({ tools: ["a".repeat(100_000)], config: ["a".repeat(100_000) + "!"] }));
    expect(ps.length).toBe(2);
    expect(Date.now() - start).toBeLessThan(1500);
  });
});

describe("parseSourceProfiles: output safety", () => {
  const places: [string, (v: string) => unknown][] = [
    ["name", (v) => withSkill({ name: v })],
    ["class", (v) => withSkill({ class: v })],
    ["capability", (v) => withSkill({ capabilities: [v], high_risk: [] })],
    ["tools", (v) => withRequires({ tools: [v] })],
    ["config", (v) => withRequires({ config: [v] })],
    ["unknown key", (v) => withSkill({ [v]: 1 })],
    ["live_services", (v) => withRequires({ live_services: [v] })],
    ["connectors", (v) => withRequires({ connectors: [v] })],
    ["evaluations", (v) => withSkill({ evaluations: [v] })],
    ["high_risk", (v) => withSkill({ high_risk: [v] })],
    ["source id", (v) => file(source({ id: v }))],
    ["exclusive", (v) => ({ ...file(source()), exclusive: [v] })],
    ["file key", (v) => ({ ...file(source()), [v]: 1 })],
    ["source key", (v) => file(source({ [v]: 1 }))],
    ["requires key", (v) => withRequires({ [v]: 1 })],
  ];
  const safe = (raw: unknown) => {
    const ps = check(raw);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(credentialProblem(`${p.where}: ${p.message}`)).toBeUndefined();
      expect(hasUnsafeChar(`${p.where}: ${p.message}`)).toBe(false);
    }
    return text(ps);
  };
  it.each(places)("a token in %s is never printed", (_n, make) => {
    expect(safe(make(TOKEN))).not.toContain(TOKEN);
    const out = safe(make(LONG_TOKEN));
    expect(out).not.toContain(LONG_TOKEN.slice(0, 20));
  });
  it.each(places)("ESC and RLO characters in %s are not printed", (_n, make) => {
    safe(make("a" + ESC + "b"));
    safe(make("a" + RLO + "b"));
  });
  const urls = [URL_USER, URL_USER_PW, URL_CHANGEME, DB_URL];
  const cases = urls.flatMap((u) => places.map((p) => [u, p[0], p[1]] as const));
  it.each(cases)("a url with user info (%s) in %s is never printed", (url, _n, make) => {
    const out = safe(make(url));
    expect(out).not.toContain(url);
    expect(out).not.toContain("user" + AT);
    expect(out).not.toContain(PW);
    expect(out).not.toContain("pw" + AT);
    expect(out).not.toContain("changeme");
  });
});

describe("readSourceProfiles", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "profiles-"));
  const GOOD = "schema: 1\nsources:\n  - id: a\n    skills:\n      - {name: b, class: vendor, capabilities: [c]}\n";
  it("returns none for a missing file", () => {
    expect(readSourceProfiles(join(dir(), "nope.yaml"))).toEqual({ state: "none" });
  });
  it("refuses a symbolic link", () => {
    const d = dir();
    writeFileSync(join(d, "real.yaml"), GOOD);
    symlinkSync(join(d, "real.yaml"), join(d, "link.yaml"));
    const r = readSourceProfiles(join(d, "link.yaml"));
    expect(r.state).toBe("invalid");
    expect(r.state === "invalid" && r.problems[0]!.message).toContain("symbolic link");
  });
  it("refuses a folder", () => {
    const d = dir();
    mkdirSync(join(d, "sub"));
    expect(readSourceProfiles(join(d, "sub")).state).toBe("invalid");
  });
  it("refuses a file over the size limit", () => {
    const d = dir();
    writeFileSync(join(d, "p.yaml"), GOOD);
    const r = readSourceProfiles(join(d, "p.yaml"), 10);
    expect(r.state === "invalid" && r.problems[0]!.message).toBe("is larger than 10 bytes");
  });
  it("does not repeat the content of broken YAML", () => {
    const d = dir();
    writeFileSync(join(d, "p.yaml"), `schema: 1\nx: [${TOKEN}\n`);
    const r = readSourceProfiles(join(d, "p.yaml"));
    expect(r.state).toBe("invalid");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it("refuses a YAML alias", () => {
    const d = dir();
    writeFileSync(join(d, "p.yaml"), "schema: 1\nsources: []\nexclusive: &a [x]\nmore: *a\n");
    expect(readSourceProfiles(join(d, "p.yaml")).state).toBe("invalid");
  });
  it("reads a good file", () => {
    const d = dir();
    writeFileSync(join(d, "p.yaml"), GOOD);
    const r = readSourceProfiles(join(d, "p.yaml"));
    expect(r.state === "ok" && r.profiles.sources[0]!.skills[0]!.name).toBe("b");
  });
  it("accepts the shipped file, which lists no sources", () => {
    const r = readSourceProfiles(SHIPPED);
    expect(r.state).toBe("ok");
    expect(r.state === "ok" && r.profiles.sources).toEqual([]);
  });
});
