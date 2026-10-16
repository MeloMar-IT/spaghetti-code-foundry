import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigSchema } from "../src/config.js";
import { appendApprovedEntry, checkApprovedEdit, normalRepository, releaseBranch, releasePullRequest, type DeploymentEntry } from "../src/skills/release-deployment.js";
import type { CatalogueChanges } from "../src/skills/release-changes.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const entry: DeploymentEntry = { catalogue: "acme", version: "1.1.0", digest: D("b") };
const old = `  - catalogue: acme\n    version: 1.0.0\n    digest: ${D("a")}`;

/** Appends, checks and proves that the text before the insertion and after it is untouched. */
function appended(before: string, e: DeploymentEntry = entry): string {
  const r = appendApprovedEntry(before, e);
  if ("problem" in r) throw new Error(r.problem);
  const c = checkApprovedEdit(before, r.text, e);
  if (!("ok" in c)) throw new Error(c.problem);
  // one insertion: the old text is a prefix plus a suffix of the new one
  let p = 0;
  while (before[p] === r.text[p]) p++;
  expect(r.text.endsWith(before.slice(p))).toBe(true);
  return r.text;
}
const approvedOf = (text: string) => ConfigSchema.parse(parse(text)).skills.releases.approved;

describe("appendApprovedEntry", () => {
  it("appends after the last item of a block list and keeps the comments", () => {
    const before = `# top\nskills:\n  releases:\n    # list\n    approved:\n${old.replace(/^  /gm, "      ")} # first\n      # between\n    keys: []\n# end\n`;
    const after = appended(before);
    expect(after).toContain(`digest: ${D("a")} # first\n      - catalogue: acme\n        version: 1.1.0\n        digest: ${D("b")}\n      # between\n`);
    expect(approvedOf(after).map((a) => a.version)).toEqual(["1.0.0", "1.1.0"]);
  });
  it("keeps a trailing comment after the last entry", () => {
    const before = `skills:\n  releases:\n    approved:\n${old.replace(/^  /gm, "      ")}\n# trailing\n`;
    const after = appended(before);
    expect(after.endsWith(`digest: ${D("b")}\n# trailing\n`)).toBe(true);
  });
  it("uses the column of the dash when the items are not indented", () => {
    const before = `skills:\n  releases:\n    approved:\n    - catalogue: acme\n      version: 1.0.0\n      digest: ${D("a")}\n`;
    expect(appended(before)).toContain(`\n    - catalogue: acme\n      version: 1.1.0\n`);
  });
  it("inserts after a last entry that ends with a block scalar, before the next setting", () => {
    for (const style of ["|-", ">-"]) {
      const before = `skills:\n  releases:\n    approved:\n      - catalogue: acme\n        version: 1.0.0\n        digest: ${D("a")}\n        artifact: ${style}\n          /tmp/art\n    keys: []\n`;
      const after = appended(before);
      expect(after).toContain(`/tmp/art\n      - catalogue: acme\n        version: 1.1.0\n        digest: ${D("b")}\n    keys: []\n`);
      expect(approvedOf(after).map((a) => a.version)).toEqual(["1.0.0", "1.1.0"]);
    }
  });
  it("handles flow lists, empty and not", () => {
    expect(approvedOf(appended("skills:\n  releases:\n    approved: []\n"))).toHaveLength(1);
    const two = appended(`skills:\n  releases:\n    approved: [{catalogue: acme, version: 1.0.0, digest: "${D("a")}"}]\n`);
    expect(approvedOf(two).map((a) => a.version)).toEqual(["1.0.0", "1.1.0"]);
  });
  it("creates the missing keys of the path", () => {
    expect(approvedOf(appended("skills:\n  releases:\n    allow_unreleased: false\n"))).toHaveLength(1);
    expect(approvedOf(appended("skills:\n  builtin: true\n"))).toHaveLength(1);
    expect(approvedOf(appended("default_model: x\n# c\n"))).toHaveLength(1);
    expect(appended("default_model: x")).toContain("default_model: x\nskills:\n");
  });
  it("makes a file of an empty or comment-only text", () => {
    expect(approvedOf(appended(""))).toHaveLength(1);
    expect(appended("# only a comment\n").startsWith("# only a comment\nskills:")).toBe(true);
    expect(approvedOf(appended("# no newline"))).toHaveLength(1);
  });
  it("writes key and signature last, in order", () => {
    const sig = Buffer.alloc(64, 1).toString("base64");
    const e = { ...entry, key: "k1", signature: sig };
    const after = appendApprovedEntry("skills:\n  releases:\n    approved: []\n", e);
    expect("text" in after && after.text).toContain(`{"catalogue":"acme","version":"1.1.0","digest":"${D("b")}","key":"k1","signature":"${sig}"}`);
    const block = appendApprovedEntry(`skills:\n  releases:\n    approved:\n${old.replace(/^  /gm, "      ")}\n`, e);
    expect("text" in block && block.text.split("\n").slice(-6, -1).map((l) => l.trim().split(":")[0])).toEqual(["- catalogue", "version", "digest", "key", "signature"]);
  });
  it("refuses forms it cannot edit byte for byte", () => {
    for (const t of ["skills: {releases: {approved: []}}\n", "skills:\n  releases:\n    approved:\n", "- a\n- b\n", "skills: [\n", "a: 1\n---\nb: 2\n", "skills:\n  releases: {}\n"]) {
      expect(appendApprovedEntry(t, entry), t).toEqual({ problem: "the deployment file has a form this command cannot edit byte for byte" });
    }
  });
});

describe("checkApprovedEdit", () => {
  const before = `skills:\n  releases:\n    approved:\n${old.replace(/^  /gm, "      ")}\n`;
  const good = appendApprovedEntry(before, entry) as { text: string };
  it("accepts the edit and returns the config", () => {
    const c = checkApprovedEdit(before, good.text, entry);
    expect("ok" in c && c.config.skills.releases.approved).toHaveLength(2);
  });
  it("refuses a change of another setting", () => {
    const c = checkApprovedEdit(before, good.text + "default_model: x\n", entry);
    expect(c).toEqual({ problem: "the edit would change another setting of the deployment file" });
  });
  it("refuses a removed entry or a re-formatted file", () => {
    expect(checkApprovedEdit(before, good.text.replace("1.0.0", "1.0.1"), entry)).toEqual({ problem: "the edit would change other bytes of the deployment file" });
    expect(checkApprovedEdit(before, good.text.replace(/\n    /g, "\n   "), entry)).toEqual({ problem: "the edit would change other bytes of the deployment file" });
  });
  it("refuses 51 entries", () => {
    const entries = Array.from({ length: 50 }, (_, i) => `{catalogue: c${i}, version: 1.0.0, digest: "${D("a")}"}`).join(", ");
    const b = `skills:\n  releases:\n    approved: [${entries}]\n`;
    const r = appendApprovedEntry(b, entry) as { text: string };
    const c = checkApprovedEdit(b, r.text, entry);
    expect("problem" in c && c.problem).toMatch(/^the edited deployment file is not a valid config: skills\.releases\.approved/);
  });
  it("refuses a key that is not in keys, and invalid YAML", () => {
    const e = { ...entry, key: "k1", signature: Buffer.alloc(64, 1).toString("base64") };
    const r = appendApprovedEntry(before, e) as { text: string };
    const c = checkApprovedEdit(before, r.text, e);
    expect("problem" in c && c.problem).toContain("is not in skills.releases.keys");
    expect(checkApprovedEdit("a: 1\n", "a: 1\nb: [\n", entry)).toEqual({ problem: "the edited deployment file is not valid YAML" });
  });
});

describe("names", () => {
  it("builds the branch", () => expect(releaseBranch("acme", "1.2.0-rc.1")).toBe("skill-catalogue/acme-1.2.0-rc.1"));
  it("compares repositories", () => {
    expect(normalRepository("github.com/Acme/Deploy")).toBe("acme/deploy");
    expect(normalRepository("ghe.example.com/a/b")).toBe("ghe.example.com/a/b");
  });
});

const sk = (id: string) => ({ id, version: "1.0.0", digest: D("c") });
const changes = (o: Partial<CatalogueChanges> = {}): CatalogueChanges => ({
  catalogue: "acme", from: { version: "1.0.0" }, to: { version: "1.1.0" }, added: [sk("new")], removed: [], changed: [], deprecated: [{ ...sk("old"), on: "2026-03-01", reason: "R", alreadyRevoked: false }], canonical: [], ...o,
});

describe("releasePullRequest", () => {
  it("states the header and the sections", () => {
    const pr = releasePullRequest({ file: "deploy/config.yaml", entry, signedBy: "k1", previous: { version: "1.0.0", digest: D("a") }, changes: changes() });
    expect(pr.title).toBe("Skill catalogue acme: approve 1.1.0");
    for (const t of ["`acme` `1.1.0`", `Digest: \`${D("b")}\``, "Signed by: `k1`", `\`1.0.0\` (\`${D("a")}\`)`, "File: `deploy/config.yaml`", "### Added", "### Deprecated", "scf skills release adopt acme@1.1.0"]) expect(pr.body).toContain(t);
  });
  it("says first release and not signed", () => {
    const pr = releasePullRequest({ file: "c.yaml", entry, changes: changes({ from: undefined }) });
    expect(pr.body).toContain("first release `1.1.0`");
    expect(pr.body).toContain("Signed by: not signed");
    expect(pr.body).toContain("Previous approved version: none");
  });
  it("escapes backticks and comment starts", () => {
    const pr = releasePullRequest({ file: "a`<!--b.yaml", entry, changes: changes() });
    expect(pr.body).not.toContain("<!--");
    expect(pr.body).toContain("a'<!- -b.yaml");
  });
  it("stays within 64 000 bytes with 500 added skills", () => {
    const added = Array.from({ length: 500 }, (_, i) => sk(`skill-${i}`));
    const pr = releasePullRequest({ file: "c.yaml", entry, previous: { version: "1.0.0", digest: D("a") }, changes: changes({ added }) });
    expect(Buffer.byteLength(pr.body)).toBeLessThanOrEqual(64_000);
  });
});

describe("skills.releases.deployment in ConfigSchema", () => {
  const parse = (d: unknown) => ConfigSchema.safeParse({ skills: { releases: { deployment: d } } }).success;
  it("accepts good values", () => {
    expect(parse({ repository: "acme/deploy", file: "deploy/config.yaml" })).toBe(true);
    expect(parse({ repository: "ghe.example.com/acme/deploy", file: "deploy/config.yml" })).toBe(true);
  });
  it("refuses bad values", () => {
    for (const d of [{ repository: "acme/deploy", file: "../x.yaml" }, { repository: "acme/deploy", file: "/abs.yaml" }, { repository: "acme/deploy", file: "x.json" }, { repository: "a b/c", file: "x.yaml" }, { repository: "acme/deploy" }, { repository: "acme/deploy", file: "x.yaml", more: 1 }, { repository: "deploy", file: "x.yaml" }]) {
      expect(parse(d), JSON.stringify(d)).toBe(false);
    }
  });
});
