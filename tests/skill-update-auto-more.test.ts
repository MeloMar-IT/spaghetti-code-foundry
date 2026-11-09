import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { LsRemoteError } from "../src/skill-import/ls-remote.js";
import { readApprovals } from "../src/skills/approvals.js";
import { GATE_MESSAGES } from "../src/skills/auto-updates.js";
import { listStoredReleases } from "../src/skills/release-store.js";
import { W } from "./helpers/skill-update-world.js";
import { A, auditLines, B, commit, head, home, KEY, manifestOf, record, releaseNames, run, skillMd, upstream, useAutoWorld, versionsOf, write, world, yaml, type Up, type World } from "./helpers/skill-auto-world.js";

// The automatic update chain (#799), part 2: the evaluation suite, a fetch that fails, a refused approval, two updates at once.

useAutoWorld();

describe("the evaluation suite of the catalogue", () => {
  const noBuiltin = ConfigSchema.parse({ skills: { builtin: false } }).skills;
  const KAFKA_MD = readFileSync("skills/kafka/SKILL.md", "utf8");

  /** The suite of the repository and its fixtures in the catalogue folder; skill `a` is a Kafka skill, `b` is not (it fails the "offered" scenarios). */
  function withSuite(w: World, up: Up, extra = ""): void {
    cpSync("evals/skill-gate/fixtures", join(w.clone, "fixtures"), { recursive: true });
    writeFileSync(join(w.clone, "skill-evaluation.yaml"), readFileSync("evals/skill-gate/suite.yaml", "utf8") + extra);
    commit(up, (work) => {
      write(work, "skills/a/SKILL.md", KAFKA_MD.replace(/^name: kafka$/m, "name: a"));
      write(work, "skills/a/skill.yaml", "version: 1.0.0\ncategory: interface\ncapabilities: [kafka]\nroles: [coder, reviewer]\nrisk: high\n");
    });
  }
  const INSTRUCTIONS = `instructions:\n  repeat: 3\n  scenarios:\n    - { id: mark, repo: fixtures/ins, task: "Do the thing", check: "true", policy: { shell: true, network: false, filesystem: write }, timeout_sec: 60 }\n`;

  it("scores the skills offline, releases the one that passes and leaves out the one that fails", async () => {
    const w = world(yaml());
    const up = upstream();
    withSuite(w, up);
    const r = await run(w, up, { skills: noBuiltin });
    expect(r.text).toContain(`ver: BLOCKED ${B()} evaluation: ${GATE_MESSAGES.evaluation}`);
    expect(r.rc).toBe(0);
    expect(r.text).toContain("ver: RELEASED ver@1.0.1 ");
    const released = manifestOf("ver", "1.0.1").skills;
    expect(released.map((s) => [s.id, s.evaluation.verdict])).toEqual([[A(), "passed"]]);
    expect(released[0]!.evaluation.record).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(released[0]!.evaluation.record).not.toBe(`sha256:${"0".repeat(64)}`);
    expect(record().ver).toMatchObject({ result: "released", failed: [{ skill: B(), gate: "evaluation", message: GATE_MESSAGES.evaluation }] });
    expect(readdirSync(join(home, "skill-evaluations", "ver"))).toHaveLength(1);
  });

  it("opens one issue for the skill that failed, and none while it is open", async () => {
    const w = world(yaml(), { FAKE_GH_CLI_ISSUES: "1" });
    const up = upstream();
    withSuite(w, up);
    const r = await run(w, up, { skills: noBuiltin });
    expect(r.rc).toBe(0);
    expect(r.text).toContain("ver: RELEASED ver@1.0.1 ");
    const file = `${w.log}.cli-issues.json`;
    const issues = JSON.parse(readFileSync(file, "utf8")) as { repo: string; title: string; labels: { name: string }[]; state: string }[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ repo: "example/verified", title: `Skill ${B()} failed the evaluation gate`, state: "OPEN", labels: [{ name: "Factory_go" }] });
    expect(auditLines().some((l) => l.action === "skill-auto-update" && l.result === "ok" && l.detail?.startsWith("issue: "))).toBe(true);

    // a new commit that changes no skill: B fails again, and the open issue is enough
    commit(up, (work) => write(work, "README.md", "changed\n"));
    const again = await run(w, up, { skills: noBuiltin });
    expect(again.text).toContain("is open already");
    const titles = (JSON.parse(readFileSync(file, "utf8")) as { title: string }[]).map((i) => i.title);
    expect(titles.filter((t) => t === `Skill ${B()} failed the evaluation gate`)).toHaveLength(1);
  });

  it("is a PROBLEM when the suite file is not valid", async () => {
    const w = world(yaml());
    writeFileSync(join(w.clone, "skill-evaluation.yaml"), "schema: 7\n");
    const up = upstream();
    const r = await run(w, up);
    expect(r.rc).toBe(1);
    expect(r.text).toContain("ver: PROBLEM the evaluation suite of the catalogue is not valid; nothing was released");
    expect(releaseNames()).toEqual([]);
  });

  it("runs the agent scenarios through the agent scoring with the abort signal, and a runner error releases nothing", async () => {
    const w = world(yaml());
    const up = upstream();
    withSuite(w, up, INSTRUCTIONS);
    mkdirSync(join(w.clone, "fixtures", "ins"), { recursive: true });
    writeFileSync(join(w.clone, "fixtures", "ins", "README.md"), "# fixture\n");
    const seen: { id: string; aborted: boolean | undefined }[] = [];
    // a runner error prints a line that names no skill, then the interrupt line (as scoreImportWithAgent does)
    const agentScore = async (id: string, _suite: string | undefined, out: (l: string) => void, o: { signal?: AbortSignal }) => {
      seen.push({ id, aborted: o.signal?.aborted });
      out("PROBLEM the agent runner failed");
      out("PROBLEM the evaluation was interrupted");
      return 1;
    };
    const r = await run(w, up, { agentScore, skills: noBuiltin });
    expect(seen).toEqual([{ id: "ver", aborted: false }]);
    expect(r.rc).toBe(1);
    expect(r.text).toContain("ver: PROBLEM the evaluation could not run; nothing was released");
    expect(releaseNames()).toEqual([]);
    expect(existsSync(join(home, "skill-auto-updates.json"))).toBe(false);
    expect(r.text).not.toContain("the agent runner failed");
  });
});

describe("a fetch that fails", () => {
  it("is a PROBLEM that writes nothing", async () => {
    const w = world(yaml());
    const up = upstream();
    const r = await run(w, up, {
      resolve: async () => {
        throw new LsRemoteError("unreachable");
      },
    });
    expect(r.rc).toBe(1);
    expect(r.lines).toContain(`ver: PROBLEM the upstream repository ${KEY} could not be reached; nothing was released`);
    for (const f of ["skill-releases", "skill-approvals.json", "skill-auto-updates.json", "skill-quarantine"]) expect(existsSync(join(home, f))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "skill-update-checks.json"), "utf8")).sources.ver.outcome).toBe("PROBLEM");
  });

  it("is a PROBLEM when the commit cannot be fetched", async () => {
    const w = world(yaml());
    const up = upstream();
    const r = await run(w, up, { remote: join(W.root, "no-such-remote") });
    expect(r.rc).toBe(1);
    expect(r.text).toContain("ver: PROBLEM the commit ");
    for (const f of ["skill-releases", "skill-approvals.json", "skill-auto-updates.json"]) expect(existsSync(join(home, f))).toBe(false);
    expect(auditLines().some((l) => l.action === "skill-auto-update" && l.result === "failed")).toBe(true);
  });
});

describe("the approval", () => {
  it("when it is refused the release stays unapproved, the record says failed, and the next run uses the next number", async () => {
    const w = world(yaml());
    const up = upstream();
    const keyed = ConfigSchema.parse({ skills: { releases: { keys: [{ id: "k1", ed25519: "A".repeat(43) + "=" }] } } }).skills;
    const r = await run(w, up, { skills: keyed });
    expect(r.rc).toBe(1);
    expect(r.text).toContain("ver: PROBLEM ver@1.0.1 was published but not approved: skills.releases.keys is set but skills.releases.auto_key is not");
    expect(listStoredReleases(home).releases.map((x) => `${x.catalogue}@${x.version}`)).toEqual(["ver@1.0.1"]);
    expect(readApprovals({ home })).toEqual({ state: "none" });
    expect(record().ver).toMatchObject({ result: "failed", release: { version: "1.0.1" } });
    const again = await run(w, up);
    expect(again.rc).toBe(0);
    expect(again.text).toContain("ver: RELEASED ver@1.0.2 ");
  });

  it("is refused when the approved release in the store is not the one that was approved", async () => {
    const w = world(yaml());
    const up = upstream();
    await run(w, up);
    const file = join(home, "skill-approvals.json");
    const approvals = JSON.parse(readFileSync(file, "utf8"));
    approvals.sources.ver.releases[0].digest = `sha256:${"2".repeat(64)}`;
    writeFileSync(file, JSON.stringify(approvals));
    commit(up, (work) => write(work, "skills/a/SKILL.md", skillMd("a", "changed")));
    const r = await run(w, up);
    expect(r.rc).toBe(1);
    expect(r.text).toContain("is not the one that was approved; versions cannot be decided; nothing was released");
    expect(releaseNames()).toEqual(["1.0.1"]);
  });
});

describe("a failed approval does not block the next update", () => {
  it("skips the version held by the unapproved release and releases the next free one", async () => {
    const w = world(yaml());
    const up = upstream();
    // 1. a@1.0.0 is approved in catalogue 1.0.1
    await run(w, up);
    // 2. a text change; the approval is refused (keys without auto_key): a@1.0.1 stays in the store, unapproved
    commit(up, (work) => write(work, "skills/a/SKILL.md", skillMd("a", "second text")));
    const keyed = ConfigSchema.parse({ skills: { releases: { keys: [{ id: "k1", ed25519: "A".repeat(43) + "=" }] } } }).skills;
    const failed = await run(w, up, { skills: keyed });
    expect(failed.rc).toBe(1);
    expect(failed.text).toContain("ver@1.0.2 was published but not approved");
    expect(versionsOf("1.0.2")).toEqual({ [A()]: "1.0.1", [B()]: "1.0.0" });
    // 3. another text change from the approved base: a would be 1.0.1 again, which the store holds with other bytes
    commit(up, (work) => write(work, "skills/a/SKILL.md", skillMd("a", "third text")));
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(r.text).toContain("ver: RELEASED ver@1.0.3 ");
    // the earlier releases are untouched; a takes the next free patch number
    expect(versionsOf("1.0.3")).toEqual({ [A()]: "1.0.2", [B()]: "1.0.0" });
    expect(versionsOf("1.0.2")).toEqual({ [A()]: "1.0.1", [B()]: "1.0.0" });
    expect(record().ver).toMatchObject({ result: "released", failed: [] });
  });
});

describe("one skill that the agent could not score", () => {
  it("costs only that skill: the other skill is still released", async () => {
    const w = world(yaml());
    const up = upstream();
    cpSync("evals/skill-gate/fixtures", join(w.clone, "fixtures"), { recursive: true });
    mkdirSync(join(w.clone, "fixtures", "ins"), { recursive: true });
    writeFileSync(join(w.clone, "fixtures", "ins", "README.md"), "# fixture\n");
    const KAFKA_MD = readFileSync("skills/kafka/SKILL.md", "utf8");
    writeFileSync(
      join(w.clone, "skill-evaluation.yaml"),
      readFileSync("evals/skill-gate/suite.yaml", "utf8") +
        `instructions:\n  repeat: 3\n  scenarios:\n    - { id: mark, repo: fixtures/ins, task: "Do the thing", check: "true", policy: { shell: true, network: false, filesystem: write }, timeout_sec: 60 }\n`,
    );
    commit(up, (work) => {
      write(work, "skills/a/SKILL.md", KAFKA_MD.replace(/^name: kafka$/m, "name: a"));
      write(work, "skills/a/skill.yaml", "version: 1.0.0\ncategory: interface\ncapabilities: [kafka]\nroles: [coder, reviewer]\nrisk: high\n");
    });
    const noBuiltin = ConfigSchema.parse({ skills: { builtin: false } }).skills;
    // The scorer scores a offline and reports b as timed out: b gets no record for this run.
    const agentScore = async (_id: string, _suite: string | undefined, out: (l: string) => void, o: { home?: string; cwd: string; today: string; now: Date; discover: object; skills?: unknown; sources?: unknown; signal?: AbortSignal }) => {
      const { scoreImport } = await import("../src/skills/evaluate-cli.js");
      scoreImport("ver", undefined, () => {}, o as Parameters<typeof scoreImport>[3]);
      out(`PROBLEM ${B()}: the agent run timed out; no instructions`);
      return 1;
    };
    const r = await run(w, up, { agentScore, skills: noBuiltin });
    expect(r.rc).toBe(0);
    expect(r.text).not.toContain("the evaluation could not run");
    expect(r.text).toContain("ver: RELEASED ver@1.0.1 ");
    expect(manifestOf("ver", "1.0.1").skills.map((s) => s.id)).toEqual([A()]);
    expect(record().ver).toMatchObject({ result: "released", failed: [{ skill: B(), gate: "evaluation" }] });
  });
});

describe("two updates of one source", () => {
  it("the second is refused by the lock, and the stored commit never goes back", async () => {
    const w = world(yaml());
    const up = upstream();
    const c1 = head(up);
    const [a, b] = await Promise.all([run(w, up), run(w, up, { resolve: async () => ({ commit: c1 }) })]);
    expect([a.rc, b.rc].sort()).toEqual([0, 1]);
    const refused = a.rc === 1 ? a : b;
    expect(refused.text).toContain("another automatic update of ver is running; nothing was released");
    const approvals = readApprovals({ home });
    expect(approvals.state === "ok" && approvals.sources.ver!.ref!.approved).toBe(c1);
    expect(releaseNames()).toEqual(["1.0.1"]);
  });
});
