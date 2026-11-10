import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom, type FakeElement } from "./helpers/fake-dom.js";

// Redesign 7: the admin pages sit on one shell, draw their heading with the shared page header, their tables with the shared
// table and their status words with the shared status pill. Unit tests: the page table, the source, and the pill helpers.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ia: any;
let users: any;
beforeAll(async () => {
  restore = installFakeDom();
  ia = await import("../ui/ia.js" as string);
  users = await import("../ui/users.js" as string);
});
afterAll(() => restore());

describe("the Administration pages", () => {
  const pages = () => ia.PAGES.filter((p: any) => p.area === "administration" && p.nav === "secondary");

  it("each resolves to the administration destination", () => {
    expect(pages().length).toBeGreaterThanOrEqual(7);
    for (const p of pages()) {
      const r = ia.resolve("admin", p.path);
      expect(r.page.id, p.path).toBe(p.id);
      expect(r.dest, p.path).toBe("administration");
    }
  });

  it("the sidebar marks Administration and the subnav lists every page", () => {
    const side = ia.sidebarFor("admin");
    expect([...side.main, ...side.extra].some((e: any) => e.id === "administration")).toBe(true);
    const ids = ia.subnavFor("admin", "administration").map((e: any) => e.id);
    for (const p of pages()) expect(ids).toContain(p.id);
  });
});

describe("the source of the admin pages", () => {
  const FILES = [
    "users", "user-detail", "watchers", "admin-credentials", "admin-repos", "repo-admin-sections", "admin-components", "admin-plugins", "admin", "admin-sections",
    "problems", "operations", "repos", "monitor", "governor", "models", "dashboard", "audit", "autonomy", "maintenance",
  ];
  for (const f of FILES) {
    it(`${f}.js has no hand-built table, h1, pill class or badge`, () => {
      const src = readFileSync(new URL(`../ui/${f}.js`, import.meta.url), "utf8");
      expect(src).not.toContain('h("table"');
      expect(src).not.toContain('h("h1"');
      expect(src).not.toMatch(/["'`]pill( (ok|fail|locked))?["'`]/);
      expect(src).not.toContain("badge(");
    });
  }
});

describe("the account status pill", () => {
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  const FUTURE = "2026-10-01T13:00:00Z";
  const u = (o: object = {}) => ({ id: "a", name: "Ann", email: "a@x", role: "user", status: "active", hasPassword: true, lockedUntil: null, ...o });
  const cases: Array<[string, object, string, string]> = [
    ["active", {}, "success", "active"],
    ["blocked", { status: "blocked" }, "danger", "blocked"],
    ["no password", { hasPassword: false }, "neutral", "no password yet"],
    ["locked", { lockedUntil: FUTURE }, "warning", "locked"],
    ["an account-system account", { provider: true, hasPassword: false }, "success", "account system"],
  ];
  for (const [name, over, sem, word] of cases) {
    it(`${name}: pill sem-${sem}, an icon and the word`, () => {
      const pill = users.userStatusPill(u(over), NOW) as FakeElement;
      expect(pill.attrs.class).toBe(`pill sem-${sem}`);
      expect(pill.all("svg").length).toBeGreaterThan(0);
      expect(pill.textContent).toBe(word);
    });
  }

  it("blocked wins over locked", () => {
    expect(users.userSemantic(u({ status: "blocked", lockedUntil: FUTURE }), NOW)).toBe("danger");
  });
});
