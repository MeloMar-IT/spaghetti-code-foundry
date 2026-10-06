import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(`ui/${p}`, "utf8");

const ADMIN_MODULES = ["editor", "library", "admin", "models", "dashboard", "users", "audit", "board", "turn", "monitor", "health", "since", "admin-repos", "admin-credentials"];

describe("ui/user/index.html", () => {
  const html = read("user/index.html");
  it("has the places the sign-in and the pages need", () => {
    for (const id of ["main", "user", "modal-root", "toast"]) expect(html).toContain(`id="${id}"`);
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
    for (const m of ["user/start.js", "user/runs.js", "auth.js", "runs.js", "repos.js", "refinement.js", "refinement-talk.js", "refinement-draft.js", "refinement-suggest.js", "dom.js"]) expect(seen.has(m), m).toBe(true);
  });

  it("signs in before it listens for hash changes, and reloads for a set-password link first", () => {
    const enter = app.indexOf('await enterDisplay("user");');
    expect(enter).toBeGreaterThan(0);
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
    expect(app).toContain('if (page.section === "start") done = await renderStart(box);');
    expect(app).toContain("isNoHash(");
    expect(app.indexOf("const mine = ++generation;")).toBeLessThan(app.indexOf("await homeHash()"));
    expect(app.match(/\+\+generation/g)).toHaveLength(1);
  });

  it("gives every renderer admin: false", () => {
    const calls = app.match(/render(Refinement|Repos)\(box[^)]*\)/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(app).toContain("renderMyRun(box, page.id)");
    expect(app).toContain("await renderMyRuns(box)");
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
  });
});
