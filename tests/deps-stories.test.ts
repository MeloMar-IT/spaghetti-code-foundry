import { describe, expect, it } from "vitest";
import type { DepUpdate, DepsReport } from "../src/deps/check.js";
import {
  BODY_MAX, type KnownIssue, buildCommands, fileSummary, fileText, groupIn, groupMarker, groupOf, isIgnored, labelsFor, marker, markersIn,
  parseDepsSettings, parseIgnore, planFiling, storyBody, storyTitle, updateLine, validReport, withoutIgnored,
} from "../src/deps/stories.js";

const up = (name: string, current: string, latest: string, cls: DepUpdate["class"], o: Partial<DepUpdate> = {}): DepUpdate => ({
  tool: name.includes(":") ? "maven" : "npm", kind: "dependency", name, current, latest, class: cls, security: false, ...o,
});
const report = (updates: DepUpdate[], o: Partial<DepsReport> = {}): DepsReport => ({
  version: 1, branch: "develop", commit: "a".repeat(40), projects: ["maven", "npm"], updates, advisories: [], unlisted: [], checks: [], notes: [], unavailable: 0, incomplete: 0, ...o,
});
const settings = { labels: ["Factory_go"], majorsGo: false };
const plan = (updates: DepUpdate[], issues: KnownIssue[] = [], o: { filed?: Parameters<typeof planFiling>[0]["filed"]; advisories?: DepsReport["advisories"]; s?: typeof settings } = {}) =>
  planFiling({ report: validReport(report(updates, { advisories: o.advisories ?? [] })), issues, settings: o.s ?? settings, filed: o.filed ?? [], build: {} });
const issue = (number: number, body: string, o: Partial<KnownIssue> = {}): KnownIssue => ({ number, state: "open", stateReason: null, title: `t${number}`, body, ...o });

const MIX = [
  up("org.foo:bar", "1.0.0", "1.0.1", "patch"),
  up("org.x:plugin", "1.0", "1.1.0", "minor", { kind: "plugin" }),
  up("org.p:parent", "1.0", "2.0", "major", { kind: "parent" }),
  up("react", "17.0.0", "18.0.0", "major"),
  up("@acme/lodash", "4.17.20", "4.17.21", "patch", { security: true }),
];

describe("deps settings", () => {
  it("has defaults, and reads labels and majors", () => {
    expect(parseDepsSettings({})).toEqual({ labels: ["Factory_go"], majorsGo: false });
    expect(parseDepsSettings({ FACTORY_VAR_DEPS_LABELS: " go , deps,go", FACTORY_VAR_DEPS_MAJORS_GO: "Yes" })).toEqual({ labels: ["go", "deps"], majorsGo: true });
    expect(parseDepsSettings({ FACTORY_VAR_DEPS_MAJORS_GO: "true" }).majorsGo).toBe(true);
    expect(parseDepsSettings({ FACTORY_VAR_DEPS_LABELS: "needs review ✓" }).labels).toEqual(["needs review ✓"]);
  });
  it("rejects a wrong value", () => {
    expect(() => parseDepsSettings({ FACTORY_VAR_DEPS_MAJORS_GO: "maybe" })).toThrow(/yes or no/);
    expect(() => parseDepsSettings({ FACTORY_VAR_DEPS_LABELS: "x".repeat(51) })).toThrow(/deps_labels/);
    expect(() => parseDepsSettings({ FACTORY_VAR_DEPS_LABELS: Array.from({ length: 21 }, (_, i) => `l${i}`).join(",") })).toThrow(/deps_labels/);
  });
  it("labels per group", () => {
    expect(labelsFor("updates", settings)).toEqual(["Factory_go", "enhancement"]);
    expect(labelsFor("major", settings)).toEqual(["enhancement"]);
    expect(labelsFor("major", { labels: ["go", "deps"], majorsGo: true })).toEqual(["enhancement", "go", "deps"]);
    expect(labelsFor("security", settings)).toEqual(["Factory_go", "bug"]);
    expect(labelsFor("security", { labels: ["bug"], majorsGo: false })).toEqual(["bug"]);
  });
});

describe("deps_ignore", () => {
  it("matches names and group patterns", () => {
    const { rules, bad } = parseIgnore("org.foo:*, react @types/node a;b  org.x:y");
    expect(rules).toEqual(["org.foo:*", "react", "@types/node", "org.x:y"]);
    expect(bad).toEqual(["a;b"]);
    expect(isIgnored("org.foo:bar", rules)).toBe(true);
    expect(isIgnored("org.foobar:x", rules)).toBe(false);
    expect(isIgnored("@types/node", rules)).toBe(true);
    expect(isIgnored("react-dom", rules)).toBe(false);
  });
  it("drops updates and advisories of ignored names", () => {
    const adv = { package: "lodash", severity: "high" as const, title: "x", url: "", fix: true };
    const r = withoutIgnored(report([up("lodash", "1.0.0", "1.0.1", "patch"), up("react", "1.0.0", "2.0.0", "major")], { advisories: [adv], unlisted: [adv] }), ["lodash"]);
    expect(r.updates.map((u) => u.name)).toEqual(["react"]);
    expect(r.advisories).toEqual([]);
    expect(r.unlisted).toEqual([]);
  });
});

describe("markers and checks", () => {
  it("reads markers of scoped names and the group", () => {
    const body = `${marker("@acme/x", "1.0.0")}\n${marker("org.a:b", "2.0")}\n${groupMarker("major")}`;
    expect(markersIn(body)).toEqual([{ name: "@acme/x", version: "1.0.0" }, { name: "org.a:b", version: "2.0" }]);
    expect(groupIn(body)).toBe("major");
    expect(groupIn("nothing")).toBeUndefined();
  });
  it("groupOf: security beats major, then major, else updates", () => {
    expect(groupOf(up("a", "1.0.0", "2.0.0", "major", { security: true }))).toBe("security");
    expect(groupOf(up("a", "1.0.0", "2.0.0", "major"))).toBe("major");
    expect(groupOf(up("a", "1.0.0", "1.1.0", "minor"))).toBe("updates");
    expect(groupOf(up("a", "1.0.0", "1.0.1", "patch"))).toBe("updates");
  });
  it("validReport drops a bad name, version, class or duplicate of a tampered file", () => {
    const r = validReport({
      branch: "develop", commit: "b".repeat(40), unavailable: 2,
      updates: [
        up("ok", "1.0.0", "1.0.1", "patch"), up("bad name;rm", "1.0.0", "1.0.1", "patch"), up("v", "1.0.0", "1.0.1 <!--", "patch"),
        { ...up("c", "1.0.0", "1.0.1", "patch"), class: "huge" }, up("ok", "1.0.0", "1.0.2", "patch"), "x",
      ],
      advisories: [{ package: "ok", severity: "high", title: "Bad @everyone", url: "javascript:alert(1)", fix: true }],
    });
    expect(r.updates.map((u) => u.name)).toEqual(["ok"]);
    expect(r.dropped).toBe(5);
    expect(r.advisories[0]!.url).toBe("");
    expect(r.advisories[0]!.title).not.toMatch(/@everyone/);
    expect(validReport(null).updates).toEqual([]);
  });
});

describe("bodies", () => {
  it("an update line has name, from, to, type, link, and the marker of the new version", () => {
    const adv = [{ package: "@acme/x", severity: "high" as const, title: "t", url: "https://github.com/advisories/GHSA-1", fix: true }];
    const l = updateLine(up("@acme/x", "1.0.0", "1.0.1", "patch", { security: true }), adv);
    expect(l).toBe("- `@acme/x` — npm dependency: 1.0.0 → 1.0.1 (patch), security: high — https://github.com/advisories/GHSA-1 <!-- deps-weekly: @acme/x@1.0.1 -->");
    expect(updateLine(up("org.x:p", "1.0", "1.1", "minor", { kind: "plugin" }), [])).toContain("Maven plugin: 1.0 → 1.1 (minor) <!-- deps-weekly: org.x:p@1.1 -->");
  });
  it("commands follow the manifests", () => {
    const npm = new Set(["npm" as const]);
    expect(buildCommands(npm, { npm: { lock: true, build: true, test: true } })).toEqual(["npm ci", "npm run build", "npm test"]);
    expect(buildCommands(npm, { npm: { lock: false, build: false, test: true } })).toEqual(["npm install", "npm test"]);
    expect(buildCommands(npm, { npm: { lock: true, build: true, test: false } })).toEqual(["npm ci", "npm run build"]);
    expect(buildCommands(new Set(["maven" as const, "npm" as const]), { maven: { wrapper: true }, npm: { lock: true, build: false, test: true } })).toEqual(["./mvnw -B verify", "npm ci", "npm test"]);
    expect(buildCommands(new Set(["maven" as const]), {})).toEqual(["mvn -B verify"]);
  });
  it("a story body lists the build, the criteria and the group marker; only the tools of its updates", () => {
    const body = storyBody("major", [up("react", "17.0.0", "18.0.0", "major")], { branch: "develop", commit: "a".repeat(40), advisories: [], build: { maven: { wrapper: false }, npm: { lock: true, build: true, test: true } } });
    expect(body).toContain("`develop` at `aaaaaaa`");
    expect(body).toContain("- `npm run build`");
    expect(body).not.toContain("mvn");
    expect(body).toContain("breaking changes");
    expect(body.trimEnd().endsWith(groupMarker("major"))).toBe(true);
    expect(storyTitle("major", [up("react", "17.0.0", "18.0.0", "major")])).toBe("Update react to 18.0.0 (major)");
  });
});

describe("planFiling", () => {
  it("files one patch/minor story, one story per major, one security story", () => {
    const p = plan(MIX);
    expect(p.found).toBe(5);
    expect(p.stories.map((s) => [s.group, s.labels, s.updates.map((u) => u.name)])).toEqual([
      ["security", ["Factory_go", "bug"], ["@acme/lodash"]],
      ["updates", ["Factory_go", "enhancement"], ["org.foo:bar", "org.x:plugin"]],
      ["major", ["enhancement"], ["org.p:parent"]],
      ["major", ["enhancement"], ["react"]],
    ]);
    for (const s of p.stories) {
      for (const u of s.updates) expect(s.body.split(marker(u.name, u.latest))).toHaveLength(2);
      expect(groupIn(s.body)).toBe(s.group);
    }
    expect(fileSummary(p)).toBe("Updates found: 5. Filed: 5 in 4 stories. Updated in open stories: 0. Skipped as already filed: 0. Tools not available: 0.");
    expect(fileText(p, { stories: [{ number: 7 }, { number: 8 }, { number: 9 }, { number: 10 }] }).split("\n").at(-1)).toBe(fileSummary(p));
  });
  it("majorsGo gives the major stories the trigger labels", () => {
    const p = plan(MIX, [], { s: { labels: ["go", "deps"], majorsGo: true } });
    expect(p.stories.filter((s) => s.group === "major").map((s) => s.labels)).toEqual([["enhancement", "go", "deps"], ["enhancement", "go", "deps"]]);
  });
  it("skips what an open or closed issue holds, also one closed as not planned", () => {
    const first = plan(MIX);
    const issues = first.stories.map((s, n) => issue(n + 1, s.body, n === 2 ? { state: "closed", stateReason: "not_planned" } : n === 3 ? { state: "closed", stateReason: "completed" } : {}));
    const p = plan(MIX, issues);
    expect(p.stories).toEqual([]);
    expect(p.edits).toEqual([]);
    expect(p.skipped.map((s) => s.why).sort()).toEqual(["closed", "not_planned", "open", "open", "open"]);
    expect(fileSummary(p)).toContain("Filed: 0 in 0 stories. Updated in open stories: 0. Skipped as already filed: 5.");
  });
  it("files a newer version when only an older one was closed as not planned", () => {
    const old = issue(1, `${marker("lodash", "4.17.20")}\n${groupMarker("updates")}`, { state: "closed", stateReason: "not_planned" });
    expect(plan([up("lodash", "4.17.19", "4.17.21", "patch")], [old]).stories).toHaveLength(1);
    expect(plan([up("lodash", "4.17.19", "4.17.20", "patch")], [old]).skipped[0]!.why).toBe("not_planned");
  });
  it("edits the line and marker of an open story for a newer version, and keeps the rest", () => {
    const first = plan([up("org.foo:bar", "1.0.0", "1.0.1", "patch"), up("org.foo:baz", "1.0.0", "1.0.1", "patch")]);
    const body = `Hand-written note.\n${first.stories[0]!.body}`;
    const p = plan([up("org.foo:bar", "1.0.0", "1.0.2", "patch"), up("org.foo:baz", "1.0.0", "1.0.1", "patch")], [issue(5, body)]);
    expect(p.stories).toEqual([]);
    expect(p.edits).toHaveLength(1);
    const e = p.edits[0]!;
    expect(e.number).toBe(5);
    expect(e.body).toContain(marker("org.foo:bar", "1.0.2"));
    expect(e.body).not.toContain(marker("org.foo:bar", "1.0.1"));
    expect(e.body).toContain("Hand-written note.");
    expect(e.body).toContain(marker("org.foo:baz", "1.0.1"));
    expect(e.title).toBeUndefined();
    expect(p.skipped).toHaveLength(1);
    expect(fileSummary(p)).toContain("Updated in open stories: 1. Skipped as already filed: 1.");
  });
  it("a major story gets a new title", () => {
    const first = plan([up("react", "17.0.0", "18.0.0", "major")]);
    const p = plan([up("react", "17.0.0", "19.0.0", "major")], [issue(3, first.stories[0]!.body)]);
    expect(p.edits[0]!.title).toBe("Update react to 19.0.0 (major)");
  });
  it("a minor story whose update becomes major gives the line up; the major gets its own story without the trigger label", () => {
    const first = plan([up("x", "1.0.0", "1.1.0", "minor"), up("y", "1.0.0", "1.0.1", "patch")]);
    const p = plan([up("x", "1.0.0", "2.0.0", "major"), up("y", "1.0.0", "1.0.1", "patch")], [issue(3, first.stories[0]!.body)]);
    expect(p.stories.map((s) => [s.group, s.labels, s.updates.map((u) => u.name)])).toEqual([["major", ["enhancement"], ["x"]]]);
    expect(p.edits).toHaveLength(1);
    expect(p.edits[0]!.body).not.toContain(marker("x", "1.1.0"));
    expect(p.edits[0]!.body).toContain(marker("y", "1.0.1"));
    expect(p.edits[0]!.moved).toEqual(["x"]);
    expect(p.edits[0]!.addLabels).toEqual([]);
    expect(p.skipped.map((s) => s.u.name)).toEqual(["y"]);
    expect(fileSummary(p)).toBe("Updates found: 2. Filed: 1 in 1 stories. Updated in open stories: 0. Skipped as already filed: 1. Tools not available: 0.");
    expect(fileText(p, { stories: [{ number: 9 }] })).toContain("Moved x out of #3: filed in their own story");
  });
  it("a major story whose update is now minor is left alone, and a minor story is filed", () => {
    const first = plan([up("x", "1.9.0", "2.0.0", "major")]);
    const p = plan([up("x", "2.0.0", "2.1.0", "minor")], [issue(3, first.stories[0]!.body)]);
    expect(p.edits).toEqual([]);
    expect(p.stories.map((s) => [s.group, s.labels])).toEqual([["updates", ["Factory_go", "enhancement"]]]);
  });
  it("a security update reaches an open story that asks for a higher version: its line, trigger labels and bug; the version stays", () => {
    const first = plan([up("react", "17.0.0", "18.0.0", "major")]);
    const adv = [{ package: "react", severity: "high" as const, title: "t", url: "", fix: true }];
    const p = plan([up("react", "17.0.0", "17.5.0", "minor", { security: true })], [issue(3, first.stories[0]!.body)], { advisories: adv });
    expect(p.stories).toEqual([]);
    expect(p.edits).toHaveLength(1);
    expect(p.edits[0]!.body).toContain(", security: high");
    expect(p.edits[0]!.body).toContain(marker("react", "18.0.0"));
    expect(p.edits[0]!.body).not.toContain(marker("react", "17.5.0"));
    expect(p.edits[0]!.addLabels).toEqual(["Factory_go", "bug"]);
    expect(p.edits[0]!.title).toBeUndefined();
    expect(p.skipped).toEqual([]);
  });
  it("skips when the open story asks for a higher version", () => {
    const p = plan([up("x", "1.0.0", "1.0.1", "patch")], [issue(3, `${marker("x", "1.0.5")}\n${groupMarker("updates")}`)]);
    expect(p.stories).toEqual([]);
    expect(p.edits).toEqual([]);
    expect(p.skipped).toHaveLength(1);
  });
  it("an unchanged version that is now a security update escalates the open story: its line and the labels", () => {
    const first = plan([up("lodash", "4.17.20", "4.17.21", "patch")]);
    const adv = [{ package: "lodash", severity: "high" as const, title: "t", url: "", fix: true }];
    const p = plan([up("lodash", "4.17.20", "4.17.21", "patch", { security: true })], [issue(3, first.stories[0]!.body)], { advisories: adv });
    expect(p.stories).toEqual([]);
    expect(p.edits).toHaveLength(1);
    expect(p.edits[0]!.body).toContain(", security: high");
    expect(p.edits[0]!.addLabels).toEqual(["Factory_go", "bug"]);
    // once the line says so, nothing more is done; a closed story is never touched
    const again = plan([up("lodash", "4.17.20", "4.17.21", "patch", { security: true })], [issue(3, p.edits[0]!.body)], { advisories: adv });
    expect(again.edits).toEqual([]);
    expect(plan([up("lodash", "4.17.20", "4.17.21", "patch", { security: true })], [issue(3, first.stories[0]!.body, { state: "closed" })]).edits).toEqual([]);
  });
  it("counts what filed.json holds as filed by this run, not as skipped", () => {
    const first = plan(MIX);
    const filed = first.stories.map((s, n) => ({ number: n + 1, markers: s.updates.map((u) => marker(u.name, u.latest)), edit: false }));
    const issues = first.stories.slice(0, 2).map((s, n) => issue(n + 1, s.body));
    const p = plan(MIX, issues, { filed: filed.slice(0, 2) });
    expect(p.mine).toEqual({ filed: 3, updated: 0, stories: 2 });
    expect(p.stories.map((s) => s.group)).toEqual(["major", "major"]);
    expect(p.skipped).toEqual([]);
    expect(fileSummary(p)).toContain("Filed: 5 in 4 stories.");
  });
  it("keeps all patch and minor updates in one story, whatever their number", () => {
    const many = Array.from({ length: 120 }, (_, i) => up(`pkg${i}`, "1.0.0", "1.0.1", "patch"));
    const p = plan(many);
    expect(p.stories).toHaveLength(1);
    expect(p.stories[0]!.body.length).toBeLessThan(BODY_MAX);
    expect(p.notes).toEqual([]);
  });
  it("splits only when the text would not fit in one issue, and says so", () => {
    const many = Array.from({ length: 700 }, (_, i) => up(`@scope/${"n".repeat(100)}${i}`, "1.0.0", "1.0.1", "patch"));
    const p = plan(many);
    expect(p.stories.length).toBeGreaterThan(1);
    for (const s of p.stories) expect(s.body.length).toBeLessThanOrEqual(BODY_MAX);
    expect(p.stories.reduce((n, s) => n + s.updates.length, 0)).toBe(700);
    expect(p.stories[0]!.title).toContain(`part 1 of ${p.stories.length}`);
    expect(p.notes[0]).toMatch(/do not fit in one issue/);
  });
});
