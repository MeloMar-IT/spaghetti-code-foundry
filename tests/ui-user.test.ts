import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(`ui/${p}`, "utf8");

const ADMIN_MODULES = ["editor", "library", "admin", "models", "dashboard", "users", "audit", "board", "turn", "monitor", "health", "since", "admin-repos", "admin-credentials"];

describe("ui/user/index.html", () => {
  const html = read("user/index.html");
  it("has the places the sign-in and the pages need", () => {
    for (const id of ["main", "user", "modal-root", "toast", "view-as", "side", "menu-btn", "page-title", "top-actions", "account"]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain("health-btn");
  });
  it("has exactly four links with the user pages", () => {
    const links = [...html.matchAll(/<a href="([^"]+)" data-nav="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2], m[3]]);
    expect(links).toEqual([
      ["#/start", "start", "Start work"],
      ["#/runs", "runs", "My runs"],
      ["#/repos", "repos", "My repositories"],
      ["#/refinement", "refinement", "Refinement"],
    ]);
    expect(html.split("data-nav=").length - 1).toBe(4);
  });
  it("has nothing of the admin page", () => {
    for (const bad of ['id="repo"', 'id="health"', 'id="since"', 'id="sidebar"', "<aside", "turn-badge"]) expect(html, bad).not.toContain(bad);
  });
  it("has the body classes and loads its own script", () => {
    expect(html).toContain('<body class="user-display signed-out">');
    expect(html).toContain('<script type="module" src="/user/app.js"></script>');
  });
});

describe("ui/user/app.js", () => {
  const app = read("user/app.js");

  const specifiers = (src: string) => [
    ...[...src.matchAll(/^(?:import|export)\b[^"'\n]*\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]!),
    ...[...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!),
    ...[...src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map((m) => m[1]!),
  ];

  it("imports only by absolute path", () => {
    for (const s of specifiers(app)) expect(s.startsWith("/"), s).toBe(true);
  });

  it("reaches no admin module", () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const s of specifiers(read(file))) {
        if (s.startsWith("/vendor/")) continue;
        const next = s.startsWith("/") ? s.slice(1) : posix.join(posix.dirname(file), s);
        expect(existsSync(`ui/${next}`), `${file} imports ${s}`).toBe(true);
        walk(next);
      }
    };
    walk("user/app.js");
    expect(seen.has("app.js")).toBe(false);
    for (const m of ADMIN_MODULES) expect(seen.has(`${m}.js`), m).toBe(false);
    for (const m of ["user/start.js", "user/runs.js", "auth.js", "runs.js", "repos.js", "refinement.js", "refinement-talk.js", "refinement-draft.js", "refinement-suggest.js", "dom.js", "view-as.js", "ia.js", "shell.js", "filters.js"]) expect(seen.has(m), m).toBe(true);
  });

  it("signs in before it listens for hash changes, and reloads for a set-password link first", () => {
    const enter = app.indexOf('await enterDisplay("user", { viewAs: as });');
    expect(enter).toBeGreaterThan(0);
    expect(app.indexOf('new URLSearchParams(location.search).get("as")')).toBeGreaterThan(0);
    expect(app.indexOf('new URLSearchParams(location.search).get("as")')).toBeLessThan(enter);
    // the preview is set up before the first page is drawn
    expect(app.indexOf("beginView(as, me")).toBeGreaterThan(enter);
    expect(app.indexOf("beginView(as, me")).toBeLessThan(app.indexOf('window.addEventListener("hashchange", route);'));
    expect(enter).toBeLessThan(app.indexOf('window.addEventListener("hashchange", route);'));
    const body = app.slice(app.indexOf("async function route() {") + "async function route() {".length);
    const first = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"))[0];
    expect(first).toBe("if (linkToken(location.hash)) return location.reload();");
  });

  it("draws each route into its own box and stops a stale one", () => {
    expect(app).toContain("const mine = ++generation;");
    expect(app).toContain("if (mine !== generation) done?.();");
    expect(app).toContain("else cleanup = done;");
  });

  it("routes Start work and decides the empty address behind the generation guard", () => {
    expect(app).toContain('if (page.section === "start") done = await renderStart(box, { readOnly });');
    expect(app).toContain("isNoHash(");
    expect(app.indexOf("const mine = ++generation;")).toBeLessThan(app.indexOf("await homeHash()"));
    expect(app.match(/\+\+generation/g)).toHaveLength(1);
  });

  it("gives every renderer admin: false", () => {
    const calls = app.match(/render(Refinement|Repos)\(box[^)]*\)/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(app).toContain("renderMyRun(box, page.id, { readOnly })");
    expect(app).toContain("await renderMyRuns(box, { readOnly, query: to.query })");
    expect(app.indexOf('resolve("user", page.hash)')).toBeLessThan(app.indexOf('showPage("user", to)'));
    for (const c of calls) expect(c, c).toContain("readOnly");
    expect(app).not.toContain('"/runs.js"');
    for (const c of calls) expect(c, c).toContain("{ admin: false");
  });
});

describe("ui/style.css", () => {
  const css = read("style.css");
  it("wraps the user top bar, scrolls tables in a box and marks the keyboard focus", () => {
    expect(css).toMatch(/\.user-display \.top \{[^}]*flex-wrap: wrap/);
    expect(css).toContain(".table-box { overflow-x: auto; }");
    expect(css).toContain("a:focus-visible, button:focus-visible");
    expect(css).toContain(".view-bar {");
  });
  it("hides the shell when signed out and turns the sidebar into a drawer on a narrow screen", () => {
    const shellCss = css;
    expect(shellCss).toContain(".signed-out .side");
    expect(shellCss).toMatch(/@media \(max-width: 760px\) \{[^@]*\.side \{ display: none; position: fixed;/);
    expect(shellCss).toContain("body.drawer-open .side");
  });
});
