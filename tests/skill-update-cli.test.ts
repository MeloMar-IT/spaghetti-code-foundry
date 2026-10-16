import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPDATE_USAGE } from "../src/skill-import/update-cli.js";
import { GitTreeError, openGitTree } from "../src/skill-import/git-tree.js";
import { LsRemoteError, type LsRemoteErrorCode } from "../src/skill-import/ls-remote.js";
import { bodies, branches, branchOf, catalogueYaml, forbiddenCalls, ghCalls, git, GOOD_REVIEW, SENTINEL, setBody, setOpenPullRequests, sigCounts, snapshot, update, useWorlds, W, world } from "./helpers/skill-update-world.js";

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
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c).toContain("--repo acme/catalogue");
    expect(calls[0]).toContain("pr list");
    expect(calls[0]).toContain(`--head ${branch}`);
    expect(calls[1]).toContain("pr list");
    expect(calls[2]).toContain("pr create");
    expect(calls[2]).toContain(`--head ${branch}`);
    expect(calls[2]).toContain("--base main");
    expect(calls[2]).toContain("--body-file -");

    // the body: old and new commit, paths, review claim, report; no upstream skill text
    const body = readFileSync(w.log, "utf8").split("--- pr body:\n")[1]!;
    for (const t of [c1, c2, "`skills`", "Merging records that `@rev` reviewed the maintainer and licence `MIT`", "## Skill import review", "nothing was promoted"]) expect(body).toContain(t);
    expect(body).not.toContain(SENTINEL);
    expect(Buffer.byteLength(body)).toBeLessThan(64_100);

    // staged in quarantine; nothing promoted or pinned
    expect(existsSync(join(w.home, "skill-quarantine", "lib", c2, "import.json"))).toBe(true);
    for (const f of ["skills.lock", "skill-lock.json", "skill-releases", "skill-catalogue"]) expect(existsSync(join(w.home, f))).toBe(false);

    // a second run for the same commit prints OPEN and opens nothing
    const head = git(w.bare, "rev-parse", branch);
    const callsBefore = ghCalls(w).length;
    const again = await update(w, ["lib"]); // an open pull request needs no --reviewer
    expect(again.rc).toBe(0);
    expect(again.lines.at(-1)).toBe(`OPEN https://github.com/owner/repo/pull/99 for lib@${c2.slice(0, 12)}; no second pull request was opened`);
    const since = ghCalls(w).slice(callsBefore);
    expect(since.some((c) => c.includes("pr view"))).toBe(true);
    expect(since.some((c) => c.includes("pr edit"))).toBe(false);
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toHaveLength(1);
    expect(branches(w)).toHaveLength(1);
    expect(git(w.bare, "rev-parse", branch)).toBe(head);
    expect(forbiddenCalls(w)).toEqual([]);
  });

  it("shows what changed since the approved commit, staging the old commit first", async () => {
    const { c1, c2 } = W;
    const w = world();
    expect(existsSync(join(w.home, "skill-quarantine", "lib", c1))).toBe(false);
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r.rc).toBe(0);
    expect(existsSync(join(w.home, "skill-quarantine", "lib", c1, "import.json"))).toBe(true);
    // the old commit is staged silently
    expect(r.lines.filter((l) => l.startsWith("OK ") && l.includes("staged"))).toHaveLength(1);
    expect(r.lines.at(-3)).toBe(`CHANGES since ${c1.slice(0, 12)}: 0 changed, 1 added, 0 removed, 1 unchanged; 1 needs a new evaluation record`);
    expect(r.lines.at(-2)).toMatch(/^REVIEWED /);

    const body = readFileSync(w.log, "utf8").split("--- pr body:\n")[1]!;
    expect(body).toContain(`### Changes since \`${c1.slice(0, 12)}\``);
    expect(body).toContain("| `skills/b` | added |");
    expect(body).toContain("Unchanged (1): `skills/a`");
    expect(body).toContain("new digest: needs a new record");
    expect(body).toMatch(/- Verdict: needs attention: [a-z, ]*evaluation[a-z, ]* \(see below\)\. Nothing is promoted until the gates pass\./);
    expect(body.indexOf("### Changes since")).toBeLessThan(body.indexOf("## Skill import review"));
    expect(body).not.toContain(SENTINEL);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(64_100);
  });

  it("opens the pull request when the old commit cannot be staged, and says it could not be compared", async () => {
    const { c1, c2 } = W;
    const w = world();
    const open: NonNullable<Parameters<typeof update>[4]>["open"] = async (source, commit, o) => {
      if (commit === c1) throw new GitTreeError("no-commit");
      return openGitTree(source, commit, o);
    };
    const r = await update(w, ["lib"], GOOD_REVIEW, { open });
    expect(r.rc).toBe(0);
    expect(r.lines.at(-3)).toBe(`CHANGES the old commit ${c1.slice(0, 12)} could not be compared`);
    expect(r.lines.at(-1)).toBe(`OK opened https://github.com/owner/repo/pull/99 for lib@${c2.slice(0, 12)}; nothing is approved until it is merged`);
    expect(existsSync(join(w.home, "skill-quarantine", "lib", c1))).toBe(false);
    const body = readFileSync(w.log, "utf8").split("--- pr body:\n")[1]!;
    expect(body).toContain("could not be staged or read, so it could not be compared");
    // the gates of the new import hold without the comparison: no evaluation record exists
    expect(body).toMatch(/- Verdict: needs attention: [a-z, ]*evaluation[a-z, ]* \(see below\)\./);
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

describe("a re-run refreshes the open pull request", () => {
  const URL99 = "https://github.com/owner/repo/pull/99";
  const edits = (w: Parameters<typeof ghCalls>[0]) => ghCalls(w).filter((c) => c.includes("pr edit"));

  it("edits the pull request when its text differs, and only then", async () => {
    const { c2 } = W;
    const w = world();
    const first = await update(w, ["lib"], GOOD_REVIEW);
    expect(first.rc).toBe(0);
    const branch = branchOf("lib", c2);
    const head = git(w.bare, "rev-parse", branch);
    const made = bodies(w)[URL99]!;
    expect(made.body).toContain("Merging records that `@rev`");
    setBody(w, URL99, { body: "old summary" });

    const r = await update(w, ["lib"]); // the review comes from the branch
    expect(r.rc).toBe(0);
    expect(r.lines.at(-1)).toBe(`UPDATED ${URL99} for lib@${c2.slice(0, 12)}; nothing is approved until it is merged`);
    expect(edits(w)).toHaveLength(1);
    expect(edits(w)[0]).toContain(`pr edit ${URL99} `);
    expect(edits(w)[0]).toContain("--repo acme/catalogue");
    expect(edits(w)[0]).toContain("--body-file -");
    expect(bodies(w)[URL99]).toEqual(made);
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toHaveLength(1);
    expect(git(w.bare, "rev-parse", branch)).toBe(head);
    expect(branches(w)).toHaveLength(1);

    const third = await update(w, ["lib"]);
    expect(third.lines.at(-1)).toBe(`OPEN ${URL99} for lib@${c2.slice(0, 12)}; no second pull request was opened`);
    expect(edits(w)).toHaveLength(1);

    setBody(w, URL99, { title: "another title" });
    expect((await update(w, ["lib"])).lines.at(-1)).toMatch(/^UPDATED /);
    expect(bodies(w)[URL99]!.title).toBe(made.title);
    expect(forbiddenCalls(w)).toEqual([]);
  });

  it("builds the text from the branch, not from the options of the re-run", async () => {
    const w = world();
    await update(w, ["lib"], GOOD_REVIEW);
    setBody(w, URL99, { body: "old" });
    const r = await update(w, ["lib"], { reviewer: "@other" });
    expect(r.lines.at(-1)).toMatch(/^UPDATED /);
    expect(bodies(w)[URL99]!.body).toContain("`@rev`");
    expect(bodies(w)[URL99]!.body).not.toContain("@other");
  });

  it("makes no review claim for a verified source that keeps an older review", async () => {
    const { c1 } = W;
    const plain = catalogueYaml();
    const yaml = plain.replace("    owner: '@octocat'\n  - id: gone", `    owner: '@octocat'\n    review: {by: '@octocat', on: '2026-01-01', commit: ${c1}, licence: MIT}\n  - id: gone`);
    expect(yaml).not.toBe(plain);
    const w = world(yaml);
    const first = await update(w, ["ver"]);
    expect(first.rc).toBe(0);
    const url = first.lines.at(-1)!.split(" ")[2]!;
    expect(bodies(w)[url]!.body).not.toContain("Merging records");
    const again = await update(w, ["ver"]);
    expect(again.lines.at(-1)).toMatch(/^OPEN /);
    expect(edits(w)).toEqual([]);
  });

  it("does not describe a local change of the file: it must be the file on origin", async () => {
    const w = world();
    await update(w, ["lib"], GOOD_REVIEW);
    setBody(w, URL99, { body: "old" });
    writeFileSync(join(w.clone, "skill-sources.yaml"), w.yaml.replace("owner: '@octocat'\n    review", "owner: '@someone'\n    review"));
    const r = await update(w, ["lib"]);
    expect(r.rc).toBe(1);
    expect(r.text).toContain("PROBLEM skill-sources.yaml in this folder differs from skill-sources.yaml on origin/main");
    expect(edits(w)).toEqual([]);
    expect(bodies(w)[URL99]!.body).toBe("old");
  });

  it("on a refresh, supersedes only the pull requests opened before it", async () => {
    const w = world();
    const acme = (n: number) => `https://github.com/acme/catalogue/pull/${n}`;
    setOpenPullRequests(w, [
      { url: acme(7), headRefName: "skill-update/lib-aaaaaaaaaaaa", createdAt: "2026-01-01T00:00:00Z" },
      { url: acme(8), headRefName: "skill-update/lib-bbbbbbbbbbbb", createdAt: "2027-01-01T00:00:00Z" },
    ]);
    const first = await update(w, ["lib"], GOOD_REVIEW);
    const url = first.lines.at(-1)!.split(" ")[2]!;
    expect(bodies(w)[url]!.body).toContain(acme(7));
    expect(bodies(w)[url]!.body).toContain(acme(8));
    setBody(w, url, { body: "old" });
    const r = await update(w, ["lib"]);
    expect(r.lines.at(-1)).toMatch(/^UPDATED /);
    expect(bodies(w)[url]!.body).toContain(acme(7));
    expect(bodies(w)[url]!.body).not.toContain(acme(8));
  });

  it("lists the open pull requests of older revisions of the source, and leaves them alone", async () => {
    const w = world();
    const acme = (n: number) => `https://github.com/acme/catalogue/pull/${n}`;
    // more than 100 unrelated pull requests come first: the older update must still be found
    const noise = Array.from({ length: 150 }, (_, i) => ({ url: acme(1000 + i), headRefName: `feature/x${i}` }));
    setOpenPullRequests(w, [
      ...noise,
      { url: acme(7), headRefName: "skill-update/lib-aaaaaaaaaaaa" },
      { url: acme(8), headRefName: "skill-update/lib-extra-aaaaaaaaaaaa" },
      { url: acme(9), headRefName: "skill-update/ver-bbbbbbbbbbbb" },
      { url: acme(10), headRefName: "skill-update/lib-cccccccccccc", state: "CLOSED" },
      { url: "https://x/a/b/pull/11)<!--", headRefName: "skill-update/lib-dddddddddddd" },
    ]);
    const r = await update(w, ["lib"], GOOD_REVIEW);
    expect(r.rc).toBe(0);
    const body = readFileSync(w.log, "utf8").split("--- pr body:\n")[1]!;
    expect(body).toContain("Supersedes (these stay open and are not changed):");
    expect(body).toContain(`- ${acme(7)} (\`skill-update/lib-aaaaaaaaaaaa\`)`);
    for (const n of [8, 9, 10]) expect(body).not.toContain(`/pull/${n}\n`);
    expect(body).not.toContain("pull/11");
    expect(body.indexOf("Supersedes")).toBeLessThan(body.indexOf("## Skill import review"));
    for (const c of ghCalls(w)) if (/pull\/(7|8|9|10|11)\b/.test(c)) throw new Error(`touched: ${c}`);
    expect(ghCalls(w).filter((c) => /pr (edit|close|merge|comment)/.test(c))).toEqual([]);
    expect(forbiddenCalls(w)).toEqual([]);
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
    expect(log).not.toContain("Changes since");
    expect(r.text).not.toContain("CHANGES");
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
