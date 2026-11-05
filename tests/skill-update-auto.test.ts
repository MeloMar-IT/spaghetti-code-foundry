import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readApprovals } from "../src/skills/approvals.js";
import { GATE_MESSAGES } from "../src/skills/auto-updates.js";
import { branches, forbiddenCalls, ghCalls, SENTINEL } from "./helpers/skill-update-world.js";
import { A, auditLines, B, commit, everything, head, home, KEY, manifestOf, record, releaseNames, run, skillMd, upstream, useAutoWorld, versionsOf, write, world, yaml } from "./helpers/skill-auto-world.js";

// The automatic update chain of an `update.auto` first-party source (#799) against a local upstream and the fake gh: a release,
// nothing changed, the versions, a skill that fails a gate. The suite, a failed fetch and the approval are in skill-update-auto-more.test.ts.

useAutoWorld();

describe("a due run of an auto source", () => {
  it("releases, approves and records the commit, and opens no pull request", async () => {
    const w = world(yaml());
    const up = upstream();
    const c = head(up);
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    const line = r.lines.find((l) => l.startsWith("ver: RELEASED"));
    expect(line).toMatch(new RegExp(`^ver: RELEASED ver@1\\.0\\.1 sha256:[0-9a-f]{64} 2 skills from ver@${c.slice(0, 12)}; approved automatically$`));
    expect(r.lines.at(-1)).toBe("CHECKED 1 sources: 0 UNCHANGED, 0 OPEN, 0 UPDATED, 1 OK, 0 PROBLEM; 1 manual");
    expect(versionsOf("1.0.1")).toEqual({ [A()]: "1.0.0", [B()]: "1.0.0" });
    expect(manifestOf("ver", "1.0.1").skills.every((s) => s.evaluation.verdict === "not-run")).toBe(true);

    const approvals = readApprovals({ home });
    expect(approvals.state === "ok" && approvals.sources.ver).toMatchObject({ repositoryKey: KEY, ref: { approved: c }, releases: [{ catalogue: "ver", version: "1.0.1" }] });
    expect(record().ver).toMatchObject({ commit: c, result: "released", release: { catalogue: "ver", version: "1.0.1" }, failed: [] });

    const lines = auditLines();
    const names = lines.filter((l) => l.action === "skill-auto-update").map((l) => l.detail!.split(":")[0]);
    expect(names).toEqual(["fetch", "import", "evaluation", "gates", "publish", "ref"]);
    expect(lines.filter((l) => l.action === "skill-auto-approve")).toHaveLength(1);
    expect(lines.every((l) => l.result === "ok")).toBe(true);
    expect(ghCalls(w).filter((c2) => c2.includes("pr create"))).toEqual([]);
    expect(branches(w)).toEqual([]);
    expect(forbiddenCalls(w)).toEqual([]);
    expect(everything(r.text)).not.toContain(SENTINEL);
  });

  it("leaves a community source to the pull request", async () => {
    const w = world(yaml({ lib: "weekly", libReviewer: "@rev" }));
    const up = upstream();
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(r.lines.some((l) => l.startsWith("ver: RELEASED"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("lib: OK opened "))).toBe(true);
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toHaveLength(1);
  });

  it("says UNCHANGED when run again at the same commit, and writes nothing new", async () => {
    const w = world(yaml());
    const up = upstream();
    await run(w, up);
    const before = readFileSync(join(home, "skill-approvals.json"), "utf8");
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(r.text).toContain(`ver: UNCHANGED ver is at ${head(up).slice(0, 12)} (approved in the data folder); nothing to release`);
    expect(releaseNames()).toEqual(["1.0.1"]);
    expect(readFileSync(join(home, "skill-approvals.json"), "utf8")).toBe(before);
    expect(record().ver).toMatchObject({ result: "unchanged", release: { version: "1.0.1" } });
  });

  it("says UNCHANGED for a commit that changes no skill", async () => {
    const w = world(yaml());
    const up = upstream();
    await run(w, up);
    commit(up, (work) => write(work, "docs/readme.md", "not a skill\n"));
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(r.text).toContain("ver: UNCHANGED ver@");
    expect(r.text).toContain("no skill changed since ver@1.0.1; nothing to release");
    expect(releaseNames()).toEqual(["1.0.1"]);
    expect(record().ver!.result).toBe("unchanged");
  });
});

describe("the versions", () => {
  it("a text change is a patch bump, a skill that did not change keeps its version, the catalogue counts up", async () => {
    const w = world(yaml());
    const up = upstream();
    await run(w, up);
    commit(up, (work) => write(work, "skills/a/SKILL.md", skillMd("a", "new body text")));
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(r.text).toContain("ver: RELEASED ver@1.0.2 ");
    expect(versionsOf("1.0.2")).toEqual({ [A()]: "1.0.1", [B()]: "1.0.0" });
  });

  it("an added file is a minor bump", async () => {
    const w = world(yaml());
    const up = upstream();
    await run(w, up);
    commit(up, (work) => write(work, "skills/a/references/notes.md", "more notes\n"));
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(versionsOf("1.0.2")).toEqual({ [A()]: "1.1.0", [B()]: "1.0.0" });
  });

  it("a version that upstream declares and that is higher is used as it is", async () => {
    const w = world(yaml());
    const up = upstream();
    await run(w, up);
    commit(up, (work) => write(work, "skills/b/SKILL.md", skillMd("b", "b with a declared version", "version: 2.5.0\n")));
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(versionsOf("1.0.2")).toEqual({ [A()]: "1.0.0", [B()]: "2.5.0" });
  });
});

describe("a skill that fails a gate", () => {
  it("is left out, recorded with the gate and the fixed message, and the others go on", async () => {
    const w = world(yaml());
    const up = upstream();
    await run(w, up);
    commit(up, (work) => write(work, "skills/b/SKILL.md", skillMd("b", `${SENTINEL} broken`, "version: banana\n")));
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(r.text).toContain(`ver: BLOCKED ${B()} normalize: ${GATE_MESSAGES.normalize}`);
    expect(versionsOf("1.0.2")).toEqual({ [A()]: "1.0.0" });
    expect(record().ver).toMatchObject({ result: "released", failed: [{ skill: B(), gate: "normalize", message: GATE_MESSAGES.normalize }] });
    expect(everything(r.text)).not.toContain(SENTINEL);
    expect(everything(r.text)).not.toContain("banana");
  });

  it("is released again from its last version when it is fixed", async () => {
    const w = world(yaml());
    const up = upstream();
    await run(w, up);
    commit(up, (work) => write(work, "skills/b/SKILL.md", skillMd("b", "x", "version: banana\n")));
    await run(w, up);
    commit(up, (work) => write(work, "skills/b/SKILL.md", skillMd("b", "fixed body")));
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(versionsOf("1.0.3")).toEqual({ [A()]: "1.0.0", [B()]: "1.0.1" });
  });

  it("an import that refuses every skill is a PROBLEM and releases nothing", async () => {
    const w = world(yaml());
    const up = upstream();
    commit(up, (work) => {
      rmSync(join(work, "skills"), { recursive: true });
      write(work, `skills/${SENTINEL}/SKILL.md`, "no frontmatter at all\n");
    });
    const r = await run(w, up);
    expect(r.rc).toBe(1);
    expect(r.text).toContain("ver: PROBLEM no skill of ver@");
    expect(releaseNames()).toEqual([]);
    expect(record().ver!.result).toBe("blocked");
    expect(everything(r.text)).not.toContain(SENTINEL);
  });

  it("when every skill fails a gate nothing is released", async () => {
    const w = world(yaml());
    const up = upstream();
    commit(up, (work) => {
      write(work, "skills/a/SKILL.md", skillMd("a", "x", "version: banana\n"));
      write(work, "skills/b/SKILL.md", skillMd("b", "x", "version: banana\n"));
    });
    const r = await run(w, up);
    expect(r.rc).toBe(1);
    expect(r.text).toContain("PROBLEM no skill of ver@");
    expect(releaseNames()).toEqual([]);
    expect(record().ver).toMatchObject({ result: "blocked" });
    expect(record().ver!.failed.map((f) => f.skill).sort()).toEqual([A(), B()].sort());
  });

  it("skips a version that another catalogue holds with other bytes, and takes the next free patch number", async () => {
    const w = world(yaml());
    const up = upstream();
    await run(w, up);
    // the same skill and version with other bytes, published by hand into another catalogue
    const dir = join(home, "skill-releases");
    cpSync(join(dir, "ver", "1.0.1"), join(dir, "manual", "1.0.1"), { recursive: true });
    const file = join(dir, "manual", "1.0.1", "catalogue-release.json");
    const edited = JSON.parse(readFileSync(file, "utf8"));
    edited.catalogue = "manual";
    edited.skills = edited.skills.map((s: { id: string; digest: string }) => (s.id === A() ? { ...s, version: "1.0.1", digest: `sha256:${"1".repeat(64)}` } : s));
    writeFileSync(file, JSON.stringify(edited));
    // the patch bump of a is 1.0.1, which "manual" holds with another digest (the folder does not verify, but its manifest is read)
    commit(up, (work) => write(work, "skills/a/SKILL.md", skillMd("a", "changed")));
    const r = await run(w, up);
    expect(r.rc).toBe(0);
    expect(record().ver).toMatchObject({ result: "released", failed: [] });
    expect(versionsOf("1.0.2")).toEqual({ [A()]: "1.0.2", [B()]: "1.0.0" });
  });
});
