import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ia: any;
let auth: any;
beforeAll(async () => {
  restore = installFakeDom();
  ia = await import("../ui/ia.js" as string);
  auth = await import("../ui/auth.js" as string);
});
afterAll(() => restore());

const read = (p: string) => readFileSync(p, "utf8");
const navLinks = (html: string) => [...html.matchAll(/<a href="([^"]+)" data-nav="([\w-]+)"([^>]*)>([^<]+)</g)].map((m) => ({ href: m[1]!, id: m[2]!, attrs: m[3]!, label: m[4]!.trim() }));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

describe("resolve with a query", () => {
  const a = (h: any) => ia.resolve("admin", h);

  it("returns the known keys as query and still resolves the same page", () => {
    expect(a("#/runs?repo=acme%2Fapp&owner=u1")).toMatchObject({ page: { id: "runs" }, redirected: false, hash: "#/runs?repo=acme%2Fapp&owner=u1", query: { repo: "acme/app", owner: "u1" } });
    expect(a("#/board/acme%2Fapp?owner=u1")).toMatchObject({ page: { id: "board-repo" }, arg: "acme/app", query: { owner: "u1" } });
    expect(a("#/runs?repo=a/b")).toMatchObject({ page: { id: "runs" }, query: { repo: "a/b" } });
    expect(a("#/runs?x=1&repo=bad")).toMatchObject({ page: { id: "runs" }, query: {} });
  });

  it("gives an empty query to every address without one", () => {
    for (const p of ia.PAGES) expect(a(p.path.replace(":id", "x").replace(":name", "x")).query, p.path).toEqual({});
  });

  it("falls back as before and sends an alias on", () => {
    expect(a("#/nope?repo=a%2Fb")).toMatchObject({ hash: "#/home", reason: "unknown", query: {} });
    expect(a("#/runs/%E0%A4%A?repo=a%2Fb")).toMatchObject({ reason: "unknown" });
    expect(a("#/?repo=a%2Fb")).toMatchObject({ reason: "none" });
    expect(a("#/your-turn?owner=u1")).toMatchObject({ hash: "#/home", reason: "alias" });
  });
});

describe("the navigation lists", () => {
  it("has seven primary destinations for an admin, four for a user, and one action each", () => {
    expect(ia.primaryFor("admin").map((p: any) => p.id)).toEqual(["home", "board", "refinement", "runs", "repos", "flows", "administration"]);
    expect(ia.primaryFor("user").map((p: any) => p.label)).toEqual(["Home", "My runs", "My repositories", "Refinement"]);
    for (const role of ["admin", "user"]) {
      expect(ia.primaryFor(role).length).toBeLessThanOrEqual(ia.MAX_PRIMARY);
      expect(ia.actionsFor(role).map((a: any) => a.href)).toEqual(["#/start"]);
    }
    const groups = ia.primaryFor("admin").map((p: any) => p.group);
    expect(groups).toEqual([...groups].sort((a: string, b: string) => (a === b ? 0 : a === "work" ? -1 : 1)));
  });

  it("matches the data-nav links of both HTML files", () => {
    for (const [file, role] of [["ui/index.html", "admin"], ["ui/user/index.html", "user"]] as const) {
      const want = [...ia.actionsFor(role), ...ia.primaryFor(role)];
      const links = navLinks(read(file));
      expect(links.map((l) => [l.id, l.label, l.href]), file).toEqual(want.map((w: any) => [w.id, w.label, w.href]));
      if (role === "admin") for (const l of links) expect(l.attrs.includes('class="setup"'), l.id).toBe(want.find((w: any) => w.id === l.id).group === "setup");
    }
  });

  it("lists the secondary pages of a destination", () => {
    const adm = ia.subnavFor("admin", "administration");
    expect(adm.map((l: any) => l.label)).toEqual(["Overview", "Problems", "Watchers", "Models", "Dashboard", "Users", "All repositories", "Credentials", "Audit", "Settings", "Maintenance"]);
    expect(adm.map((l: any) => l.section)).toEqual([...Array(5).fill("operations"), ...Array(4).fill("access"), "system", "system"]);
    expect(ia.subnavFor("admin", "flows").map((l: any) => l.href)).toEqual(["#/flows", "#/library"]);
    expect(ia.subnavFor("admin", "flows").every((l: any) => l.section === undefined)).toBe(true);
    expect(ia.subnavFor("admin", "repos")).toEqual([]);
    expect(ia.subnavFor("user", "repos")).toEqual([]);
    expect(ia.subnavFor("admin", "runs")).toEqual([]);
  });

  it("only uses known sections", () => {
    expect(ia.SECTIONS.map((s: any) => s.label)).toEqual(["Operations", "People and access", "System"]);
    for (const p of ia.PAGES.filter((x: any) => x.section)) expect(ia.SECTIONS.map((s: any) => s.id)).toContain(p.section);
  });
});

describe("resolve for an admin", () => {
  const r = (h: any) => ia.resolve("admin", h);

  it("keeps every page address as it is", () => {
    for (const p of ia.PAGES.filter((x: any) => x.roles.includes("admin"))) {
      const hash = p.path.replace(":id", "abc-1").replace(":name", "my-flow");
      const to = r(hash);
      expect(to.redirected, hash).toBe(false);
      expect(to.hash).toBe(hash);
      expect(to.page.id).toBe(p.id);
    }
  });

  it("sends #/your-turn to #/home", () => {
    expect(r("#/your-turn")).toMatchObject({ hash: "#/home", redirected: true, reason: "alias" });
  });

  it("sends no hash to Home", () => {
    for (const h of ["", "#", "#/", undefined]) expect(r(h), String(h)).toMatchObject({ hash: "#/home", reason: "none", redirected: true });
  });

  it("sends an unknown hash to Home", () => {
    for (const h of ["#/nope", "#/runs/a/b", "#/runs/%E0%A4%A", "#/runs/"]) expect(r(h), h).toMatchObject({ hash: "#/home", reason: "unknown", redirected: true });
  });

  it("keeps an encoded name", () => {
    expect(r("#/flows/my%20flow")).toMatchObject({ hash: "#/flows/my%20flow", arg: "my flow", title: "my flow" });
  });

  it("builds crumbs and back", () => {
    const crumbs = (h: string) => r(h).crumbs.map((c: any) => [c.label, c.href]);
    expect(crumbs("#/runs/r1")).toEqual([["Runs", "#/runs"], ["Run r1", null]]);
    expect(r("#/runs/r1").back).toBe("#/runs");
    expect(crumbs("#/operations")).toEqual([["Administration", "#/operations"], ["Overview", null]]);
    expect(ia.primaryFor("admin").find((p: any) => p.id === "administration")).toMatchObject({ href: "#/operations" });
    expect(crumbs("#/users")).toEqual([["Administration", "#/operations"], ["Users", null]]);
    expect(r("#/users").back).toBeNull();
    expect(crumbs("#/all-repos")).toEqual([["Administration", "#/operations"], ["All repositories", null]]);
    expect(crumbs("#/credentials")).toEqual([["Administration", "#/operations"], ["Credentials", null]]);
    expect(crumbs("#/maintenance")).toEqual([["Administration", "#/operations"], ["Maintenance", null]]);
    expect(r("#/all-repos")).toMatchObject({ dest: "administration", redirected: false });
    expect(crumbs("#/flows")).toEqual([]);
    expect(crumbs("#/flows/x")).toEqual([["Flows", "#/flows"], ["x", null]]);
    expect(crumbs("#/library")).toEqual([["Flows", "#/flows"], ["Library", null]]);
    expect(crumbs("#/repos")).toEqual([["Repositories", "#/repos"], ["My repositories", null]]);
    expect(r("#/runs/r1").title).toBe("Run r1");
    expect(r("#/runs").title).toBe("Runs");
  });
});

describe("resolve for a user", () => {
  const r = (h: any) => ia.resolve("user", h);

  it("agrees with isUserHash", () => {
    for (const h of ["#/home", "#/start", "#/runs", "#/runs/abc-1", "#/repos", "#/refinement", "#/refinement/s-1"]) {
      expect(auth.isUserHash(h), h).toBe(true);
      expect(r(h), h).toMatchObject({ hash: h, redirected: false });
    }
    expect(r("#/home").title).toBe("Home");
  });

  it("resolves the backlog page before the session page, for both roles", () => {
    for (const role of ["admin", "user"]) {
      const to = ia.resolve(role, "#/refinement/backlog");
      expect(to, role).toMatchObject({ hash: "#/refinement/backlog", redirected: false, title: "Backlog readiness", back: "#/refinement" });
      expect(to.page.id).toBe("refinement-backlog");
      expect(ia.resolve(role, "#/refinement/s-1").page.id).toBe("refinement-session");
    }
    expect(auth.isUserHash("#/refinement/backlog")).toBe(true);
  });

  it("accepts a query on the three pages that take one, and sends the board to My runs", () => {
    for (const h of ["#/runs?repo=a%2Fb&owner=u9", "#/refinement?owner=u1", "#/repos?x=1"]) {
      expect(auth.isUserHash(h), h).toBe(true);
      expect(r(h), h).toMatchObject({ hash: h, redirected: false });
    }
    expect(r("#/runs?repo=a%2Fb&owner=u9").query).toEqual({ repo: "a/b", owner: "u9" });
    expect(r("#/board?owner=u1")).toMatchObject({ hash: "#/runs", redirected: true });
  });

  it("sends admin pages to My runs", () => {
    for (const h of ["#/users", "#/operations", "#/your-turn", "#/board", "#/maintenance", "#/all-repos", "#/credentials"]) expect(r(h), h).toMatchObject({ hash: "#/runs", redirected: true, reason: "unknown" });
  });

  it("has no link to the admin-only pages in the user HTML", () => {
    const html = read("ui/user/index.html");
    for (const h of ["#/maintenance", "#/all-repos", "#/credentials", "#/operations"]) expect(html).not.toContain(h);
  });

  it("builds crumbs", () => {
    expect(r("#/runs/r1").crumbs.map((c: any) => c.label)).toEqual(["My runs", "Run r1"]);
    expect(r("#/repos").crumbs).toEqual([]);
  });
});

describe("the data", () => {
  it("is consistent", () => {
    const ids = ia.PAGES.map((p: any) => p.id);
    const paths = ia.PAGES.map((p: any) => p.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
    const areas = ia.AREAS.map((a: any) => a.id);
    for (const p of ia.PAGES) {
      expect(areas, p.id).toContain(p.area);
      if (p.parent) expect(ids, p.id).toContain(p.parent);
      if (p.dest) expect(ia.DESTINATIONS.map((d: any) => d.id), p.id).toContain(p.dest);
      expect(p.path.split(":").length - 1).toBeLessThanOrEqual(1);
    }
    for (const d of ia.DESTINATIONS) expect(ids).toContain(d.landing);
    for (const a of ia.ALIASES) {
      const to = ia.resolve("admin", a.to);
      expect(to.reason).toBeNull();
    }
  });

  it("resolves every page address the server writes", () => {
    const found = new Set<string>();
    for (const f of files("src")) for (const m of read(f).matchAll(/#\/[a-z][a-z-]*/g)) found.add(m[0]);
    expect(found.size).toBeGreaterThan(0);
    for (const h of found) {
      const to = ia.resolve("admin", h);
      expect([null, "alias"], h).toContain(to.reason);
    }
  });
});

describe("the grouped shell", () => {
  it("GROUPS cover every group of the destinations", () => {
    const ids = ia.GROUPS.map((g: any) => g.id);
    for (const d of ia.DESTINATIONS) expect(ids, d.id).toContain(d.group);
  });

  it("the admin sidebar headings are the groups its destinations use, in order", () => {
    const html = read("ui/index.html");
    const heads = [...html.matchAll(/<span class="side-head">([^<]+)</g)].map((m) => m[1]);
    const used = new Set(ia.primaryFor("admin").map((d: any) => d.group));
    expect(heads).toEqual(ia.GROUPS.filter((g: any) => used.has(g.id)).map((g: any) => g.label));
    expect(read("ui/user/index.html")).not.toContain("side-head");
  });

  it("every page link but Start work is in the sidebar; the top bar has only Start work", () => {
    for (const file of ["ui/index.html", "ui/user/index.html"]) {
      const html = read(file);
      const top = html.slice(html.indexOf('<header class="top"'), html.indexOf("</header>"));
      expect([...top.matchAll(/data-nav="([\w-]+)"/g)].map((m) => m[1]), file).toEqual(["start"]);
      const from = html.indexOf('<nav id="side"');
      const side = html.slice(from, html.indexOf("</nav>", from));
      const all = [...html.matchAll(/data-nav="([\w-]+)"/g)].length;
      expect([...side.matchAll(/data-nav="([\w-]+)"/g)].length + 1, file).toBe(all);
    }
  });
});
