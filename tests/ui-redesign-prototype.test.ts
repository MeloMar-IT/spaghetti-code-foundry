import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// docs/ui-redesign/prototype/ holds static pages (#248). This test reads them as text and keeps them in step with
// the documents and the code. It does not check how the pages look, or the wiring in a real browser (see README.md).

const DIR = "docs/ui-redesign";
const PROTO = `${DIR}/prototype`;
const read = (p: string) => readFileSync(p, "utf8");
const doc = (name: string) => read(`${DIR}/${name}`);
const pages = readdirSync(PROTO).filter((f) => f.endsWith(".html")).sort();
const page = (name: string) => read(`${PROTO}/${name}`);

/** Rows of the first markdown table under a heading; cells trimmed; header and separator dropped. */
function tableRows(text: string, heading: string): string[][] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return [];
  const rows: string[][] = [];
  let started = false;
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (!line.trim().startsWith("|")) {
      if (started) break;
      continue;
    }
    started = true;
    rows.push(line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
  }
  return rows.slice(2);
}

const code = (cell: string): string => /`([^`]*)`/.exec(cell)?.[1] ?? "";
const words = (s: string | undefined): string[] => (s ?? "").split(/\s+/).filter((w) => w && w !== "—");
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

function diff(a: string[], b: string[]): { missing: string[]; extra: string[] } {
  const d = new Set(a);
  const s = new Set(b);
  return { missing: [...s].filter((x) => !d.has(x)).sort(), extra: [...d].filter((x) => !s.has(x)).sort() };
}

/** Both directions of a comparison between declared and used option values. */
const compareOptions = (declared: string[], used: string[]) => diff(declared, used);

type View = { attrs: Record<string, string[]>; body: string };
const attrsOf = (text: string): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const m of text.matchAll(/data-only-(role|state|alt|run)="([^"]*)"/g)) out[m[1]!] = words(m[2]);
  return out;
};
const viewsOf = (html: string): View[] =>
  [...html.matchAll(/<section class="view"([^>]*)>([\s\S]*?)<\/section>/g)].map((m) => ({ attrs: attrsOf(m[1]!), body: m[2]! }));

/** True when a `<section` opens while another is still open. */
function hasNestedView(html: string): boolean {
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)section\b/g)) {
    depth += m[1] ? -1 : 1;
    if (depth > 1) return true;
  }
  return false;
}

const badEmails = (text: string): string[] => (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).filter((e) => !e.endsWith("@example.test"));

const htmlOptions = (html: string) => {
  const tag = /<html [^>]*>/.exec(html)?.[0] ?? "";
  const get = (n: string) => new RegExp(`${n}="([^"]*)"`).exec(tag)?.[1];
  return { alts: words(get("data-alts")), states: words(get("data-states")), runs: words(get("data-runs")), tag };
};
const used = (html: string, kind: string) => sorted([...html.matchAll(new RegExp(`data-only-${kind}="([^"]*)"`, "g"))].flatMap((m) => words(m[1])));

const navOf = (html: string) => /<nav class="side"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
const navCount = (file: string) => (read(file).match(/data-nav="/g) ?? []).length;

// ── proto.js, loaded with node:vm and the fake DOM ──

let restore: () => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Proto: any;
beforeAll(() => {
  restore = installFakeDom();
  const ctx = vm.createContext({ document: (globalThis as unknown as { document: unknown }).document });
  vm.runInContext(read(`${PROTO}/proto.js`), ctx);
  Proto = (ctx as { Proto: unknown }).Proto;
});
afterAll(() => restore());
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("helpers (failure paths)", () => {
  it("tableRows returns [] for a missing heading", () => {
    expect(tableRows("## A\n| x |\n|---|\n| 1 |\n", "## B")).toEqual([]);
    expect(tableRows("## A\n\n| x | y |\n|---|---|\n| 1 | |\n\ntext\n", "## A")).toEqual([["1", ""]]);
  });

  it("the option comparison reports one missing and one extra state", () => {
    expect(compareOptions(["data", "empty"], ["data", "loading"])).toEqual({ missing: ["loading"], extra: ["empty"] });
  });

  it("the nesting check flags a view inside a view", () => {
    expect(hasNestedView('<section class="view"><section class="view"></section></section>')).toBe(true);
    expect(hasNestedView('<section class="view"></section><section class="view"></section>')).toBe(false);
  });

  it("the e-mail check flags a@b.com", () => {
    expect(badEmails("a@b.com and ana@example.test")).toEqual(["a@b.com"]);
  });
});

describe("files", () => {
  it("lists every page in prototypes.md, both ways", () => {
    const rows = tableRows(doc("prototypes.md"), "## Pages").map((r) => code(r[0]!));
    expect(pages).toHaveLength(7);
    expect(diff(rows, pages)).toEqual({ missing: [], extra: [] });
  });

  it("names the documents in README.md and keeps every new file short", () => {
    const readme = doc("README.md");
    for (const n of ["prototypes.md", "walkthroughs.md", "decisions.md", "prototype/"]) expect(readme, n).toContain(n);
    expect(readme).toContain("Status: partial");
    expect(readme).toContain("What is not checked");
    for (const f of [...pages.map((p) => `${PROTO}/${p}`), `${PROTO}/proto.css`, `${PROTO}/proto.js`, ...["prototypes.md", "walkthroughs.md", "decisions.md"].map((n) => `${DIR}/${n}`)]) {
      expect(read(f).split("\n").length, f).toBeLessThan(500);
    }
  });
});

describe("self-contained and private", () => {
  it("loads only proto.css and proto.js", () => {
    for (const p of pages) {
      const html = page(p);
      expect([...html.matchAll(/<link [^>]*href="([^"]*)"/g)].map((m) => m[1]), p).toEqual(["proto.css"]);
      expect([...html.matchAll(/<script [^>]*src="([^"]*)"/g)].map((m) => m[1]), p).toEqual(["proto.js"]);
    }
  });

  it("has no network address, no fetch and no import", () => {
    for (const f of [...pages, "proto.css", "proto.js"]) expect(read(`${PROTO}/${f}`), f).not.toMatch(/https?:\/\/(?!github\.com\/example\/)/);
    const js = read(`${PROTO}/proto.js`);
    for (const re of [/fetch\(/, /XMLHttpRequest/, /\/api\//, /\bimport\b/]) expect(js, String(re)).not.toMatch(re);
    expect(JSON.stringify(JSON.parse(read("package.json")).files)).not.toContain("docs/ui-redesign");
  });

  it("uses only example addresses and repositories, and no local path", () => {
    const all = [...pages.map((p) => `${PROTO}/${p}`), `${PROTO}/proto.css`, `${PROTO}/proto.js`, ...["prototypes.md", "walkthroughs.md", "decisions.md"].map((n) => `${DIR}/${n}`)];
    for (const f of all) {
      const text = read(f);
      expect(badEmails(text), f).toEqual([]);
      expect(text, f).not.toMatch(/\/Users\/|\/home\//);
    }
    for (const p of pages) {
      for (const m of page(p).matchAll(/class="repo">([^<]*)</g)) expect(m[1], p).toMatch(/^example\//);
    }
  });
});

describe("tokens", () => {
  it("has every colour token of ui/style.css with the same value, both themes", () => {
    const css = read("ui/style.css");
    const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]!).filter((b) => b.includes("--bg:"));
    expect(blocks.length).toBe(2);
    const proto = read(`${PROTO}/proto.css`);
    for (const b of blocks) for (const m of b.matchAll(/(--[\w-]+):\s*([^;]+);/g)) expect(proto, `${m[1]}: ${m[2]}`).toContain(`${m[1]}: ${m[2]};`);
    expect(proto).toContain('html[data-theme="dark"]');
    expect(proto).toContain('html[data-theme="light"]');
    expect(proto).toMatch(/@container[^{]*\(max-width: 760px\)/);
  });
});

describe("navigation", () => {
  it("has the same nav block on all seven pages", () => {
    const first = navOf(page(pages[0]!));
    expect(first).toContain("<nav");
    for (const p of pages) expect(navOf(page(p)), p).toBe(first);
  });

  it("has fewer first-level links than today, and Board, Flows and Administration are admin only", () => {
    const nav = navOf(page("index.html"));
    const links = [...nav.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(links.length).toBeLessThanOrEqual(7);
    expect(links.length).toBeLessThan(navCount("ui/index.html"));
    expect(links.filter((l) => !l.includes('data-only-role="admin"')).length).toBeLessThanOrEqual(navCount("ui/user/index.html"));
    for (const name of ["Board", "Flows", "Administration"]) {
      const link = links.find((l) => l.includes(`>${name}<`));
      expect(link, name).toBeDefined();
      expect(link, name).toContain('data-only-role="admin"');
    }
  });
});

describe("options and states", () => {
  const matrix = tableRows(doc("prototypes.md"), "## State matrix");

  it("declares the five defaults on every page", () => {
    for (const p of pages) {
      const { tag } = htmlOptions(page(p));
      for (const d of ['data-role="admin"', 'data-theme="auto"', 'data-width="wide"', 'data-state="data"', 'data-alt="a"']) expect(tag, `${p} ${d}`).toContain(d);
    }
  });

  it("uses exactly the declared alternatives, states and runs, and the state matrix says the same", () => {
    expect(matrix).toHaveLength(pages.length);
    for (const p of pages) {
      const html = page(p);
      const o = htmlOptions(html);
      expect(compareOptions(o.alts, used(html, "alt")), `${p} alternatives`).toEqual({ missing: [], extra: [] });
      expect(compareOptions(o.states, used(html, "state")), `${p} states`).toEqual({ missing: [], extra: [] });
      expect(compareOptions(o.runs, used(html, "run")), `${p} runs`).toEqual({ missing: [], extra: [] });
      const row = matrix.find((r) => code(r[0]!) === p);
      expect(row, p).toBeDefined();
      expect(sorted(words(row![1])), `${p} matrix alternatives`).toEqual(sorted(o.alts));
      expect(sorted(words(row![2])), `${p} matrix states`).toEqual(sorted(o.states));
      expect(sorted(words(row![3])), `${p} matrix runs`).toEqual(sorted(o.runs));
    }
  });

  it("never nests views and never shows a blank page", () => {
    for (const p of pages) {
      const html = page(p);
      expect(hasNestedView(html), `${p} nests views`).toBe(false);
      const o = htmlOptions(html);
      const views = viewsOf(html);
      expect(views.length, p).toBeGreaterThan(0);
      const combos: Record<string, string>[] = [];
      for (const alt of o.alts) {
        for (const state of alt === "a" ? o.states : ["data"]) for (const run of o.runs.length ? o.runs : [""]) combos.push({ alt, state, run });
      }
      for (const role of ["admin", "user"]) {
        for (const c of combos) {
          const ok = views.some((v) => v.attrs.role?.includes(role) !== false && [["alt", c.alt], ["state", c.state], ["run", c.run]].every(([k, val]) => !v.attrs[k!] || v.attrs[k!]!.includes(val!)));
          expect(ok, `${p}: role ${role}, alt ${c.alt}, state ${c.state}, run ${c.run || "-"} shows nothing`).toBe(true);
        }
      }
    }
  });
});

describe("permissions", () => {
  it("shows a prototype note, not a product screen, on Board and Administration for a user", () => {
    for (const p of ["board.html", "admin.html"]) {
      const v = viewsOf(page(p)).find((x) => x.attrs.role?.join() === "user");
      expect(v, p).toBeDefined();
      expect(v!.body).toContain('class="proto-note"');
      expect(v!.body).toContain('href="home.html"');
    }
    for (const p of pages) expect(page(p).toLowerCase(), p).not.toMatch(/do not have access|not allowed/);
  });

  it("answers not found with one card for both roles", () => {
    const text = /export const NOT_FOUND = "([^"]*)";/.exec(read("ui/user/runs.js"))![1]!;
    const v = viewsOf(page("run.html")).find((x) => x.attrs.state?.join() === "notfound");
    expect(v).toBeDefined();
    expect(v!.attrs.role).toBeUndefined();
    expect(v!.body).toContain(text);
  });

  it("makes owner, cost, transcript, health and since admin only", () => {
    for (const p of pages) {
      for (const m of page(p).matchAll(/<[a-z0-9]+ [^>]*class="([^"]*)"[^>]*>/g)) {
        if (!words(m[1]).some((c) => ["owner", "cost", "transcript", "health", "since"].includes(c))) continue;
        expect(m[0], `${p}: ${m[0]}`).toContain('data-only-role="admin"');
      }
    }
  });
});

describe("health, since and the old run", () => {
  const rows = tableRows(doc("prototypes.md"), "## Health and since");

  it("maps every name and finds it in the code", () => {
    const names = rows.map((r) => code(r[0]!));
    for (const n of ["summary", "problems", "closed_elsewhere", "monitorFindings", "repos", "version", "update", "does not answer", "done", "develop", "released", "failed", "waiting", "notes", "Dismiss"]) expect(names, n).toContain(n);
    for (const r of rows) expect(read(code(r[1]!)), `${r[0]} in ${r[1]}`).toContain(code(r[0]!));
  });

  it("shows the server error in the error state of index.html", () => {
    const text = /const NO_ANSWER = "([^"]*)";/.exec(read("ui/health.js"))![1]!;
    const v = viewsOf(page("index.html")).find((x) => x.attrs.state?.join() === "error");
    expect(v!.body).toContain(text);
  });

  it("has an old run in the list and no filled button on its page", () => {
    expect(page("runs.html")).toContain('data-run="old"');
    const v = viewsOf(page("run.html")).find((x) => x.attrs.run?.join() === "old" && x.attrs.alt?.join() === "a");
    expect(v).toBeDefined();
    expect(v!.body).not.toContain("primary");
  });
});

describe("routes and the board", () => {
  const inv = doc("inventory.md");
  const expected = ["## Admin display", "## User display", "## Special addresses"].flatMap((h) => tableRows(inv, h).map((r) => r[0]!));
  const routes = tableRows(doc("prototypes.md"), "## Routes");

  it("has a row for every address of the audit, and all of them still work", () => {
    expect(expected.length).toBeGreaterThanOrEqual(36);
    expect(diff(routes.map((r) => r[0]!), expected).missing).toEqual([]);
    for (const r of routes) {
      expect(r[3], r[0]).toBe("yes");
      if (!expected.includes(r[0]!)) expect(r[4], `${r[0]} is not in inventory.md`).toMatch(/^new\b/);
    }
  });

  it("uses every board column title", () => {
    const src = read("src/board.ts");
    const block = /export const COLUMNS[\s\S]*?\n\];/.exec(src)![0];
    const titles = [...block.matchAll(/title: "([^"]+)"/g)].map((m) => m[1]!);
    expect(titles.length).toBe(9);
    for (const t of titles) expect(page("board.html"), t).toContain(t);
  });
});

describe("walkthroughs", () => {
  const walk = doc("walkthroughs.md");
  const measurement = doc("measurement.md");
  const journeys = doc("journeys.md");
  const five = tableRows(walk, "## The five tasks");
  const key = (r: string[]) => `${r[0]!.split(" ")[0]}|${r[1]}|${r[2]}`;
  const triple = (s: string) => s.split("/").map((x) => Number(x.trim()));
  // The baseline of each row, and the line of journeys.md it was copied from.
  const held: Record<string, { line: string; base: number[] }> = {
    "1|user|Empty": { line: "| user, Empty | 1 | 2 | 1 |", base: [1, 2, 1] },
    "1|user|Base": { line: "| user, Base | 2 | 3 | 1 |", base: [2, 3, 1] },
    "1|admin|Base": { line: "| admin, Base | 2 | 3 | 1 |", base: [2, 3, 1] },
    "2|admin|—": { line: "| J2 Approve | admin, Your turn | 1 | 2 | 0 |", base: [1, 2, 0] },
    "2|user|—": { line: "| J2 Approve | user | 2 | 3 | 0 |", base: [2, 3, 0] },
    "3|admin|—": { line: "| J4 Diagnose | admin | 2 | 3 | 0 |", base: [2, 3, 0] },
    "3|user|—": { line: 'click the "Steps" tab | 1 | 2 |', base: [1, 2, 0] },
    "4|user|—": { line: "| J6 Add repository | user | 2 | 5 | 2 |", base: [2, 5, 2] },
    "4|admin|—": { line: "| admin, via `#/repos` | 2 | 5 | 2 |", base: [2, 5, 2] },
    "5|user|—": { line: "| J7 Refine | user | 3 | 5 | 2 |", base: [3, 5, 2] },
  };

  it("has 11 rows with whole numbers, none longer than its baseline", () => {
    expect(five).toHaveLength(11);
    for (const r of five) {
      const mine = [r[4], r[5], r[6]].map((x) => Number(x));
      for (const n of mine) expect(Number.isInteger(n), `${r[0]} ${r[1]}`).toBe(true);
      const base = triple(r[7]!);
      expect(base).toHaveLength(3);
      mine.forEach((n, i) => expect(n, `${key(r)} column ${i}`).toBeLessThanOrEqual(base[i]!));
    }
  });

  it("copies the baselines from journeys.md and measurement.md", () => {
    for (const [k, h] of Object.entries(held)) {
      expect(journeys, `${k}: line not in journeys.md any more`).toContain(h.line);
      const r = five.find((x) => key(x) === k);
      expect(r, k).toBeDefined();
      expect(triple(r![7]!), k).toEqual(h.base);
    }
    const m = tableRows(measurement, "## The five tasks");
    expect(m).toHaveLength(5);
    for (const [k, task] of [["1|user|Empty", "1"], ["2|admin|—", "2"], ["3|admin|—", "3"], ["4|user|—", "4"], ["5|user|—", "5"]] as const) {
      const row = m.find((x) => x[0] === task)!;
      expect(triple(five.find((x) => key(x) === k)![7]!), k).toEqual([Number(row[4]), Number(row[5]), Number(row[6])]);
    }
  });

  it("counts the admin Refine baseline from the code", () => {
    const r = five.find((x) => key(x) === "5|admin|—")!;
    expect(triple(r[7]!)).toEqual([3, 5, 2]);
    expect(r[8]).toContain("ui/refinement.js");
    expect(read("ui/refinement.js")).toContain("New session");
  });

  it("walks every alternative of decisions.md through its tasks, for both roles or 'no access'", () => {
    const decisions = tableRows(doc("decisions.md"), "## Decisions");
    const alts = sorted(decisions.map((r) => /^([SHBLRPA][123]):/.exec(r[2]!)?.[1] ?? "").filter(Boolean));
    expect(alts).toEqual(["A1", "A2", "B1", "B2", "H1", "H2", "L1", "L2", "P1", "P2", "R1", "R2", "S1", "S2", "S3"]);
    const rows = tableRows(walk, "## Alternatives");
    const tasks: Record<string, string[]> = {
      S: ["1 Start work", "4 Add repository", "5 Refine"],
      H: ["1 Start work", "2 Approve", "3 Diagnose"],
      B: ["2 Approve", "3 Diagnose"],
      L: ["2 Approve", "3 Diagnose"],
      R: ["2 Approve", "3 Diagnose"],
      P: ["4 Add repository", "Find repository settings"],
      A: ["Reach Users", "Reach Settings"],
    };
    for (const r of rows) {
      expect(["admin", "user"], `${r[0]} ${r[1]}`).toContain(r[2]);
      for (const c of [r[3], r[4], r[5]]) expect(c, `${r[0]} ${r[1]}`).toMatch(/^(\d+|no access)$/);
    }
    for (const a of alts) {
      const mine = rows.filter((r) => r[0] === a);
      for (const t of tasks[a[0]!]!) {
        expect(mine.some((r) => r[1] === t && r[2] === "admin"), `${a} ${t} admin`).toBe(true);
        expect(mine.some((r) => r[2] === "user" && (r[1] === t || r[3] === "no access")), `${a} ${t} user`).toBe(true);
      }
    }
  });

  it("has 8 locate rows within two clicks and an action for every page and both roles", () => {
    const locate = tableRows(walk, "## Locate");
    expect(locate).toHaveLength(8);
    for (const r of locate) expect(Number(r[4]), r[0]).toBeLessThanOrEqual(2);
    const actions = tableRows(walk, "## Primary action");
    expect(diff(actions.map((r) => code(r[0]!)), pages)).toEqual({ missing: [], extra: [] });
    for (const r of actions) {
      expect(r[1], r[0]).not.toBe("");
      expect(r[2], r[0]).not.toBe("");
    }
  });

  it("leaves the cells of both check sheets empty", () => {
    const usability = tableRows(walk, "## Usability check sheet");
    const visual = tableRows(walk, "## Visual check sheet");
    expect(usability.length).toBeGreaterThanOrEqual(5);
    expect(visual).toHaveLength(pages.length);
    for (const r of usability) expect(r.slice(-3), r[0]).toEqual(["", "", ""]);
    for (const r of visual) expect(r.slice(-3), r[0]).toEqual(["", "", ""]);
  });
});

describe("decisions", () => {
  const text = doc("decisions.md");
  const rows = tableRows(text, "## Decisions");
  const findings = new Set([...doc("findings.md").matchAll(/^### (F\d+)/gm)].map((m) => m[1]!));
  const alts = new Set(tableRows(doc("walkthroughs.md"), "## Alternatives").map((r) => r[0]!));

  it("gives every row a status, a reason and existing evidence", () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const r of rows) {
      expect(["Accepted", "Rejected"], r[0]).toContain(r[3]);
      expect(r[4], r[0]).not.toBe("");
      const tokens = [...(r[5] ?? "").matchAll(/\b(F\d+|[SHBLRPA][123])\b/g)].map((m) => m[1]!);
      expect(tokens.length, `${r[0]} names no evidence`).toBeGreaterThan(0);
      for (const t of tokens) expect(t.startsWith("F") ? findings.has(t) : alts.has(t), `${r[0]}: ${t} does not exist`).toBe(true);
    }
  });

  it("has an accepted and a rejected decision for each of the seven surfaces", () => {
    const surfaces = sorted(rows.map((r) => r[1]!));
    expect(surfaces).toEqual(["Administration", "Board", "Home", "Repositories", "Run", "Runs", "Shell"]);
    for (const s of surfaces) {
      expect(rows.some((r) => r[1] === s && r[3] === "Accepted"), `${s} accepted`).toBe(true);
      expect(rows.some((r) => r[1] === s && r[3] === "Rejected"), `${s} rejected`).toBe(true);
    }
  });

  it("covers the seven patterns", () => {
    const patterns = tableRows(text, "## Patterns").map((r) => r[0]);
    expect(patterns).toEqual(["Global session access", "Task-state boards", "Master-detail workspaces", "Command search", "Focused side panels", "Display options", "Progressive disclosure"]);
    expect(text).toMatch(/^## Open after the walkthroughs$/m);
  });

  it("records the owner approval only as the run output shows it", () => {
    const at = text.indexOf("\n## Owner approval\n");
    expect(at).toBeGreaterThan(0);
    const section = text.slice(at);
    expect(section).toContain("#248");
    expect(section).toMatch(/^Status: (approved from the plan sketches|proposed)$/m);
    expect(section).toMatch(/^Approved by: .+$/m);
    if (/^Status: proposed$/m.test(section)) expect(section).toMatch(/^Approved by: —$/m);
    expect(section).toContain("any account with write access");
  });
});

describe("proto.js", () => {
  const opts = { alts: ["a", "b"], states: ["data", "empty"], runs: [] as string[] };
  const runOpts = { alts: ["a"], states: ["data"], runs: ["waiting", "failed", "old"] };

  it("reads options from the page", () => {
    const root = new FakeElement("html");
    root.setAttribute("data-alts", "a b");
    root.setAttribute("data-states", "data empty");
    root.setAttribute("data-runs", "waiting failed");
    expect(plain(Proto.options(root))).toEqual({ alts: ["a", "b"], states: ["data", "empty"], runs: ["waiting", "failed"] });
    expect(plain(Proto.options(new FakeElement("html")))).toEqual({ alts: ["a"], states: ["data"], runs: [] });
  });

  it("falls back to the defaults for values it does not know", () => {
    const d = { role: "admin", theme: "auto", width: "wide", state: "data", alt: "a" };
    expect(plain(Proto.read("?role=x", opts))).toEqual(d);
    expect(plain(Proto.read("?state=loading", opts))).toEqual(d);
    expect(plain(Proto.read("?alt=c", opts))).toEqual(d);
    expect(plain(Proto.read("", opts))).toEqual(d);
    expect(plain(Proto.read("?role=user&theme=dark&width=narrow&state=empty", opts))).toEqual({ role: "user", theme: "dark", width: "narrow", state: "empty", alt: "a" });
  });

  it("shows the data state for an alternative other than a", () => {
    expect(Proto.read("?alt=b&state=empty", opts)).toMatchObject({ alt: "b", state: "data" });
  });

  it("reads and writes the run", () => {
    expect(Proto.read("?run=failed", runOpts).run).toBe("failed");
    expect(Proto.read("?run=nope", runOpts).run).toBe("waiting");
    expect(Proto.query({ role: "user", theme: "auto", width: "wide", state: "data", alt: "a", run: "waiting" })).toBe("?role=user");
    expect(Proto.query({ role: "admin", theme: "auto", width: "wide", state: "data", alt: "a" })).toBe("");
    expect(Proto.query({ role: "admin", theme: "dark", width: "wide", state: "empty", alt: "a", run: "old" })).toBe("?theme=dark&state=empty&run=old");
  });

  it("carries role, theme and width to another page, and leaves other links alone", () => {
    const v = { role: "user", theme: "dark", width: "narrow" };
    expect(Proto.carry("runs.html", v)).toBe("runs.html?role=user&theme=dark&width=narrow");
    expect(Proto.carry("run.html?run=failed", v)).toBe("run.html?run=failed&role=user&theme=dark&width=narrow");
    expect(Proto.carry("runs.html?role=admin#x", v)).toBe("runs.html?role=admin&theme=dark&width=narrow#x");
    expect(Proto.carry("#top", v)).toBe("#top");
    expect(Proto.carry("https://github.com/example/app", v)).toBe("https://github.com/example/app");
  });

  it("focuses the autofocus box on open and the opener on close", () => {
    const panel = new FakeElement("div");
    const box = new FakeElement("input");
    box.setAttribute("autofocus", "");
    panel.append(box);
    const opener = new FakeElement("button");
    const active = () => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement;
    panel.hidden = true;
    Proto.toggle(panel, true, opener);
    expect(panel.hidden).toBe(false);
    expect(active()).toBe(box);
    Proto.toggle(panel, false, opener);
    expect(panel.hidden).toBe(true);
    expect(active()).toBe(opener);
  });

  it("maps the keys", () => {
    expect(Proto.key({ key: "k", metaKey: true })).toBe("search");
    expect(Proto.key({ key: "K", ctrlKey: true })).toBe("search");
    expect(Proto.key({ key: "/", target: { tagName: "DIV" } })).toBe("search");
    expect(Proto.key({ key: "/", target: { tagName: "INPUT" } })).toBe("");
    expect(Proto.key({ key: "/", target: { tagName: "TEXTAREA" } })).toBe("");
    expect(Proto.key({ key: "Escape" })).toBe("close");
    expect(Proto.key({ key: "a" })).toBe("");
  });
});

describe("links, panels and primary actions", () => {
  it("has unique ids and a panel for every data-open", () => {
    for (const p of pages) {
      const html = page(p);
      const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
      expect(ids.length, `${p}: duplicate id`).toBe(new Set(ids).size);
      for (const m of html.matchAll(/data-open="([^"]+)"/g)) expect(ids, `${p}: no panel ${m[1]}`).toContain(m[1]);
      for (const m of html.matchAll(/<a [^>]*href="#start"[^>]*>/g)) expect(m[0], p).toContain('data-open="start"');
    }
  });

  it("points every link of an Administration view at an id inside the same view", () => {
    for (const v of viewsOf(page("admin.html"))) {
      const ids = [...v.body.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
      for (const m of v.body.matchAll(/<a [^>]*href="#([^"]+)"/g)) expect(ids, `admin link #${m[1]}`).toContain(m[1]);
    }
  });

  it("opens the panel of the card that was clicked", () => {
    const html = page("board.html");
    const link = (panel: string) => new RegExp(`id="${panel}"[\\s\\S]*?href="([^"]+)"`).exec(html)![1];
    expect(link("cardpw")).toBe("run.html?run=waiting");
    expect(link("cardpf")).toBe("run.html?run=failed");
    for (const m of html.matchAll(/data-open="(cardp\w*)">#317/g)) expect(m[1]).toBe("cardpf");
    for (const m of html.matchAll(/data-open="(cardp\w*)">#300/g)) expect(m[1]).toBe("cardpw");
    expect(html).toContain('#317 Rename the config keys</span><button class="btn small" data-open="cardpf"');
  });

  it("shows a run's own data in R2: a title per run, and a transcript only for the failed run", () => {
    const v = viewsOf(page("run.html")).find((x) => x.attrs.alt?.join() === "b")!;
    for (const r of ["waiting", "running", "failed", "done", "old"]) expect(v.body, r).toContain(`<h1 data-only-run="${r}">`);
    const pre = /<pre class="transcript"[^>]*>/.exec(v.body)![0];
    expect(pre).toContain('data-only-run="failed"');
    expect(pre).toContain('data-only-role="admin"');
    expect(v.body.match(/Code ✗/g)).toHaveLength(1);
  });

  it("shows at most one filled button in each visible view", () => {
    for (const p of pages) {
      const runs = htmlOptions(page(p)).runs;
      for (const v of viewsOf(page(p))) {
        const tags = [...v.body.matchAll(/<(?:a|button)\b[^>]*class="[^"]*\bprimary\b[^"]*"[^>]*>/g)].map((m) => attrsOf(m[0]).run);
        for (const run of runs.length ? runs : [""]) {
          const n = tags.filter((r) => !r || r.includes(run)).length;
          expect(n, `${p} (${JSON.stringify(v.attrs)}) run ${run || "-"}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("keeps the S3 tab row in the page flow at narrow widths", () => {
    expect(read(`${PROTO}/proto.css`)).toMatch(/@container[\s\S]*html\[data-alt="c"\] \.page-index \.side \{ display: flex; position: static/);
  });
});
