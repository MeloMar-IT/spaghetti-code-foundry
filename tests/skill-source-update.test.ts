import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { connectorFor, connectorSource } from "../src/skills/connectors.js";
import { reviewFailed, type ImportReview, type ReviewedSkill } from "../src/skills/import-review.js";
import { SOURCE_CHANGE_LIMITS, type SourceChange } from "../src/skills/source-change.js";
import { addConnectorEntry, attentionParts, changeApproved, checkEdit, communityReview, PULL_REQUEST_BYTES, repoFromUrl, scalarText, updateBranch, updateBranchPrefix, updatePullRequest } from "../src/skills/source-update.js";
import { parseSources, type SkillLibrarySource } from "../src/skills/sources.js";

const TODAY = "2026-10-15";
const OLD = "0123456789abcdef0123456789abcdef01234567";
const NEW = "89abcdef0123456789abcdef0123456789abcdef";
const BLOCK = [
  "# the catalogue's skill sources",
  "schema: 1",
  "sources:",
  "  # first, a verified one",
  "  - id: first-skills",
  "    repository: https://github.com/example/first",
  "    status: enabled",
  "    ref:",
  "      track: main # follow main",
  `      approved: ${OLD}`,
  "    paths: [skills]",
  "    adapter: agent-skills",
  "    trust: verified",
  "    licence: {allow: [MIT]}",
  "    update: {cadence: weekly}",
  "    owner: '@octocat'",
  "    review: {by: '@old', on: '2026-01-01', commit: '" + OLD + "', licence: MIT}",
  "",
  "  # second, a community one",
  "  - id: second-skills",
  "    repository: https://github.com/example/second",
  "    status: enabled",
  `    ref: {track: main, approved: '${OLD}'}`,
  "    paths: [skills, more/skills]",
  "    adapter: agent-skills",
  "    trust: community",
  "    licence: {allow: [MIT]}",
  "    update: {cadence: manual}",
  "    owner: '@octocat'",
  `    review: {by: '@octocat', on: '2026-01-01', commit: ${OLD}, licence: MIT}`,
  "  # third, last",
  "  - id: third-skills",
  "    repository: https://github.com/example/third",
  "    status: disabled",
  "    reason: not approved yet",
  "    ref:",
  "      track: dev",
  "    paths: [skills]",
  "    adapter: agent-skills",
  "    trust: verified",
  "    licence: {allow: [MIT, Apache-2.0]}",
  "    update: {cadence: manual}",
  "    owner: '@octocat'",
  "# the end",
  "",
].join("\n");
const FLOW = `{schema: 1, sources: [{id: flow-skills, repository: "https://github.com/example/flow", status: enabled, ref: {track: main, approved: "${OLD}"}, paths: [skills], adapter: agent-skills, trust: verified, licence: {allow: [MIT]}, update: {cadence: manual}, owner: "@octocat"}, {id: other-skills, repository: "https://github.com/example/other", status: disabled, reason: "not approved yet", ref: {track: main}, paths: [skills], adapter: agent-skills, trust: verified, licence: {allow: [MIT]}, update: {cadence: manual}, owner: "@octocat"}]}\n`;

const ok = <T extends object>(r: T | { problem: string }): T => {
  if ("problem" in r) throw new Error(r.problem);
  return r;
};
const entries = (text: string) => (parse(text) as { sources: Record<string, unknown>[] }).sources;
const valid = (text: string) => expect(parseSources(parse(text), TODAY).problems).toEqual([]);

/** The text outside the given ranges is the same: the only difference is one splice. */
function onlyBetween(before: string, after: string): { removed: string; added: string } {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  let j = 0;
  while (j < before.length - i && j < after.length - i && before[before.length - 1 - j] === after[after.length - 1 - j]) j++;
  return { removed: before.slice(i, before.length - j), added: after.slice(i, after.length - j) };
}

describe("changeApproved", () => {
  it("replaces only the commit of a block entry and keeps every comment", () => {
    const { text } = ok(changeApproved(BLOCK, "first-skills", NEW));
    expect(onlyBetween(BLOCK, text)).toEqual({ removed: expect.stringContaining(OLD.slice(0, 20)), added: expect.stringContaining(NEW.slice(0, 20)) });
    expect(text.split(OLD).length).toBe(BLOCK.split(OLD).length - 1);
    expect(text).toContain("track: main # follow main");
    valid(text);
    expect(entries(text)[0]!.ref).toEqual({ track: "main", approved: NEW });
    expect(entries(text)[1]).toEqual(entries(BLOCK)[1]);
  });

  it("replaces a quoted commit in a flow map and keeps the quote style", () => {
    const { text } = ok(changeApproved(BLOCK, "second-skills", NEW, undefined));
    expect(text).toContain(`ref: {track: main, approved: '${NEW}'}`);
    expect(entries(text)[0]).toEqual(entries(BLOCK)[0]);
    expect(entries(text)[2]).toEqual(entries(BLOCK)[2]);
  });

  it("changes the four review values of a community entry and keeps '@x' quoted style", () => {
    const review = { by: "@reviewer", on: TODAY, commit: NEW, licence: "MIT" };
    const { text } = ok(changeApproved(BLOCK, "second-skills", NEW, review));
    expect(text).toContain(`review: {by: '@reviewer', on: '${TODAY}', commit: ${NEW}, licence: MIT}`);
    valid(text);
    expect(entries(text)[1]!.review).toEqual(review);
    expect(checkEdit(BLOCK, text, "second-skills", NEW, TODAY, review)).toMatchObject({ ok: true });
  });

  it("leaves the review of a verified entry as it was", () => {
    const { text } = ok(changeApproved(BLOCK, "first-skills", NEW));
    expect(entries(text)[0]!.review).toEqual(entries(BLOCK)[0]!.review);
  });

  it("adds the key when ref has only a track, in block style", () => {
    const { text } = ok(changeApproved(BLOCK, "third-skills", NEW));
    expect(onlyBetween(BLOCK, text).removed).toBe("");
    expect(text).toContain(`      track: dev\n      approved: ${NEW}\n    paths`);
    valid(text);
  });

  it("works in a file written entirely in flow style, and adds the key there", () => {
    const a = ok(changeApproved(FLOW, "flow-skills", NEW));
    expect(onlyBetween(FLOW, a.text).removed).toBe(OLD);
    expect(entries(a.text)[0]!.ref).toEqual({ track: "main", approved: NEW });
    const b = ok(changeApproved(FLOW, "other-skills", NEW));
    expect(onlyBetween(FLOW, b.text).removed).toBe("");
    expect(entries(b.text)[1]!.ref).toEqual({ track: "main", approved: NEW });
    expect(entries(b.text)[0]).toEqual(entries(FLOW)[0]);
    valid(b.text);
  });

  it("quotes an all-digit commit and refuses a file it cannot edit", () => {
    const digits = "1".repeat(40);
    const { text } = ok(changeApproved(BLOCK, "first-skills", digits));
    expect(text).toContain(`approved: "${digits}"`);
    expect(entries(text)[0]!.ref).toEqual({ track: "main", approved: digits });
    expect(changeApproved(BLOCK, "nope", NEW)).toHaveProperty("problem");
    expect(changeApproved("a: [", "x", NEW)).toHaveProperty("problem");
    expect(changeApproved("- 1\n", "x", NEW)).toHaveProperty("problem");
  });
});

describe("addConnectorEntry", () => {
  const connector = connectorFor("github.com/github/awesome-copilot")!;
  const review = { by: "@o", on: TODAY, commit: NEW, licence: "MIT" };
  const entry = (): SkillLibrarySource => connectorSource(connector, { commit: NEW, owner: "@o", review });

  it("adds one entry at the end of a block list and keeps the rest byte for byte", () => {
    const { text } = ok(addConnectorEntry(BLOCK, entry()));
    expect(onlyBetween(BLOCK, text).removed).toBe("");
    expect(text.startsWith("# the catalogue's skill sources\nschema: 1\n")).toBe(true);
    expect(text.indexOf("# the end")).toBeGreaterThan(text.indexOf("id: awesome-copilot"));
    valid(text);
    const all = entries(text);
    expect(all).toHaveLength(4);
    expect(all.slice(0, 3)).toEqual(entries(BLOCK));
    expect(all[3]).toMatchObject({ id: "awesome-copilot", ref: { track: "main", approved: NEW }, paths: ["skills"], trust: "community", owner: "@o", review });
    expect(all[3]).not.toHaveProperty("repositoryKey");
    expect(checkEdit(BLOCK, text, "awesome-copilot", NEW, TODAY, review)).toMatchObject({ ok: true });
  });

  it("adds an entry to a flow list, to an empty flow list and to a missing file", () => {
    const f = ok(addConnectorEntry(FLOW, entry()));
    expect(onlyBetween(FLOW, f.text).removed).toBe("");
    valid(f.text);
    expect(entries(f.text)).toHaveLength(3);
    const empty = ok(addConnectorEntry("schema: 1\nsources: []\n", entry()));
    expect(entries(empty.text)).toHaveLength(1);
    valid(empty.text);
    const fresh = ok(addConnectorEntry(undefined, entry()));
    expect(fresh.text.startsWith("schema: 1\nsources:\n")).toBe(true);
    valid(fresh.text);
    expect(checkEdit(undefined, fresh.text, "awesome-copilot", NEW, TODAY, review)).toMatchObject({ ok: true });
  });

  it("adds after a last line that has no newline", () => {
    const { text } = ok(addConnectorEntry(BLOCK.replace(/# the end\n$/, "").trimEnd(), entry()));
    valid(text);
    expect(entries(text)).toHaveLength(4);
  });

  it("builds an entry that follows the connector rules, and the rules catch a broken one", () => {
    const bad = { ...entry(), paths: ["elsewhere"] };
    const { text } = ok(addConnectorEntry(undefined, bad));
    expect(checkEdit(undefined, text, "awesome-copilot", NEW, TODAY, review)).toEqual({ problem: expect.stringContaining("connector awesome-copilot") });
  });
});

describe("checkEdit", () => {
  it("catches an edit that changed another entry, a missing commit and invalid YAML", () => {
    const { text } = ok(changeApproved(BLOCK, "first-skills", NEW));
    expect(checkEdit(BLOCK, text.replace("owner: '@octocat'\n# the end", "owner: '@other'\n# the end"), "first-skills", NEW, TODAY)).toEqual({ problem: expect.stringContaining("another entry") });
    expect(checkEdit(BLOCK, BLOCK, "first-skills", NEW, TODAY)).toEqual({ problem: expect.stringContaining("new commit") });
    expect(checkEdit(BLOCK, "a: [", "first-skills", NEW, TODAY)).toEqual({ problem: expect.stringContaining("not valid YAML") });
  });
  it("catches a community entry whose review does not match the commit", () => {
    const { text } = ok(changeApproved(BLOCK, "second-skills", NEW));
    expect(checkEdit(BLOCK, text, "second-skills", NEW, TODAY)).toEqual({ problem: expect.stringContaining("review.commit") });
  });
});

describe("communityReview", () => {
  const community = { status: "enabled" as const, trust: "community" as const, licence: { allow: ["MIT"] }, review: undefined };
  it("needs a reviewer for an enabled community entry", () => {
    expect(communityReview(community, { commit: NEW, today: TODAY })).toEqual({ problem: expect.stringContaining("--reviewer") });
    expect(communityReview(community, { commit: NEW, reviewer: "x", today: TODAY })).toEqual({ problem: expect.stringContaining("@octocat") });
    expect(communityReview(community, { commit: NEW, reviewer: "@r", today: TODAY })).toEqual({ review: { by: "@r", on: TODAY, commit: NEW, licence: "MIT" } });
  });
  it("takes the old licence while it is allowed, else asks", () => {
    const two = { ...community, licence: { allow: ["MIT", "ISC"] } };
    expect(communityReview(two, { commit: NEW, reviewer: "@r", today: TODAY })).toEqual({ problem: expect.stringContaining("--licence") });
    const old = { ...two, review: { by: "@a", on: "2026-01-01", commit: OLD, licence: "ISC" } };
    expect(communityReview(old, { commit: NEW, reviewer: "@r", today: TODAY })).toEqual({ review: { by: "@r", on: TODAY, commit: NEW, licence: "ISC" } });
    expect(communityReview(old, { commit: NEW, reviewer: "@r", licence: "MIT", today: TODAY })).toEqual({ review: { by: "@r", on: TODAY, commit: NEW, licence: "MIT" } });
    expect(communityReview(old, { commit: NEW, reviewer: "@r", licence: "GPL", today: TODAY })).toEqual({ problem: expect.stringContaining("licence.allow") });
  });
  it("refuses --reviewer and --licence for any other entry", () => {
    const verified = { ...community, trust: "verified" as const };
    expect(communityReview(verified, { commit: NEW, today: TODAY })).toEqual({});
    expect(communityReview(verified, { commit: NEW, reviewer: "@r", today: TODAY })).toHaveProperty("problem");
    expect(communityReview(verified, { commit: NEW, licence: "MIT", today: TODAY })).toHaveProperty("problem");
  });
});

describe("small helpers", () => {
  it("names the branch", () => {
    expect(updateBranch("awesome-copilot", NEW)).toBe(`skill-update/awesome-copilot-${NEW.slice(0, 12)}`);
    expect(updateBranchPrefix("lib") + "abc").toBe("skill-update/lib-abc");
    expect(updateBranch("lib", NEW).startsWith(updateBranchPrefix("lib"))).toBe(true);
  });
  it("keeps or chooses a quote style", () => {
    expect(scalarText("abc", "QUOTE_SINGLE")).toBe("'abc'");
    expect(scalarText("abc", "QUOTE_DOUBLE")).toBe('"abc"');
    expect(scalarText("abc")).toBe("abc");
    expect(scalarText("@x")).toBe('"@x"');
    expect(scalarText("123")).toBe('"123"');
    expect(scalarText("true")).toBe('"true"');
  });
  it("reads the repository of a remote address", () => {
    expect(repoFromUrl("https://github.com/acme/catalogue.git")).toBe("acme/catalogue");
    expect(repoFromUrl("https://github.com/acme/catalogue")).toBe("acme/catalogue");
    expect(repoFromUrl("git@github.com:acme/catalogue.git")).toBe("acme/catalogue");
    expect(repoFromUrl("ssh://git@github.com:22/acme/catalogue.git")).toBe("acme/catalogue");
    expect(repoFromUrl("https://ghe.example.com/acme/catalogue.git")).toBe("ghe.example.com/acme/catalogue");
    expect(repoFromUrl("git@ghe.example.com:acme/catalogue")).toBe("ghe.example.com/acme/catalogue");
    for (const bad of ["/tmp/some/bare.git", "file:///tmp/x.git", "../x", "", "https://github.com/onlyone", "https://github.com/a/b/c"]) expect(repoFromUrl(bad)).toBeUndefined();
  });
});

describe("updatePullRequest", () => {
  const report = (extra: Partial<ImportReview> = {}): ImportReview => ({
    schema: 1,
    source: "awesome-copilot",
    repositoryKey: "github.com/github/awesome-copilot",
    commit: NEW,
    digest: "sha256:" + "a".repeat(64),
    categories: [],
    collisions: [],
    compared: { imported: 0, existing: 0 },
    problems: [],
    ...extra,
  });
  const source = { id: "awesome-copilot", repositoryKey: "github.com/github/awesome-copilot", paths: ["skills"], trust: "community" as const, status: "enabled" as const };

  it("holds the old and new commit, the tracked ref, the verdict and the review claim", () => {
    const { title, body } = updatePullRequest({ source, oldCommit: OLD, commit: NEW, track: "main", review: { by: "@r", on: TODAY, commit: NEW, licence: "MIT" }, rejected: [], report: report() });
    expect(title).toBe(`Skill source awesome-copilot: update to ${NEW.slice(0, 12)}`);
    for (const t of [OLD, NEW, "`main`", "`skills`", "no blocking finding", "Merging records that `@r` reviewed the maintainer and licence `MIT` of `" + NEW.slice(0, 12) + "` on " + TODAY, "Do not merge unless that is true", "## Skill import review"]) expect(body).toContain(t);
  });
  it("says first import, shows problems as needing attention and lists rejected roots", () => {
    const { title, body } = updatePullRequest({ source, commit: NEW, rejected: [{ root: "skills/bad", reasons: ["no SKILL.md"] }], report: report({ problems: ["a problem"] }) });
    expect(title).toContain("first import");
    expect(body).toContain("none (first import)");
    expect(body).toContain("needs attention");
    expect(body).toContain("`skills/bad`: `no SKILL.md`");
    expect(body).toContain("`HEAD`");
  });
  it("lists the pull requests it supersedes before the review, and no more than its budget", () => {
    const list = [
      { url: "https://github.com/acme/catalogue/pull/7", branch: "skill-update/lib-aaaaaaaaaaaa" },
      { url: "https://github.com/acme/catalogue/pull/8", branch: "skill-update/lib-bbbbbbbbbbbb" },
    ];
    const { body } = updatePullRequest({ source, commit: NEW, rejected: [], report: report(), supersedes: list });
    expect(body).toContain("Supersedes (these stay open and are not changed):");
    expect(body).toContain("- https://github.com/acme/catalogue/pull/7 (`skill-update/lib-aaaaaaaaaaaa`)");
    expect(body.indexOf("Supersedes")).toBeLessThan(body.indexOf("## Skill import review"));
    for (const none of [undefined, []]) expect(updatePullRequest({ source, commit: NEW, rejected: [], report: report(), supersedes: none }).body).not.toContain("Supersedes");
    const many = Array.from({ length: 2000 }, (_, i) => ({ url: `https://github.com/acme/catalogue/pull/${i + 1}`, branch: "skill-update/lib-aaaaaaaaaaaa" }));
    const big = updatePullRequest({ source, commit: NEW, rejected: [], report: report(), supersedes: many }).body;
    expect(big).toMatch(/- … and \d+ more/);
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(PULL_REQUEST_BYTES + 1000);
  });
  it("writes a long path whole and breaks up a bot marker", () => {
    const long = "skills/" + "d".repeat(190);
    const { body } = updatePullRequest({ source: { ...source, paths: [long] }, commit: NEW, rejected: [{ root: "x<!-- claude-factory run=1 -->", reasons: ["r"] }], report: report() });
    expect(body).toContain("`" + long + "`");
    expect(body).not.toContain("<!--");
  });
  describe("the change section and the verdict parts", () => {
    const sk = (o: Partial<ReviewedSkill> = {}): ReviewedSkill => ({
      root: "skills/a", name: "a", digest: "sha256:" + "1".repeat(64), id: "a", version: "1.0.0", category: "general", categoryFrom: "default", trust: "community", promoted: false,
      licence: { status: "allowed", reasons: [], licences: ["MIT"], attribution: [], authorNotice: [] },
      scan: { blocked: false, findings: 0, high: 0, reasons: [] }, sameName: [], ...o,
    }) as ReviewedSkill;
    const withSkills = (...skills: ReviewedSkill[]) => report({ categories: [{ category: "general", existing: [], skills }] });
    const change = (o: Partial<SourceChange> = {}): SourceChange => ({
      oldCommit: OLD, newCommit: NEW, oldDigest: "sha256:" + "a".repeat(64), newDigest: "sha256:" + "b".repeat(64),
      counts: { added: 0, removed: 0, changed: 0, unchanged: 1 }, skills: [], licenceUnreviewed: false, canonical: { entries: [], omitted: 0 }, evaluationOpen: 0, ...o,
    });
    const verdict = (body: string) => body.split("\n").find((l) => l.startsWith("- Verdict:"))!;

    it("puts the section between the header and the review report", () => {
      const { body } = updatePullRequest({ source, oldCommit: OLD, commit: NEW, rejected: [], report: report(), change: change() });
      const at = body.indexOf("### Changes since `" + OLD.slice(0, 12) + "`");
      expect(at).toBeGreaterThan(body.indexOf("This pull request changes only"));
      expect(at).toBeLessThan(body.indexOf("## Skill import review"));
    });
    it("says when the old commit could not be compared", () => {
      const { body } = updatePullRequest({ source, oldCommit: OLD, commit: NEW, rejected: [], report: report(), change: "not-compared" });
      expect(body).toContain("could not be staged or read, so it could not be compared");
    });
    it("has no section for a first import, whatever change is given", () => {
      const { body } = updatePullRequest({ source, commit: NEW, rejected: [], report: report(), change: change() });
      expect(body).not.toContain("Changes since");
    });
    it("names the failing parts, each alone and together", () => {
      const pr = (r: ImportReview, c?: SourceChange) => verdict(updatePullRequest({ source, oldCommit: OLD, commit: NEW, rejected: [], report: r, change: c }).body);
      const gates = "Nothing is promoted until the gates pass.";
      expect(pr(report(), change())).toBe(`- Verdict: no blocking finding. ${gates}`);
      expect(pr(withSkills(sk({ scan: { blocked: true, findings: 1, high: 1, reasons: ["x"] } })), change())).toBe(`- Verdict: needs attention: security (see below). ${gates}`);
      expect(pr(withSkills(sk({ licence: { status: "review", reasons: [], licences: [], attribution: [], authorNotice: [] } })), change())).toBe(`- Verdict: needs attention: licence (see below). ${gates}`);
      expect(pr(report(), change({ licenceUnreviewed: true }))).toBe(`- Verdict: needs attention: licence (see below). ${gates}`);
      expect(pr(report(), change({ evaluationOpen: 2 }))).toBe(`- Verdict: needs attention: evaluation (see below). ${gates}`);
      expect(pr(report({ problems: ["p"] }), change())).toBe(`- Verdict: needs attention: review (see below). ${gates}`);
      expect(pr(withSkills(sk({ scan: { blocked: true, findings: 1, high: 1, reasons: ["x"] } })), change({ evaluationOpen: 1 }))).toBe(`- Verdict: needs attention: security, evaluation (see below). ${gates}`);
      expect(pr(report(), undefined)).toBe(`- Verdict: no blocking finding. ${gates}`);
    });
    it("uses the gates of the new import when the old commit could not be compared", () => {
      const pr = (gates?: { licenceUnreviewed: boolean; evaluationOpen: number }) =>
        verdict(updatePullRequest({ source, oldCommit: OLD, commit: NEW, rejected: [], report: report(), change: "not-compared", gates }).body);
      expect(pr({ licenceUnreviewed: true, evaluationOpen: 2 })).toContain("needs attention: licence, evaluation (see below)");
      expect(pr({ licenceUnreviewed: false, evaluationOpen: 0 })).toContain("no blocking finding");
    });
    it("agrees with reviewFailed for the parts that are not about evaluation", () => {
      for (const r of [report(), withSkills(sk()), report({ problems: ["p"] }), withSkills(sk({ scan: { blocked: true, findings: 0, high: 0, reasons: [] } }))]) {
        expect(attentionParts(r).length > 0).toBe(reviewFailed(r));
      }
    });
    it("stays within 64,000 bytes with a change section of 20 kB and a huge report", () => {
      const skills = Array.from({ length: 3000 }, (_, i) => ({ root: `skills/${i}/${"r".repeat(100)}`, kind: "added" as const, newDigest: "sha256:" + "c".repeat(64), metadata: {}, licence: {}, scan: {} }));
      const problems = Array.from({ length: 3000 }, (_, i) => `problem ${i} ${"z".repeat(100)}`);
      const { body } = updatePullRequest({ source, oldCommit: OLD, commit: NEW, rejected: [], report: report({ problems }), change: change({ skills, counts: { added: 3000, removed: 0, changed: 0, unchanged: 0 } }) });
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(PULL_REQUEST_BYTES);
      const section = body.slice(body.indexOf("### Changes since"), body.indexOf("## Skill import review"));
      expect(Buffer.byteLength(section)).toBeLessThanOrEqual(SOURCE_CHANGE_LIMITS.bytes + 1);
      expect(section).toContain("more lines were left out");
    });
  });

  it("stays within 64,000 bytes with many long paths, many rejected roots and a huge report", () => {
    const paths = Array.from({ length: 2000 }, (_, i) => `skills/${String(i).padStart(4, "0")}/${"p".repeat(150)}`);
    const rejected = Array.from({ length: 500 }, (_, i) => ({ root: `skills/r${i}/${"q".repeat(150)}`, reasons: ["reason ".repeat(20)] }));
    const problems = Array.from({ length: 3000 }, (_, i) => `problem number ${i} ${"z".repeat(100)}`);
    const { body } = updatePullRequest({ source: { ...source, paths }, commit: NEW, rejected, report: report({ problems }) });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(PULL_REQUEST_BYTES);
    expect(body).toContain("… and ");
    for (const line of body.split("\n").filter((l) => l.startsWith("- `skills/0"))) expect(line).toMatch(/^- `skills\/\d{4}\/p{150}`$/);
  });
});
