import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitCredential } from "../src/skill-import/git-tree.js";
import { ACCESS_CHANGED } from "../src/skill-import/source-access.js";
import { branchOf, catalogueYaml, ghCalls, git, setOpenPullRequests, update, useWorlds, W, world } from "./helpers/skill-update-world.js";

// `scf skills update` for a private first-party source: the credential is made once for the approved source and used only for
// a candidate with the same repository and the same access. The git and gh parts are the ones of skill-update-cli.test.ts.

useWorlds();

const SECRET = "ghs_" + "Zq8Xw3Lm0Pa7Rt5Vb2Nc";
const CRED: GitCredential = { username: "x-access-token", password: SECRET };
const priv = (approved: string) =>
  [
    "  - id: priv",
    "    repository: https://github.com/example/private",
    "    status: enabled",
    `    ref: {track: main, approved: '${approved}'}`,
    "    paths: [skills]",
    "    adapter: agent-skills",
    "    trust: first-party",
    "    licence: {allow: [MIT]}",
    "    update: {cadence: manual}",
    "    access: {repo: example/private}",
    "    owner: '@octocat'",
  ].join("\n");
const privWorld = () => world(catalogueYaml({ extra: [priv(W.c1)] }));
const ok = (calls: { n: number }) => async () => (calls.n++, { ok: true as const, credential: CRED });

describe("update of a source with access", () => {
  it("makes one credential for the approved source and gives it to the resolver; a source without access gets none", async () => {
    const w = privWorld();
    const calls = { n: 0 };
    const seen: (GitCredential | undefined)[] = [];
    const resolve = async (_r: string, _t: string | undefined, o: { credential?: GitCredential }) => (seen.push(o.credential), { commit: W.c1 });
    const r = await update(w, ["priv"], {}, { access: ok(calls), resolve });
    expect(r.lines.at(-1)).toMatch(/^UNCHANGED priv is at /);
    expect(calls.n).toBe(1);
    expect(seen).toEqual([CRED]);
    const v = await update(w, ["ver"], {}, { access: ok(calls), resolve });
    expect(v.lines.at(-1)).toMatch(/^UNCHANGED ver is at /);
    expect(calls.n).toBe(1);
    expect(seen).toEqual([CRED, undefined]);
    expect(r.text).not.toContain(SECRET);
  });

  it("ends with the fixed sentence, and no git call, when the access cannot be made", async () => {
    const w = privWorld();
    let resolved = 0;
    const r = await update(w, ["priv"], {}, { access: async () => ({ ok: false, problem: "a fixed sentence" }), resolve: async () => (resolved++, { commit: W.c1 }) });
    expect(r.lines.at(-1)).toBe("PROBLEM a fixed sentence");
    expect(r.rc).toBe(1);
    expect(resolved).toBe(0);
    expect(ghCalls(w).filter((c) => c.includes("pr create"))).toEqual([]);
  });

  /** Opens the pull request, then changes the entry on its branch with `edit`. */
  const changedBranch = async (edit: (text: string) => string) => {
    const w = privWorld();
    const calls = { n: 0 };
    const first = await update(w, ["priv"], {}, { access: ok(calls) });
    expect(first.lines.at(-1)).toMatch(/^OK opened /);
    const branch = branchOf("priv", W.c2);
    const tmp = mkdtempSync(join(W.root, "edit-"));
    git(tmp, "clone", "--quiet", w.bare, "c");
    const c = join(tmp, "c");
    git(c, "checkout", "--quiet", branch);
    const file = join(c, "skill-sources.yaml");
    const text = readFileSync(file, "utf8");
    const next = edit(text);
    expect(next).not.toBe(text);
    writeFileSync(file, next);
    git(c, "commit", "--quiet", "-am", "change the destination");
    git(c, "push", "--quiet", "origin", branch);
    setOpenPullRequests(w, [{ url: "https://github.com/owner/repo/pull/99", headRefName: branch }]);
    return { w, calls };
  };

  it.each([
    ["changes repository and access", (t: string) => t.replace("example/private", "example/other").replace("example/private", "example/other")],
    ["drops access", (t: string) => t.replace("    access: {repo: example/private}\n", "")],
  ])("a refresh whose candidate %s ends with a fixed PROBLEM and fetches nothing", async (_n, edit) => {
    const { w, calls } = await changedBranch(edit);
    let opened = 0;
    const open = (async () => (opened++, undefined as never)) as never;
    const r = await update(w, ["priv"], {}, { access: ok(calls), open });
    expect(r.lines.at(-1)).toBe(`PROBLEM ${ACCESS_CHANGED}`);
    expect(r.rc).toBe(1);
    expect(opened).toBe(0);
    expect(r.text).not.toContain(SECRET);
  });
});
