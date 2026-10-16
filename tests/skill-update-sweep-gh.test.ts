import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFindings } from "../src/monitor/findings.js";
import { skillUpdateSweeper } from "../src/server/skill-update-sweep.js";
import { catalogueYaml, ghCalls, git, NOW, useWorlds, W, world, type World } from "./helpers/skill-update-world.js";

// The sweeper with its default runner against local git and the fake gh: it opens pull requests and never merges or approves.

useWorlds();

const dueYaml = (): string => {
  let n = 0;
  return catalogueYaml({ lib: W.c1, ver: W.c2 }).replace(/update: \{cadence: manual\}/g, (m) => {
    n++;
    return n === 1 ? "update: {cadence: weekly, reviewer: '@rev'}" : n === 2 ? "update: {cadence: weekly}" : m;
  });
};

let dir: string;
let file: string;
let w: World;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sweep-gh-"));
  file = join(dir, "findings.json");
  w = world(dueYaml());
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sweeper = () =>
  skillUpdateSweeper({
    config: () => ({ folder: w.clone, everyMs: 0 }),
    log: (l) => lines.push(l),
    findingsIdle: (fn) => Promise.resolve(fn()),
    updateOptions: { home: w.home, remote: W.upstream, now: NOW, env: w.env },
    file,
    userHome: join(dir, "home"),
  });
const open = () => readFindings(file).findings.filter((f) => !f.gone);
const creates = () => ghCalls(w).filter((c) => c.includes("pr create"));

describe("the default runner", () => {
  it("opens one pull request and never merges, reviews or approves", async () => {
    const main = git(w.bare, "rev-parse", "main");
    await sweeper().tick();
    expect(creates()).toHaveLength(1);
    expect(ghCalls(w).filter((c) => /pr merge|pr review|--approve|\/merge|\/reviews/.test(c))).toEqual([]);
    expect(git(w.bare, "rev-parse", "main")).toBe(main);
    expect(lines.some((l) => l.startsWith("skill-sources: lib: OK opened "))).toBe(true);
    expect(open()).toEqual([]);
  });

  it("shows a PROBLEM as a finding and clears it on the next tick", async () => {
    w.env.FAKE_GH_FAIL = "pr edit";
    const s = sweeper();
    await s.tick();
    expect(open().map((f) => f.summary)).toEqual([expect.stringMatching(/^Skill source lib: .*gh could not ask @rev/)]);
    delete w.env.FAKE_GH_FAIL;
    await s.tick();
    expect(lines.some((l) => l.startsWith("skill-sources: lib: OPEN "))).toBe(true);
    expect(open()).toEqual([]);
    expect(creates()).toHaveLength(1);
  });
});
