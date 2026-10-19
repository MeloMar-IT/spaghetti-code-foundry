import { describe, expect, it } from "vitest";
import { runTarget } from "../src/run-target.js";

const folders = new Set(["/work", "/work/app"]);
const base = { vars: {}, cwd: "/work", workspace: "worktree" as string | undefined, exists: (p: string) => folders.has(p) };

describe("runTarget", () => {
  it("keeps the folder form", () => {
    expect(runTarget({ ...base, repoArg: "app" })).toEqual({ repo: "/work/app", vars: {} });
    expect(runTarget({ ...base })).toEqual({ repo: "/work", vars: {} });
    expect(runTarget({ ...base, repoArg: "/work/app", vars: { a: "b" } })).toEqual({ repo: "/work/app", vars: { a: "b" } });
  });

  it("takes owner/name as the variable github_repo for a flow that clones itself", () => {
    expect(runTarget({ ...base, repoArg: "acme/app", workspace: "empty" })).toEqual({ repo: "/work", vars: { github_repo: "acme/app" } });
  });

  it("lets an existing folder win over owner/name", () => {
    expect(runTarget({ ...base, repoArg: "acme/app", workspace: "empty", exists: (p) => p === "/work/acme/app" || p === "/work" })).toEqual({
      repo: "/work/acme/app",
      vars: {},
    });
  });

  it("gives a hint when the flow does not clone the repository itself", () => {
    expect(() => runTarget({ ...base, repoArg: "acme/app", workspace: "worktree" })).toThrow(/repo not found: \/work\/acme\/app.*owner\/name.*--var github_repo=acme\/app/);
  });

  it("says repo not found for anything else", () => {
    expect(() => runTarget({ ...base, repoArg: "nowhere", workspace: "empty" })).toThrow(/^repo not found: \/work\/nowhere$/);
    expect(() => runTarget({ ...base, repoArg: "owner/repo", workspace: "empty" })).toThrow(/repo not found/);
  });

  it("sets ref from --ref", () => {
    expect(runTarget({ ...base, repoArg: "acme/app", workspace: "empty", ref: "develop" }).vars).toEqual({ github_repo: "acme/app", ref: "develop" });
    expect(runTarget({ ...base, ref: "abc1234" }).vars).toEqual({ ref: "abc1234" });
  });

  it("refuses conflicts and an empty --ref", () => {
    expect(() => runTarget({ ...base, repoArg: "acme/app", workspace: "empty", vars: { github_repo: "x/y" } })).toThrow(/conflicts with --var github_repo=x\/y/);
    expect(() => runTarget({ ...base, ref: "a", vars: { ref: "b" } })).toThrow(/conflicts with --var ref=b/);
    expect(() => runTarget({ ...base, ref: "  " })).toThrow(/--ref is empty/);
    expect(runTarget({ ...base, ref: "a", vars: { ref: "a" } }).vars).toEqual({ ref: "a" });
  });
});
