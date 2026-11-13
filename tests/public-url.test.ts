import { describe, expect, it } from "vitest";
import { appBase, appLink, isPublicUrl } from "../src/public-url.js";

describe("public url", () => {
  it.each(["https://f.example.com", "https://f.example.com:8443/foundry/", "https://localhost", "https://[::1]:8443"])("accepts %s", (u) => expect(isPublicUrl(u)).toBe(true));
  it.each(["http://f.example.com", "ftp://f.example.com", "f.example.com", "https://", "https://u:p@f.example.com", "https://f.example.com/?x", "https://f.example.com/#/a",
    "https://f.example.com/a b", "https://f.example.com/(x)", "https://f.example.com/a|b", "https://f.example.com/\nx", `https://f.example.com/${"a".repeat(2048)}`])("refuses %j", (u) =>
    expect(isPublicUrl(u)).toBe(false));
  it("drops trailing slashes", () => {
    expect(appBase("https://f.example.com//")).toBe("https://f.example.com");
    expect(appBase(undefined)).toBeUndefined();
    expect(appBase("")).toBeUndefined();
  });
  it("links only safe pages", () => {
    expect(appLink("https://f.example.com", "#/runs/r1")).toBe("https://f.example.com/#/runs/r1");
    expect(appLink(undefined, "#/runs/r1")).toBeUndefined();
    for (const p of ["https://evil.example", "#/a b", "#/a)", undefined]) expect(appLink("https://f.example.com", p)).toBeUndefined();
  });
});
