import { describe, it, expect } from "vitest";
import { SHOTS, validateManifest, type Shot } from "../scripts/screenshots/shots.js";

const shot = (name: string, over: Partial<Shot> = {}): Shot => ({
  name, guide: "user", role: "user", path: "/user/", expect: "Start work", ...over,
});

describe("screenshot manifest", () => {
  it("accepts a clean manifest", () => {
    expect(validateManifest([shot("a"), shot("b")], { a: async () => {} })).toEqual([]);
  });
  it("reports duplicate names", () => {
    expect(validateManifest([shot("a"), shot("a")])).toEqual(["duplicate shot: a"]);
  });
  it("reports prepare keys that are not shots", () => {
    expect(validateManifest([shot("a")], { zzz: 1 })).toEqual(["prepare step for unknown shot: zzz"]);
  });
  it("reports a shot with no expected locator", () => {
    expect(validateManifest([shot("a", { expect: " " })])).toEqual(["shot without an expected locator: a"]);
  });
  it("the real manifest is valid", () => {
    expect(validateManifest(SHOTS)).toEqual([]);
  });
});
