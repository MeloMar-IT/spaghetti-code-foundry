import { afterEach, describe, expect, it } from "vitest";
import { expandTag, expandVersion, parseRecipe } from "../src/release/recipe.js";

const base = "builds:\n  - {name: a, run: make, artifacts: [out/*]}\n";
const err = (text: string) => {
  try {
    parseRecipe(text);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected an error");
};

describe("release recipe", () => {
  it("applies the defaults to a minimal recipe", () => {
    const r = parseRecipe(base);
    expect(r).toMatchObject({ version: "{commit_datetime}", tag: "v{version}", prerelease: true, keep: 5, timeout_minutes: 60 });
    expect(r.builds[0]).toMatchObject({ on: ["macos", "linux", "windows"], requires: [] });
    expect(r.builds[0]!.arch).toBeUndefined();
    expect(r.assemble).toBeUndefined();
  });

  it("names unknown keys", () => {
    expect(err(`colour: red\n${base}`)).toMatch(/colour/);
    expect(err("builds:\n  - {name: a, run: make, artifacts: [x], shell: bash}\n")).toMatch(/builds\.0: .*shell/);
  });

  it("refuses an empty or missing builds list", () => {
    expect(err("builds: []\n")).toMatch(/builds: list at least one build/);
    expect(err("keep: 3\n")).toMatch(/builds/);
  });

  it("refuses a duplicate or unsafe name", () => {
    expect(err("builds:\n  - {name: a, run: x, artifacts: [x]}\n  - {name: a, run: x, artifacts: [x]}\n")).toMatch(/builds\.1\.name: "a" is used twice/);
    for (const n of ["A", "a b", "../x", "-x", "a".repeat(65)]) expect(err(`builds:\n  - {name: "${n}", run: x, artifacts: [x]}\n`)).toMatch(/builds\.0\.name/);
  });

  it("checks keep and timeout_minutes", () => {
    for (const k of ["0", "51", "2.5"]) expect(err(`keep: ${k}\n${base}`)).toMatch(/keep/);
    for (const t of ["0", "481"]) expect(err(`timeout_minutes: ${t}\n${base}`)).toMatch(/timeout_minutes/);
    expect(parseRecipe(`keep: 50\ntimeout_minutes: 480\n${base}`)).toMatchObject({ keep: 50, timeout_minutes: 480 });
  });

  it("checks on, arch, requires and artifacts", () => {
    const b = (s: string) => `builds:\n  - {name: a, run: x, artifacts: [x], ${s}}\n`;
    expect(err(b("on: [beos]"))).toMatch(/builds\.0\.on/);
    expect(err(b("on: []"))).toMatch(/at least one of/);
    expect(err(b("arch: ppc"))).toMatch(/builds\.0\.arch/);
    expect(err(b("requires: ['a b']"))).toMatch(/builds\.0\.requires/);
    for (const g of ["/abs", "../x", "a/../b", "a\\\\b", "~/x"]) expect(err(`builds:\n  - {name: a, run: x, artifacts: ["${g}"]}\n`)).toMatch(/builds\.0\.artifacts\.0/);
  });

  it("refuses an unknown placeholder and a bad tag", () => {
    expect(err(`version: "{nope}"\n${base}`)).toMatch(/version may hold only .*\{commit_datetime\}/);
    expect(err(`tag: "v..1"\n${base}`)).toMatch(/tag/);
    expect(err(`tag: "-v"\n${base}`)).toMatch(/tag/);
    expect(err(`version: "{version}"\n${base}`)).toMatch(/version/);
  });

  it("refuses empty text and text that is not YAML", () => {
    expect(err("")).toMatch(/is empty/);
    expect(err("a: [1\n")).toMatch(/not valid YAML/);
    expect(err("- 1\n")).toMatch(/not valid/);
  });
});

describe("expandVersion and expandTag", () => {
  const commit = { sha: "0123456789abcdef0123456789abcdef01234567", committerTime: Date.UTC(2026, 9, 18, 20, 30) / 1000 };
  const saved = process.env.TZ;
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it("fills the placeholders", () => {
    const r = parseRecipe(base);
    expect(expandVersion(r, commit)).toBe("202610182030");
    expect(expandTag(r, commit)).toBe("v202610182030");
    const own = parseRecipe(`version: "{commit_date}-{sha}"\ntag: "rel/{version}-{commit_datetime}"\n${base}`);
    expect(expandVersion(own, commit)).toBe("20261018-0123456");
    expect(expandTag(own, commit)).toBe("rel/20261018-0123456-202610182030");
  });

  it("does not depend on the time zone", () => {
    const r = parseRecipe(base);
    for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = tz;
      expect(expandVersion(r, commit)).toBe("202610182030");
      expect(expandTag(r, commit)).toBe("v202610182030");
    }
  });
});
