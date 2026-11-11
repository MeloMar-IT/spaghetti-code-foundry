import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextStep } from "../src/next-step.js";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { parseCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let words: any;
let model: any;
let view: any;
let homeMod: any;
beforeAll(async () => {
  restore = installFakeDom();
  homeMod = await import("../ui/simple-home.js" as string);
  words = await import("../ui/simple-words.js" as string);
  model = await import("../ui/simple-model.js" as string);
  view = await import("../ui/simple.js" as string);
});
afterAll(() => restore());

const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const box = (nodes: any[]) => {
  const root = new FakeElement("div");
  root.append(...nodes.filter(Boolean));
  return root;
};
const texts = (root: FakeElement) => [root, ...walk(root)].flatMap((e) => [e.children.filter((c) => typeof c === "string").join(""), e.attrs["aria-label"] ?? "", e.attrs.title ?? ""]);
const iso = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) - min * 60_000).toISOString();
const run = (id: string, kind: any, over: any = {}) => ({
  runId: id, flow: "issue-gitflow", task: `Show the weather (#12)\n\n**Epic:** x\n\nShows the weather for a city. More.`, status: "running", startedAt: iso(10),
  vars: { github_repo: "o/app", issue: "12" }, history: [], next: nextStep(kind, { runId: id, repo: "o/app", title: "Show the weather (#12)" } as any), ...over,
});
const repos = [{ id: "r1", url: "https://github.com/o/app", github: "o/app" }, { id: "r2", url: "https://github.com/o/other", github: "o/other" }];
const hm = (runs: any[], opts: any = {}) => model.homeModel(runs, [], repos, model.projectsModel(repos, runs, []), opts);
const draw = (m: any, look = "midnight") => box(homeMod.homeLayout(m, look));
const wrapOf = (page: FakeElement) => page.all("div")[0]!;
const kids = (el: FakeElement) => el.children.filter((c: any) => c instanceof FakeElement) as FakeElement[];
const order = (el: FakeElement) => kids(el).map((c) => c.tag + (c.attrs.class ? "." + c.attrs.class.split(" ")[0] : ""));
const building = (id: string, over: any = {}) => run(id, "running", { state: { next: "implement" }, ...over });

const three = [run("a", "questions"), run("p", "approve_plan"), run("s", "failed", { status: "failed" })];

describe("the list layout of the Simple home", () => {
  it("is drawn for Midnight and Editorial, in the given order", () => {
    for (const look of ["midnight", "editorial"]) {
      const wrap = wrapOf(draw(hm([...three, building("b")]), look));
      expect(wrap.attrs["data-layout"]).toBe("list");
      expect(order(wrap)).toEqual(["h1.simple-home-headline", "section.simple-home-rows", "nav.today-counters", "section.today-building", "section.simple-card", "section.simple-card"]);
    }
    const open = wrapOf(draw(hm(three, { list: "check" })));
    expect(order(open).slice(0, 4)).toEqual(["h1.simple-home-headline", "section.simple-home-rows", "nav.today-counters", "section.today-list"]);
  });

  it("says how many things need the person", () => {
    const text = (runs: any[]) => draw(hm(runs)).all("h1")[0]!.textContent;
    expect(text(three)).toBe("3 things need you");
    expect(text([three[0]!])).toBe("1 thing needs you");
    expect(text([])).toBe("Nothing needs you");
    const none = wrapOf(draw(hm([])));
    expect(order(none).includes("section.simple-home-rows")).toBe(false);
  });

  it("draws numbered rows with a tag and one button", () => {
    const rows = draw(hm(three)).all("li").filter((l) => l.attrs.class === "simple-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.all("span")[0]!.textContent)).toEqual(["01", "02", "03"]);
    for (const r of rows) {
      expect(r.all("span")[0]!.attrs["aria-hidden"]).toBe("true");
      expect(r.all("h3")).toHaveLength(1);
      expect(r.all("p").length).toBeGreaterThan(0);
      expect(r.all("a").filter((a) => a.attrs.class === "btn primary")).toHaveLength(1);
      const cause = r.all("details")[0]!;
      expect(cause.attrs.class).toBe("today-cause");
      expect(cause.all("summary")[0]!.attrs["data-focus"]).toMatch(/^simple-today-cause-/);
    }
    const tags = rows.map((r) => r.all("span").find((s) => s.attrs.class?.includes("simple-row-tag"))!);
    expect(tags.map((t) => t.textContent)).toEqual(["Question", "To check", "Stuck"]);
    expect(tags.map((t) => t.attrs.class)).toEqual(["pill sem-info simple-row-tag", "pill sem-accent simple-row-tag", "pill sem-danger simple-row-tag"]);
  });

  it("shows five rows and says how many more", () => {
    const seven = ["1", "2", "3", "4", "5", "6", "7"].map((i) => run(`q${i}`, "questions"));
    const page = draw(hm(seven));
    expect(page.all("li").filter((l) => l.attrs.class === "simple-row")).toHaveLength(5);
    const more = page.all("a").find((a) => a.textContent === "+2 more")!;
    expect(more.attrs.href).toBe("#/home?list=check");
  });

  it("has the same counters as the cards layout", () => {
    const m = hm([...three, building("b")]);
    const nav = (p: FakeElement) => p.all("nav")[0]!.all("a").map((a) => [a.attrs.href, a.textContent]);
    expect(nav(draw(m))).toEqual(nav(draw(m, "calm")));
    expect(nav(draw(m))[0]).toEqual(["#/home?list=check", "3 Needs you"]);
  });

  it("draws Building now in columns with a thin progress bar", () => {
    const page = draw(hm([building("b")]));
    const sec = page.all("section").find((s) => s.attrs.class === "today-building")!;
    expect(sec.all("h2")[0]!.textContent).toBe("Building now");
    const cols = sec.all("li").filter((l) => l.attrs.class === "simple-column");
    expect(cols).toHaveLength(1);
    const bar = cols[0]!.all("progress")[0]!;
    expect(bar.attrs.max).toBe("5");
    expect(Number((bar as any).value)).toBe(3);
    expect(bar.attrs["aria-label"]).toMatch(/^Progress: .+/);
    expect(cols[0]!.all("h3")[0]!.all("a")).toHaveLength(1);
  });

  it("says so when nothing runs", () => {
    const none = draw(hm([]));
    expect(none.all("progress")).toHaveLength(0);
    expect(none.all("p").some((p) => p.textContent === "Nothing is running right now.")).toBe(true);
  });

  it("shows five columns and says how many more", () => {
    const six = ["1", "2", "3", "4", "5", "6"].map((i) => building(`b${i}`));
    const page = draw(hm(six));
    expect(page.all("li").filter((l) => l.attrs.class === "simple-column")).toHaveLength(5);
    expect(page.all("a").some((a) => a.textContent === "+1 more")).toBe(true);
  });

  it("computes the bar value from the phase", () => {
    for (const [phase, v] of [[null, 0], [{ index: 0 }, 1], [{ index: 4 }, 5], [{ index: 9 }, 5], [{ index: -1 }, 0], [{ index: "2" }, 0]] as any[]) {
      expect(homeMod.barValue(phase), JSON.stringify(phase)).toBe(v);
    }
  });

  it("puts the opened list right after the counters", () => {
    const wrap = wrapOf(draw(hm([run("r", "approve_plan", { status: "waiting" })], { list: "ready" })));
    const names = order(wrap);
    expect(names[names.indexOf("nav.today-counters") + 1]).toBe("section.today-list");
    expect(wrap.all("a").some((a) => a.textContent === "Back to Today")).toBe(true);
  });

  it("has no forbidden term, passes the audit and has unique focus names on the whole home", () => {
    const m = hm([...three, building("b"), building("c")], { list: "check" });
    const page = box([...homeMod.homeLayout(m, "midnight"), ...view.projectsView(model.projectsModel(repos, [...three], []))]);
    expect(words.forbiddenIn(texts(page).join("\n"))).toEqual([]);
    expect(audit(page)).toEqual([]);
    const levels = walk(page).filter((e) => /^h\d$/.test(e.tag)).map((e) => Number(e.tag[1]));
    levels.forEach((l, i) => { if (i) expect(l - levels[i - 1]!).toBeLessThanOrEqual(1); });
    const names = walk(page).filter((e) => e.tag === "a" || e.tag === "summary").map((e) => e.attrs["data-focus"]);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the CSS of the list layout", () => {
  const rules = parseCss(readFileSync("ui/css/pages/simple.css", "utf8"));
  const decl = (selector: string, ctx: (c: string) => boolean) => rules.find((r) => r.selector === selector && ctx(r.context))?.declarations ?? [];
  const base = (c: string) => !c.includes("max-width");
  const phone = (c: string) => c.includes("max-width: 767px");

  it("has three columns, one on a phone, and wraps long words", () => {
    expect(decl(".simple-columns", base)).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(decl(".simple-columns", phone)).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(decl(".simple-row", phone)).toContain("grid-template-columns: auto minmax(0, 1fr)");
    expect(decl(".simple-row", base)).toContain("overflow-wrap: anywhere");
    expect(decl(".simple-column", base)).toContain("overflow-wrap: anywhere");
  });

  it("does not use data-look", () => {
    expect(rules.some((r) => r.selector.includes("data-look"))).toBe(false);
  });
});
