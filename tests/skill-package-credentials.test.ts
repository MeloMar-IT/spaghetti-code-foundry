import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillPackage, parseSkillPackage, SkillPackageError, type SkillEntry } from "../src/skills/package.js";
import { SKILL_LIMITS } from "../src/skills/schema.js";

// Test data is built from pieces so that tools/secret-scan finds nothing in this file.
const url = (scheme: string, rest: string) => scheme + "://" + rest;
const TOKEN_SLUG = "sk-" + "ant-" + "abcdefghij" + "0123456789";
const GH_TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const CONN = url("postgres", "user:" + "s3cretpw" + "@db.corp.net/x");

const enc = (s: string) => new TextEncoder().encode(s);
const MD = "---\nname: minimal\ndescription: A tiny example skill used only in tests.\n---\n\n# Minimal\n\nKeep changes small.\n";
const YAML = "id: minimal\nversion: 0.1.0\n";
const file = (path: string, text = "x"): SkillEntry => ({ path, content: enc(text) });
const base = (): SkillEntry[] => [file("SKILL.md", MD), file("skill.yaml", YAML)];
const withEntries = (...extra: SkillEntry[]) => [...base(), ...extra];
const replace = (path: string, text: string) => base().map((e) => (e.path === path ? file(path, text) : e));

function failure(fn: () => unknown): SkillPackageError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SkillPackageError);
    return e as SkillPackageError;
  }
  throw new Error("expected an error");
}
const fail = (entries: readonly SkillEntry[], dirName?: string) => failure(() => parseSkillPackage(entries, "src", dirName));
const issues = (entries: readonly SkillEntry[], dirName?: string) => fail(entries, dirName).issues;
const has = (list: { path: string; reason: string }[], path: string, reason: string) =>
  expect(list.some((i) => i.path === path && i.reason.includes(reason)), JSON.stringify(list)).toBe(true);
/** The error holds exactly this one issue and none of the secrets. */
function only(entries: readonly SkillEntry[], path: string, reason: string, dirName?: string) {
  const err = fail(entries, dirName);
  expect(err.issues, JSON.stringify(err.issues)).toHaveLength(1);
  expect(err.issues[0]!.path).toBe(path);
  expect(err.issues[0]!.reason).toContain(reason);
  noSecret(err);
}
function noSecret(err: SkillPackageError) {
  const all = err.message + JSON.stringify(err.issues);
  for (const s of [TOKEN_SLUG, GH_TOKEN, AWS_KEY, "s3cretpw", "abcdefghij"]) expect(all).not.toContain(s);
}
const FOUND = (rule: string) => `holds what looks like a credential or a live endpoint (${rule}); use a placeholder`;

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "skillcred-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseSkillPackage: connectors", () => {
  const yaml = (extra: string) => replace("skill.yaml", YAML + extra);
  it("loads sorted connectors with a risk of medium", () => {
    expect(parseSkillPackage(yaml("risk: medium\nconnectors: [oracle, kafka]\n")).connectors).toEqual(["kafka", "oracle"]);
  });
  it("needs a risk of medium or high", () => {
    has(issues(yaml("connectors: [oracle]\n")), "skill.yaml: risk", "must be medium or high when the package names connectors");
  });
  it("accepts slugs only", () => {
    has(issues(yaml('risk: medium\nconnectors: ["kafka://broker:9092"]\n')), "skill.yaml: connectors.0", "");
  });
  it("refuses a live endpoint as a connector", () => {
    only(yaml('risk: medium\nconnectors: ["kafka://x.corp:9092"]\n'), "skill.yaml", "(connection endpoint)");
  });
  it("keeps endpoint and credential as unknown keys", () => {
    has(issues(yaml("endpoint: x\n")), "skill.yaml: endpoint", "unknown key");
    has(issues(yaml("credential: x\n")), "skill.yaml: credential", "unknown key");
  });
  it("reports duplicates and too many", () => {
    has(issues(yaml("risk: medium\nconnectors: [a, a]\n")), "skill.yaml: connectors.1", "");
    const many = Array.from({ length: 17 }, (_, i) => `c${i}`).join(", ");
    has(issues(yaml(`risk: medium\nconnectors: [${many}]\n`)), "skill.yaml: connectors", "");
  });
});

describe("parseSkillPackage: file content", () => {
  it("refuses a credential in a file", () => {
    only(withEntries(file("references/a.md", "token " + GH_TOKEN)), "references/a.md", FOUND("GitHub token"));
  });
  it("refuses a live endpoint in SKILL.md", () => {
    only(replace("SKILL.md", MD + "\nUse kafka://kafka-prod-01.corp.net:9092 here.\n"), "SKILL.md", "(connection endpoint)");
  });
  it("sees a key inside a binary file", () => {
    only(withEntries({ path: "assets/blob.bin", content: Uint8Array.of(0xff, 0xfe, ...enc(AWS_KEY)) }), "assets/blob.bin", "(AWS access key)");
  });
  it("scans a file that another check refuses", () => {
    only(withEntries(file("notes.txt", GH_TOKEN)), "notes.txt", "(GitHub token)");
    only([...withEntries(file("references/a.md")), file("references/A.md", GH_TOKEN)], "references/A.md", "(GitHub token)");
  });
  it("reports only the finding, not entry or parse problems", () => {
    const hit = file("references/a.md", GH_TOKEN);
    only(withEntries(hit, file("notes.txt")), "references/a.md", "(GitHub token)");
    only(withEntries(hit, { path: "assets/b", size: -1 }), "references/a.md", "(GitHub token)");
    only([...replace("skill.yaml", YAML + "bogus: 1\n"), hit], "references/a.md", "(GitHub token)");
  });
  it("loads a package with all the placeholders", () => {
    const text = [
      "kafka://<broker>:9092",
      "redis://${REDIS_HOST}:6379",
      "amqp://mq.example.com",
      "kafka://localhost:9092",
      "mysql://db/app",
      url("postgres", "user:<password>@localhost/app"),
      "jdbc:oracle:thin:<user>/<password>@//<host>:1521/<service>",
    ].join("\n");
    expect(parseSkillPackage(withEntries(file("references/ok.md", text))).id).toBe("minimal");
  });
});

describe("parseSkillPackage: file and folder names", () => {
  it("refuses credential files by name, also at the top", () => {
    const reason = "is a credential file by its name; a skill must not hold credentials";
    only(withEntries(file("scripts/.env")), "scripts/.env", reason);
    only(withEntries(file("assets/server.pem")), "assets/server.pem", reason);
    only(withEntries(file(".env")), ".env", reason);
    only(withEntries(file("config/.env")), "config/.env", reason);
  });
  it("accepts an example file and a folder with a key-like name", () => {
    expect(parseSkillPackage(withEntries(file("references/key.pem.example"))).id).toBe("minimal");
    expect(parseSkillPackage(withEntries({ path: "assets/keys.pem", kind: "directory" })).id).toBe("minimal");
  });
  it("never prints a file name that looks like a credential", () => {
    const reason = "a file name looks like a credential (GitHub token)";
    only(withEntries(file(`references/${GH_TOKEN}.md`)), "(package)", reason);
    only(withEntries(file(`references/${GH_TOKEN}.md`), file(`assets/${GH_TOKEN}.txt`)), "(package)", reason);
    const p = `references/${GH_TOKEN}.md`;
    only(withEntries(file(p), file(p)), "(package)", reason);
    only(withEntries(file(p), { path: p, size: SKILL_LIMITS.fileBytes + 1 }), "(package)", reason);
  });
  it("never prints a folder name that looks like a credential", () => {
    only(base(), "(package)", "the folder name looks like a credential (Anthropic key)", TOKEN_SLUG);
    const err = failure(() => parseSkillPackage(base(), "/x/" + TOKEN_SLUG, TOKEN_SLUG));
    expect(err.message.startsWith("(package): invalid skill package")).toBe(true);
    noSecret(err);
  });
});

describe("parseSkillPackage: nothing is parsed after a hit", () => {
  it.each([
    ["an unknown key in skill.yaml", () => replace("skill.yaml", YAML + `${TOKEN_SLUG}: 1\n`), "skill.yaml"],
    ["duplicate capabilities", () => replace("skill.yaml", YAML + `capabilities: [${TOKEN_SLUG}, ${TOKEN_SLUG}]\n`), "skill.yaml"],
    ["an id that differs from the name", () => replace("skill.yaml", `id: ${TOKEN_SLUG}\nversion: 0.1.0\n`), "skill.yaml"],
    [
      "equal detectors",
      () => {
        const d = { type: "content", glob: "*.md", contains: CONN };
        return replace("skill.yaml", YAML + `detectors: ${JSON.stringify([d, d])}\n`);
      },
      "skill.yaml",
    ],
    ["an unknown frontmatter key", () => replace("SKILL.md", MD.replace("---\n\n#", `${TOKEN_SLUG}: x\n---\n\n#`)), "SKILL.md"],
  ])("%s", (_name, entries, path) => {
    const err = fail(entries());
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]!.path).toBe(path);
    noSecret(err);
  });
});

describe("parseSkillPackage: scan budget", () => {
  const big = () => Array.from({ length: 8 }, (_, i) => ({ path: `references/big${i}.bin`, content: new Uint8Array(SKILL_LIMITS.fileBytes) }));
  const bad = replace("skill.yaml", YAML + "bogus: 1\n");
  it("refuses a package over its total size without parsing it", () => {
    const list = issues([...bad, ...big(), file("references/z.md", GH_TOKEN)]);
    has(list, "(package)", "package is larger");
    expect(list.some((i) => i.path.startsWith("skill.yaml"))).toBe(false);
    expect(JSON.stringify(list)).not.toContain(GH_TOKEN);
  });
  it("still reports a finding that was scanned before the budget ran out", () => {
    only([...bad, file("references/a.md", GH_TOKEN), ...big()], "references/a.md", "(GitHub token)");
  });
});

describe("loadSkillPackage: credentials", () => {
  function make(name = "minimal") {
    const dir = join(tmp(), name);
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), MD);
    writeFileSync(join(dir, "skill.yaml"), YAML);
    return dir;
  }
  it("refuses a live endpoint in a file", () => {
    const dir = make();
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "conn.md"), "amqps://mq.acme.io:5671");
    has(failure(() => loadSkillPackage(dir)).issues, "references/conn.md", "connection endpoint");
  });
  it("does not print a folder name that looks like a credential", () => {
    const err = failure(() => loadSkillPackage(make(TOKEN_SLUG)));
    expect(err.issues).toEqual([{ path: "(package)", reason: "the folder name looks like a credential (Anthropic key)" }]);
    noSecret(err);
  });
});
