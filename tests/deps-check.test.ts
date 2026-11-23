import { describe, expect, it } from "vitest";
import {
  UP_TO_DATE, buildReport, classify, cloneInfo, compareVersions, depsNpmEnv, lockedVersions, mavenFromRun, npmOutdatedFromRun,
  parseMavenUpdates, parseNpmAuditAll, parseNpmOutdated, reportText, summaryLine,
  type DepsReport,
} from "../src/deps/check.js";

describe("classify", () => {
  it.each([
    ["1.2.3", "1.2.4", "patch"], ["1.2.3", "1.3.0", "minor"], ["1.2.3", "2.0.0", "major"],
    ["31.1-jre", "32.1.2-jre", "major"], ["1.0", "1.0.1", "patch"], ["v1.0.0", "1.1.0", "minor"],
    ["2.0.0", "1.9.0", undefined], ["abc", "1.0.0", "major"],
    ["1.0.0-rc.2", "1.0.0-rc.1", undefined], ["1.0.0-rc.1", "1.0.0", "patch"],
    ["1.0.0+a", "1.0.0+b", undefined], ["1.0.0-rc.2", "1.0.0-rc.10", "patch"],
    ["1.0.0.9", "1.0.0.10", "patch"], ["1.0.0.10", "1.0.0.9", undefined], ["1.0.0.9", "1.0.1", "patch"],
  ])("%s → %s is %s", (a, b, want) => {
    expect(classify(a, b)).toBe(want);
  });

  it("orders a prerelease below its release", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBe(1);
    expect(compareVersions("x", "1.0.0")).toBeUndefined();
  });
});

const MAVEN = `[INFO] --- versions:2.16.0:display-dependency-updates (default-cli) @ app ---
[INFO] The following dependencies in Dependencies have newer versions:
[INFO]   org.foo:bar ........................................ 1.0.0 -> 1.0.1
[INFO]   com.google.guava:guava ...................... 31.1-jre -> 32.1.2-jre
[INFO]   org.foo:bar ........................................ 1.0.0 -> 1.0.1
[INFO]   a;rm:evil .......................................... 1.0 -> 2.0
[INFO]
[INFO] The following dependencies in Dependency Management have newer versions:
[INFO]   org.dm:managed ..................................... 1.0 -> 1.1
[INFO]
[WARNING] The following plugins do not have their version specified:
[WARNING]   maven-antrun-plugin ....................... 1.0 -> 2.0
[INFO]
[INFO] The following plugin updates are available:
[INFO]   org.apache.maven.plugins:maven-compiler-plugin
[INFO]       ...................................... 3.8.1 -> 3.11.0
[INFO]   maven-surefire-plugin ................ (from super-pom) 2.12.4 -> 3.0.0
[INFO]
[INFO] The parent project has a newer version:
[INFO]   \u001b[1morg.springframework.boot:spring-boot-starter-parent\u001b[m ... 2.7.0 -> 3.0.0
[INFO]   org.spring:parent .................................. 2.7.0 -> 3.0.0
[INFO]   stray:entry ........................................ 1.0 -> 1.1
`;

describe("parseMavenUpdates", () => {
  const got = parseMavenUpdates(MAVEN);
  it("reads kinds, names and versions", () => {
    expect(got).toEqual([
      { kind: "dependency", name: "org.foo:bar", current: "1.0.0", latest: "1.0.1" },
      { kind: "dependency", name: "com.google.guava:guava", current: "31.1-jre", latest: "32.1.2-jre" },
      { kind: "dependency", name: "org.dm:managed", current: "1.0", latest: "1.1" },
      { kind: "plugin", name: "org.apache.maven.plugins:maven-compiler-plugin", current: "3.8.1", latest: "3.11.0" },
      { kind: "plugin", name: "maven-surefire-plugin", current: "2.12.4", latest: "3.0.0" },
      { kind: "parent", name: "org.springframework.boot:spring-boot-starter-parent", current: "2.7.0", latest: "3.0.0" },
      { kind: "parent", name: "org.spring:parent", current: "2.7.0", latest: "3.0.0" },
      { kind: "parent", name: "stray:entry", current: "1.0", latest: "1.1" },
    ]);
  });
  it("drops a bad name, keeps duplicates once, ignores the warning section and stray lines", () => {
    expect(got.some((e) => e.name.includes("rm"))).toBe(false);
    expect(got.some((e) => e.name === "maven-antrun-plugin")).toBe(false);
    expect(parseMavenUpdates("[INFO]   org.foo:bar ... 1.0 -> 2.0\n")).toEqual([]);
  });
});

describe("npm outdated and lock", () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lodash": { version: "4.17.20" }, "node_modules/a/node_modules/b": { version: "1.0.0" } } });
  it("reads v3 and v1 locks and survives invalid JSON", () => {
    expect([...lockedVersions(lock)]).toEqual([["lodash", "4.17.20"]]);
    expect(lockedVersions(JSON.stringify({ dependencies: { react: { version: "17.0.0" } } })).get("react")).toBe("17.0.0");
    expect(lockedVersions("{nope").size).toBe(0);
  });
  it("reads the object and array forms, fills current from the lock, counts the unlocated", () => {
    const locked = lockedVersions(lock);
    const p = parseNpmOutdated(JSON.stringify({ lodash: { latest: "4.17.21" }, react: [{ current: "17.0.0", latest: "18.0.0" }], ghost: { latest: "2.0.0" }, "bad name": { current: "1.0.0", latest: "2.0.0" } }), locked);
    expect(p).toEqual({ ok: true, notLocated: 1, entries: [{ name: "lodash", current: "4.17.20", latest: "4.17.21" }, { name: "react", current: "17.0.0", latest: "18.0.0" }] });
  });
  it("fails on error JSON and invalid JSON, accepts empty output", () => {
    expect(parseNpmOutdated(JSON.stringify({ error: { summary: "boom" } }), new Map())).toMatchObject({ ok: false });
    expect(parseNpmOutdated("not json", new Map())).toMatchObject({ ok: false });
    expect(parseNpmOutdated("", new Map())).toEqual({ ok: true, entries: [], notLocated: 0 });
  });
});

describe("parseNpmAuditAll", () => {
  it("keeps every severity and drops bad names", () => {
    const v = (severity: string, name = "p") => ({ via: [{ name, severity, title: "T", url: "https://github.com/advisories/GHSA-1" }], fixAvailable: true });
    const r = parseNpmAuditAll(JSON.stringify({ vulnerabilities: { a: v("low", "a"), b: v("moderate", "b"), c: v("high", "c"), d: v("critical", "d"), e: v("low", "bad name") } }));
    expect(r).toMatchObject({ checked: true });
    expect(r.checked && r.advisories.map((a) => a.package + a.severity)).toEqual(["dcritical", "chigh", "bmoderate", "alow"]);
  });
  it("marks a package that depends on a vulnerable one (npm lists its name as a string in via)", () => {
    const r = parseNpmAuditAll(JSON.stringify({
      vulnerabilities: {
        "parent-pkg": { via: ["child-pkg"], fixAvailable: true },
        "child-pkg": { via: [{ name: "child-pkg", severity: "high", title: "Bad", url: "https://github.com/advisories/GHSA-2" }], fixAvailable: false },
      },
    }));
    expect(r.checked && r.advisories.map((a) => [a.package, a.severity])).toEqual([["child-pkg", "high"], ["parent-pkg", "high"]]);
    expect(r.checked && r.advisories.find((a) => a.package === "parent-pkg")).toMatchObject({ title: "depends on child-pkg: Bad", fix: true });
    const rep = buildReport({ branch: "", commit: "", npm: { outdated: { status: 1, stdout: JSON.stringify({ "parent-pkg": { current: "1.0.0", latest: "1.0.1" } }) }, audit: r, lock: "{}" } });
    expect(rep.updates.find((u) => u.name === "parent-pkg")).toMatchObject({ security: true });
  });
  it("is not checked on error JSON", () => {
    expect(parseNpmAuditAll(JSON.stringify({ error: { code: "E" } }))).toMatchObject({ checked: false });
  });
});

describe("depsNpmEnv", () => {
  it("drops credentials and npm settings, keeps the rest", () => {
    const e = depsNpmEnv({ NPM_TOKEN: "x", NODE_AUTH_TOKEN: "x", "npm_config_//registry.npmjs.org/:_authToken": "x", npm_config_registry: "http://evil", PATH: "/bin", HOME: "/h" }, "/u", "/g");
    expect(e).toEqual({ PATH: "/bin", HOME: "/h", npm_config_userconfig: "/u", npm_config_globalconfig: "/g" });
  });
});

describe("runs", () => {
  it("maven: missing, timed out, failed", () => {
    expect(mavenFromRun({ error: { code: "ENOENT" } }, "mvn")).toMatchObject({ ok: false, note: "mvn was not found" });
    expect(mavenFromRun({ error: { code: "ETIMEDOUT" } }, "mvn").note).toContain("did not finish in 20 min");
    expect(mavenFromRun({ status: 1, stdout: MAVEN }, "mvn")).toMatchObject({ ok: false, found: [] });
  });
  it("npm outdated: exit 1 with JSON is normal; exit 2 and error JSON are failures", () => {
    const out = JSON.stringify({ react: { current: "17.0.0", latest: "18.0.0" } });
    expect(npmOutdatedFromRun({ status: 1, stdout: out }, new Map())).toMatchObject({ ok: true });
    expect(npmOutdatedFromRun({ status: 2, stdout: "{}" }, new Map())).toMatchObject({ ok: false });
    expect(npmOutdatedFromRun({ status: 1, stdout: JSON.stringify({ error: { code: "E" } }) }, new Map())).toMatchObject({ ok: false });
  });
});

const outdated = JSON.stringify({ lodash: { current: "4.17.20", latest: "4.17.21" }, react: { current: "17.0.0", latest: "18.0.0" }, jest: { current: "29.0.0", latest: "29.1.0" } });
const audit = (...pkgs: string[]) => parseNpmAuditAll(JSON.stringify({ vulnerabilities: Object.fromEntries(pkgs.map((p) => [p, { via: [{ name: p, severity: "moderate", title: "T" }], fixAvailable: false }])) }));

describe("buildReport", () => {
  it("marks security by package, sorts, and counts", () => {
    const r = buildReport({
      branch: "develop", commit: "a".repeat(40),
      maven: { run: { status: 0, stdout: MAVEN }, cmd: "mvn" },
      npm: { outdated: { status: 1, stdout: outdated }, audit: audit("lodash"), lock: "{}" },
    });
    const npm = r.updates.filter((u) => u.tool === "npm");
    expect(npm.map((u) => [u.name, u.class, u.security])).toEqual([["lodash", "patch", true], ["react", "major", false], ["jest", "minor", false]]);
    expect(r.updates.filter((u) => u.security)).toHaveLength(1);
    expect(r.updates[0]!.name).toBe("lodash");
    expect(r.projects).toEqual(["maven", "npm"]);
    expect(r.unavailable).toBe(0);
  });
  it("counts a failed audit as not available and a failed ci or unlocated entry as incomplete", () => {
    const r = buildReport({
      branch: "", commit: "",
      npm: { ci: { status: 1 }, outdated: { status: 1, stdout: JSON.stringify({ ghost: { latest: "2.0.0" } }) }, audit: { checked: false, reason: "no lock" }, lock: "{}" },
    });
    expect(r.unavailable).toBe(1);
    expect(r.incomplete).toBe(2);
    expect(reportText(r)).not.toContain(UP_TO_DATE);
  });
  it("lists an advisory with no update row", () => {
    const r = buildReport({ branch: "develop", commit: "", npm: { outdated: { status: 0, stdout: "{}" }, audit: audit("minimist"), lock: "{}" } });
    expect(r.unlisted.map((a) => a.package)).toEqual(["minimist"]);
    const t = reportText(r);
    expect(t).toContain("Vulnerable, no update row:");
    expect(t).not.toContain(UP_TO_DATE);
  });
  it("has no project", () => {
    const r = buildReport({ branch: "", commit: "" });
    expect(r.projects).toEqual([]);
    expect(reportText(r)).toContain("nothing to check");
  });
});

describe("reportText", () => {
  it("says up to date only when everything worked", () => {
    const r = buildReport({ branch: "develop", commit: "b".repeat(40), npm: { outdated: { status: 0, stdout: "{}" }, audit: audit(), lock: "{}" } });
    const t = reportText(r);
    expect(t).toContain(UP_TO_DATE);
    expect(t.split("\n").at(-1)).toBe("Updates found: 0 (0 security). Tools not available: 0. Incomplete: 0.");
    expect(t.split("\n")[0]).toBe("Dependencies of develop (bbbbbbb):");
  });
  it("never says up to date when a tool was not available", () => {
    const t = reportText(buildReport({ branch: "", commit: "", maven: { run: { error: { code: "ENOENT" } }, cmd: "mvn" } }));
    expect(t).not.toContain(UP_TO_DATE);
    expect(t).toContain("Note: maven: mvn was not found");
    expect(t.split("\n").at(-1)).toContain("Tools not available: 1.");
  });
  it("shows at most 100 rows", () => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`pkg-${i}`, { current: "1.0.0", latest: "2.0.0" }]));
    const r: DepsReport = buildReport({ branch: "", commit: "", npm: { outdated: { status: 1, stdout: JSON.stringify(many) }, audit: audit(), lock: "{}" } });
    const lines = reportText(r).split("\n");
    expect(lines.filter((l) => l.startsWith("npm "))).toHaveLength(100);
    expect(lines).toContain("… and 50 more in deps.json");
    expect(r.updates).toHaveLength(150);
    expect(summaryLine(r)).toBe(lines.at(-1));
  });
});

describe("cloneInfo", () => {
  it("reads the branch and the commit", () => {
    expect(cloneInfo(`x\nbranch: develop\nBASE: ${"c".repeat(40)}\n`)).toEqual({ branch: "develop", commit: "c".repeat(40) });
    expect(cloneInfo("nothing")).toEqual({ branch: "", commit: "" });
  });
});
