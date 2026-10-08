import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";
import { code, tableRows } from "./helpers/md-table.js";
import { BASELINE, effortText, KNOWN_OVER, over, REDESIGN, TASKS, type TaskId } from "./browser/journeys-baseline.js";

// docs/ui-redesign/ is a research audit of every screen. This test keeps its tables in step with the code:
// routes, nav links, dialog call sites, native dialogs and inline styles. It does not check wording, the counts
// inside journeys, or dialog variants added inside a call site other than callDialog.

const DIR = "docs/ui-redesign";
const read = (p: string) => readFileSync(p, "utf8");
const doc = (name: string) => read(`${DIR}/${name}`);

/** Both directions of a set comparison. */
function diff(docItems: string[], source: string[]): { missing: string[]; extra: string[] } {
  const d = new Set(docItems);
  const s = new Set(source);
  return { missing: [...s].filter((x) => !d.has(x)).sort(), extra: [...d].filter((x) => !s.has(x)).sort() };
}

/** Routes from the USER_HASH source text; throws on a shape it does not know. */
function userRoutes(authSource: string): string[] {
  const m = /const USER_HASH = \/(.*)\/;/.exec(authSource);
  if (!m) throw new Error("USER_HASH not found in ui/auth.js");
  const outer = /^\^#\\\/\((.*)\)\$$/.exec(m[1]!);
  if (!outer) throw new Error(`USER_HASH has a shape this test does not know: ${m[1]}`);
  const alts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of outer[1]!) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "|" && depth === 0) {
      alts.push(cur);
      cur = "";
    } else cur += ch;
  }
  alts.push(cur);
  const out: string[] = [];
  for (const alt of alts) {
    const a = /^([\w-]+)(\(\\\/\[\\w-\]\+\)\?)?$/.exec(alt);
    if (!a) throw new Error(`USER_HASH alternative has a shape this test does not know: ${alt}`);
    out.push(`#/${a[1]}`);
    if (a[2]) out.push(`#/${a[1]}/:id`);
  }
  return out;
}

/** Admin routes from route() in ui/app.js: `#/x`, and `#/x/:` for sections whose line uses `arg`. */
function adminRoutes(appSource: string): { sections: string[]; detail: string[] } {
  const sections = new Set<string>();
  const detail = new Set<string>();
  for (const line of appSource.split("\n")) {
    const m = /^\s*(?:else )?if \(section === "([\w-]+)"/.exec(line);
    if (!m) continue;
    sections.add(`#/${m[1]}`);
    if (/\barg\b/.test(line)) detail.add(`#/${m[1]}/:`);
  }
  return { sections: [...sections], detail: [...detail] };
}

const asDetail = (route: string) => route.replace(/^(#\/[\w-]+\/:)\w*$/, "$1");
const uiFiles = (): string[] => [...readdirSync("ui").filter((f) => f.endsWith(".js")).map((f) => `ui/${f}`), ...readdirSync("ui/user").filter((f) => f.endsWith(".js")).map((f) => `ui/user/${f}`)];
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
const sectionText = (text: string, heading: string) => {
  const at = text.indexOf(`\n${heading}\n`);
  if (at < 0) return "";
  const rest = text.slice(at + heading.length + 2);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
};
const navLinks = (html: string) => [...html.matchAll(/<a [^>]*data-nav="([\w-]+)"[^>]*>([^<]+)</g)].map((m) => ({ name: m[1]!, text: m[2]!.trim() }));

const inventory = doc("inventory.md");
const appSource = read("ui/app.js");
const authSource = read("ui/auth.js");
const admin = adminRoutes(appSource);
const adminRows = tableRows(inventory, "## Admin display");
const userRows = tableRows(inventory, "## User display");
const adminCells = adminRows.map((r) => code(r[0]!));
const userCells = userRows.map((r) => code(r[0]!));

let restore: () => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
beforeAll(async () => {
  restore = installFakeDom();
  auth = await import("../ui/auth.js" as string);
});
afterAll(() => restore());

describe("helpers (failure paths)", () => {
  it("diff reports one missing and one extra route exactly", () => {
    expect(diff(["#/a", "#/c"], ["#/a", "#/b"])).toEqual({ missing: ["#/b"], extra: ["#/c"] });
  });

  it("userRoutes reads a known shape", () => {
    expect(userRoutes("const USER_HASH = /^#\\/(start|runs(\\/[\\w-]+)?|x)$/;")).toEqual(["#/start", "#/runs", "#/runs/:id", "#/x"]);
  });

  it("userRoutes throws on an unknown shape", () => {
    expect(() => userRoutes("const USER_HASH = /a(b|c)/;")).toThrow(/shape/);
    expect(() => userRoutes("const USER_HASH = /^#\\/(a(b|c))$/;")).toThrow(/shape/);
    expect(() => userRoutes("nothing here")).toThrow(/not found/);
  });

  it("adminRoutes finds the detail section", () => {
    const sample = ['    if (section === "a") x = await renderA(main);', '    else if (section === "b") x = renderB(main, arg);', '    else if (section === "b2" && other) y();'].join("\n");
    expect(adminRoutes(sample)).toEqual({ sections: ["#/a", "#/b", "#/b2"], detail: ["#/b/:"] });
  });

  it("tableRows returns [] for a missing heading", () => {
    expect(tableRows("## A\n| x |\n|---|\n| 1 |\n", "## B")).toEqual([]);
    expect(tableRows("## A\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\ntext\n", "## A")).toEqual([["1", "2"]]);
  });
});

describe("the inventory matches the code", () => {
  it("lists every admin route, both ways", () => {
    expect(admin.sections.length).toBeGreaterThanOrEqual(15);
    expect(admin.detail.length).toBeGreaterThanOrEqual(3);
    const expected = [...admin.sections, ...admin.detail];
    const d = diff(adminCells.map(asDetail), expected);
    expect(d, "missing = in route() but not in ## Admin display; extra = the reverse").toEqual({ missing: [], extra: [] });
    expect(new Set(adminCells).size).toBe(adminCells.length);
  });

  it("lists every user route, both ways", () => {
    const d = diff(userCells, userRoutes(authSource).map((r) => `/user/${r}`));
    expect(d).toEqual({ missing: [], extra: [] });
  });

  it("isUserHash accepts every parsed user route", () => {
    for (const r of userRoutes(authSource)) expect(auth.isUserHash(r.replace(":id", "x-1")), r).toBe(true);
  });

  it("gives every row the nav label of its page in ui/ia.js (— for a detail page)", async () => {
    const { PAGES } = (await import("../ui/ia.js" as string)) as { PAGES: { path: string; nav: string; label: Record<string, string> }[] };
    for (const [role, prefix, rows] of [["admin", "", adminRows], ["user", "/user/", userRows]] as const) {
      for (const r of rows) {
        const page = PAGES.find((p) => p.path === code(r[0]!).slice(prefix.length));
        expect(page, `${r[0]}: no page in ui/ia.js`).toBeDefined();
        expect(r[1], `${r[0]}: nav label`).toBe(page!.nav === "detail" ? "—" : page!.label[role] ?? "—");
      }
    }
  });

  it("has a data-nav link in each HTML file for every primary destination and action", async () => {
    const { primaryFor, actionsFor } = (await import("../ui/ia.js" as string)) as {
      primaryFor: (r: string) => { id: string; label: string }[];
      actionsFor: (r: string) => { id: string; label: string }[];
    };
    for (const [file, role] of [["ui/index.html", "admin"], ["ui/user/index.html", "user"]] as const) {
      const links = navLinks(read(file)).map((l) => ({ id: l.name, label: l.text }));
      const want = [...actionsFor(role), ...primaryFor(role)].map((l) => l.id);
      expect(links.map((l) => l.id).sort(), file).toEqual(want.sort());
    }
  });

  it("has the special addresses", () => {
    const text = sectionText(inventory, "## Special addresses");
    expect(text).toContain("`#/set-password/:token`");
    expect(text).toContain("`/user/?as=<id>`");
    const firsts = tableRows(inventory, "## Special addresses").map((r) => r[0]!);
    expect(firsts.filter((c) => /no hash/.test(c)).length).toBeGreaterThanOrEqual(2);
    expect(firsts.filter((c) => /unknown hash/.test(c)).length).toBeGreaterThanOrEqual(2);
  });

  it("covers every route in States and Responsive layout, both ways", () => {
    const all = [...adminCells, ...userCells];
    for (const heading of ["## States", "## Responsive layout"]) {
      const cells = tableRows(inventory, heading).map((r) => code(r[0]!));
      expect(diff(cells, all), heading).toEqual({ missing: [], extra: [] });
    }
  });
});

describe("the dialogs match the code", () => {
  const files = uiFiles().filter((f) => f !== "ui/dom.js");
  const dialogs = tableRows(doc("dialogs.md"), "## Dialogs");
  const natives = tableRows(doc("dialogs.md"), "## Native dialogs");

  it("has a row for every modal call site, with unique (file, dialog) keys", () => {
    let total = 0;
    for (const f of files) {
      const src = read(f);
      const sites = count(src, /\bmodal\(/g);
      if (!sites) continue;
      total += sites;
      const rows = dialogs.filter((r) => code(r[0]!) === f);
      const need = f === "ui/users.js" ? Math.max(sites, count(src, /\bcallDialog\(\{/g) - 1) : sites;
      expect(rows.length, `${f}: ${rows.length} rows for ${need} variants`).toBeGreaterThanOrEqual(need);
    }
    expect(total).toBeGreaterThanOrEqual(23);
    const keys = dialogs.map((r) => `${code(r[0]!)}|${r[1]}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of dialogs) expect(files, `unknown file in dialogs: ${r[0]}`).toContain(code(r[0]!));
  });

  it("has a row for every native confirm or prompt", () => {
    for (const f of files) {
      const rows = natives.filter((r) => code(r[0]!).split(":")[0] === f);
      expect(rows.length, `${f}: one row per native call`).toBe(count(read(f), /\b(confirm|prompt)\(/g));
    }
    for (const r of natives) {
      const [f, line] = code(r[0]!).split(":") as [string, string];
      const text = read(f).split("\n")[Number(line) - 1] ?? "";
      expect(/\b(confirm|prompt)\(/.test(text), `${r[0]} is not a confirm or prompt line`).toBe(true);
    }
    expect(new Set(natives.map((r) => code(r[0]!))).size).toBe(natives.length);
  });
});

describe("inline styles", () => {
  it("lists every file with a style: use and its count, both ways", () => {
    const table: Record<string, number> = {};
    for (const r of tableRows(inventory, "## Inline styles")) table[code(r[0]!)] = Number(r[1]);
    const source: Record<string, number> = {};
    for (const f of uiFiles()) {
      const n = count(read(f), /style\s*:/g);
      if (n > 0) source[f] = n;
    }
    expect(table).toEqual(source);
    const total = Object.values(source).reduce((a, b) => a + b, 0);
    expect(sectionText(inventory, "## Inline styles")).toContain(`Total ${total} in ${Object.keys(source).length} files.`);
  });
});

describe("the documents", () => {
  const names = ["README.md", "inventory.md", "dialogs.md", "journeys.md", "findings.md", "measurement.md"];

  it("exist, are linked from README.md and stay short", () => {
    const readme = doc("README.md");
    for (const n of names.slice(1)) expect(readme, n).toContain(n);
    expect(readme).toContain("Status: partial");
    for (const n of names) expect(doc(n).split("\n").length, n).toBeLessThan(500);
  });

  it("types every finding and has the closing sections", () => {
    const findings = doc("findings.md");
    const blocks = findings.split(/^### (?=F\d+)/m).slice(1).map((b) => b.split(/^#{1,3} /m)[0]!);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(/\*\*(Structural|Visual)\*\*/.test(b), b.split("\n")[0]).toBe(true);
    expect(blocks.some((b) => b.includes("**Structural**"))).toBe(true);
    expect(blocks.some((b) => b.includes("**Visual**"))).toBe(true);
    expect(findings).toMatch(/^## Candidates \(not measured\)$/m);
    expect(findings).toMatch(/^## Consolidation candidates$/m);
  });

  it("has a results table with five tasks and no invented measurements", () => {
    const measurement = doc("measurement.md");
    const rows = tableRows(measurement, "## Results");
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r[1], "Nav steps").toMatch(/^\d+$/);
      expect(r[2], "Modelled s").toMatch(/^\d+(\.\d+)?$/);
      expect([r[3], r[4], r[5]], `${r[0]}: measured, errors, confidence are open`).toEqual(["", "", ""]);
    }
  });

  it("keeps the browser test's baseline in step with the table in measurement.md", () => {
    const rows = tableRows(doc("measurement.md"), "## The five tasks");
    expect(rows.map((r) => r[0])).toEqual(["1", "2", "3", "4", "5"]);
    for (const r of rows) {
      const id = Number(r[0]) as TaskId;
      expect(TASKS[id], `task ${r[0]}`).toBe(r[1]);
      for (const cell of [r[4], r[5], r[6]]) expect(cell, `task ${r[0]}: a count`).toMatch(/^\d+$/);
      expect({ nav: Number(r[4]), clicks: Number(r[5]), fields: Number(r[6]) }, `task ${r[0]}`).toEqual(BASELINE[id]);
    }
  });

  it("finds the measures that are above the baseline", () => {
    expect(over({ nav: 2, clicks: 3, fields: 1 }, { nav: 1, clicks: 2, fields: 1 })).toEqual(["nav 2 > 1", "clicks 3 > 2"]);
    expect(over(BASELINE[4], BASELINE[4])).toEqual([]);
    expect(effortText(BASELINE[1])).toBe("1 / 2 / 1");
  });

  it("names a follow-up for every task that is above the baseline, and only for those", () => {
    for (const id of [1, 2, 3, 4, 5] as TaskId[]) {
      expect(over(REDESIGN[id], BASELINE[id]).length > 0, `task ${id}`).toBe(KNOWN_OVER[id] !== undefined);
    }
  });

  it("names the widths and every screenshot in docs/images", () => {
    const measurement = doc("measurement.md");
    for (const w of ["1440", "1280", "768", "390"]) expect(measurement).toContain(w);
    const pngs = readdirSync("docs/images").filter((f) => f.endsWith(".png"));
    expect(pngs.length).toBeGreaterThan(0);
    for (const p of pngs) expect(measurement, p).toContain(p);
  });
});
