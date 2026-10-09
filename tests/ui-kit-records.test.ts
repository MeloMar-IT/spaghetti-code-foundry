import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { kitCssProblems, kitSourceProblems, tokenNames } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let kit: any;
let h: any;

beforeAll(async () => {
  restore = installFakeDom();
  kit = await import("../ui/kit/records.js" as string);
  h = (await import("../ui/dom.js" as string)).h;
});
afterAll(() => restore());

const TONES = ["neutral", "ok", "fail", "run", "warn", "accent"];
const cls = (e: FakeElement) => e.getAttribute("class");
function* walk(el: FakeElement): Generator<FakeElement> {
  yield el;
  for (const c of el.children) if (c instanceof FakeElement) yield* walk(c);
}
const all = (el: FakeElement) => [...walk(el)];
const byClass = (el: FakeElement, c: string) => all(el).filter((e) => (cls(e) ?? "").split(" ").includes(c));
const lineKinds = (el: FakeElement) => byClass(el, "scf-diff__line").map((l) => (cls(l)!.match(/--(\w+)/) ?? [])[1] ?? "none");

describe("exports", () => {
  it("are exactly the five components", () => {
    expect(Object.keys(kit).filter((k) => typeof kit[k] === "function").sort()).toEqual(["diffView", "evidence", "logView", "timeline", "timelineEntry"]);
  });
  it("every component refuses inline styles and puts the caller class last", () => {
    const make: Record<string, (p: any) => FakeElement> = {
      evidence: (p) => kit.evidence({ title: "T", ...p }),
      timelineEntry: (p) => kit.timelineEntry({ title: "T", ...p }),
      timeline: (p) => kit.timeline({ label: "L", ...p }, []),
      logView: (p) => kit.logView({ label: "L", ...p }),
      diffView: (p) => kit.diffView(p),
    };
    for (const [name, build] of Object.entries(make)) {
      expect(() => build({ style: {} }), name).toThrow();
      expect(cls(build({ class: "mine" }))!.endsWith(" mine"), name).toBe(true);
    }
  });
  it("audit finds nothing in a representative tree", () => {
    const tree = h("div", {},
      kit.evidence({ title: "E", source: "step x", href: "/runs/1" }, "body"),
      kit.timeline({ label: "Steps" }, [kit.timelineEntry({ title: "A", time: "2026-10-01T10:00:00Z" }, "x"), kit.timelineEntry({ title: "B" })]),
      kit.logView({ label: "Log", lines: [{ text: "a", tone: "ok" }] }),
      kit.diffView({ stat: " 1 file", patch: "@@ -1 +1 @@\n-a\n+b", truncated: true }));
    expect(audit(tree)).toEqual([]);
  });
});

describe("evidence", () => {
  it("is a details with a summary that names the title and source", () => {
    const e = kit.evidence({ title: "Tests", source: "step build" }, "x") as FakeElement;
    expect(e.tag).toBe("details");
    expect((e.children[0] as FakeElement).tag).toBe("summary");
    expect((e.children[0] as FakeElement).textContent).toContain("Tests");
    expect((e.children[0] as FakeElement).textContent).toContain("Source: step build");
    expect(cls(e)).toBe("scf-evidence");
  });
  it("is open only when asked", () => {
    expect(kit.evidence({ title: "T", open: true }).getAttribute("open")).not.toBeNull();
    expect(kit.evidence({ title: "T" }).getAttribute("open")).toBeNull();
  });
  it("says so when the source is missing", () => {
    expect(kit.evidence({ title: "T" }, "x").textContent).toContain("Source not recorded");
  });
  it("links to the source from the body, not the summary", () => {
    const e = kit.evidence({ title: "T", source: "step build", href: "/runs/1" }, "x") as FakeElement;
    const links = e.all("a");
    expect(links.length).toBe(1);
    expect(links[0]!.getAttribute("href")).toBe("/runs/1");
    expect(links[0]!.textContent).toBe("Open source: step build");
    expect((e.children[0] as FakeElement).all("a").length).toBe(0);
  });
  it("drops unsafe links", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", " ", "//evil.test"]) {
      expect(kit.evidence({ title: "T", source: "s", href }).all("a").length, href).toBe(0);
    }
  });
  it("draws with no children and with empty children", () => {
    expect(() => kit.evidence({ title: "T" })).not.toThrow();
    expect(() => kit.evidence({ title: "T" }, null, false)).not.toThrow();
  });
  it("needs a title", () => {
    expect(() => kit.evidence({ title: " " })).toThrow();
  });
});

describe("timelineEntry", () => {
  it("is an li with a tone class", () => {
    const e = kit.timelineEntry({ title: "T" }) as FakeElement;
    expect(e.tag).toBe("li");
    expect(cls(e)).toBe("scf-timeline__entry scf-timeline__entry--neutral");
    for (const tone of TONES) expect(cls(kit.timelineEntry({ title: "T", tone }))).toContain(`--${tone}`);
    expect(() => kit.timelineEntry({ title: "T", tone: "x" })).toThrow('unknown timeline tone "x"');
  });
  it("has one time element with an ISO datetime when time is given", () => {
    const e = kit.timelineEntry({ title: "T", time: "2026-10-01T10:00:00Z" }) as FakeElement;
    expect(e.all("time").length).toBe(1);
    expect(e.all("time")[0]!.getAttribute("datetime")).toBe("2026-10-01T10:00:00.000Z");
    expect(e.all("time")[0]!.textContent).not.toBe("");
    const ms = Date.parse("2026-10-01T10:00:00Z");
    expect(kit.timelineEntry({ title: "T", time: ms }).all("time")[0].getAttribute("datetime")).toBe("2026-10-01T10:00:00.000Z");
    expect(kit.timelineEntry({ title: "T", time: new Date(ms) }).all("time")[0].getAttribute("datetime")).toBe("2026-10-01T10:00:00.000Z");
  });
  it("has no time element when time is missing or bad", () => {
    for (const time of [undefined, null, "", "not a date", NaN, true]) {
      expect(kit.timelineEntry({ title: "T", time }).all("time").length, String(time)).toBe(0);
    }
  });
  it("shows the actor only when given", () => {
    expect(byClass(kit.timelineEntry({ title: "T", actor: "Maker" }), "scf-timeline__actor").length).toBe(1);
    expect(byClass(kit.timelineEntry({ title: "T" }), "scf-timeline__actor").length).toBe(0);
  });
  it("has a body only when it has children", () => {
    expect(byClass(kit.timelineEntry({ title: "T" }, null, undefined, false), "scf-timeline__body").length).toBe(0);
    const node = h("b", {}, "x");
    expect(byClass(kit.timelineEntry({ title: "T" }, node), "scf-timeline__body")[0]!.children).toContain(node);
  });
  it("needs a title", () => {
    expect(() => kit.timelineEntry({ title: "" })).toThrow();
  });
});

describe("timeline", () => {
  it("is a named ol holding the entries in order", () => {
    const a = kit.timelineEntry({ title: "A" });
    const b = kit.timelineEntry({ title: "B" });
    const t = kit.timeline({ label: "Steps" }, [a, b]) as FakeElement;
    expect(t.tag).toBe("ol");
    expect(t.getAttribute("aria-label")).toBe("Steps");
    expect(t.getAttribute("role")).toBe("list");
    expect(t.children).toEqual([a, b]);
  });
  it("shows an empty item for no entries", () => {
    for (const entries of [[], undefined, null]) {
      const t = kit.timeline({ label: "L" }, entries) as FakeElement;
      expect(byClass(t, "scf-timeline__empty")[0]!.textContent).toBe("Nothing recorded.");
      expect(t.all("li").length).toBe(1);
    }
    expect(kit.timeline({ label: "L", empty: "None yet" }, []).textContent).toBe("None yet");
  });
  it("skips null and false entries", () => {
    expect(kit.timeline({ label: "L" }, [kit.timelineEntry({ title: "A" }), null, false]).all("li").length).toBe(1 + 0);
  });
  it("needs a label and an array", () => {
    expect(() => kit.timeline({ label: "" }, [])).toThrow();
    expect(() => kit.timeline({ label: "L" }, "x")).toThrow();
  });
});

describe("logView", () => {
  it("is a focusable named log region", () => {
    const l = kit.logView({ label: "Step log", lines: [{ text: "a" }] }) as FakeElement;
    expect(l.getAttribute("role")).toBe("log");
    expect(l.getAttribute("aria-label")).toBe("Step log");
    expect(l.getAttribute("tabindex")).toBe("0");
    expect(cls(l)).toBe("scf-log");
  });
  it("follow adds a class", () => {
    expect(cls(kit.logView({ label: "L", follow: true }))).toContain("scf-log--follow");
    expect(cls(kit.logView({ label: "L" }))).not.toContain("follow");
  });
  it("draws lines with tones, strings and missing text", () => {
    const l = kit.logView({ label: "L", lines: [{ text: "a", tone: "ok" }, { text: "b" }, "c", { tone: "fail" }, null] }) as FakeElement;
    const lines = byClass(l, "scf-log__line");
    expect(lines.map((x) => x.textContent)).toEqual(["a", "b", "c", ""]);
    expect(lines.map((x) => cls(x))).toEqual(["scf-log__line scf-log__line--ok", "scf-log__line", "scf-log__line", "scf-log__line scf-log__line--fail"]);
    expect(() => kit.logView({ label: "L", lines: [{ text: "a", tone: "x" }] })).toThrow();
  });
  it("shows an empty state and stays a named region", () => {
    for (const p of [{ lines: [] }, {}]) {
      const l = kit.logView({ label: "L", ...p }) as FakeElement;
      expect(byClass(l, "scf-log__line").length).toBe(0);
      expect(byClass(l, "scf-log__empty")[0]!.textContent).toBe("No log lines.");
      expect(l.getAttribute("role")).toBe("log");
      expect(l.getAttribute("tabindex")).toBe("0");
    }
  });
  it("draws 500 lines", () => {
    const lines = Array.from({ length: 500 }, (_, i) => ({ text: `line ${i}` }));
    expect(byClass(kit.logView({ label: "L", lines }), "scf-log__line").length).toBe(500);
  });
  it("keeps HTML-looking text as text", () => {
    const text = "<img src=x onerror=alert(1)><b>bold</b>";
    const l = kit.logView({ label: "L", lines: [{ text }] }) as FakeElement;
    expect(byClass(l, "scf-log__line")[0]!.textContent).toBe(text);
    expect(all(l).some((e) => e.tag === "img" || e.tag === "b")).toBe(false);
    expect(Object.keys(l.listeners)).toEqual([]);
  });
  it("needs a label and an array", () => {
    expect(() => kit.logView({ label: "" })).toThrow();
    expect(() => kit.logView({ label: "L", lines: "x" })).toThrow();
  });
});

describe("diffView", () => {
  const PATCH = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " ctx", "-old", "+new", "\\ No newline at end of file"].join("\n");
  it("marks each line by kind", () => {
    expect(lineKinds(kit.diffView({ patch: PATCH }))).toEqual(["file", "file", "file", "file", "hunk", "none", "del", "add", "none"]);
  });
  it("keeps every character, including + and -", () => {
    const d = kit.diffView({ patch: PATCH }) as FakeElement;
    const lines = byClass(d, "scf-diff__line");
    expect(lines.map((l) => l.textContent)).toEqual(PATCH.split("\n").map((l) => `${l}\n`));
    expect(lines.map((l) => l.textContent).join("")).toBe(`${PATCH}\n`);
  });
  it("treats --- and +++ inside a hunk as removed and added lines", () => {
    const patch = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", "--- a comment", "+++ plus"].join("\n");
    expect(lineKinds(kit.diffView({ patch }))).toEqual(["file", "file", "file", "hunk", "del", "add"]);
  });
  it("reads the next file's headers after a hunk", () => {
    const patch = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", "diff --git a/y b/y", "--- a/y", "+++ b/y", "@@ -1 +1 @@", "-c", "+d"].join("\n");
    expect(lineKinds(kit.diffView({ patch }))).toEqual(["file", "file", "file", "hunk", "del", "add", "file", "file", "file", "hunk", "del", "add"]);
  });
  it("reads a plain unified diff with two files", () => {
    const patch = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " same", "-a", "+b", "--- a/y", "+++ b/y", "@@ -1,1 +1,1 @@", "-c", "+d"].join("\n");
    expect(lineKinds(kit.diffView({ patch }))).toEqual(["file", "file", "hunk", "none", "del", "add", "file", "file", "hunk", "del", "add"]);
  });
  it("draws a patch with only a header", () => {
    const d = kit.diffView({ patch: "diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b" }) as FakeElement;
    expect(lineKinds(d)).toEqual(["file", "file", "file", "file"]);
  });
  it("adds no line for a trailing newline", () => {
    expect(byClass(kit.diffView({ patch: "@@ -1 +1 @@\n-a\n+b\n" }), "scf-diff__line").length).toBe(3);
  });
  it("keeps HTML-looking lines as text", () => {
    const d = kit.diffView({ patch: "@@ -1,1 +1,1 @@\n+<script>alert(1)</script>\n-</pre><h1>x</h1>" }) as FakeElement;
    const lines = byClass(d, "scf-diff__line");
    expect(lines[1]!.textContent).toBe("+<script>alert(1)</script>\n");
    expect(lines[2]!.textContent).toBe("-</pre><h1>x</h1>\n");
    expect(all(d).some((e) => e.tag === "script" || e.tag === "h1")).toBe(false);
  });
  it("puts the patch in a focusable named region", () => {
    const p = byClass(kit.diffView({ patch: PATCH }), "scf-diff__patch")[0]!;
    expect(p.tag).toBe("pre");
    expect(p.getAttribute("role")).toBe("region");
    expect(p.getAttribute("aria-label")).toBe("Diff");
    expect(p.getAttribute("tabindex")).toBe("0");
    expect(byClass(kit.diffView({ patch: PATCH, label: "Changes" }), "scf-diff__patch")[0]!.getAttribute("aria-label")).toBe("Changes");
  });
  it("shows the stat only when given", () => {
    expect(byClass(kit.diffView({ stat: " 1 file", patch: PATCH }), "scf-diff__stat")[0]!.textContent).toBe(" 1 file");
    expect(byClass(kit.diffView({ patch: PATCH }), "scf-diff__stat").length).toBe(0);
  });
  it("shows the truncated notice only when truncated", () => {
    const n = all(kit.diffView({ patch: PATCH, truncated: true })).filter((e) => e.getAttribute("role") === "status");
    expect(n.map((e) => e.textContent)).toEqual(["Diff truncated (very large)."]);
    expect(all(kit.diffView({ patch: PATCH })).some((e) => e.getAttribute("role") === "status")).toBe(false);
  });
  it("shows the none text for an empty patch", () => {
    for (const patch of ["", undefined, null, "  \n"]) {
      const d = kit.diffView({ patch }) as FakeElement;
      expect(byClass(d, "scf-diff__none")[0]!.textContent, String(patch)).toBe("No changes.");
      expect(all(d).some((e) => e.getAttribute("role") === "region")).toBe(false);
    }
    expect(byClass(kit.diffView({ patch: "", none: "Nothing" }), "scf-diff__none")[0]!.textContent).toBe("Nothing");
    expect(() => kit.diffView({})).not.toThrow();
  });
  it("draws a very large patch without a limit", () => {
    const patch = ["@@ -1,0 +1,5000 @@", ...Array.from({ length: 4999 }, (_, i) => `+line ${i}`)].join("\n");
    expect(byClass(kit.diffView({ patch }), "scf-diff__line").length).toBe(5000);
  });
});

describe("records.css and records.js", () => {
  const css = readFileSync("ui/kit/records.css", "utf8");
  const rule = (sel: string) => new RegExp(`${sel.replace(/[.]/g, "\\.")} \\{[^}]*\\}`).exec(css)?.[0] ?? "";
  it("passes the selector and colour test", () => {
    expect(kitCssProblems(css, tokenNames())).toEqual([]);
  });
  it("has the header comment and no fixed log colours", () => {
    expect(css.startsWith("/* ui/kit/records.css")).toBe(true);
    expect(css).toContain("Belongs here:");
    expect(css).toContain("Does not belong here:");
    expect(css).not.toContain("--color-log-");
  });
  it("has the states and scroll boxes", () => {
    for (const s of [".scf-log--follow", ".scf-diff__line--add", ".scf-diff__line--del", ".scf-diff__line--hunk", ".scf-diff__line--file", ".scf-log:focus-visible", ".scf-evidence[open] > .scf-evidence__summary"]) expect(css, s).toContain(s);
    expect(rule(".scf-log")).toContain("overflow: auto");
    expect(rule(".scf-diff__patch")).toContain("overflow: auto");
  });
  it("is imported by kit.css", () => {
    expect(readFileSync("ui/kit/kit.css", "utf8")).toContain('@import url("/kit/records.css");');
  });
  it("the source sets no styles and no HTML", () => {
    const source = readFileSync("ui/kit/records.js", "utf8");
    expect(kitSourceProblems(source)).toEqual([]);
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });
});
