import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { skillsCommand } from "../src/skills/cli.js";
import { decisionText, effectCheckLine, effectPromotion, effectState } from "../src/skills/effect.js";
import { readNewestEffect } from "../src/skills/evaluation-store.js";
import { clearSkillRegistryCache, discoverSkills } from "../src/skills/registry.js";
import { parseSuiteRecords, type EffectDecision } from "../src/skills/suite-records.js";
import { breakEffect, writeEffect } from "./helpers/effect-records.js";

const TODAY = "2026-10-13";
const D1 = "sha256:" + "1".repeat(64);
const D2 = "sha256:" + "2".repeat(64);
const ID = "lib-kafka";
const SKILL = { id: ID, version: "1.0.0", digest: D1 };
const dec = (accept: EffectDecision["accept"], over: Partial<EffectDecision> = {}): EffectDecision => ({
  skill: ID, digest: D1, accept, owner: "@octocat", reviewed: "2026-10-01", note: "measured later", ...over,
});
const BOTH = [dec("no-effect"), dec("not-measured")];

const made: string[] = [];
let home: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skilleffect-promo-")));
  made.push(d);
  return d;
};
beforeEach(() => {
  home = fresh();
});
afterEach(() => {
  clearSkillRegistryCache();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const read = () => readNewestEffect(ID, D1, { home });

describe("effectPromotion", () => {
  it("blocks harms whatever decisions exist", () => {
    writeEffect(home, SKILL, "harms");
    expect(effectPromotion(read(), BOTH, ID, D1)).toEqual({ verdict: "harms", code: "effect-harms" });
  });

  it("blocks no measurable effect unless a no-effect decision exists for the skill and digest", () => {
    writeEffect(home, SKILL, "no-effect");
    expect(effectPromotion(read(), [], ID, D1)).toEqual({ verdict: "no-effect", code: "effect-no-effect" });
    expect(effectPromotion(read(), [dec("not-measured")], ID, D1).code).toBe("effect-no-effect");
    expect(effectPromotion(read(), [dec("no-effect", { digest: D2 })], ID, D1).code).toBe("effect-no-effect");
    expect(effectPromotion(read(), [dec("no-effect", { skill: "other" })], ID, D1).code).toBe("effect-no-effect");
    const ok = effectPromotion(read(), BOTH, ID, D1);
    expect(ok).toEqual({ verdict: "no-effect", decision: dec("no-effect") });
    expect(decisionText(ok.decision!)).toBe("no-effect accepted by @octocat on 2026-10-01");
  });

  it("blocks a skill that was never measured unless a not-measured decision exists", () => {
    expect(read()).toEqual({ state: "none" });
    expect(effectPromotion(read(), [], ID, D1)).toEqual({ verdict: "not-measured", code: "effect-not-measured" });
    expect(effectPromotion(read(), [dec("no-effect")], ID, D1).code).toBe("effect-not-measured");
    expect(effectPromotion(read(), [dec("not-measured", { digest: D2 })], ID, D1).code).toBe("effect-not-measured");
    expect(effectPromotion(read(), BOTH, ID, D1)).toEqual({ verdict: "not-measured", decision: dec("not-measured") });
  });

  it("adds nothing for a skill that helps", () => {
    writeEffect(home, SKILL, "helps");
    expect(effectPromotion(read(), [], ID, D1)).toEqual({ verdict: "helps" });
  });

  it("blocks an unreadable record, even with decisions", () => {
    writeEffect(home, SKILL, "helps");
    breakEffect(home, ID, D1);
    expect(read().state).toBe("invalid");
    expect(effectPromotion(read(), BOTH, ID, D1)).toEqual({ verdict: "invalid", code: "effect-invalid" });
  });

  it("prints the EFFECT lines", () => {
    expect(effectCheckLine(ID, D1, { verdict: "helps" })).toBe(`EFFECT ${ID} ${D1}: helps`);
    expect(effectCheckLine(ID, D1, { verdict: "harms", code: "effect-harms" })).toBe(`EFFECT ${ID} ${D1}: harms (effect-harms)`);
    expect(effectCheckLine(ID, D1, { verdict: "not-measured", decision: dec("not-measured") })).toBe(`EFFECT ${ID} ${D1}: not-measured (accepted by @octocat on 2026-10-01)`);
    expect(effectCheckLine(ID, D1, { verdict: "invalid", code: "effect-invalid" }, "wrong mode")).toBe(`EFFECT ${ID} ${D1}: invalid (effect-invalid: wrong mode)`);
  });
});

describe("parseSuiteRecords, effect_decisions", () => {
  const parse = (decisions: unknown) => parseSuiteRecords({ schema: 1, evaluations: [], effect_decisions: decisions }, TODAY);
  const problems = (decisions: unknown) => parse(decisions).problems.map((p) => `${p.where}: ${p.message}`);
  const good = { skill: ID, digest: D1, accept: "no-effect", owner: "@octocat", reviewed: "2026-10-01", note: "fine" };

  it("reads a valid list, and a file without the key as before", () => {
    expect(parse([good]).manifest?.effect_decisions).toEqual([good]);
    expect(parse([]).manifest?.effect_decisions).toEqual([]);
    expect(parseSuiteRecords({ schema: 1, evaluations: [] }, TODAY).manifest).toEqual({ schema: 1, evaluations: [], effect_decisions: [] });
  });

  it("allows both kinds of decision for one skill and digest", () => {
    expect(parse([good, { ...good, accept: "not-measured" }]).problems).toEqual([]);
  });

  it("reports bad values with the entry and the field", () => {
    expect(problems([{ ...good, accept: "helps" }])).toEqual([`effect_decisions[0] (${ID}) accept: must be "no-effect" or "not-measured"`]);
    const { note: _note, ...noNote } = good;
    expect(problems([noNote])).toEqual([`effect_decisions[0] (${ID}) note: is required`]);
    expect(problems([{ ...good, note: "  " }])[0]).toMatch(/note: must be text of 1 to/);
    expect(problems([{ ...good, reviewed: "2026-10-14" }])).toEqual([`effect_decisions[0] (${ID}) reviewed: must not be in the future`]);
    expect(problems([{ ...good, reviewed: "yesterday" }])[0]).toMatch(/reviewed: must be a date/);
    expect(problems([{ ...good, owner: "octocat" }])[0]).toMatch(/owner: must be a GitHub user/);
    expect(problems([{ ...good, digest: "sha256:abc" }])[0]).toMatch(/digest: must be a package digest/);
    expect(problems([{ ...good, skill: "kafka-*" }])[0]).toMatch(/skill: wildcards are not allowed/);
    expect(problems([{ ...good, extra: 1 }])[0]).toMatch(/unknown key "extra"/);
    expect(problems([{ ...good, note: "token " + "ghp_" + "a1B2c3D4e5".repeat(4) }])[0]).toMatch(/note: holds what looks like a credential/);
    expect(problems(["text"])).toEqual(["effect_decisions[0]: must be a map"]);
  });

  it("reports a duplicate", () => {
    expect(problems([good, { ...good, owner: "@other" }])).toEqual([`effect_decisions[1] (${ID}): is already listed by effect_decisions[0]`]);
  });

  it("refuses a value that is not a list and too many decisions", () => {
    expect(problems(null)).toEqual(["effect_decisions: must be a list"]);
    expect(problems({})).toEqual(["effect_decisions: must be a list"]);
    expect(problems(Array.from({ length: 501 }, () => good))).toEqual(["effect_decisions: must hold at most 500 decisions"]);
  });
});

describe("scf skills (the list), effect", () => {
  const SKILLS = ConfigSchema.parse({ skills: { releases: { allow_unreleased: true } } }).skills;
  let builtin: string;
  const KAFKA_MD = readFileSync("skills/kafka/SKILL.md", "utf8");
  const options = () => ({ home, builtinRoot: builtin, env: {}, userHome: fresh(), skills: SKILLS });
  beforeEach(() => {
    builtin = fresh();
    for (const id of ["t-one", "t-two", "t-three"]) {
      const dir = join(builtin, id);
      cpSync("skills/kafka", dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), KAFKA_MD.replace(/^name: kafka$/m, `name: ${id}`));
      writeFileSync(join(dir, "skill.yaml"), `id: ${id}\nversion: 1.0.0\ncategory: interface\ncapabilities: [kafka]\nroles: [coder, reviewer]\nrisk: high\n`);
    }
  });
  const list = async () => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: [], values: {} }, (l) => void lines.push(l), options());
    return { code, lines };
  };
  const registered = (id: string) => {
    const o = options();
    const s = discoverSkills(SKILLS, { home: o.home, builtinRoot: o.builtinRoot, env: o.env, userHome: o.userHome }).skills.find((x) => x.id === id)!;
    return { id: s.id, version: s.version, digest: s.digest };
  };
  const lineOf = (lines: string[], id: string) => lines.find((l) => l.startsWith(id.padEnd(24)))!;

  it("shows helps, harms, no-effect, not-measured and invalid from the newest record of the digest", async () => {
    const one = registered("t-one");
    const two = registered("t-two");
    writeEffect(home, one, "helps");
    writeEffect(home, two, "harms");
    const first = await list();
    expect(lineOf(first.lines, "t-one")).toContain(`${one.digest} effect helps`);
    expect(lineOf(first.lines, "t-two")).toContain(`${two.digest} effect harms`);
    expect(lineOf(first.lines, "t-three")).toMatch(/ effect not-measured$/);

    // a later re-run shows up
    writeEffect(home, one, "no-effect");
    expect(lineOf((await list()).lines, "t-one")).toContain("effect no-effect");

    // an unreadable record is shown, and does not change the exit code
    breakEffect(home, two.id, two.digest);
    const last = await list();
    expect(lineOf(last.lines, "t-two")).toContain("effect invalid");
    expect(last.code).toBe(first.code);
  });

  it("maps every read to one state", () => {
    expect(effectState({ state: "none" })).toBe("not-measured");
    expect(effectState({ state: "invalid", problem: "x" })).toBe("invalid");
  });
});
