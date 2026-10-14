import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { skillsCommand } from "../src/skills/cli.js";
import { COMMUNITY_REPOSITORIES } from "../src/skills/community-rules.js";
import { credentialProblem } from "../src/skills/credential-scan.js";
import { parseSources, readSources, shownValue, usableSources } from "../src/skills/sources.js";

// Token-like samples are built from pieces so that tools/secret-scan finds nothing in this file.
const TOKEN = "sk-" + "ant-" + "abcdefghijklmnopqrst";
const LONG_TOKEN = "sk-" + "ant-" + "a".repeat(120);
const ESC = "\u001b[2J";
const RLO = "‮";
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const valid = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "example-skills",
  repository: "https://github.com/example/skills",
  status: "enabled",
  ref: { track: "main", approved: COMMIT },
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "verified",
  licence: { allow: ["MIT", "Apache-2.0"] },
  update: { cadence: "weekly" },
  owner: "@octocat",
  ...o,
});
const file = (...sources: Record<string, unknown>[]) => ({ schema: 1, sources });
const check = (...sources: Record<string, unknown>[]) => parseSources(file(...sources)).problems;
const text = (ps: { where: string; message: string }[]) => ps.map((p) => `${p.where}: ${p.message}`).join("\n");

describe("parseSources", () => {
  it("accepts a valid source", () => {
    const r = parseSources(file(valid()));
    expect(r.problems).toEqual([]);
    expect(r.manifest!.sources[0]!.repositoryKey).toBe("github.com/example/skills");
    expect(usableSources(r.manifest!)).toHaveLength(1);
  });

  it.each([
    ["http url", { repository: "http://github.com/a/b" }, "repository", "https://"],
    ["scp url", { repository: "git@github.com:a/b" }, "repository", "https://"],
    ["short name", { repository: "owner/name" }, "repository", "https://"],
    ["credentials in url", { repository: "https://user:pw@github.com/a/b" }, "repository", ""],
    ["query", { repository: "https://github.com/a/b?x=1" }, "repository", ""],
    ["parent path", { paths: ["../x"] }, "paths[0]", "plain relative"],
    ["absolute path", { paths: ["/abs"] }, "paths[0]", "plain relative"],
    ["glob", { paths: ["a/*"] }, "paths[0]", "globs"],
    [".git path", { paths: [".git/hooks"] }, "paths[0]", "plain relative"],
    ["no paths", { paths: [] }, "paths", "1 to 20"],
    ["nested paths", { paths: ["a", "a/b"] }, "paths", '"a/b" is inside "a"'],
    ["root with others", { paths: [".", "skills"] }, "paths", "alone"],
    ["branch approved", { ref: { track: "main", approved: "main" } }, "ref.approved", "full commit id"],
    ["tag approved", { ref: { track: "main", approved: "v1.2.3" } }, "ref.approved", "full commit id"],
    ["short sha", { ref: { track: "main", approved: "0123456" } }, "ref.approved", "full commit id"],
    ["upper hex", { ref: { track: "main", approved: COMMIT.toUpperCase() } }, "ref.approved", "full commit id"],
    ["track dash", { ref: { track: "-x", approved: COMMIT } }, "ref.track", "git accepts"],
    ["track dots", { ref: { track: "a..b", approved: COMMIT } }, "ref.track", "git accepts"],
    ["track commit", { ref: { track: COMMIT, approved: COMMIT } }, "ref.track", "ref.approved"],
    ["track hidden", { ref: { track: ".hidden", approved: COMMIT } }, "ref.track", "git accepts"],
    ["track part hidden", { ref: { track: "feature/.hidden", approved: COMMIT } }, "ref.track", "git accepts"],
    ["track trailing dot", { ref: { track: "release.", approved: COMMIT } }, "ref.track", "git accepts"],
    ["track lock", { ref: { track: "foo.lock/bar", approved: COMMIT } }, "ref.track", "git accepts"],
    ["unknown licence", { licence: { allow: ["GPL-3.0"] } }, "licence.allow[0]", "not an accepted licence"],
    ["no licence", { licence: { allow: [] } }, "licence.allow", "1 to 20"],
    ["wrong case licence", { licence: { allow: ["mit"] } }, "licence.allow[0]", "not an accepted licence"],
    ["trust", { trust: "trusted" }, "trust", "first-party, verified, community"],
    ["adapter", { adapter: "custom" }, "adapter", 'unknown adapter "custom"'],
    ["status", { status: "paused" }, "status", "must be one of"],
    ["cadence", { update: { cadence: "hourly" } }, "update.cadence", "must be one of"],
    ["no owner", { owner: undefined }, "owner", "required"],
    ["owner without at", { owner: "octocat" }, "owner", "@octocat"],
    ["unknown key", { extra: 1 }, "", 'unknown key "extra"'],
    ["number commit", { ref: { track: "main", approved: 1234567890123456 } }, "ref.approved", "put it in quotes"],
    ["enabled without approved", { ref: { track: "main" } }, "ref.approved", "needs ref.approved"],
    ["weekly without track", { ref: { approved: COMMIT } }, "ref.track", "needs ref.track"],
    ["enabled with reason", { reason: "why" }, "reason", "no reason"],
  ])("refuses %s", (_n, over, field, part) => {
    const ps = check(valid(over));
    const hit = ps.find((p) => p.where === (field ? `sources[0] (example-skills) ${field}` : "sources[0] (example-skills)"));
    expect(hit, text(ps)).toBeDefined();
    expect(hit!.message).toContain(part);
  });

  it("refuses unknown top-level keys and schema 2", () => {
    expect(text(parseSources({ schema: 1, sources: [valid()], x: 1 }).problems)).toContain('unknown key "x"');
    expect(text(parseSources({ schema: 2, sources: [valid()] }).problems)).toContain("schema must be 1");
  });

  it("accepts good tracking refs and manual cadence without one", () => {
    for (const track of ["main", "v1.2.3", "release/2026.10", "feature/a.b"]) expect(check(valid({ ref: { track, approved: COMMIT } }))).toEqual([]);
    expect(check(valid({ ref: { approved: COMMIT }, update: { cadence: "manual" } }))).toEqual([]);
  });

  it("reports several faults at once", () => {
    const ps = check(valid({ trust: "x", owner: "y", adapter: "z" }));
    expect(ps.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a duplicate id and names both places", () => {
    const ps = check(valid(), valid({ repository: "https://github.com/example/other" }));
    expect(ps).toHaveLength(1);
    expect(ps[0]!.where).toBe("sources[1] (example-skills) id");
    expect(ps[0]!.message).toContain("sources[0]");
  });

  it.each(["disabled", "quarantined", "retired"])("a %s source needs a reason and is not usable", (status) => {
    const off = valid({ status, reason: "under review", ref: { track: "main" } });
    const r = parseSources(file(off));
    expect(r.problems).toEqual([]);
    expect(usableSources(r.manifest!)).toEqual([]);
    expect(text(check({ ...off, reason: undefined }))).toContain(`a ${status} source needs a reason`);
  });
});

describe("output safety", () => {
  const where = (ps: { where: string; message: string }[]) => ps.map((p) => p.where + " " + p.message).join(" ");

  it.each([
    ["id", { id: TOKEN }],
    ["repository", { repository: "https://github.com/example/" + TOKEN }],
    ["reason", { status: "disabled", reason: TOKEN }],
    ["ref.track", { ref: { track: TOKEN, approved: COMMIT } }],
    ["path", { paths: [TOKEN] }],
    ["owner", { owner: "@acme/" + TOKEN }],
  ])("a credential in %s is reported and never shown", (_n, over) => {
    const ps = check(valid(over));
    expect(text(ps)).toContain("looks like a credential");
    expect(where(ps)).not.toContain(TOKEN);
    expect(where(ps)).not.toContain("abcdefghijklmnopqrst");
  });

  it("hides credentials in unknown keys, adapters and licences", () => {
    const ps = check(valid({ [TOKEN]: 1, adapter: TOKEN, licence: { allow: [TOKEN] } }));
    expect(ps.length).toBeGreaterThan(0);
    expect(where(ps)).not.toContain("abcdefghijklmnopqrst");
  });

  it("does not show a long credential in part", () => {
    const ps = check(valid({ adapter: LONG_TOKEN }));
    expect(where(ps)).not.toContain("aaaaaaaa");
    expect(shownValue(LONG_TOKEN)).toBe("(hidden)");
  });

  it.each([ESC, RLO])("escapes unsafe characters (%j)", (bad) => {
    const ps = check(valid({ [`k${bad}`]: 1, adapter: `a${bad}`, licence: { allow: [`l${bad}`] }, paths: [`p${bad}`] }));
    expect(where(ps)).not.toMatch(UNSAFE);
    expect(text(ps)).toContain("control or invisible character");
  });

  it("cuts a long plain value", () => {
    expect(shownValue("x".repeat(500)).length).toBeLessThanOrEqual(81);
  });
});

describe("blank values", () => {
  it("a null ref does not satisfy an enabled weekly source", () => {
    const t = text(check(valid({ ref: { approved: null, track: null } })));
    expect(t).toContain("ref.approved: must not be blank");
    expect(t).toContain("ref.track: must not be blank");
    expect(t).toContain("needs ref.approved");
    expect(t).toContain("needs ref.track");
  });

  it("a null reason does not satisfy a disabled source", () => {
    const t = text(check(valid({ status: "disabled", reason: null, ref: {}, update: { cadence: "manual" } })));
    expect(t).toContain("reason: must not be blank");
    expect(t).toContain("needs a reason");
  });

  it("a null reason on an enabled source is refused", () => {
    expect(check(valid({ reason: null })).length).toBeGreaterThan(0);
  });
});

describe("readSources", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "scf-sources-"));

  it("gives none for a missing file", () => {
    expect(readSources(join(dir(), "nope.yaml")).state).toBe("none");
  });

  it("refuses a link", () => {
    const d = dir();
    writeFileSync(join(d, "real.yaml"), stringify(file(valid())));
    symlinkSync(join(d, "real.yaml"), join(d, "link.yaml"));
    expect(readSources(join(d, "link.yaml")).state).toBe("invalid");
  });

  it("refuses a file over the limit", () => {
    const d = dir();
    writeFileSync(join(d, "a.yaml"), stringify(file(valid())));
    expect(readSources(join(d, "a.yaml"), 10).state).toBe("invalid");
  });

  it("reports broken YAML without repeating its content", () => {
    const d = dir();
    writeFileSync(join(d, "a.yaml"), `key: [${TOKEN} ${ESC}\n  : : x: "\n`);
    const r = readSources(join(d, "a.yaml"));
    expect(r.state).toBe("invalid");
    const t = r.state === "invalid" ? where2(r.problems) : "";
    expect(t).toContain("is not valid YAML");
    expect(t).not.toContain("abcdefghijklmnopqrst");
    expect(t).not.toMatch(UNSAFE);
  });

  it("refuses an alias", () => {
    const d = dir();
    writeFileSync(join(d, "a.yaml"), "schema: 1\nx: &a [1]\nsources: *a\n");
    expect(readSources(join(d, "a.yaml")).state).toBe("invalid");
  });

  it("reads a good file", () => {
    const d = dir();
    writeFileSync(join(d, "a.yaml"), stringify(file(valid())));
    expect(readSources(join(d, "a.yaml")).state).toBe("ok");
  });
});

function where2(ps: { where: string; message: string }[]): string {
  return ps.map((p) => `${p.where} ${p.message}`).join(" ");
}

describe("scf skills sources check", () => {
  const run = async (positionals: string[], cwd: string, values: Record<string, unknown> = {}, home?: string) => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals, values }, (l) => lines.push(l), { cwd, ...(home ? { home } : {}) });
    return { code, lines };
  };
  const dir = () => mkdtempSync(join(tmpdir(), "scf-sources-cli-"));

  it("prints one line per source and a summary", async () => {
    const d = dir();
    const off = valid({ id: "old-skills", repository: "https://github.com/example/old", status: "disabled", reason: "under review", ref: {} });
    writeFileSync(join(d, "list.yaml"), stringify(file(valid(), { ...off, update: { cadence: "manual" } })));
    const r = await run(["sources", "check", "list.yaml"], d);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[1]).toContain("(under review)");
    expect(r.lines[2]).toBe("OK 2 sources, 1 enabled");
  });

  it("fails for an invalid file", async () => {
    const d = dir();
    writeFileSync(join(d, "list.yaml"), stringify(file(valid({ ref: { track: "main", approved: "main" } }))));
    const r = await run(["sources", "check", "list.yaml"], d);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^PROBLEM sources\[0\] \(example-skills\) ref\.approved: /);
  });

  it("fails for a missing file and uses the default name", async () => {
    const d = dir();
    expect((await run(["sources", "check"], d)).code).toBe(1);
    writeFileSync(join(d, "skill-sources.yaml"), stringify(file(valid())));
    expect((await run(["sources", "check"], d)).code).toBe(0);
  });

  it("refuses bad syntax", async () => {
    const d = dir();
    await expect(run(["sources"], d)).rejects.toThrow("usage:");
    await expect(run(["sources", "list"], d)).rejects.toThrow("usage:");
    await expect(run(["sources", "check", "a", "b"], d)).rejects.toThrow("usage:");
    await expect(run(["sources", "check"], d, { replace: true })).rejects.toThrow("usage:");
  });

  it("does not touch the data folder", async () => {
    const d = dir();
    const home = join(d, "home");
    mkdirSync(home);
    writeFileSync(join(d, "skill-sources.yaml"), stringify(file(valid())));
    expect((await run(["sources", "check"], d, {}, home)).code).toBe(0);
    expect(readdirSync(home)).toEqual([]);
  });

  it("prints nothing credential-like or unsafe for hostile files", async () => {
    const d = dir();
    const hostile = [
      file(valid({ id: TOKEN })),
      file(valid({ adapter: LONG_TOKEN })),
      file(valid({ [`k${ESC}`]: 1, adapter: `a${RLO}`, licence: { allow: [`l${ESC}`] }, paths: [`p${RLO}`] })),
      file(valid({ reason: TOKEN })),
    ];
    for (const [i, h] of hostile.entries()) {
      writeFileSync(join(d, `h${i}.yaml`), stringify(h));
      const r = await run(["sources", "check", `h${i}.yaml`], d);
      expect(r.code).toBe(1);
      for (const l of r.lines) {
        expect(credentialProblem(l)).toBeUndefined();
        expect(l).not.toMatch(UNSAFE);
      }
    }
  });
});

describe("connector rules", () => {
  const ac = (o: Record<string, unknown> = {}) =>
    valid({ id: "my-copy", repository: "https://github.com/github/awesome-copilot", licence: { allow: ["MIT"] }, ...o });

  it("accepts a source that follows the connector", () => {
    expect(check(ac())).toEqual([]);
    expect(check(ac({ paths: ["skills/demo"] }))).toEqual([]);
  });

  it.each([
    ["root", { paths: ["."] }],
    ["agents", { paths: ["agents"] }],
    ["hooks", { paths: ["hooks"] }],
    ["workflows", { paths: ["workflows"] }],
    ["plugins", { paths: ["plugins"] }],
    ["instructions", { paths: ["instructions"] }],
    ["trust", { trust: "verified" }],
    ["licence", { licence: { allow: ["MIT", "Apache-2.0"] } }],
  ])("refuses a bad %s", (_n, o) => {
    const ps = check(ac(o));
    expect(ps).toHaveLength(1);
    expect(ps[0]!.message).toContain("connector awesome-copilot");
    expect(ps[0]!.where).toBe("sources[0] (my-copy)");
  });

  it("refuses an unknown adapter", () => {
    expect(check(ac({ adapter: "custom" })).length).toBeGreaterThan(0);
  });

  it.each([
    ["a .git spelling", { repository: "https://github.com/GitHub/Awesome-Copilot.git" }],
    ["a trailing slash", { repository: "https://github.com/github/awesome-copilot/" }],
    ["another id", { id: "anything-else" }],
  ])("matches %s", (_n, o) => {
    expect(check(ac({ paths: ["agents"], ...o }))).toHaveLength(1);
  });

  it("applies to a disabled entry", () => {
    const off = ac({ status: "disabled", reason: "under review", ref: {}, update: { cadence: "manual" }, paths: ["."] });
    expect(check(off)).toHaveLength(1);
  });

  it("still needs ref.approved as a commit id", () => {
    expect(text(check(ac({ ref: { track: "main" } })))).toContain("needs ref.approved");
    expect(text(check(ac({ ref: { track: "main", approved: "main" } })))).toContain("full commit id");
  });

  it("leaves other repositories alone", () => {
    expect(check(valid({ paths: ["."], trust: "verified" }))).toEqual([]);
  });

  it("is reported by sources check", async () => {
    const d = mkdtempSync(join(tmpdir(), "scf-sources-conn-"));
    writeFileSync(join(d, "list.yaml"), stringify(file(ac({ paths: ["agents"] }))));
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["sources", "check", "list.yaml"], values: {} }, (l) => lines.push(l), { cwd: d });
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^PROBLEM sources\[0\] \(my-copy\): connector awesome-copilot: /);
  });
});

describe("community review", () => {
  const TODAY = "2026-10-13";
  const review = (o: Record<string, unknown> = {}) => ({ by: "@octocat", on: "2026-10-01", commit: COMMIT, licence: "MIT", ...o });
  const community = (o: Record<string, unknown> = {}) => valid({ trust: "community", review: review(), ...o });
  const probs = (s: Record<string, unknown>, today = TODAY) => text(parseSources(file(s), today).problems);

  it("accepts an enabled community source with a full review and keeps it", () => {
    const r = parseSources(file(community()), TODAY);
    expect(r.problems).toEqual([]);
    expect(r.manifest!.sources[0]!.review).toEqual(review());
  });

  it("needs a review for an enabled community source", () => {
    expect(probs(community({ review: undefined }))).toContain("review: an enabled community source needs a review");
  });

  it("needs a new review for a new commit", () => {
    expect(probs(community({ review: review({ commit: "b".repeat(40) }) }))).toContain("review.commit: is not the commit in ref.approved; a new commit needs a new review");
  });

  it("gives one message when a commit is malformed", () => {
    const p = probs(community({ review: review({ commit: "main" }) }));
    expect(p).toContain("review.commit: must be a full commit id");
    expect(p).not.toContain("new review");
  });

  it.each([
    ["by without at", { by: "octocat" }, "review.by: must be a GitHub user"],
    ["by number", { by: 5 }, "review.by: must be text"],
    ["on bad month", { on: "2026-13-01" }, "review.on: must be a date"],
    ["on bad day", { on: "2026-02-30" }, "review.on: must be a date"],
    ["on bad order", { on: "13-10-2026" }, "review.on: must be a date"],
    ["on tomorrow", { on: "2026-10-14" }, "review.on: must not be in the future"],
    ["commit branch", { commit: "main" }, "review.commit: must be a full commit id"],
    ["commit short", { commit: "0123456" }, "review.commit: must be a full commit id"],
    ["commit upper", { commit: COMMIT.toUpperCase() }, "review.commit: must be a full commit id"],
    ["licence not accepted", { licence: "GPL-3.0" }, 'review.licence: "GPL-3.0" is not in licence.allow'],
    ["licence not allowed here", { licence: "ISC" }, 'review.licence: "ISC" is not in licence.allow'],
    ["missing by", { by: undefined }, "review.by: is required"],
    ["missing licence", { licence: undefined }, "review.licence: is required"],
    ["unknown key", { extra: "x" }, 'review: unknown key "extra"'],
  ])("refuses a review with %s", (_n, over, msg) => {
    expect(probs(community({ review: review(over) }))).toContain(msg);
    expect(parseSources(file(community({ review: review(over) })), TODAY).manifest).toBeUndefined();
  });

  it("accepts a review dated today", () => {
    expect(probs(community({ review: review({ on: TODAY }) }))).toBe("");
  });

  it.each([null, "x", []])("refuses a review that is not a map (%j)", (bad) => {
    expect(probs(community({ review: bad }))).toContain("review: must be a map");
  });

  it("does not print a credential-like review.by", () => {
    const p = probs(community({ review: review({ by: TOKEN }) }));
    expect(p).toContain("review.by");
    expect(p).not.toContain(TOKEN);
  });

  it("does not need a review for a disabled community source, and ignores a stale one", () => {
    const off = { status: "disabled", reason: "waiting", ref: {}, update: { cadence: "manual" } };
    expect(probs(community({ ...off, review: undefined }))).toBe("");
    expect(probs(community({ ...off, ref: { approved: COMMIT }, review: review({ commit: "b".repeat(40) }) }))).toBe("");
  });

  it("does not need a review for a verified or first-party source, and keeps one that is given", () => {
    for (const trust of ["verified", "first-party"]) {
      expect(probs(valid({ trust }))).toBe("");
      expect(parseSources(file(valid({ trust, review: review() })), TODAY).manifest!.sources[0]!.review).toEqual(review());
    }
  });

  describe("known community repositories", () => {
    const urls = ["https://github.com/jiangxianze/spring-agent-skills", "https://github.com/Jiangxianze/Spring-Agent-Skills.git", "https://GitHub.com/JiangXianze/spring-agent-skills/"];
    const off = { status: "disabled", reason: "waiting", ref: {}, update: { cadence: "manual" } };
    it.each(urls)("refuses another trust for %s", (repository) => {
      for (const trust of ["verified", "first-party"]) {
        for (const status of [{}, off]) {
          const ps = parseSources(file(valid({ repository, trust, ...status })), TODAY).problems;
          expect(ps.some((p) => p.where.endsWith(" trust") && p.message.includes("must be community"))).toBe(true);
        }
      }
      expect(probs(community({ repository, ...off }))).toBe("");
    });

    it("lists the key in lower case", () => {
      expect(COMMUNITY_REPOSITORIES).toContain("github.com/jiangxianze/spring-agent-skills");
      for (const k of COMMUNITY_REPOSITORIES) expect(k).toBe(k.toLowerCase());
    });
  });

  it("refuses a bad today without throwing", () => {
    const r = parseSources(file(valid()), "nope");
    expect(r.manifest).toBeUndefined();
    expect(text(r.problems)).toBe("today: must be a date like 2026-10-13");
    expect(parseSources(file(valid())).problems).toEqual([]);
  });

  it("reads an unquoted date from YAML as text", () => {
    const d = mkdtempSync(join(tmpdir(), "scf-review-"));
    const yaml = [
      "schema: 1",
      "sources:",
      "  - id: lib",
      "    repository: https://github.com/example/skills",
      "    status: enabled",
      `    ref: {approved: '${COMMIT}'}`,
      "    paths: [skills]",
      "    adapter: agent-skills",
      "    trust: community",
      "    licence: {allow: [MIT]}",
      "    update: {cadence: manual}",
      "    owner: '@octocat'",
      `    review: {by: '@octocat', on: 2026-10-01, commit: '${COMMIT}', licence: MIT}`,
      "",
    ].join("\n");
    writeFileSync(join(d, "list.yaml"), yaml);
    expect(readSources(join(d, "list.yaml"), undefined, TODAY).state).toBe("ok");
  });

  describe("scf skills sources check", () => {
    const run = async (sources: Record<string, unknown>[]) => {
      const d = mkdtempSync(join(tmpdir(), "scf-review-cli-"));
      writeFileSync(join(d, "list.yaml"), stringify(file(...sources)));
      const lines: string[] = [];
      const code = await skillsCommand({ positionals: ["sources", "check", "list.yaml"], values: {} }, (l) => lines.push(l), { cwd: d, today: TODAY });
      return { code, lines };
    };

    it("prints trust and the review", async () => {
      const r = await run([community()]);
      expect(r.code).toBe(0);
      expect(r.lines[0]).toMatch(/ enabled community agent-skills github\.com\/example\/skills@0123456789ab @octocat reviewed by @octocat on 2026-10-01$/);
    });

    it("prints no review for a source without one", async () => {
      expect((await run([valid()])).lines[0]).not.toContain("reviewed by");
    });

    it("prints the review before the reason of a disabled source", async () => {
      const r = await run([community({ status: "disabled", reason: "paused", ref: {}, update: { cadence: "manual" } })]);
      expect(r.lines[0]).toMatch(/ reviewed by @octocat on 2026-10-01 \(paused\)$/);
    });

    it("prints only PROBLEM lines for an unreviewed enabled community source", async () => {
      const r = await run([community({ review: undefined })]);
      expect(r.code).toBe(1);
      expect(r.lines.every((l) => l.startsWith("PROBLEM "))).toBe(true);
    });
  });
});
