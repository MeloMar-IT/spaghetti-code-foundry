import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPDATE_DUE_USAGE } from "../src/skill-import/update-cli.js";
import { LsRemoteError } from "../src/skill-import/ls-remote.js";
import { branches, branchOf, catalogueYaml, ghCalls, git, NOW, sigCounts, snapshot, update, useWorlds, W, world, type World } from "./helpers/skill-update-world.js";

// `scf skills update --due [--all]` against local git and the fake gh. Syntax, the due rule, the record, the community reviewer.

useWorlds();

const DAY = 86_400_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);

/** The catalogue with the cadence (and reviewer) of `lib` and `ver` set; the helper writes `update: {cadence: manual}` for both. */
function dueYaml(o: { lib?: string; libReviewer?: string; ver?: string; libAt?: string; verAt?: string }): string {
  let n = 0;
  return catalogueYaml({ lib: o.libAt ?? W.c1, ver: o.verAt ?? W.c2 }).replace(/update: \{cadence: manual\}/g, (m) => {
    n++;
    if (n === 1) return `update: {cadence: ${o.lib ?? "weekly"}${o.libReviewer ? `, reviewer: '${o.libReviewer}'` : ""}}`;
    if (n === 2) return `update: {cadence: ${o.ver ?? "weekly"}}`;
    return m;
  });
}
const dueWorld = (o: Parameters<typeof dueYaml>[0] = { libReviewer: "@rev" }, env: Record<string, string> = {}) => world(dueYaml(o), env);
const run = (w: World, values: Record<string, unknown> = {}, o: Parameters<typeof update>[3] = {}) => update(w, [], { due: true, ...values }, o);
const record = (w: World) => JSON.parse(readFileSync(join(w.home, "skill-update-checks.json"), "utf8")).sources as Record<string, { checkedAt: string; outcome: string; succeededAt?: string }>;
const c12 = (c: string) => c.slice(0, 12);
const reviewersFile = (w: World) => (existsSync(`${w.log}.reviewers.json`) ? JSON.parse(readFileSync(`${w.log}.reviewers.json`, "utf8")) : {});
const URL99 = "https://github.com/owner/repo/pull/99";

describe("the syntax", () => {
  it("is refused before any git or gh call", async () => {
    const w = dueWorld();
    for (const [positionals, values] of [[["lib"], { due: true }], [[], { all: true }], [[], { due: true, reviewer: "@r" }], [[], { due: true, owner: "@r" }], [[], { due: true, licence: "MIT" }]] as const) {
      await expect(update(w, [...positionals], values)).rejects.toThrow(UPDATE_DUE_USAGE);
    }
    expect(ghCalls(w)).toEqual([]);
  });
});

describe("a community source, first time", () => {
  it("opens one pull request, asks the reviewer after it, records both, and is quiet when run again", async () => {
    const w = dueWorld();
    const before = snapshot(w);
    const signals = sigCounts();
    const r = await run(w);
    expect(r.rc).toBe(0);
    expect(r.lines[0]).toBe("NOTE skill-update-checks.json is not in the data folder yet; every source counts as never checked");
    expect(r.lines.filter((l) => l.startsWith("NOTE"))).toHaveLength(1);
    const own = r.lines.slice(1);
    expect(own.every((l) => l.startsWith("lib: ") || l.startsWith("ver: ") || l.startsWith("CHECKED "))).toBe(true);
    expect(r.lines.filter((l) => l.startsWith("lib: OK opened "))).toEqual([`lib: OK opened ${URL99} for lib@${c12(W.c2)}; nothing is approved until it is merged`]);
    expect(r.lines).toContain(`ver: UNCHANGED ver is at ${c12(W.c2)} (ref.approved); nothing to propose`);
    expect(r.lines.at(-1)).toBe("CHECKED 2 sources: 1 UNCHANGED, 0 OPEN, 0 UPDATED, 1 OK, 0 PROBLEM");
    expect(sigCounts()).toEqual(signals);

    const calls = ghCalls(w);
    const create = calls.findIndex((c) => c.includes("pr create"));
    expect(calls[create]).not.toContain("--reviewer");
    expect(calls[create + 1]).toBe(`gh pr edit ${URL99} --repo acme/catalogue --add-reviewer rev`);
    expect(reviewersFile(w)).toEqual({ [URL99]: ["rev"] });
    const body = readFileSync(w.log, "utf8").split("--- pr body:\n")[1]!;
    expect(body).toContain("opened by an unattended run");
    expect(body).toContain("`@rev` (from `update.reviewer`) is named as the reviewer and has not reviewed it yet");

    expect(branches(w)).toEqual([`refs/heads/${branchOf("lib", W.c2)}`]);
    expect(git(w.bare, "show", `${branchOf("lib", W.c2)}:skill-sources.yaml`)).toContain(`review: {by: '@rev', on: '2026-10-15', commit: ${W.c2}, licence: MIT}`);
    expect(snapshot(w)).toEqual(before);

    const rec = record(w);
    expect(Object.keys(rec)).toEqual(["lib", "ver"]);
    expect(rec.lib).toEqual({ checkedAt: NOW.toISOString(), outcome: "OK", succeededAt: NOW.toISOString() });
    expect(rec.ver!.outcome).toBe("UNCHANGED");

    // nothing is due at the same time: no note, no gh call
    const count = ghCalls(w).length;
    const quiet = await run(w);
    expect(quiet.lines).toEqual(["CHECKED 0 sources: 0 UNCHANGED, 0 OPEN, 0 UPDATED, 0 OK, 0 PROBLEM; 2 not due"]);
    expect(quiet.rc).toBe(0);
    expect(ghCalls(w)).toHaveLength(count);
    expect((await run(w, {}, { now: later(7 * DAY - 1) })).lines.at(-1)).toContain("; 2 not due");

    // --all ignores the cadence: the open pull request is found, its reviewer is confirmed, nothing is edited or opened again
    const since = ghCalls(w).length;
    const all = await run(w, { all: true });
    expect(all.lines).toContain(`lib: OPEN ${URL99} for lib@${c12(W.c2)}; no second pull request was opened`);
    expect(all.lines.at(-1)).toBe("CHECKED 2 sources: 1 UNCHANGED, 1 OPEN, 0 UPDATED, 0 OK, 0 PROBLEM");
    const more = ghCalls(w).slice(since);
    expect(more.filter((c) => c.includes("reviewRequests,reviews"))).toHaveLength(1);
    expect(more.some((c) => c.includes("--add-reviewer") || c.includes("--body-file") || c.includes("pr create"))).toBe(false);
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toHaveLength(1);

    // a week later both are due
    const week = await run(w, {}, { now: later(7 * DAY) });
    expect(week.lines.at(-1)).toBe("CHECKED 2 sources: 1 UNCHANGED, 1 OPEN, 0 UPDATED, 0 OK, 0 PROBLEM");

    // the reviewer view fails: PROBLEM, and the body is left alone
    const failed = await run(w, { all: true }, { env: { FAKE_GH_REVIEWERS_FAIL: "1" } });
    expect(failed.rc).toBe(1);
    expect(failed.lines).toContain(`lib: PROBLEM the pull request ${URL99} is open, but gh could not confirm or ask @rev to review it; it was left as it was; the next --due run tries again`);
    expect(ghCalls(w).some((c) => c.startsWith("gh pr edit") && c.includes("--body-file"))).toBe(false);
  });

  it("is a PROBLEM when the reviewer cannot be asked; the next run asks again and opens nothing new", async () => {
    const w = dueWorld();
    const r = await run(w, {}, { env: { FAKE_GH_FAIL: "pr edit" } });
    expect(r.rc).toBe(1);
    expect(r.lines).toContain(`lib: PROBLEM opened ${URL99} for lib@${c12(W.c2)}, but gh could not ask @rev to review it; ask them on GitHub or fix update.reviewer; the next --due run tries again`);
    expect(r.lines.at(-1)).toBe("CHECKED 2 sources: 1 UNCHANGED, 0 OPEN, 0 UPDATED, 0 OK, 1 PROBLEM");
    expect(branches(w)).toEqual([`refs/heads/${branchOf("lib", W.c2)}`]);
    expect(record(w).lib).toEqual({ checkedAt: NOW.toISOString(), outcome: "PROBLEM" });

    const again = await run(w, {}, { now: later(60_000) });
    expect(again.rc).toBe(0);
    expect(again.lines.filter((l) => l.startsWith("lib: ")).at(-1)).toBe(`lib: OPEN ${URL99} for lib@${c12(W.c2)}; no second pull request was opened`);
    expect(again.lines.at(-1)).toBe("CHECKED 1 sources: 0 UNCHANGED, 1 OPEN, 0 UPDATED, 0 OK, 0 PROBLEM; 1 not due");
    expect(reviewersFile(w)).toEqual({ [URL99]: ["rev"] });
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toHaveLength(1);
    expect(record(w).lib).toEqual({ checkedAt: later(60_000).toISOString(), outcome: "OPEN", succeededAt: later(60_000).toISOString() });
  });

  it("reports a pull request that names another reviewer than update.reviewer now says", async () => {
    const w = dueWorld();
    await run(w);
    const file = join(w.clone, "skill-sources.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("reviewer: '@rev'", "reviewer: '@other'"));
    git(w.clone, "commit", "--quiet", "-am", "correct the reviewer");
    git(w.clone, "push", "--quiet", w.bare, "HEAD:main");
    const r = await run(w, { all: true });
    expect(r.rc).toBe(1);
    expect(r.lines).toContain(`lib: PROBLEM the pull request ${URL99} names @rev as the reviewer, but update.reviewer is @other; close the pull request and delete its branch ${branchOf("lib", W.c2)}, then the next --due run opens one that names the right reviewer`);
    expect(reviewersFile(w)).toEqual({ [URL99]: ["rev"] });
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toHaveLength(1);
  });

  it("retries after a forced failure on the next ordinary run", async () => {
    const w = dueWorld();
    await run(w);
    const resolve = async (repository: string) => {
      if (repository.endsWith("/example/skills")) throw new LsRemoteError("unreachable");
      return { commit: W.c2 };
    };
    const forced = await run(w, { all: true }, { resolve, now: later(60_000) });
    expect(forced.rc).toBe(1);
    expect(forced.lines).toContain("lib: PROBLEM the upstream repository github.com/example/skills could not be reached; nothing was proposed");
    expect(forced.lines).toContain(`ver: UNCHANGED ver is at ${c12(W.c2)} (ref.approved); nothing to propose`);
    expect(record(w).lib).toEqual({ checkedAt: later(60_000).toISOString(), outcome: "PROBLEM", succeededAt: NOW.toISOString() });

    const next = await run(w, {}, { now: later(120_000) });
    expect(next.lines.some((l) => l.startsWith("ver: "))).toBe(false);
    expect(next.lines.at(-1)).toBe("CHECKED 1 sources: 0 UNCHANGED, 1 OPEN, 0 UPDATED, 0 OK, 0 PROBLEM; 1 not due");
  });
});

describe("the reviewer", () => {
  it("is needed for a changed community source: PROBLEM, nothing opened, the others still run", async () => {
    const w = dueWorld({});
    const r = await run(w);
    expect(r.rc).toBe(1);
    expect(r.lines.filter((l) => l.startsWith("lib: "))).toEqual([expect.stringMatching(/^lib: PROBLEM needs update\.reviewer: /)]);
    expect(r.lines).toContain(`ver: UNCHANGED ver is at ${c12(W.c2)} (ref.approved); nothing to propose`);
    expect(branches(w)).toEqual([]);
    expect(ghCalls(w).some((c) => c.includes("pr create"))).toBe(false);
    expect(record(w).lib).toEqual({ checkedAt: NOW.toISOString(), outcome: "PROBLEM" });
  });

  it("is not needed when upstream did not change", async () => {
    const w = dueWorld({ libAt: W.c2 });
    const r = await run(w);
    expect(r.rc).toBe(0);
    expect(r.lines).toContain(`lib: UNCHANGED lib is at ${c12(W.c2)} (ref.approved); nothing to propose`);
    expect(branches(w)).toEqual([]);
  });
});

describe("the list of sources", () => {
  it("comes from origin, not from the working copy", async () => {
    const w = dueWorld();
    writeFileSync(join(w.clone, "skill-sources.yaml"), readFileSync(join(w.clone, "skill-sources.yaml"), "utf8") + "# a local note\n");
    const r = await run(w);
    expect(r.rc).toBe(0);
    expect(r.lines.filter((l) => l.startsWith("lib: OK opened "))).toHaveLength(1);
    expect(git(w.bare, "show", `${branchOf("lib", W.c2)}:skill-sources.yaml`)).not.toContain("a local note");
  });

  it("skips manual sources unless --all, and never a disabled one", async () => {
    const w = dueWorld({ lib: "manual", ver: "manual", libReviewer: "@rev" });
    const r = await run(w);
    expect(r.lines).toEqual(["NOTE skill-update-checks.json is not in the data folder yet; every source counts as never checked", "CHECKED 0 sources: 0 UNCHANGED, 0 OPEN, 0 UPDATED, 0 OK, 0 PROBLEM; 2 manual"]);
    expect(ghCalls(w).some((c) => c.includes("pr create"))).toBe(false);
    const all = await run(w, { all: true });
    expect(all.lines.at(-1)).toBe("CHECKED 2 sources: 1 UNCHANGED, 0 OPEN, 0 UPDATED, 1 OK, 0 PROBLEM");
    expect(all.lines.some((l) => /^(gone|held|old): /.test(l))).toBe(false);
  });

  it("is a single PROBLEM line, without a record, when origin is not a GitHub repository", async () => {
    const w = dueWorld();
    git(w.clone, "config", "remote.origin.url", w.bare);
    const r = await run(w);
    expect(r.rc).toBe(1);
    expect(r.lines).toEqual(["PROBLEM the address of origin is not a GitHub repository address; the pull request needs it"]);
    expect(existsSync(join(w.home, "skill-update-checks.json"))).toBe(false);
  });
});

describe("the record", () => {
  it("is reported once when unreadable, and replaced", async () => {
    const w = dueWorld();
    mkdirSync(w.home, { recursive: true });
    writeFileSync(join(w.home, "skill-update-checks.json"), "nope");
    const r = await run(w);
    expect(r.lines.filter((l) => l.startsWith("NOTE"))).toEqual(["NOTE skill-update-checks.json in the data folder is not valid JSON; every source counts as never checked"]);
    expect(r.lines.at(-1)).toBe("CHECKED 2 sources: 1 UNCHANGED, 0 OPEN, 0 UPDATED, 1 OK, 0 PROBLEM");
    expect(Object.keys(record(w))).toEqual(["lib", "ver"]);
  });

  it("a failed write is one note and not fatal", async () => {
    const w = dueWorld();
    mkdirSync(join(w.home, "skill-update-checks.json"), { recursive: true }); // a folder where the file belongs: the read says "unreadable", the rename fails
    const r = await run(w);
    expect(r.rc).toBe(0);
    expect(r.lines.filter((l) => l.includes("could not be written"))).toEqual(["NOTE skill-update-checks.json could not be written to the data folder; the next run may check the same sources again"]);
  });
});

describe("failures of one source", () => {
  it("do not stop the others", async () => {
    const w = dueWorld();
    const resolve = async (repository: string) => {
      if (repository.endsWith("/example/skills")) throw new LsRemoteError("unreachable");
      return { commit: W.c2 };
    };
    const r = await run(w, {}, { resolve });
    expect(r.rc).toBe(1);
    expect(r.lines).toContain("lib: PROBLEM the upstream repository github.com/example/skills could not be reached; nothing was proposed");
    expect(r.lines).toContain(`ver: UNCHANGED ver is at ${c12(W.c2)} (ref.approved); nothing to propose`);
    expect(r.lines.at(-1)).toBe("CHECKED 2 sources: 1 UNCHANGED, 0 OPEN, 0 UPDATED, 0 OK, 1 PROBLEM");
  });

  it("an interrupt ends the run, records nothing for the source, and restores the listeners", async () => {
    const w = dueWorld();
    const signals = sigCounts();
    const resolve = async (repository: string) => {
      if (repository.endsWith("/example/skills")) process.emit("SIGINT");
      return { commit: W.c2 };
    };
    const r = await run(w, {}, { resolve });
    expect(r.rc).toBe(1);
    expect(r.lines).toContain("lib: PROBLEM the update was interrupted; nothing was proposed");
    expect(r.lines.some((l) => l.startsWith("ver: "))).toBe(false);
    expect(r.lines.at(-1)).toBe("CHECKED 1 sources: 0 UNCHANGED, 0 OPEN, 0 UPDATED, 0 OK, 1 PROBLEM; interrupted, 1 not checked");
    expect(existsSync(join(w.home, "skill-update-checks.json"))).toBe(false);
    expect(sigCounts()).toEqual(signals);
  });
});
