import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OUTCOME_DEFINITIONS, outcomeText } from "../src/outcomes.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let o: any;
beforeAll(async () => {
  restore = installFakeDom();
  o = await import("../ui/outcomes.js" as string);
});
afterAll(() => restore());

const answer = (over: Record<string, unknown> = {}): any => ({
  values: { repos: ["acme/app", "acme/web"], flows: ["feature"], models: ["claude:anthropic:opus"], policies: ["baseline@1"] },
  definitions: OUTCOME_DEFINITIONS,
  measures: OUTCOME_DEFINITIONS.map((d) => ({ id: d.id, value: d.id === "issue_to_pr_time" ? 7_200_000 : null, detail: {}, counted: d.id === "issue_to_pr_time" ? 3 : 0, excluded: d.id === "issue_to_pr_time" ? 1 : 4 })),
  ...over,
});
const rows = (el: FakeElement) => el.all("tr").map((r) => r.all("td").map((x) => x.textContent)).filter((r) => r.length > 0);
const note = (what: string, _e: unknown, retry: () => void) => {
  const n = new FakeElement("div");
  n.append(`Could not load ${what}.`);
  (n as any).retry = retry;
  return n;
};
const make = (answers: (p: any, n: number) => Promise<unknown>) => {
  const calls: any[] = [];
  const section = o.outcomesSection({ load: (p: any) => { calls.push(p); return answers(p, calls.length); }, note });
  return { calls, section };
};
const ok = (...list: unknown[]) => (_p: any, n: number) => Promise.resolve(list[Math.min(n, list.length) - 1]);
const pick = (el: FakeElement, name: string) => el.all("select").find((s) => s.attrs.name === name)!;
const change = async (s: any, name: string, value: string) => {
  const sel = pick(s.el, name);
  sel.value = value;
  sel.fire("change", { target: sel });
  await s.ready;
};

describe("outcomes card", () => {
  it("draws groups with their pairs, captions and the server's text", async () => {
    const defs = OUTCOME_DEFINITIONS.map((d) => (d.id === "merge_rate" ? { ...d, definition: "Server text" } : d));
    const { section } = make(ok(answer({ definitions: defs })));
    await section.ready;
    const el = section.el as FakeElement;
    expect(el.all("h3").map((x) => x.textContent)).toEqual(["Outcomes"]);
    const tables = el.all("table");
    const captions = tables.map((t) => t.all("caption")[0]!.textContent);
    expect(captions[0]).toBe("Issue to pull request and the measures to read with it");
    expect(captions.at(-1)).toBe("Other measures");
    expect(captions).toContain("Approval latency and the measures to read with it");
    expect(captions).toContain("Cost per successful run and the measures to read with it");
    const first = rows(tables[0] as FakeElement);
    expect(first.map((r) => r[0])).toEqual(["Issue to pull request", "First-pass test success", "Rework after delivery", "Policy blocks", "Returning users"]);
    expect(first[0]!.slice(1, 5)).toEqual(["2 h", "3 work items", "1 run", "repository owner"]);
    expect(first[0]![5]).toContain(" Setting: concurrency");
    expect(first[1]!.slice(1, 4)).toEqual(["—", "0 runs", "4 runs"]);
    expect(el.textContent).toContain("Server text");
    expect(el.all("summary")[0]!.textContent).toContain("Definition and exclusions");
    const other = rows(tables.at(-1) as FakeElement).map((r) => r[0]);
    expect(other).toEqual(expect.arrayContaining(["Merge rate (pushed work)", "Evidence completeness", "Resumes"]));
  });

  it("fills the menus", async () => {
    const { section } = make(ok(answer()));
    await section.ready;
    const opts = (n: string) => pick(section.el, n).all("option").map((x) => x.textContent);
    expect(opts("repo")).toEqual(["All repositories", "acme/app", "acme/web"]);
    expect(opts("flow")).toEqual(["All flows", "feature"]);
    expect(opts("model")).toEqual(["All model routes", "claude:anthropic:opus"]);
    expect(opts("policy")).toEqual(["All policy versions", "baseline@1"]);
    expect(opts("days")).toEqual(["7 days", "30 days", "90 days"]);
    expect(pick(section.el, "days").value).toBe("30");
  });

  it("loads again with the filters when a menu changes", async () => {
    const { section, calls } = make(ok(answer()));
    await section.ready;
    await change(section, "repo", "acme/app");
    await change(section, "days", "7");
    expect(calls).toEqual([{ days: 30 }, { repo: "acme/app", days: 30 }, { repo: "acme/app", days: 7 }]);
  });

  it("api.outcomes builds the URL", async () => {
    const real = globalThis.fetch;
    let url = "";
    (globalThis as any).fetch = async (u: string) => { url = u; return { ok: true, status: 200, json: async () => ({}) }; };
    try {
      const { api } = await import("../ui/api.js" as string);
      await api.outcomes({ repo: "acme/app", days: 7 });
      expect(url).toBe("/api/outcomes?repo=acme%2Fapp&days=7");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("shows a note on error, keeps the menus, and Retry loads again", async () => {
    const { section, calls } = make((_p, n) => (n === 2 ? Promise.reject({ status: 500 }) : Promise.resolve(answer())));
    await section.ready;
    await change(section, "repo", "acme/app");
    expect(section.el.textContent).toContain("Could not load the outcomes.");
    expect(pick(section.el, "repo").value).toBe("acme/app");
    (section.el.all("div").find((d: any) => d.retry) as any).retry();
    await section.ready;
    expect(calls[2]).toEqual({ repo: "acme/app", days: 30 });
    expect(section.el.textContent).not.toContain("Could not load");
    expect(section.el.all("table").length).toBeGreaterThan(0);
  });

  it("shows dashes and the number left out when there is no data", async () => {
    const measures = OUTCOME_DEFINITIONS.map((d) => ({ id: d.id, value: null, detail: {}, counted: 0, excluded: 4 }));
    const { section } = make(ok(answer({ measures })));
    await section.ready;
    const all = rows(section.el);
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) expect([r[1], r[3]]).toEqual(["—", "4 runs"]);
  });

  it("says so without definitions, and does not throw on no answer", async () => {
    const a = make(ok(undefined));
    await a.section.ready;
    expect(a.section.el.textContent).toContain("No outcome measures yet.");
    const b = make(ok(answer({ definitions: undefined })));
    await b.section.ready;
    expect(b.section.el.textContent).toContain("No outcome measures yet.");
  });

  it("drops a late answer", async () => {
    const pending: Array<(v: unknown) => void> = [];
    const { section } = make(() => new Promise((r) => pending.push(r)));
    const sel = pick(section.el, "repo");
    sel.value = "acme/app";
    sel.fire("change", { target: sel });
    pending[1]!(answer({ definitions: [{ ...OUTCOME_DEFINITIONS[0]!, label: "Second" }], measures: [] }));
    await section.ready;
    pending[0]!(answer({ definitions: [{ ...OUTCOME_DEFINITIONS[0]!, label: "First" }], measures: [] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(section.el.textContent).toContain("Second");
    expect(section.el.textContent).not.toContain("First");
  });

  it("keeps a selected value missing from the new values; menus without values stay hidden", async () => {
    const { section } = make(ok(answer(), answer({ values: { repos: [], flows: [], models: ["other"], policies: [] } })));
    await section.ready;
    await change(section, "model", "gone");
    const bare = make(ok(answer({ values: { repos: [], flows: [] } })));
    await bare.section.ready;
    expect(bare.section.el.all("label").filter((l: FakeElement) => l.hidden).length).toBe(2);
    expect(pick(section.el, "model").all("option").map((x) => x.textContent)).toEqual(["All model routes", "other", "gone"]);
    expect(pick(section.el, "model").value).toBe("gone");
  });
});

describe("helpers", () => {
  it("outcomeGroups skips missing ids and bad input", () => {
    expect(o.outcomeGroups(null)).toEqual([]);
    const defs = OUTCOME_DEFINITIONS.filter((d) => d.id !== "cost_per_successful_run" && d.id !== "returning_users");
    const groups = o.outcomeGroups([...defs, { nope: 1 }]);
    expect(groups.some((g: any) => g.title === "Cost per successful run")).toBe(false);
    const other = groups.at(-1).items.map((d: any) => d.id);
    expect(new Set(other).size).toBe(other.length);
  });

  it("countText uses singular and plural", () => {
    expect(o.countText(1, "runs")).toBe("1 run");
    expect(o.countText(2, "work items")).toBe("2 work items");
    expect(o.countText(0, "accounts")).toBe("0 accounts");
    expect(o.countText(5, "other")).toBe("5");
  });

  it("outcomeValueText equals outcomeText", () => {
    const cases: Array<[string, Array<number | null>]> = [
      ["ms", [null, Number.NaN, 0, 59_000, 3_599_999, 3_600_000, 9_000_000]],
      ["share", [0, 0.12345, 1]], ["usd", [0, 1.005]], ["count", [7]],
    ];
    for (const [unit, values] of cases) for (const v of values) {
      const def = { ...OUTCOME_DEFINITIONS[0]!, unit } as any;
      expect(o.outcomeValueText(def, v)).toBe(outcomeText(def, v));
    }
  });
});
