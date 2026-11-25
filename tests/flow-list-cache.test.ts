import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { listFlows } from "../src/flow/load.js";

vi.mock("yaml", async (orig) => {
  const m = await orig<typeof import("yaml")>();
  return { ...m, parse: vi.fn(m.parse) };
});

const flowText = (description: string) => `name: a\ndescription: ${description}\nsteps:\n  - id: s\n    type: shell\n    run: "true"\n`;
const root = mkdtempSync(join(tmpdir(), "flow-list-cache-"));
let n = 0;
let repo: string;
let dir: string;
const mine = (repo: string) => listFlows(repo).filter((f) => f.scope === "repo");

beforeEach(() => {
  repo = join(root, `r${n++}`);
  dir = join(repo, ".claude-factory", "flows");
  mkdirSync(dir, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("listFlows cache", () => {
  it("does not parse an unchanged file again", () => {
    writeFileSync(join(dir, "a.yaml"), flowText("one"));
    const first = mine(repo);
    expect(first[0]?.description).toBe("one");
    vi.mocked(parse).mockClear();
    expect(mine(repo)).toEqual(first);
    expect(parse).toHaveBeenCalledTimes(0);
  });

  it("parses a changed file again", () => {
    writeFileSync(join(dir, "a.yaml"), flowText("one"));
    mine(repo);
    writeFileSync(join(dir, "a.yaml"), flowText("two"));
    vi.mocked(parse).mockClear();
    expect(mine(repo)[0]?.description).toBe("two");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("shows the error of a broken file and recovers", () => {
    writeFileSync(join(dir, "a.yaml"), "name: [unclosed");
    const bad = mine(repo)[0]!;
    expect(bad.error).toBeTruthy();
    expect(bad.description).toBeUndefined();
    expect(mine(repo)[0]).toEqual(bad);
    writeFileSync(join(dir, "a.yaml"), flowText("ok"));
    const good = mine(repo)[0]!;
    expect(good.error).toBeUndefined();
    expect(good.description).toBe("ok");
  });

  it("stops listing a deleted file", () => {
    writeFileSync(join(dir, "a.yaml"), flowText("one"));
    expect(mine(repo)).toHaveLength(1);
    rmSync(join(dir, "a.yaml"));
    expect(mine(repo)).toHaveLength(0);
  });

  it("lets a repo flow hide a built-in one of the same name", () => {
    writeFileSync(join(dir, "issue-gitflow.yaml"), flowText("mine"));
    const f = listFlows(repo).filter((x) => x.name === "issue-gitflow");
    expect(f).toHaveLength(1);
    expect(f[0]?.scope).toBe("repo");
  });
});
