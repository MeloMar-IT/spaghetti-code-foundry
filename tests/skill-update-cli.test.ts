import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPDATE_USAGE } from "../src/skill-import/update-cli.js";
import { LsRemoteError, type LsRemoteErrorCode } from "../src/skill-import/ls-remote.js";
import { branches, branchOf, catalogueYaml, ghCalls, git, GOOD_REVIEW, SENTINEL, sigCounts, snapshot, update, useWorlds, W, world } from "./helpers/skill-update-world.js";

// `scf skills update` against local git and the fake gh (see tests/helpers/skill-update-world.ts). The failure and interrupt
// cases are in skill-update-failures.test.ts.

useWorlds();

describe("a community entry, end to end", () => {
  it("opens one pull request that changes only skill-sources.yaml, and writes nothing else", async () => {
    const { c1, c2 } = W;
    const w = world();
    const before = snapshot(w);
    const signals = sigCounts();
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r.text).toContain("OK 2 skills staged");
    expect(r.lines.at(-2)).toMatch(/^REVIEWED 2 skills from github\.com\/example\/skills@[0-9a-f]{12} sha256:/);
    expect(r.lines.at(-1)).toBe(`OK opened https://github.com/owner/repo/pull/99 for lib@${c2.slice(0, 12)}; nothing is approved until it is merged`);
    expect(r.rc).toBe(0);
    expect(sigCounts()).toEqual(signals);

    const branch = branchOf("lib", c2);
    expect(branches(w)).toEqual([`refs/heads/${branch}`]);
    expect(git(w.bare, "diff", "--name-only", "main", branch).split("\n")).toEqual(["skill-sources.yaml"]);
    const expected = w.yaml
      .replace(`approved: '${c1}'}`, `approved: '${c2}'}`)
      .replace(`review: {by: '@octocat', on: '2026-01-01', commit: ${c1}, licence: MIT}`, `review: {by: '@rev', on: '2026-10-15', commit: ${c2}, licence: MIT}`);
    expect(expected).not.toBe(w.yaml);
    expect(git(w.bare, "show", `${branch}:skill-sources.yaml`)).toBe(expected.trim());
    expect(git(w.bare, "rev-parse", "main")).toBe(git(w.bare, "rev-parse", `${branch}~1`));

    // nothing in the working copy changed, and no local branch was made
    expect(snapshot(w)).toEqual(before);
    expect(git(w.clone, "branch", "--list", "skill-update/*")).toBe("");

    // every gh call names the catalogue repository, whatever GH_REPO and the other remotes say
    const calls = ghCalls(w);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toContain("--repo acme/catalogue");
    expect(calls[0]).toContain("pr list");
    expect(calls[1]).toContain("pr create");
    expect(calls[1]).toContain(`--head ${branch}`);
    expect(calls[1]).toContain("--base main");
    expect(calls[1]).toContain("--body-file -");

    // the body: old and new commit, paths, review claim, report; no upstream skill text
    const body = readFileSync(w.log, "utf8").split("--- pr body:\n")[1]!;
    for (const t of [c1, c2, "`skills`", "Merging records that `@rev` reviewed the maintainer and licence `MIT`", "## Skill import review", "nothing was promoted"]) expect(body).toContain(t);
    expect(body).not.toContain(SENTINEL);
    expect(Buffer.byteLength(body)).toBeLessThan(64_100);

    // staged in quarantine; nothing promoted or pinned
    expect(existsSync(join(w.home, "skill-quarantine", "lib", c2, "import.json"))).toBe(true);
    for (const f of ["skills.lock", "skill-lock.json", "skill-releases", "skill-catalogue"]) expect(existsSync(join(w.home, f))).toBe(false);

    // a second run for the same commit prints OPEN and opens nothing
    const again = await update(w, ["lib"]); // an open pull request needs no --reviewer
    expect(again.rc).toBe(0);
    expect(again.lines).toEqual([`OPEN https://github.com/owner/repo/pull/99 for lib@${c2.slice(0, 12)}; no second pull request was opened`]);
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toHaveLength(1);
    expect(branches(w)).toHaveLength(1);
  });

  it("prints UNCHANGED, with no gh call, when the upstream is at ref.approved", async () => {
    const w = world(catalogueYaml({ lib: W.c2 }));
    const r = await update(w, ["lib"]); // no --reviewer: nothing is proposed, so no review is needed
    expect(r.rc).toBe(0);
    expect(r.lines).toEqual([`UNCHANGED lib is at ${W.c2.slice(0, 12)} (ref.approved); nothing to propose`]);
    expect(ghCalls(w)).toEqual([]);
    expect(branches(w)).toEqual([]);
    expect(existsSync(w.home)).toBe(false);
  });
});

describe("other entries and first imports", () => {
  it("works from a folder below the top of the clone", async () => {
    const { c1, c2 } = W;
    const w = world(undefined, {}, "config");
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r.rc).toBe(0);
    const branch = branchOf("lib", c2);
    expect(git(w.bare, "diff", "--name-only", "main", branch)).toBe("config/skill-sources.yaml");
    expect(git(w.bare, "show", `${branch}:config/skill-sources.yaml`)).toContain(`approved: '${c2}'`);
    expect(git(w.bare, "show", `${branch}:config/skill-sources.yaml`)).not.toContain(c1 + "'}");
  });

  it("changes only ref.approved of a verified entry and keeps its comment", async () => {
    const { c1, c2 } = W;
    const w = world();
    const r = await update(w, ["ver"]);
    expect(r.rc).toBe(0);
    const branch = branchOf("ver", c2);
    const expected = w.yaml.replace(`      approved: ${c1}\n    paths: [skills]\n    adapter: agent-skills\n    trust: verified`, `      approved: ${c2}\n    paths: [skills]\n    adapter: agent-skills\n    trust: verified`);
    expect(git(w.bare, "show", `${branch}:skill-sources.yaml`)).toBe(expected.trim());
    expect(git(w.bare, "show", `${branch}:skill-sources.yaml`)).toContain("track: main # follow main");
  });

  it("adds one entry for a connector with no entry yet", async () => {
    const { c2 } = W;
    const w = world();
    const r = await update(w, ["awesome-copilot"], { owner: "@o", reviewer: "@o" });
    expect(r.rc).toBe(0);
    const branch = branchOf("awesome-copilot", c2);
    const after = git(w.bare, "show", `${branch}:skill-sources.yaml`);
    expect(after.startsWith(w.yaml.trimEnd())).toBe(true);
    expect(after).toContain("id: awesome-copilot");
    expect(after).toContain(c2);
    expect(git(w.bare, "diff", "--name-only", "main", branch)).toBe("skill-sources.yaml");
    const log = readFileSync(w.log, "utf8");
    expect(log).toContain("none (first import)");
    expect(log).toContain(`Skill source awesome-copilot: first import at ${c2.slice(0, 12)}`);
  });

  it("refuses a connector whose repository another entry already uses", async () => {
    const { c1 } = W;
    const mine = ["  - id: mine", "    repository: https://github.com/github/awesome-copilot", "    status: enabled", `    ref: {track: main, approved: '${c1}'}`, "    paths: [skills]", "    adapter: agent-skills", "    trust: community", "    licence: {allow: [MIT]}", "    update: {cadence: manual}", "    owner: '@octocat'", `    review: {by: '@octocat', on: '2026-01-01', commit: ${c1}, licence: MIT}`];
    const w = world(catalogueYaml({ extra: mine }));
    const r = await update(w, ["awesome-copilot"], { owner: "@o", reviewer: "@o" });
    expect(r.rc).toBe(1);
    expect(r.text).toBe("PROBLEM the repository of the connector awesome-copilot is already used by the source mine; update that source");
    expect(ghCalls(w)).toEqual([]);
  });
});

describe("refusals before anything is read from the network", () => {
  for (const [id, status] of [["gone", "disabled"], ["held", "quarantined"], ["old", "retired"]] as const) {
    it(`refuses a ${status} source`, async () => {
      const w = world();
      const r = await update(w, [id]);
      expect(r).toMatchObject({ rc: 1, text: `PROBLEM the source ${id} is ${status}; only an enabled source can be updated` });
      expect(ghCalls(w)).toEqual([]);
    });
  }
  it("checks the options", async () => {
    const w = world();
    expect((await update(w, ["lib"], { owner: "@o", reviewer: "@r" })).text).toMatch(/^PROBLEM --owner is only for a connector that has no entry yet/);
    expect((await update(w, ["awesome-copilot"], { reviewer: "@r" })).text).toMatch(/^PROBLEM the connector awesome-copilot has no entry yet; give --owner/);
    expect((await update(w, ["awesome-copilot"], { owner: "@o" })).text).toMatch(/^PROBLEM an enabled community source needs a review; give --reviewer/);
    expect((await update(w, ["lib"])).text).toMatch(/^PROBLEM an enabled community source needs a review; give --reviewer/);
    expect((await update(w, ["ver"], { reviewer: "@r" })).text).toBe("PROBLEM --reviewer applies only to an enabled community source");
    expect((await update(w, ["ver"], { licence: "MIT" })).text).toBe("PROBLEM --licence applies only to an enabled community source");
    expect((await update(w, ["lib"], { reviewer: "@r", licence: "ISC" })).text).toMatch(/^PROBLEM --licence ISC is not in licence.allow/);
    expect((await update(w, ["nope"])).text).toBe("PROBLEM no source and no connector with the id nope");
    expect(ghCalls(w).filter((c) => !c.includes("pr list"))).toEqual([]);
  });
  it("rejects bad syntax before it reads anything", async () => {
    const w = world();
    for (const [pos, values] of [[[], {}], [["a", "b"], {}], [["Bad_Id"], {}], [["lib"], { json: true }], [["lib"], { owner: "x" }], [["lib"], { reviewer: "x" }]] as const) {
      await expect(update(w, [...pos], { ...values })).rejects.toThrow(UPDATE_USAGE);
    }
    expect(ghCalls(w)).toEqual([]);
  });
  it("needs a clone whose origin is a GitHub address and whose file is the one on origin", async () => {
    const w = world();
    git(w.clone, "config", "remote.origin.url", join(w.dir, "somewhere.git"));
    expect((await update(w, ["lib"], GOOD_REVIEW)).text).toBe("PROBLEM the address of origin is not a GitHub repository address; the pull request needs it");
    const w2 = world();
    writeFileSync(join(w2.clone, "skill-sources.yaml"), w2.yaml + "# local note\n");
    const r = await update(w2, ["lib"], GOOD_REVIEW);
    expect(r.rc).toBe(1);
    expect(r.text).toContain("PROBLEM skill-sources.yaml in this folder differs from skill-sources.yaml on origin/main");
    expect(ghCalls(w2).filter((c) => c.includes("pr create"))).toEqual([]);
    expect(branches(w2)).toEqual([]);
    const w3 = world();
    git(w3.dir, "init", "--quiet", "-b", "main", join(w3.dir, "plain"));
    expect((await update({ ...w3, clone: join(w3.dir, "plain") }, ["lib"], GOOD_REVIEW)).text).toBe("PROBLEM this clone has no remote named origin");
  });
});

describe("the upstream", () => {
  const cases: [LsRemoteErrorCode, RegExp][] = [
    ["unreachable", /^PROBLEM the upstream repository github\.com\/example\/skills could not be reached; nothing was proposed$/],
    ["timeout", /^PROBLEM git did not answer in 20 seconds; nothing was proposed$/],
    ["bad-answer", /^PROBLEM the answer of the upstream repository could not be read; nothing was proposed$/],
    ["no-git", /^PROBLEM git was not found; install git and try again$/],
  ];
  for (const [code, sentence] of cases) {
    it(`gives a fixed sentence for ${code}`, async () => {
      const w = world();
      const r = await update(w, ["lib"], GOOD_REVIEW, { resolve: async () => { throw new LsRemoteError(code); } });
      expect(r.rc).toBe(1);
      expect(r.text).toMatch(sentence);
      expect(ghCalls(w)).toEqual([]);
      expect(existsSync(w.home)).toBe(false);
    });
  }
  it("reports a missing and an ambiguous ref", async () => {
    const w = world();
    expect((await update(w, ["lib"], GOOD_REVIEW, { resolve: async () => ({ missing: "no-ref" }) })).text).toBe("PROBLEM the upstream repository has no branch or tag named main; nothing was proposed");
    expect((await update(w, ["lib"], GOOD_REVIEW, { resolve: async () => ({ missing: "ambiguous" }) })).text).toContain("has both a branch and a tag named main");
  });
  it("reads a real upstream that cannot be reached", async () => {
    const w = world();
    const r = await update(w, ["lib"], GOOD_REVIEW, { remote: join(w.dir, "missing.git") });
    expect(r).toMatchObject({ rc: 1, text: "PROBLEM the upstream repository github.com/example/skills could not be reached; nothing was proposed" });
  });
});
