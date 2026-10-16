import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CONFIG_PATH, ConfigSchema } from "../src/config.js";
import { PROPOSE_USAGE } from "../src/skill-import/release-propose-cli.js";
import { listStoredReleases } from "../src/skills/release-store.js";
import { forbiddenCalls } from "./helpers/skill-update-world.js";
import { deployYaml, fileOnBranch, FILE, keyPair, makeRelease, P, pBodies, pBranches, pCalls, propose, pworld, sign, skillsConfig, tree, useProposeWorld, wcSnapshot } from "./helpers/skill-propose-world.js";
import { git } from "./helpers/skill-update-world.js";

// `scf skills release propose` against a real local bare deployment repository and the fake gh (tests/helpers/skill-propose-world.ts).

useProposeWorld();
const URL99 = "https://github.com/owner/repo/pull/99";
const BRANCH = "skill-catalogue/acme-1.1.0";
const gh = (w: ReturnType<typeof pworld>) => ({ calls: pCalls(w), made: pCalls(w).filter((c) => c.includes("pr create")) });

describe("propose", () => {
  it("opens a pull request that appends one entry and shows the change report", async () => {
    const w = pworld();
    const before = wcSnapshot(w);
    const home = tree(P.store);
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r.rc).toBe(0);
    expect(r.lines[0]).toBe("CHANGES acme@1.0.0 -> 1.1.0: 2 changes");
    expect(r.lines.at(-1)).toBe(`OK opened ${URL99} for acme@1.1.0; an installation uses it only after its config names it`);
    expect(pBranches(w)).toEqual([`refs/heads/${BRANCH}`]);
    expect(git(w.bare, "diff", "--name-only", "main", BRANCH)).toBe(FILE);
    const after = fileOnBranch(w, BRANCH);
    expect(after.startsWith(w.yaml.slice(0, w.yaml.indexOf("# end of file")).replace(/\n$/, ""))).toBe(true);
    expect(after.endsWith("# end of file\n")).toBe(true);
    expect(after).toContain(`digest: ${P.d100} # pinned\n      - catalogue: acme\n        version: 1.1.0\n        digest: ${P.d110}\n`);
    const approved = ConfigSchema.parse(parse(after)).skills.releases.approved;
    expect(approved.map((a) => a.version)).toEqual(["1.0.0", "1.1.0"]);

    expect(gh(w).calls.filter((c) => c.startsWith("gh pr")).map((c) => c.replace(/ --json.*| --limit.*/, ""))).toEqual([
      `gh pr list --repo acme/deploy --head ${BRANCH} --state open`,
      `gh pr create --repo acme/deploy --base main --head ${BRANCH} --title Skill catalogue acme: approve 1.1.0 --body-file -`,
    ]);
    const body = pBodies(w)[URL99]!.body;
    for (const t of ["## Catalogue changes", "### Added", "### Deprecated", P.d110, "`gamma@1.0.0`", "`beta@1.0.0`"]) expect(body).toContain(t);
    expect(wcSnapshot(w)).toEqual(before);
    expect(git(w.clone, "branch", "--list", "skill-catalogue/*")).toBe("");
    expect(tree(P.store)).toEqual(home);
    expect(forbiddenCalls(w as never)).toEqual([]);
  });

  it("prints OPEN on a second run and opens nothing", async () => {
    const w = pworld();
    await propose(w, ["acme@1.1.0"]);
    const head = git(w.bare, "rev-parse", BRANCH);
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r).toMatchObject({ rc: 0, text: `OPEN ${URL99} for acme@1.1.0; no second pull request was opened` });
    expect(gh(w).made).toHaveLength(1);
    expect(git(w.bare, "rev-parse", BRANCH)).toBe(head);
  });

  it("prints UNCHANGED when the entry is in the file, without gh or push", async () => {
    const w = pworld(deployYaml({ approved: [{ version: "1.0.0", digest: P.d100 }, { version: "1.1.0", digest: P.d110 }] }));
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r).toMatchObject({ rc: 0, text: `UNCHANGED acme@1.1.0 ${P.d110} is already in ${FILE}; nothing to propose` });
    expect(gh(w).calls).toEqual([]);
    expect(pBranches(w)).toEqual([]);
  });

  it("refuses the same version with another digest", async () => {
    const w = pworld(deployYaml({ approved: [{ version: "1.1.0", digest: P.d100 }] }));
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r).toMatchObject({ rc: 1, text: `PROBLEM ${FILE} already approves acme@1.1.0 with another digest; nothing was proposed` });
    expect(pBranches(w)).toEqual([]);
  });

  it("refuses another repository and a missing deployment setting", async () => {
    const w = pworld();
    const r = await propose(w, ["acme@1.1.0"], {}, skillsConfig({ repository: "other/deploy" }));
    expect(r.text).toBe("PROBLEM origin is acme/deploy, not the deployment repository other/deploy; run the command in a clone of it; nothing was proposed");
    const none = await propose(w, ["acme@1.1.0"], {}, skillsConfig({ deployment: false }));
    expect(none.text).toContain("PROBLEM skills.releases.deployment is not set");
    expect(gh(w).calls).toEqual([]);
    expect(pBranches(w)).toEqual([]);
    // the address may carry the host
    const host = await propose(pworld(), ["acme@1.1.0"], {}, skillsConfig({ repository: "GitHub.com/ACME/Deploy" }));
    expect(host.rc).toBe(0);
  });

  describe("signatures", () => {
    const k = keyPair();
    const keyed = () => pworld(deployYaml({ keys: [{ id: k.id, pub: k.pub }] }));
    it("needs a signature when the deployment file has keys", async () => {
      const w = keyed();
      const r = await propose(w, ["acme@1.1.0"]);
      expect(r).toMatchObject({ rc: 1 });
      expect(r.text).toContain("skills.releases.keys is set, so the entry needs --key");
      expect(pBranches(w)).toEqual([]);
    });
    it("adds key and signature when they verify", async () => {
      const w = keyed();
      const r = await propose(w, ["acme@1.1.0"], { key: "k1", signature: sign(k.priv, "1.1.0", P.d110) });
      expect(r.rc).toBe(0);
      const approved = ConfigSchema.parse(parse(fileOnBranch(w, BRANCH))).skills.releases.approved;
      expect(approved.at(-1)).toMatchObject({ version: "1.1.0", key: "k1", signature: sign(k.priv, "1.1.0", P.d110) });
      expect(pBodies(w)[URL99]!.body).toContain("Signed by: `k1`");
    });
    it("refuses a wrong signature and an unknown key id", async () => {
      const w = keyed();
      const bad = await propose(w, ["acme@1.1.0"], { key: "k1", signature: sign(k.priv, "1.1.0", P.d100) });
      expect(bad.text).toBe(`PROBLEM the signature does not verify for acme@1.1.0 ${P.d110}; nothing was proposed`);
      const unknown = await propose(w, ["acme@1.1.0"], { key: "k2", signature: sign(k.priv, "1.1.0", P.d110) });
      expect(unknown.text).toBe(`PROBLEM the key k2 is not in skills.releases.keys of ${FILE}; nothing was proposed`);
      expect(pBranches(w)).toEqual([]);
      expect(gh(w).made).toEqual([]);
    });
    it("needs a signature when only the local config has keys", async () => {
      const w = pworld();
      const r = await propose(w, ["acme@1.1.0"], {}, skillsConfig({ keys: [{ id: "k1", ed25519: k.pub }] }));
      expect(r.text).toContain("skills.releases.keys is set, so the entry needs --key");
      expect(pBranches(w)).toEqual([]);
    });
  });

  it("takes the release from --artifact and writes nothing to the store", async () => {
    const w = pworld();
    const art = makeRelease(join(P.root, "outside"), "1.2.0", ["alpha", "delta"]);
    const home = tree(P.store);
    const r = await propose(w, ["acme@1.2.0"], { artifact: art.root });
    expect(r.rc).toBe(0);
    expect(listStoredReleases(P.store).releases.map((x) => x.version)).not.toContain("1.2.0");
    expect(tree(P.store)).toEqual(home);
    const branch = "skill-catalogue/acme-1.2.0";
    expect(fileOnBranch(w, branch)).not.toContain(art.root);
    expect(pBodies(w)[URL99]!.body).not.toContain(art.root);
    expect(r.text).not.toContain(art.root);
  });

  it("asks for --artifact when the release is not in the store", async () => {
    const w = pworld();
    const r = await propose(w, ["acme@1.2.0"]);
    expect(r).toMatchObject({ rc: 1 });
    expect(r.text).toContain("give --artifact");
    expect(gh(w).calls).toEqual([]);
  });

  it("refuses a version that is not newer", async () => {
    const w = pworld(deployYaml({ approved: [{ version: "1.1.0", digest: P.d110 }] }));
    const r = await propose(w, ["acme@1.0.0"]);
    expect(r.text).toBe("PROBLEM acme@1.0.0 is not newer than the approved acme@1.1.0; nothing was proposed");
    expect(pBranches(w)).toEqual([]);
  });

  describe("the older release for the change report", () => {
    const yaml = () => deployYaml({ approved: [{ version: "0.9.0", digest: P.d090 }] });
    it("refuses when it is neither in the store nor named by an artifact", async () => {
      const w = pworld(yaml());
      const r = await propose(w, ["acme@1.1.0"]);
      expect(r.rc).toBe(1);
      expect(r.text).toContain("PROBLEM the change report against acme@0.9.0 cannot be built");
      expect(pBranches(w)).toEqual([]);
      expect(gh(w).made).toEqual([]);
    });
    it("reads it from the artifact of the local config, read-only", async () => {
      const w = pworld(yaml());
      const home = tree(P.store);
      const skills = skillsConfig({ approved: [{ catalogue: "acme", version: "0.9.0", digest: P.d090, artifact: P.art090 }] });
      const r = await propose(w, ["acme@1.1.0"], {}, skills);
      expect(r.rc).toBe(0);
      expect(pBodies(w)[URL99]!.body).toContain("`0.9.0` → `1.1.0`");
      expect(listStoredReleases(P.store).releases.map((x) => x.version)).not.toContain("0.9.0");
      expect(tree(P.store)).toEqual(home);
    });
  });

  it("writes a first-release report when the file has no acme entry", async () => {
    const w = pworld(deployYaml({ approved: [] }));
    const r = await propose(w, ["acme@1.1.0"]);
    expect(r.lines[0]).toBe("CHANGES acme@none -> 1.1.0: 4 changes");
    expect(pBodies(w)[URL99]!.body).toContain("first release `1.1.0`");
    expect(ConfigSchema.parse(parse(fileOnBranch(w, BRANCH))).skills.releases.approved).toHaveLength(1);
  });

  it("refuses a missing or invalid file on origin", async () => {
    const w = pworld();
    const r = await propose(w, ["acme@1.1.0"], {}, ConfigSchema.parse({ skills: { roots: [], releases: { deployment: { repository: "acme/deploy", file: "deploy/other.yaml" } } } }).skills);
    expect(r.text).toBe("PROBLEM deploy/other.yaml is not on origin/main; nothing was proposed");
    const bad = pworld("skills: {bogus: 1}\n");
    const r2 = await propose(bad, ["acme@1.1.0"]);
    expect(r2.rc).toBe(1);
    expect(r2.text).toContain(`PROBLEM ${FILE} on origin/main is not a valid config`);
    expect(pBranches(bad)).toEqual([]);
  });

  it("turns an unreadable or invalid local config into one fixed sentence", async () => {
    const path = CONFIG_PATH();
    mkdirSync(dirname(path), { recursive: true });
    try {
      for (const text of ["SECRET-CONFIG-LINE: [\n", "SECRET-CONFIG-LINE: 1\n"]) {
        writeFileSync(path, text);
        const w = pworld();
        const r = await propose(w, ["acme@1.1.0"], {}, null);
        expect(r).toMatchObject({ rc: 1, text: "PROBLEM the local config cannot be read or is not a valid config; nothing was proposed" });
        expect(gh(w).calls).toEqual([]);
        expect(pBranches(w)).toEqual([]);
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("checks the syntax before anything is read", async () => {
    const w = pworld();
    const sig = Buffer.alloc(64, 1).toString("base64");
    const cases: [string[], Record<string, unknown>][] = [
      [[], {}],
      [["acme"], {}],
      [["acme@1.1.0"], { key: "k1" }],
      [["acme@1.1.0"], { key: "k1", signature: "!!" }],
      [["acme@1.1.0"], { artifact: "relative/dir" }],
      [["acme@1.1.0"], { owner: "@x" }],
      [["acme@1.1.0"], { signature: sig }],
    ];
    for (const [pos, values] of cases) await expect(propose(w, pos, values), JSON.stringify([pos, values])).rejects.toThrow(PROPOSE_USAGE);
    expect(gh(w).calls).toEqual([]);
  });
});
