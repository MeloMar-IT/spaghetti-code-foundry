import { describe, expect, it } from "vitest";
import { selectCanonicalSkills } from "../src/skills/canonical.js";
import { canonicalFromCollision } from "../src/skills/canonical-facts.js";
import { detectSkillCandidates } from "../src/skills/candidates.js";
import type { CollisionCandidate } from "../src/skills/collisions.js";
import { detectIntegrationCandidates } from "../src/skills/integration-candidates.js";
import { projectTechnologies, supportStatus, technologyName, technologyVersion } from "../src/skills/project-technologies.js";
import { dependenciesIn } from "../src/skills/repo-profile-detect.js";
import type { RepoFinding, RepoProfile } from "../src/skills/repo-profile.js";
import { REPO_PROFILE_LIMITS, SKIP_CLASSES } from "../src/skills/repo-profile-rules.js";
import { SUPPORTED_LINES, TECHNOLOGY_ALIASES, TECHNOLOGY_NAMES, TECHNOLOGY_SUPPORT_REVIEWED } from "../src/skills/technology-rules.js";
import { parsePartial } from "../src/skills/version-range.js";

const profile = (findings: RepoFinding[]): RepoProfile => ({
  version: 1,
  limits: REPO_PROFILE_LIMITS,
  stats: { files: 0, directories: 0, bytesRead: 0 },
  truncated: { files: false, bytes: false, findings: false },
  skipped: Object.fromEntries(SKIP_CLASSES.map((c) => [c, 0])),
  findings,
}) as unknown as RepoProfile;
const dep = (path: string, name: string, value?: string): RepoFinding =>
  ({ kind: "dependency", name, path, detector: "technology-x", reason: "r", ...(value !== undefined ? { value } : {}) }) as RepoFinding;
const manifest = (path: string, name: string): RepoFinding => ({ kind: "manifest", name, path, detector: "manifest-name", reason: "r" }) as RepoFinding;
const lang = (path: string, name: string): RepoFinding => ({ kind: "language", name, path, detector: "language-extension", reason: "r", count: 1 }) as RepoFinding;
const BOOT = "org.springframework.boot";
const show = (p: RepoProfile, modules?: string[]) =>
  projectTechnologies(p, modules ? { affectedModules: modules } : {}).map((t) => `${t.name}${t.version ? ` ${t.version}` : ""}`);

describe("technologyVersion", () => {
  it.each<[Parameters<typeof technologyVersion>[0], string, string | undefined]>([
    ["spring-boot", "2.3.4.RELEASE", "2.3.4"],
    ["spring-boot", "4.0.0-RC1", "4.0.0-RC1"],
    ["spring-framework", "5.0.0.M1", "5.0.0-M1"],
    ["gradle", "8.5-rc-1", "8.5.0-rc-1"],
    ["java", "1.8", "8"],
    ["java", "17", "17"],
    ["java", "17-ea", undefined],
    ["spring-boot", "1.2.3.4", undefined],
    ["spring-boot", "latest", undefined],
    ["spring-boot", "3.+", undefined],
    ["spring-boot", "^3.2", undefined],
    ["maven", "3.9.6", "3.9.6"],
  ])("%s %s", (name, raw, want) => {
    expect(technologyVersion(name, raw)).toBe(want);
  });
});

describe("projectTechnologies", () => {
  it("reads a Maven project", () => {
    const p = profile([
      manifest("pom.xml", "maven"),
      dep("pom.xml", BOOT, "4.0.1"),
      dep("pom.xml", "java", "17"),
      dep(".mvn/wrapper/maven-wrapper.properties", "maven", "3.9.6"),
    ]);
    expect(show(p)).toEqual(["java 17", "spring-boot 4.0.1", "spring-framework", "maven 3.9.6"]);
  });
  it("reads a Gradle project", () => {
    const p = profile([dep("build.gradle.kts", BOOT, "4.1.0"), dep("build.gradle.kts", "java", "21"), dep("gradle/wrapper/gradle-wrapper.properties", "gradle", "9.1")]);
    expect(show(p)).toEqual(["java 21", "spring-boot 4.1.0", "spring-framework", "gradle 9.1"]);
  });
  it("reads Spring versions from dependencies", () => {
    const p = profile([dep("pom.xml", `${BOOT}:spring-boot-starter-web`, "4.0.2"), dep("pom.xml", "org.springframework:spring-core", "7.0.3")]);
    expect(show(p)).toEqual(["spring-boot 4.0.2", "spring-framework 7.0.3"]);
  });
  it("gives a name without a version for values that are not plain", () => {
    for (const v of ["latest", "3.+", "^3.2"]) expect(show(profile([dep("pom.xml", BOOT, v)]))).toEqual(["spring-boot", "spring-framework"]);
    expect(show(profile([dep("pom.xml", BOOT, "2.3.4.RELEASE")]))).toEqual(["spring-boot 2.3.4", "spring-framework"]);
    expect(show(profile([dep("pom.xml", "java", "1.8")]))).toEqual(["java 8"]);
  });

  describe("modules", () => {
    const mixed = () => profile([dep("pom.xml", BOOT, "4.0.1"), dep("legacy/pom.xml", BOOT, "3.5.0")]);
    it("uses the build folders in or above the modules", () => {
      expect(show(mixed(), ["legacy"])).toEqual(["spring-boot 3.5.0", "spring-framework"]);
      expect(show(mixed(), ["app"])).toEqual(["spring-boot 4.0.1", "spring-framework"]);
    });
    it("shows conflicting evidence when no module is named", () => {
      expect(show(mixed())).toEqual(["spring-boot 3.5.0", "spring-boot 4.0.1", "spring-framework"]);
      expect(show(mixed(), ["legacy", "app"])).toEqual(["spring-boot 3.5.0", "spring-boot 4.0.1", "spring-framework"]);
    });
    it("lets a child build without a version inherit from the root", () => {
      const p = profile([dep("pom.xml", BOOT, "4.0.1"), dep("app/pom.xml", "java", "21")]);
      expect(show(p, ["app"])).toEqual(["java 21", "spring-boot 4.0.1", "spring-framework"]);
      expect(show(p)).toEqual(["java 21", "spring-boot 4.0.1", "spring-framework"]);
    });
    it("stops inheriting at a child whose version is declared but unreadable", () => {
      const p = profile([dep("pom.xml", BOOT, "4.0.1"), dep("app/pom.xml", BOOT, "unreadable")]);
      expect(show(p, ["app"])).toEqual(["spring-boot", "spring-framework"]);
      expect(show(p, ["other"])).toEqual(["spring-boot 4.0.1", "spring-framework"]);
      expect(show(p)).toEqual(["spring-boot 4.0.1", "spring-framework"]);
    });
    it("still inherits when the child declares no version at all", () => {
      const p = profile([dep("pom.xml", BOOT, "4.0.1"), dep("app/pom.xml", BOOT)]);
      expect(show(p, ["app"])).toEqual(["spring-boot 4.0.1", "spring-framework"]);
    });
    it("gives one entry for modules that agree", () => {
      const p = profile([dep("a/pom.xml", BOOT, "4.0.1"), dep("b/pom.xml", BOOT, "4.0.1")]);
      expect(show(p)).toEqual(["spring-boot 4.0.1", "spring-framework"]);
    });
    it("does not use a sibling folder, and web is not website", () => {
      const p = profile([dep("website/pom.xml", BOOT, "4.0.1"), dep("web/pom.xml", BOOT, "3.5.0")]);
      expect(show(p, ["web"])).toEqual(["spring-boot 3.5.0", "spring-framework"]);
      expect(show(p, ["other"])).toEqual([]);
    });
    it("accepts . and a trailing slash, and refuses a path outside the repository", () => {
      expect(show(mixed(), ["."])).toEqual(show(mixed()));
      expect(show(mixed(), ["legacy/"])).toEqual(show(mixed(), ["legacy"]));
      expect(() => projectTechnologies(mixed(), { affectedModules: ["../x"] })).toThrow("invalid module path");
    });
  });

  it("ignores findings at paths that are not build files", () => {
    expect(show(profile([dep("package.json", "java", "17"), dep("pom.xml.txt", "maven", "3.9.6"), dep("docs/maven-wrapper.properties", "maven", "3.9.6")]))).toEqual([]);
  });
  it("names maven, gradle and java from manifests and languages", () => {
    expect(show(profile([manifest("pom.xml", "maven"), lang("src/A.java", "java")]))).toEqual(["java", "maven"]);
    expect(show(profile([manifest("build.gradle", "gradle")]))).toEqual(["gradle"]);
    expect(show(profile([{ ...manifest("package-lock.json", "maven"), value: "lockfile" } as RepoFinding]))).toEqual([]);
  });
  it("gives nothing for a project without JVM findings", () => {
    expect(show(profile([manifest("package.json", "npm"), dep("package.json", "react", "18.0.0")]))).toEqual([]);
  });
  it("is the same for every order of the findings", () => {
    const a = [dep("pom.xml", BOOT, "4.0.1"), dep("pom.xml", BOOT, "4.0.2"), dep("legacy/pom.xml", "java", "21"), dep("pom.xml", "java", "17")];
    const want = show(profile(a));
    expect(show(profile([...a].reverse()))).toEqual(want);
    expect(show(profile([a[2]!, a[0]!, a[3]!, a[1]!]))).toEqual(want);
  });
  it("sorts partial and full versions by value", () => {
    const p = profile([dep("a/pom.xml", "java", "17"), dep("b/pom.xml", "java", "9"), dep("c/pom.xml", "java", "17.0.0"), dep("d/pom.xml", "java", "21")]);
    expect(show(p).filter((s) => s.startsWith("java"))).toEqual(["java 9", "java 17", "java 17.0.0", "java 21"]);
  });
});

describe("supportStatus", () => {
  const status = (name: string, version?: string) => supportStatus([{ name, ...(version !== undefined ? { version } : {}) }]);
  it("marks versions that fit no supported line as stale", () => {
    expect(status("spring-boot", "^3")).toBe("stale");
    expect(status("spring-boot", "~3.5.2")).toBe("stale");
    expect(status("maven", "~3.8.9")).toBe("stale");
    expect(status("gradle", "~8.5.0")).toBe("stale");
    expect(status("java", "11")).toBe("stale");
    expect(status("java", "8")).toBe("stale");
  });
  it("accepts versions that fit a supported line", () => {
    expect(status("spring-boot", "^4")).toBe("supported");
    expect(status("maven", "^3")).toBe("supported");
    expect(status("gradle", "^8")).toBe("supported");
    expect(status("gradle", "~9.1.0")).toBe("supported");
    expect(status("java", ">=17")).toBe("supported");
    expect(status("java")).toBe("supported");
  });
  it("cannot check a range it cannot read, and stale wins", () => {
    expect(status("java", "latest")).toBe("unchecked");
    expect(supportStatus([{ name: "java", version: "latest" }, { name: "maven", version: "~3.8.9" }])).toBe("stale");
    expect(supportStatus([{ name: "java", version: "latest" }, { name: "maven", version: "^3" }])).toBe("unchecked");
  });
  it("is generic without the five technologies", () => {
    expect(status("react", "^18")).toBe("generic");
    expect(supportStatus([])).toBe("generic");
  });
  it("reads aliases", () => {
    expect(status("jdk", "11")).toBe("stale");
    expect(status("springboot", ">=4")).toBe("supported");
    expect(technologyName("jdk")).toBe("java");
    expect(technologyName("react")).toBe("react");
    expect(technologyName("constructor")).toBe("constructor");
  });
});

describe("technology table", () => {
  it("lists readable lines, known alias targets and a review date", () => {
    for (const name of TECHNOLOGY_NAMES) {
      expect(SUPPORTED_LINES[name].length, name).toBeGreaterThan(0);
      for (const line of SUPPORTED_LINES[name]) {
        const p = parsePartial(line);
        expect([1, 2], `${name} ${line}`).toContain(p?.n);
        expect(p?.pre).toBeUndefined();
      }
    }
    for (const target of Object.values(TECHNOLOGY_ALIASES)) expect(TECHNOLOGY_NAMES).toContain(target);
    expect(Number.isNaN(Date.parse(TECHNOLOGY_SUPPORT_REVIEWED))).toBe(false);
    expect(TECHNOLOGY_SUPPORT_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("candidate stability", () => {
  it("does not change skill or integration candidates", () => {
    const pom = [
      "<project>",
      "<parent>",
      "<groupId>org.springframework.boot</groupId>",
      "<artifactId>spring-boot-starter-parent</artifactId>",
      "<version>4.0.1</version>",
      "</parent>",
      "<properties>",
      "<java.version>21</java.version>",
      "</properties>",
      "</project>",
    ].join("\n");
    const found = dependenciesIn("pom.xml", pom);
    expect(found.length).toBeGreaterThan(0);
    const mk = (withTech: boolean) =>
      profile([
        manifest("pom.xml", "maven"),
        lang("src/A.java", "java"),
        ...(withTech ? found.map((f) => ({ ...f, path: "pom.xml" }) as RepoFinding) : []),
      ]);
    expect(detectSkillCandidates(mk(true))).toEqual(detectSkillCandidates(mk(false)));
    expect(detectIntegrationCandidates(mk(true))).toEqual(detectIntegrationCandidates(mk(false)));
  });
});

describe("end to end", () => {
  const skill = (techs: { name: string; version?: string }[]): CollisionCandidate =>
    ({
      skill: {
        package: { id: "s", version: "1.0.0", capabilities: ["cap"], category: "general", risk: "low", tool_profile: { shell: false }, connectors: [] },
        provenance: { technologies: techs },
        identity: { id: "s", version: "1.0.0", fingerprint: "fp" },
      },
      approved: true,
      trust: "verified",
      licencesAllowed: [],
    }) as unknown as CollisionCandidate;
  const run = (techs: { name: string; version?: string }[], p: RepoProfile, modules?: string[]) => {
    const c = canonicalFromCollision(skill(techs), { licence: "allowed", evidence: projectTechnologies(p, modules ? { affectedModules: modules } : {}) });
    return { c, result: selectCanonicalSkills([c], { exclusive: ["cap"], highRisk: [] }) };
  };
  const rejected = (r: ReturnType<typeof run>["result"]) => r.resolutions.flatMap((x) => x.rejected.map((j) => j.code));

  it("rejects a Boot 4 skill on a Boot 3.5 project", () => {
    const { c, result } = run([{ name: "spring-boot", version: "^4" }], profile([dep("pom.xml", BOOT, "3.5.0")]));
    expect(c.compatibility).toBe("incompatible");
    expect(rejected(result)).toEqual(["incompatible"]);
  });
  it("rejects a Java 21 skill on a Java 17 project", () => {
    const { c, result } = run([{ name: "java", version: ">=21" }], profile([dep("pom.xml", "java", "17")]));
    expect(c.compatibility).toBe("incompatible");
    expect(rejected(result)).toEqual(["incompatible"]);
  });
  it("chooses a Boot 4 skill on a Boot 4 project", () => {
    const { c, result } = run([{ name: "spring-boot", version: "^4" }], profile([dep("pom.xml", BOOT, "4.0.1")]));
    expect(c.compatibility).toBe("version");
    expect(result.resolutions.map((r) => r.winner?.id)).toEqual(["s"]);
  });
  it("rejects a Boot 4 skill when one module of the repository is on Boot 3.5", () => {
    const p = profile([dep("pom.xml", BOOT, "4.0.1"), dep("legacy/pom.xml", BOOT, "3.5.0")]);
    expect(rejected(run([{ name: "spring-boot", version: "^4" }], p).result)).toEqual(["incompatible"]);
    expect(run([{ name: "spring-boot", version: "^4" }], p, ["app"]).c.compatibility).toBe("version");
  });
  it("rejects a stale skill without any evidence", () => {
    const c = canonicalFromCollision(skill([{ name: "spring-boot", version: "^2" }]), { licence: "allowed" });
    expect(rejected(selectCanonicalSkills([c], { exclusive: ["cap"], highRisk: [] }))).toEqual(["incompatible"]);
  });
});
