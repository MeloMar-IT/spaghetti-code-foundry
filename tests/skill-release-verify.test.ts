import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { MAX_VERIFY_BYTES, verifyRelease } from "../src/skills/release-verify.js";
import { RELEASE_FILE, type ReleaseRead } from "../src/skills/release.js";
import { skillsCommand } from "../src/skills/cli.js";
import { writeV2Release } from "./helpers/skill-release-v2.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillver-")));
  tmps.push(d);
  return d;
};
function pkg(root: string, id: string, body = "Do it."): void {
  const d = join(root, id);
  mkdirSync(join(d, "references"), { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\n${body}\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: 1.0.0\n`);
  writeFileSync(join(d, "references", "notes.md"), "Some notes.\n");
}
const ATTR = { a: { "LICENSE.txt": "MIT licence text\n", "docs/NOTICE": "notice\n" } };
function good(opts: Parameters<typeof writeV2Release>[1] = { attribution: ATTR }) {
  const root = tmp();
  pkg(root, "a");
  pkg(root, "b");
  const rel = writeV2Release(root, opts);
  return { root, ...rel };
}
const reason = (root: string) => {
  const v = verifyRelease(root);
  return v.ok ? undefined : v.reason;
};

describe("verifyRelease", () => {
  it("verifies a good release, whatever the verdict, with .DS_Store files", () => {
    for (const verdict of ["passed", "failed", "not-run"] as const) {
      const { root, approved } = good({ verdict, attribution: ATTR });
      for (const p of [join(root, ".DS_Store"), join(root, "a", ".DS_Store"), join(root, "a", "references", ".DS_Store"), join(root, ".attribution", ".DS_Store"), join(root, ".attribution", "a", ".DS_Store")]) writeFileSync(p, "x");
      const v = verifyRelease(root);
      expect(v).toMatchObject({ ok: true, digest: approved.digest });
    }
  });

  it("follows the folder the operator names, once", () => {
    const { root } = good();
    const link = join(tmp(), "current");
    symlinkSync(root, link);
    expect(verifyRelease(link).ok).toBe(true);
  });

  const pkgFile = (r: string) => join(r, "a", "references", "notes.md");
  const attrFile = (r: string) => join(r, ".attribution", "a", "LICENSE.txt");
  it.each([
    ["change one byte of a package file", (r: string) => writeFileSync(pkgFile(r), "Some notes!\n")],
    ["add one byte to a package file", (r: string) => appendFileSync(pkgFile(r), "x")],
    ["remove one byte of a package file", (r: string) => truncateSync(pkgFile(r), 11)],
    ["change one byte of an attribution file", (r: string) => writeFileSync(attrFile(r), "MIT licence text!\n")],
    ["add one byte to an attribution file", (r: string) => appendFileSync(attrFile(r), "x")],
    ["remove one byte of an attribution file", (r: string) => truncateSync(attrFile(r), 16)],
    ["an unlisted file in a package", (r: string) => writeFileSync(join(r, "a", "extra.md"), "x")],
    ["an unlisted file in .attribution", (r: string) => writeFileSync(join(r, ".attribution", "a", "extra"), "x")],
    ["an unlisted file for another id in .attribution", (r: string) => (mkdirSync(join(r, ".attribution", "zz")), writeFileSync(join(r, ".attribution", "zz", "x"), "x"))],
    ["an extra file at the root", (r: string) => writeFileSync(join(r, "README.md"), "x")],
    ["a missing listed file", (r: string) => unlinkSync(pkgFile(r))],
    ["a missing attribution file", (r: string) => unlinkSync(attrFile(r))],
    ["a file link in a package", (r: string) => (unlinkSync(pkgFile(r)), symlinkSync(join(r, "a", "SKILL.md"), pkgFile(r)))],
    ["a folder link in a package", (r: string) => symlinkSync(tmp(), join(r, "a", "linked"))],
    ["the package folder is a link", (r: string) => (rmSync(join(r, "b"), { recursive: true }), symlinkSync(tmp(), join(r, "b")))],
    ["a link in .attribution", (r: string) => (rmSync(join(r, ".attribution"), { recursive: true }), symlinkSync(tmp(), join(r, ".attribution")))],
    ["a folder link inside .attribution/<id>", (r: string) => symlinkSync(tmp(), join(r, ".attribution", "a", "linked"))],
  ])("refuses: %s", (_name, mutate) => {
    const { root } = good();
    mutate(root);
    const why = reason(root);
    expect(why).toBeTruthy();
    expect(why).not.toContain(root);
    expect(why).not.toContain("notes.md");
    expect(why).not.toContain("LICENSE");
  });

  it("rejects a linked attribution folder before it reads a file through it", () => {
    const { root } = good();
    const a = join(root, ".attribution", "a");
    renameSync(join(a, "docs"), join(a, "real-docs"));
    symlinkSync(join(a, "real-docs"), join(a, "docs"));
    // The listed file is readable through the link with the right bytes: only the walk can refuse it.
    expect(readFileSync(join(a, "docs", "NOTICE"), "utf8")).toBe("notice\n");
    expect(reason(root)).toBe("skill a: attribution holds a link");
  });

  it("refuses a manifest with an edited file digest or a wrong package digest", () => {
    const { root } = good();
    const original = readFileSync(join(root, RELEASE_FILE), "utf8");
    const edit = (f: (m: any) => void) => {
      const m = JSON.parse(original);
      f(m);
      writeFileSync(join(root, RELEASE_FILE), JSON.stringify(m));
      return reason(root);
    };
    expect(edit((m) => (m.skills[0].files[0].sha256 = "0".repeat(64)))).toMatch(/another SHA-256/);
    expect(edit((m) => (m.skills[1].digest = "sha256:" + "0".repeat(64)))).toMatch(/package digest/);
  });

  it("limits folders and depth of .attribution", () => {
    const many = good();
    for (let i = 0; i < 1001; i++) mkdirSync(join(many.root, ".attribution", "a", `d${i}`));
    expect(reason(many.root)).toMatch(/too many folders/);
    const deep = good();
    mkdirSync(join(deep.root, ".attribution", "a", "1", "2", "3", "4", "5", "6", "7"), { recursive: true });
    expect(reason(deep.root)).toMatch(/too deep/);
  });

  it("refuses a release that lists more than 64 MiB before it reads any file", () => {
    const { root, manifest } = good();
    const big = structuredClone(manifest);
    for (const s of big.skills) s.files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, sha256: "0".repeat(64), bytes: 262144 }));
    const n = Math.ceil(MAX_VERIFY_BYTES / (5 * 262144)) + 1;
    expect(n).toBeGreaterThan(2);
    const skills = Array.from({ length: n }, (_, i) => ({ ...big.skills[0]!, id: `s${i}`, files: big.skills[0]!.files }));
    const read: ReleaseRead = { state: "ok", manifest: { ...big, skills }, digest: "sha256:" + "0".repeat(64) };
    expect(verifyRelease(join(root, "nowhere"), read)).toEqual({ ok: false, reason: "the release lists more than 64 MiB" });
  });

  it("gives a reason for no manifest, an invalid one and schema 1", () => {
    const root = tmp();
    expect(reason(root)).toContain("no catalogue-release.json");
    writeFileSync(join(root, RELEASE_FILE), "{");
    expect(reason(root)).toContain("not valid JSON");
    writeFileSync(
      join(root, RELEASE_FILE),
      JSON.stringify({ schema: 1, catalogue: "c", version: "1.0.0", createdAt: "2026-01-02T03:04:05Z", source: { repository: "github.com/a/b", commit: "a".repeat(40) }, skills: [{ id: "a", version: "1.0.0", digest: "sha256:" + "a".repeat(64) }] }),
    );
    expect(reason(root)).toContain("schema 1");
  });

  it("names no path, file name or content in a reason", () => {
    const root = tmp();
    pkg(root, "a");
    writeFileSync(join(root, "a", "references", "distinctive-name.md"), "distinctive content");
    writeV2Release(root);
    writeFileSync(join(root, "a", "references", "distinctive-name.md"), "other distinctive content");
    const why = reason(root)!;
    expect(why).toBeTruthy();
    for (const s of [root, "distinctive"]) expect(why).not.toContain(s);
  });
});

describe("scf skills release verify", () => {
  const run = async (positionals: string[], skills = ConfigSchema.parse({}).skills, values: Record<string, unknown> = {}) => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals, values }, (l) => lines.push(l), { skills });
    return { code, lines };
  };
  const cfg = (approved: unknown[]) => ConfigSchema.parse({ skills: { releases: { approved } } }).skills;

  it("prints VERIFIED and APPROVED", async () => {
    const { root, approved } = good();
    const r = await run(["release", "verify", root], cfg([approved]));
    expect(r.code).toBe(0);
    expect(r.lines.at(-2)).toBe(`VERIFIED acme-skills@1.0.0 ${approved.digest} 2 skills`);
    expect(r.lines.at(-1)).toBe("APPROVED");
    expect(r.lines[0]).toMatch(/^SKILL a@1\.0\.0 sha256:[0-9a-f]{64} evaluation passed$/);
  });

  it("prints NOT-APPROVED with exit 0 when the release is not approved", async () => {
    const { root } = good();
    const r = await run(["release", "verify", root]);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toBe("NOT-APPROVED");
  });

  it("shows the verdict and the revocation", async () => {
    const { root } = good({ verdict: "failed", revoked: { b: { on: "2026-02-03", reason: "bad advice" } } });
    const r = await run(["release", "verify", root]);
    expect(r.lines.slice(0, 2)).toEqual([expect.stringMatching(/ a@1\.0\.0 .* evaluation failed$/), expect.stringMatching(/ b@1\.0\.0 .* evaluation failed REVOKED 2026-02-03: bad advice$/)]);
  });

  it("prints PROBLEM and exits 1", async () => {
    const { root } = good();
    appendFileSync(join(root, "a", "SKILL.md"), "x");
    const r = await run(["release", "verify", root]);
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^PROBLEM skill a: /);
  });

  it("refuses wrong operands and options", async () => {
    await expect(run(["release"])).rejects.toThrow(/expects "verify" and one folder/);
    await expect(run(["release", "verify"])).rejects.toThrow(/one folder/);
    await expect(run(["release", "verify", "a", "b"])).rejects.toThrow(/one folder/);
    await expect(run(["release", "check", "a"])).rejects.toThrow(/one folder/);
    await expect(run(["release", "verify", "a"], undefined, { repo: "x" })).rejects.toThrow(/unexpected option --repo/);
  });
});
