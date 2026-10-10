import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let mod: any;
beforeAll(async () => {
  restore = installFakeDom();
  mod = await import("../ui/run-output.js" as string);
});
afterAll(() => restore());

const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === v));
const one = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) => {
  const [el] = find(root, tag, attrs);
  if (!el) throw new Error(`no ${tag} ${JSON.stringify(attrs)}`);
  return el;
};
const notes = (el: FakeElement) => find(el, "span", { class: "log-note" });
const spans = (el: FakeElement) => el.children.filter((c): c is FakeElement => c instanceof FakeElement && c.attrs.class !== "log-note");
const buttons = (el: FakeElement) => find(el, "button");

describe("createLog", () => {
  it("keeps the last lines, shows the note and counts every line", () => {
    const log = mod.createLog({ max: 3 });
    for (let i = 1; i <= 5; i++) log.add(`l${i}`);
    expect(notes(log.el).map((n) => n.textContent)).toEqual(["2 earlier lines are not shown"]);
    expect(log.el.children[0]).toBe(notes(log.el)[0]);
    expect(spans(log.el).map((s) => s.textContent)).toEqual(["l3\n", "l4\n", "l5\n"]);
    expect(log.count()).toBe(5);
  });

  it("clear removes the lines and the note, resets the count and draws new lines", () => {
    const log = mod.createLog({ max: 3 });
    for (let i = 1; i <= 5; i++) log.add(`l${i}`);
    log.clear();
    expect(notes(log.el)).toHaveLength(0);
    expect(spans(log.el)).toHaveLength(0);
    expect(log.count()).toBe(0);
    log.add("again");
    expect(spans(log.el).map((s) => s.textContent)).toEqual(["again\n"]);
    expect(notes(log.el)).toHaveLength(0);
    expect(log.count()).toBe(1);
  });

  it("says '1 earlier line' for one and has no note when nothing is dropped", () => {
    const one1 = mod.createLog({ max: 3 });
    for (let i = 1; i <= 4; i++) one1.add(`l${i}`);
    expect(notes(one1.el)[0].textContent).toBe("1 earlier line is not shown");
    const none = mod.createLog({ max: 3 });
    for (let i = 1; i <= 3; i++) none.add(`l${i}`);
    expect(notes(none.el)).toHaveLength(0);
  });

  it("keeps 2,000 lines by default", () => {
    const log = mod.createLog();
    for (let i = 0; i < 2005; i++) log.add(`l${i}`);
    expect(spans(log.el)).toHaveLength(2000);
    expect(notes(log.el)[0].textContent).toBe("5 earlier lines are not shown");
  });

  it("logLine classes", () => {
    const cls = (l: string) => mod.logLine(l).attrs.class;
    expect(cls("▶ step")).toBe("step");
    expect(cls("✔ ok")).toBe("ok");
    expect(cls("✘ bad")).toBe("fail");
    expect(cls("  indented")).toBe("dim");
    expect(cls("plain")).toBeUndefined();
  });

  it("follows the end while the reader is at the end, and stops when they scroll up", () => {
    const log = mod.createLog();
    const el = log.el as any;
    el.scrollHeight = 900;
    log.add("a");
    expect(el.scrollTop).toBe(900);
    el.scrollTop = 0;
    el.clientHeight = 100;
    el.fire("scroll");
    log.add("b");
    expect(el.scrollTop).toBe(0);
    el.scrollTop = 800;
    el.fire("scroll");
    log.add("c");
    expect(el.scrollTop).toBe(900);
  });

  it("keeps what the reader looks at when old lines are dropped", () => {
    const make = (top: number) => {
      const log = mod.createLog({ max: 5 });
      const el = log.el as any;
      Object.defineProperty(el, "scrollHeight", { get: () => el.children.length * 10 });
      for (let i = 0; i < 5; i++) log.add(`l${i}`);
      el.scrollTop = top;
      el.clientHeight = 5;
      el.fire("scroll");
      log.add("x");
      log.add("y");
      return el.scrollTop;
    };
    expect(make(20)).toBe(10);
    expect(make(5)).toBe(0);
  });

  it("batches a burst into one write per frame", () => {
    const frames: Array<() => void> = [];
    (globalThis as any).requestAnimationFrame = (fn: () => void) => frames.push(fn);
    try {
      const log = mod.createLog();
      const append = vi.spyOn(log.el, "append");
      for (let i = 0; i < 3; i++) log.add(`l${i}`);
      expect(log.el.children).toHaveLength(0);
      expect(frames).toHaveLength(1);
      expect(log.count()).toBe(3);
      frames[0]();
      expect(append).toHaveBeenCalledTimes(1);
      expect(spans(log.el)).toHaveLength(3);

      const small = mod.createLog({ max: 2 });
      for (let i = 0; i < 10; i++) small.add(`l${i}`);
      frames[frames.length - 1]();
      expect(spans(small.el)).toHaveLength(2);
      expect(notes(small.el)[0].textContent).toBe("8 earlier lines are not shown");
    } finally {
      delete (globalThis as any).requestAnimationFrame;
    }
  });

  it("accepts a line that is not a string", () => {
    const log = mod.createLog();
    expect(() => log.add(undefined)).not.toThrow();
    expect(log.count()).toBe(1);
  });
});

describe("the run pages use the bounded log", () => {
  it("the admin page", async () => {
    const handlers: Record<string, (e: { data: string }) => void> = {};
    (globalThis as any).EventSource = class {
      static CLOSED = 2;
      readyState = 1;
      addEventListener(type: string, fn: (e: { data: string }) => void) { handlers[type] = fn; }
      close() {}
    };
    const runs = (await import("../ui/runs.js" as string)) as any;
    const main = new FakeElement("div") as any;
    const stop = runs.renderRunDetail(main, "r1", { admin: false });
    for (let i = 0; i < 2010; i++) handlers.log!({ data: JSON.stringify({ line: `l${i}` }) });
    const pre = one(main, "pre", { class: "log" });
    expect(spans(pre)).toHaveLength(2000);
    expect(notes(pre)[0].textContent).toBe("10 earlier lines are not shown");
    stop();
  });

  it("the user page", async () => {
    const ui = (await import("../ui/user/runs.js" as string)) as any;
    const listeners: Record<string, (e: { data: string }) => void> = {};
    const stream = { addEventListener: (t: string, fn: any) => { listeners[t] = fn; }, close() {}, readyState: 1 };
    const a = { run: async () => { throw new Error("x"); }, queue: async () => ({ pending: [] }), events: () => stream };
    const main = new FakeElement("div") as any;
    const stop = ui.renderMyRun(main, "r1", { a });
    for (let i = 0; i < 2010; i++) listeners.log!({ data: JSON.stringify({ line: `l${i}` }) });
    const pre = one(main, "pre", { class: "log" });
    expect(spans(pre)).toHaveLength(2000);
    expect(notes(pre)[0].textContent).toBe("10 earlier lines are not shown");
    stop();
  });

  it("runs.js still exports diffView and logLine", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    expect(runs.diffView).toBe(mod.diffView);
    expect(runs.logLine).toBe(mod.logLine);
  });
});

const fileDiff = (name: string, extra = 0) =>
  [`diff --git a/${name} b/${name}`, "index 1..2 100644", `--- a/${name}`, `+++ b/${name}`, "@@ -1 +1 @@", "-old", "+new", ...Array.from({ length: extra }, (_, i) => `+x${i}`)];

describe("splitPatch", () => {
  it("handles 0, 1 and several files", () => {
    expect(mod.splitPatch("")).toEqual([]);
    expect(mod.splitPatch("+a")).toEqual([{ file: "", lines: ["+a"] }]);
    const one1 = mod.splitPatch(fileDiff("x.ts").join("\n") + "\n");
    expect(one1).toHaveLength(1);
    expect(one1[0].file).toBe("x.ts");
    expect(one1[0].lines[0]).toBe("diff --git a/x.ts b/x.ts");
    const input = [...fileDiff("a.ts"), ...fileDiff("b.ts"), ...fileDiff("c.ts")];
    const three = mod.splitPatch(input.join("\n") + "\n");
    expect(three.map((c: any) => c.file)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(three.flatMap((c: any) => c.lines)).toEqual(input);
  });

  it("names renames, deletions, binary files and ignores content lines", () => {
    expect(mod.splitPatch("diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt")[0].file).toBe("old.txt → new.txt");
    expect(mod.splitPatch("diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x")[0].file).toBe("gone.txt");
    expect(mod.splitPatch("diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ")[0].file).toBe("img.png");
    expect(mod.splitPatch([...fileDiff("real.ts"), "+++ b/other"].join("\n"))[0].file).toBe("real.ts");
  });
});

describe("diffView", () => {
  it("shows the empty text", () => {
    expect(mod.diffView({ patch: "" }).textContent).toContain("No changes");
    expect(mod.diffView({ patch: "" }, { none: "Nothing." }).textContent).toBe("Nothing.");
  });

  it("builds a file when it is opened, once", () => {
    const patch = [...fileDiff("a.ts"), ...fileDiff("b.ts")].join("\n");
    const v = mod.diffView({ patch, stat: "2 files" });
    expect(find(v, "pre", { class: "mono diffstat" })).toHaveLength(1);
    const details = find(v, "details");
    expect(details).toHaveLength(2);
    expect(details.every((d) => d.attrs.open === undefined)).toBe(true);
    expect(find(v, "pre", { class: "diff" })).toHaveLength(0);
    const d = details[0] as any;
    d.open = true;
    d.fire("toggle", { target: d });
    const pre = find(d, "pre", { class: "diff" });
    expect(pre).toHaveLength(1);
    expect(find(pre[0], "span").map((s) => s.attrs.class)).toEqual(expect.arrayContaining(["file", "hunk", "add", "del"]));
    d.fire("toggle", { target: d });
    expect(find(d, "pre", { class: "diff" })).toHaveLength(1);
    expect(find(details[1], "pre", { class: "diff" })).toHaveLength(0);
  });

  it("opens a single file at once and keeps the truncated line", () => {
    const v = mod.diffView({ patch: fileDiff("a.ts").join("\n"), stat: "1 file", truncated: true });
    expect(one(v, "details").attrs.open).toBeDefined();
    expect(find(v, "pre", { class: "diff" })).toHaveLength(1);
    expect(v.textContent).toContain("Diff truncated (very large).");
  });

  it("shows all lines of a file with 200,000 lines without a stack error", () => {
    const v = mod.diffView({ patch: fileDiff("big.ts", 200_000).join("\n"), stat: "s" });
    buttons(v)[0].click();
    expect(find(one(v, "pre", { class: "diff" }), "span").length).toBe(200_007);
  });

  it("cuts a long file at 1,500 lines with a Show all button", () => {
    const long = mod.diffView({ patch: fileDiff("a.ts", 1600 - 7).join("\n"), stat: "s" });
    expect(find(one(long, "pre", { class: "diff" }), "span")).toHaveLength(1500);
    const [btn] = buttons(long);
    expect(btn.textContent).toBe("Show all 1600 lines");
    btn.click();
    expect(find(one(long, "pre", { class: "diff" }), "span")).toHaveLength(1600);
    expect(buttons(long)).toHaveLength(0);
    const exact = mod.diffView({ patch: fileDiff("a.ts", 1500 - 7).join("\n"), stat: "s" });
    expect(find(one(exact, "pre", { class: "diff" }), "span")).toHaveLength(1500);
    expect(buttons(exact)).toHaveLength(0);
  });
});

describe("transcriptView", () => {
  const texts = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "text", text: `t${i}` }));

  it("says so when empty", () => {
    expect(mod.transcriptView([]).textContent).toBe("No transcript recorded.");
  });

  it("shows events a page at a time", () => {
    const v = mod.transcriptView(texts(450));
    const count = () => find(v, "div", { class: "tx-text" }).length;
    expect(count()).toBe(200);
    expect(buttons(v)[0].textContent).toBe("Show 200 more");
    buttons(v)[0].click();
    expect(count()).toBe(400);
    expect(buttons(v)[0].textContent).toBe("Show 50 more");
    buttons(v)[0].click();
    expect(count()).toBe(450);
    expect(buttons(v)).toHaveLength(0);
    expect(find(v, "div", { class: "tx-text" }).map((d) => d.textContent)).toEqual(texts(450).map((e) => e.text));
    expect(buttons(mod.transcriptView(texts(200)))).toHaveLength(0);
    expect(find(mod.transcriptView(texts(5), { page: 2 }), "div", { class: "tx-text" })).toHaveLength(2);
  });

  it("cuts long results and raw text", () => {
    const tool = (result: string) => ({ kind: "tool", name: "Bash", input: { command: "ls" }, result });
    const v = mod.transcriptView([tool("x".repeat(20001))]);
    expect(one(v, "pre", { class: "mono tx-out" }).textContent).toHaveLength(20000);
    expect(buttons(v)[0].textContent).toBe("Show all");
    buttons(v)[0].click();
    expect(one(v, "pre", { class: "mono tx-out" }).textContent).toHaveLength(20001);
    expect(buttons(v)).toHaveLength(0);
    expect(buttons(mod.transcriptView([tool("x".repeat(20000))]))).toHaveLength(0);
    expect(one(mod.transcriptView([tool("")]), "pre", { class: "mono tx-out" }).textContent).toBe("(empty)");
    const raw = mod.transcriptView([{ kind: "raw", text: "y".repeat(25000) }]);
    expect(one(raw, "pre", { class: "mono" }).textContent).toHaveLength(20000);
    buttons(raw)[0].click();
    expect(one(raw, "pre", { class: "mono" }).textContent).toHaveLength(25000);
  });

  it("draws a very large Edit without a stack error", () => {
    const big = Array.from({ length: 200_000 }, (_, i) => `l${i}`).join("\n");
    const v = mod.transcriptView([{ kind: "tool", name: "Edit", input: { file_path: "a", old_string: big, new_string: big } }]);
    const diff = one(v, "pre", { class: "diff" });
    expect(find(diff, "span", { class: "del" })[0].textContent.startsWith("- l0\n- l1\n")).toBe(true);
    expect(find(diff, "span", { class: "add" })).toHaveLength(1);
  });

  it("renders the other events as before", () => {
    const v = mod.transcriptView([
      { kind: "tool", name: "Edit", input: { file_path: "a", old_string: "o", new_string: "n" } },
      { kind: "tool", name: "Write", input: { file_path: "b", content: "w".repeat(7000) } },
      { kind: "tool", name: "Bash", input: { command: "x" }, isError: true },
      { kind: "result", isError: false, costUsd: 0.5, turns: 3, text: "done" },
      { kind: "result", isError: true, text: "bad" },
    ]);
    const diff = one(v, "pre", { class: "diff" });
    expect(find(diff, "span", { class: "del" })).toHaveLength(1);
    expect(find(diff, "span", { class: "add" })).toHaveLength(1);
    expect(find(v, "pre", { class: "mono" })[0].textContent).toHaveLength(6000);
    expect(find(v, "details", { class: "tx-tool bad" })).toHaveLength(1);
    const results = find(v, "div").filter((d) => (d.attrs.class ?? "").startsWith("tx-result"));
    expect(results[0].textContent).toContain("✔ Result");
    expect(results[0].textContent).toContain("$0.5000");
    expect(results[1].textContent).toContain("✘ Result");
  });
});
