import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";

const parse = (delivery: unknown) => ConfigSchema.safeParse({ delivery });
const names = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);

describe("delivery settings", () => {
  it("has defaults, and an old config still loads", () => {
    const d = ConfigSchema.parse({}).delivery;
    expect(d).toEqual({ required_checks: [], artifacts: [], provenance: false, repositories: {} });
    expect(d.signing_key_path).toBeUndefined();
  });

  it("takes a full example and trims names", () => {
    const r = parse({
      signing_key_path: "/data/delivery-keys/signing-key",
      required_checks: ["  build  ", "test"],
      artifacts: ["dist/app.tgz"],
      provenance: true,
      repositories: { "acme/app": { required_checks: [" e2e "], provenance: false } },
    });
    expect(r.success).toBe(true);
    expect(r.data!.delivery.required_checks).toEqual(["build", "test"]);
    expect(r.data!.delivery.repositories["acme/app"]!.required_checks).toEqual(["e2e"]);
  });

  it("refuses a relative key path", () => {
    const r = parse({ signing_key_path: "keys/k" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain("must be an absolute path");
  });

  it("refuses bad repository keys, too many repositories and unknown keys", () => {
    for (const k of ["Acme/App", "acme", "acme/a/b"]) expect(parse({ repositories: { [k]: {} } }).success, k).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`acme/app${i}`, {}]));
    expect(parse({ repositories: many }).success).toBe(false);
    expect(parse({ repositories: { "acme/app": { foo: 1 } } }).success).toBe(false);
    expect(parse({ extra: 1 }).success).toBe(false);
  });

  it("checks names in the lists and in the repository entries", () => {
    for (const where of [(l: string[]) => ({ required_checks: l }), (l: string[]) => ({ artifacts: l }), (l: string[]) => ({ repositories: { "acme/app": { artifacts: l } } })]) {
      expect(parse(where(["a", "a"])).success).toBe(false);
      expect(parse(where(["a", " a "])).success).toBe(false);
      expect(parse(where([""])).success).toBe(false);
      expect(parse(where(["   "])).success).toBe(false);
      expect(parse(where(["a".repeat(201)])).success).toBe(false);
      expect(parse(where(["a".repeat(200)])).success).toBe(true);
      expect(parse(where(["a\nb"])).success).toBe(false);
      expect(parse(where(["a\u007fb"])).success).toBe(false);
      expect(parse(where(names(501))).success).toBe(false);
      expect(parse(where(names(500))).success).toBe(true);
    }
  });
});
