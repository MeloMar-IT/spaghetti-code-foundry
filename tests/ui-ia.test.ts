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
    expect(ia.subnavFor("admin", "administration").map((l: any) => l.label)).toEqual(["Users", "Watchers", "Models", "Problems", "Dashboard", "Audit", "Settings"]);
    expect(ia.subnavFor("admin", "flows").map((l: any) => l.href)).toEqual(["#/flows", "#/library"]);
    expect(ia.subnavFor("admin", "repos").map((l: any) => l.href)).toEqual(["#/repos", "#/all-repos", "#/credentials"]);
    expect(ia.subnavFor("user", "repos")).toEqual([]);
    expect(ia.subnavFor("admin", "runs")).toEqual([]);
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
    expect(crumbs("#/users")).toEqual([["Administration", "#/users"], ["Users", null]]);
    expect(r("#/users").back).toBeNull();
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

  it("sends admin pages to My runs", () => {
    for (const h of ["#/users", "#/your-turn", "#/board"]) expect(r(h), h).toMatchObject({ hash: "#/runs", redirected: true, reason: "unknown" });
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
