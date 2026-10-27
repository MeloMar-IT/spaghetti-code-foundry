import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSha256Sums } from "../src/release/build.js";
import { addValidator, validatorFileName, validatorVersion } from "../src/release/validator.js";

const REAL = resolve("tools/delivery-validate/validate.mjs");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("release validator", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relval-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const script = (body: string) => {
    const f = join(dir, "fake.mjs");
    writeFileSync(f, body);
    return f;
  };

  it("names the file after the version", () => {
    expect(validatorFileName("1.2.3")).toBe("scf-delivery-validate-1.2.3.mjs");
  });

  it("reads the version the script prints", () => {
    expect(validatorVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(validatorVersion(script('console.log("2.3.4");'))).toBe("2.3.4");
  });

  it("refuses a script without a usable version", () => {
    expect(() => validatorVersion(script('console.log("nope");'))).toThrow("no usable version");
    expect(() => validatorVersion(script("process.exit(1);"))).toThrow("no usable version");
  });

  it("copies the script and writes a matching .sha256 file", () => {
    const out = join(dir, "out");
    mkdirSync(out);
    const v = addValidator(out);
    const name = validatorFileName(v.version);
    expect(v.name).toBe(name);
    const copy = readFileSync(join(out, name));
    expect(copy.equals(readFileSync(REAL))).toBe(true);
    expect(v.sha256).toBe(sha(copy));
    expect(readFileSync(join(out, name + ".sha256"), "utf8")).toBe(`${sha(copy)}  ${name}\n`);
  });

  it("never overwrites a file of the same name", () => {
    const name = validatorFileName(validatorVersion());
    for (const clash of [name, name + ".sha256"]) {
      const out = mkdtempSync(join(dir, "o-"));
      writeFileSync(join(out, clash), "mine");
      expect(() => addValidator(out)).toThrow(`the release files already have ${clash}; the Foundry adds it itself`);
      expect(readFileSync(join(out, clash), "utf8")).toBe("mine");
    }
  });

  it("is listed in SHA256SUMS", async () => {
    const out = mkdtempSync(join(dir, "o-"));
    const v = addValidator(out);
    expect(await writeSha256Sums(out)).toBe(true);
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8");
    expect(sums).toContain(`${v.sha256}  ${v.name}\n`);
    expect(sums).toContain(`  ${v.name}.sha256\n`);
  });
});
