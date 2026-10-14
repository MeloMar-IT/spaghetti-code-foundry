import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseSkillSelections, readSkillSelections, selectionConnectors, type SkillSelection } from "../src/skills/selections.js";

const TODAY = "2026-10-13";
const DIGEST = "sha256:" + "a".repeat(64);
// Built from pieces: tools/secret-scan reads this file too.
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);

const valid = (o: Record<string, unknown> = {}): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries({
      source: "microsoft-skills", skill: "azure-cosmos-py", digest: DIGEST, scope: "provider", provider: "azure",
      product: { name: "azure-cosmos-db", version: "2024-11" },
      sdk: { name: "azure-cosmos", language: "python", version: ">=4.7" },
      category: "database", capabilities: ["cosmos-db"],
      requires: { clis: ["az"], mcp: ["azure"], credentials: ["azure-identity"], services: ["azure-cosmos-db"] },
      owner: "@octocat", reviewed: "2026-10-13", ...o,
    }).filter(([, v]) => v !== undefined),
  );
const portable = (o: Record<string, unknown> = {}) => valid({ scope: "portable", provider: undefined, product: undefined, sdk: undefined, requires: undefined, ...o });
const file = (...entries: unknown[]) => ({ schema: 1, selections: entries });
const text = (p: { where: string; message: string }[]) => p.map((x) => `${x.where}: ${x.message}`).join("\n");
const refuse = (entry: unknown) => text(parseSkillSelections(file(entry), TODAY).problems);

describe("parseSkillSelections", () => {
  it("accepts the example and fills all four requires lists", () => {
    const r = parseSkillSelections(file(valid(), portable({ skill: "plain" })), TODAY);
    expect(r.problems).toEqual([]);
    expect(Object.keys(r.manifest!.selections[0]!).sort()).toEqual(
      ["capabilities", "category", "digest", "owner", "product", "provider", "requires", "reviewed", "scope", "sdk", "skill", "source"],
    );
    expect(r.manifest!.selections[1]!.requires).toEqual({ clis: [], mcp: [], credentials: [], services: [] });
    expect(r.manifest!.selections[1]!.provider).toBeUndefined();
  });
  it("accepts a portable entry with product and sdk, and an empty file", () => {
    const sdk = { name: "@azure/cosmos", language: "js", version: "[4.7,5)" };
    expect(parseSkillSelections(file(portable({ product: { name: "p", version: "1" }, sdk })), TODAY).problems).toEqual([]);
    expect(parseSkillSelections(file(), TODAY).manifest!.selections).toEqual([]);
  });
  it("accepts the boundaries", () => {
    const names = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const sdk = { name: "x", language: "go", version: "v".repeat(64) };
    const r = parseSkillSelections(file(valid({ sdk, reviewed: TODAY, requires: { clis: names(8, "a"), mcp: names(8, "b") } })), TODAY);
    expect(r.problems).toEqual([]);
  });
  it("accepts 500 distinct entries and refuses 501", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => valid({ skill: `skill-${i}` }));
    expect(parseSkillSelections(file(...many(500)), TODAY).problems).toEqual([]);
    expect(text(parseSkillSelections(file(...many(501)), TODAY).problems)).toContain("selections: must hold at most 500 selections");
  });
  it("accepts the same skill under another source", () => {
    expect(parseSkillSelections(file(valid(), valid({ source: "other" })), TODAY).problems).toEqual([]);
  });

  const long = (n: number) => "a".repeat(n);
  const sdkWith = (version: unknown) => valid({ sdk: { name: "x", language: "go", version } });
  const missing = ["source", "skill", "digest", "scope", "category", "capabilities", "owner", "reviewed"];
  const cases: [string, Record<string, unknown>, string][] = [
    ...missing.map((k): [string, Record<string, unknown>, string] => [`missing ${k}`, valid({ [k]: undefined }), `${k}: is required`]),
    ["scope", valid({ scope: "cloud" }), "scope: must be"],
    ["provider needed", valid({ provider: undefined }), "provider: is required for scope provider"],
    ["product needed", valid({ product: undefined }), "product: is required"],
    ["sdk needed", valid({ sdk: undefined }), "sdk: is required"],
    ["portable with provider", portable({ provider: "azure" }), "provider: is not allowed for scope portable"],
    ["upper source", valid({ source: "Src" }), "source: must be a lower-case slug"],
    ["upper skill", valid({ skill: "Skill" }), "skill: must be a lower-case slug"],
    ["upper provider", valid({ provider: "Azure" }), "provider: must be a lower-case slug"],
    ["upper category", valid({ category: "Db" }), "category: must be a lower-case slug"],
    ["bad capability", valid({ capabilities: ["ok", "Bad"] }), "capabilities[1]: must be a lower-case slug"],
    ["duplicate capability", valid({ capabilities: ["a", "a"] }), 'capabilities[1]: "a" is listed twice'],
    ["empty capabilities", valid({ capabilities: [] }), "capabilities: must hold 1 to 32 names"],
    ["33 capabilities", valid({ capabilities: Array.from({ length: 33 }, (_, i) => `c${i}`) }), "capabilities: must hold 1 to 32 names"],
    ["bad digest", valid({ digest: "sha256:abc" }), "digest: must be a package digest"],
    ["bad owner", valid({ owner: "octocat" }), "owner: must be a GitHub user"],
    ["bad date", valid({ reviewed: "2026-02-30" }), "reviewed: must be a date"],
    ["numeric date", valid({ reviewed: 20261001 }), "reviewed: must be text; put it in quotes"],
    ["future date", valid({ reviewed: "2026-10-14" }), "reviewed: must not be in the future"],
    ["product not a map", valid({ product: "x" }), "product: must be a map"],
    ["product no name", valid({ product: { version: "1" } }), "product.name: is required"],
    ["product no version", valid({ product: { name: "x" } }), "product.version: is required"],
    ["sdk no name", valid({ sdk: { language: "go", version: "1" } }), "sdk.name: is required"],
    ["sdk no language", valid({ sdk: { name: "x", version: "1" } }), "sdk.language: is required"],
    ["sdk no version", valid({ sdk: { name: "x", language: "go" } }), "sdk.version: is required"],
    ["numeric version", sdkWith(4.7), "sdk.version: must be text; put it in quotes"],
    ["blank version", sdkWith("  "), "sdk.version: must be text of 1 to 64"],
    ["long version", sdkWith(long(65)), "sdk.version: must be text of 1 to 64"],
    ["wildcard version", sdkWith("4.*"), "sdk.version: wildcards are not allowed"],
    ["sdk name space", valid({ sdk: { name: "a b", language: "go", version: "1" } }), "sdk.name: must be a package name"],
    ["unknown entry key", valid({ extra: 1 }), 'unknown key "extra"'],
    ["unknown product key", valid({ product: { name: "x", version: "1", x: 1 } }), 'product: unknown key "x"'],
    ["unknown sdk key", valid({ sdk: { name: "x", language: "go", version: "1", x: 1 } }), 'sdk: unknown key "x"'],
    ["unknown requires key", valid({ requires: { tools: [] } }), 'requires: unknown key "tools"'],
    ["requires list", valid({ requires: { clis: "az" } }), "requires.clis: must be a list"],
    ["requires slug", valid({ requires: { clis: ["AZ"] } }), "requires.clis[0]: must be a lower-case slug"],
    ["duplicate name", valid({ requires: { clis: ["az", "az"] } }), 'requires.clis[1]: "az" is already listed in requires.clis[0]'],
    ["name in two lists", valid({ requires: { clis: ["az"], mcp: ["az"] } }), 'requires.mcp[0]: "az" is already listed in requires.clis[0]'],
    [
      "17 names",
      valid({ requires: { clis: Array.from({ length: 9 }, (_, i) => `a${i}`), mcp: Array.from({ length: 8 }, (_, i) => `b${i}`) } }),
      "requires: must hold at most 16 names in total",
    ],
    ["long credential", valid({ requires: { credentials: [long(60)] } }), "is too long"],
    ["wildcard skill", valid({ skill: "az*" }), "skill: wildcards are not allowed"],
    ["wildcard source", valid({ source: "*" }), "source: wildcards are not allowed"],
    ["wildcard digest", valid({ digest: "sha256:*" }), "digest: wildcards are not allowed"],
    ["not a map", "text" as unknown as Record<string, unknown>, "selections[0]: must be a map"],
  ];
  it.each(cases)("refuses %s", (_n, entry, fragment) => {
    const t = refuse(entry);
    expect(t).toContain("selections[0]");
    expect(t).toContain(fragment);
  });

  it("names the entry by source and skill", () => {
    expect(refuse(sdkWith(1))).toContain("selections[0] (microsoft-skills/azure-cosmos-py) sdk.version");
  });
  it("checks the file level", () => {
    expect(text(parseSkillSelections({ ...file(), extra: 1 }, TODAY).problems)).toContain('file: unknown key "extra"');
    expect(text(parseSkillSelections({ schema: 2, selections: [] }, TODAY).problems)).toContain("schema must be 1");
    expect(text(parseSkillSelections({ schema: 1, selections: {} }, TODAY).problems)).toContain("selections: must be a list");
    expect(text(parseSkillSelections(file(), "yesterday").problems)).toContain("today");
    expect(text(parseSkillSelections("x", TODAY).problems)).toContain("file: must be a map");
  });
  it("refuses the same source and skill twice", () => {
    expect(text(parseSkillSelections(file(valid(), valid()), TODAY).problems)).toBe(
      "selections[1] (microsoft-skills/azure-cosmos-py): is already listed by selections[0]",
    );
  });
  it("never prints a credential-like value", () => {
    const t = text([
      ...parseSkillSelections(file(valid({ sdk: { name: TOKEN, language: "go", version: TOKEN }, [TOKEN]: 1 })), TODAY).problems,
      ...parseSkillSelections(file(valid({ category: TOKEN, source: TOKEN })), TODAY).problems,
    ]);
    expect(t).toMatch(/credential|\(hidden\)/);
    expect(t).not.toContain(TOKEN);
  });
  it("never prints a control character", () => {
    const t = refuse(valid({ category: "a\u0007b", ["k\u001b"]: 1 }));
    expect(t).toContain("control or invisible character");
    // eslint-disable-next-line no-control-regex
    expect(t.split("\n").join("")).not.toMatch(/[\u0000-\u001f]/);
  });
  it("never throws on hostile input", () => {
    const boom = () => {
      throw new Error("boom " + TOKEN);
    };
    const hostile = new Proxy({}, { get: boom, ownKeys: boom, getPrototypeOf: boom });
    const getter = { schema: 1, get selections(): unknown { return boom(); } };
    const cyclic: Record<string, unknown> = { schema: 1 };
    cyclic.selections = [cyclic];
    const badEntry = { get source(): unknown { return boom(); } };
    for (const raw of [hostile, getter, cyclic, null, 7, undefined, file(hostile), file(badEntry)]) {
      const r = parseSkillSelections(raw, TODAY);
      expect(r.manifest).toBeUndefined();
      expect(r.problems.length).toBeGreaterThan(0);
      expect(text(r.problems)).not.toContain(TOKEN);
      expect(text(r.problems)).not.toContain("boom");
    }
  });
});

describe("selectionConnectors", () => {
  const sel = (requires: Partial<SkillSelection["requires"]>) => ({ requires: { clis: [], mcp: [], credentials: [], services: [], ...requires } });
  it("returns the sorted connector slugs", () => {
    const m = parseSkillSelections(file(valid()), TODAY).manifest!;
    expect(selectionConnectors(m.selections[0]!)).toEqual(["cli-az", "credential-azure-identity", "mcp-azure", "service-azure-cosmos-db"]);
    expect(selectionConnectors(sel({}))).toEqual([]);
    expect(selectionConnectors(sel({ clis: ["z", "a"], mcp: ["m"] }))).toEqual(["cli-a", "cli-z", "mcp-m"]);
  });
  it("throws a TypeError for a name that is not a slug", () => {
    expect(() => selectionConnectors(sel({ clis: ["Bad"] }))).toThrow(TypeError);
    expect(() => selectionConnectors(sel({ credentials: ["a".repeat(60)] }))).toThrow(TypeError);
  });
});

describe("readSkillSelections", () => {
  const dir = mkdtempSync(join(tmpdir(), "selections-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const YAML = [
    "schema: 1",
    "selections:",
    "  - source: s",
    "    skill: k",
    `    digest: ${DIGEST}`,
    "    scope: portable",
    "    category: c",
    "    capabilities: [x]",
    '    owner: "@octocat"',
    "    reviewed: 2026-10-01",
    "",
  ].join("\n");
  const put = (name: string, content: string) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };
  it("is none for a missing file and ok for a valid one", () => {
    expect(readSkillSelections(join(dir, "missing.yaml"), TODAY)).toEqual({ state: "none" });
    expect(readSkillSelections(put("ok.yaml", YAML), TODAY).state).toBe("ok");
  });
  it("prints nothing to stderr for a YAML warning and never shows the credential", () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const err = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = readSkillSelections(put("tag.yaml", `${YAML}extra: !unrecognized ${TOKEN}\n`), TODAY);
      expect(r.state).toBe("invalid");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(spy).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });
  it("is invalid for a link, a large file, bad YAML, an alias and a directory, and never shows the path", () => {
    const real = put("real.yaml", YAML);
    symlinkSync(real, join(dir, "link.yaml"));
    mkdirSync(join(dir, "folder.yaml"));
    const results = [
      readSkillSelections(join(dir, "link.yaml"), TODAY),
      readSkillSelections(real, TODAY, 10),
      readSkillSelections(put("bad.yaml", "a: [1\n"), TODAY),
      readSkillSelections(put("alias.yaml", "schema: &a 1\nselections: []\nx: *a\n"), TODAY),
      readSkillSelections(join(dir, "folder.yaml"), TODAY),
    ];
    for (const r of results) {
      expect(r.state).toBe("invalid");
      expect(JSON.stringify(r)).not.toContain(dir);
    }
  });
});
