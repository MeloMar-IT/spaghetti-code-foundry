import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KINDS } from "../src/words.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { readUiCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let m: any;
let runs: any;
beforeAll(async () => {
  restore = installFakeDom();
  m = await import("../ui/icons.js" as string);
  runs = await import("../ui/runs.js" as string);
});
afterAll(() => restore());

const SEMANTICS = ["accent", "danger", "disabled", "info", "neutral", "running", "success", "waiting", "warning"];

describe("icons", () => {
  it("builds every icon from path, circle, rect and line", () => {
    expect(Object.keys(m.ICONS)).toHaveLength(19);
    for (const [name, parts] of Object.entries(m.ICONS) as [string, [string, Record<string, unknown>][]][]) {
      for (const [tag, attrs] of parts) {
        expect(["path", "circle", "rect", "line"]).toContain(tag);
        for (const v of Object.values(attrs)) expect(typeof v).toBe("string");
      }
      const el = m.icon(name) as FakeElement;
      expect(el.tag).toBe("svg");
      expect(el.children).toHaveLength(parts.length);
    }
  });

  it("is hidden without a label and an image with one", () => {
    const a = m.icon("check") as FakeElement;
    expect(a.attrs["aria-hidden"]).toBe("true");
    expect(a.attrs.role).toBeUndefined();
    expect(a.attrs.class).toBe("ico");
    expect(a.attrs.stroke).toBe("currentColor");
    expect(a.attrs.viewBox).toBe("0 0 24 24");
    expect(a.attrs.style).toBeUndefined();
    expect(Object.keys(a.style)).toHaveLength(0);
    const b = m.icon("check", { label: "Done" }) as FakeElement;
    expect(b.attrs.role).toBe("img");
    expect(b.attrs["aria-label"]).toBe("Done");
    expect(b.attrs["aria-hidden"]).toBeUndefined();
    expect(b.textContent).toBe("");
    expect(m.icon("check", { small: true }).attrs.class).toBe("ico ico-sm");
    expect(m.icon("check", { spin: true }).attrs.class).toBe("ico spin");
    expect(() => m.icon("nope")).toThrow(/unknown icon "nope"/);
  });

  it("makes an icon button only with a label", () => {
    expect(() => m.iconButton("x", "")).toThrow();
    expect(() => m.iconButton("x", "  ")).toThrow();
    const onClick = vi.fn();
    const b = m.iconButton("x", "Close", { class: "a", title: "other", onClick }) as FakeElement;
    expect(b.attrs["aria-label"]).toBe("Close");
    expect(b.attrs.title).toBe("Close");
    expect(b.attrs.class).toBe("icon a");
    expect(b.all("svg")).toHaveLength(1);
    b.click();
    expect(onClick).toHaveBeenCalled();
  });
});

describe("status", () => {
  it("has nine semantics with nine different icons", () => {
    expect(Object.keys(m.STATUS).sort()).toEqual(SEMANTICS);
    const names = Object.values(m.STATUS) as string[];
    expect(new Set(names).size).toBe(9);
    for (const n of names) expect(m.ICONS).toHaveProperty(n);
  });

  it("maps every kind to a semantic, both ways", () => {
    expect(Object.keys(m.KIND_SEMANTIC).sort()).toEqual([...KINDS].sort());
    for (const s of Object.values(m.KIND_SEMANTIC)) expect(m.STATUS).toHaveProperty(s as string);
    const expected: Record<string, string[]> = {
      success: ["done"],
      running: ["running", "checking", "starting"],
      danger: ["failed", "watcher_error", "monitor_stopped", "watcher_stale"],
      warning: ["usage_limit", "daily_budget", "user_limit", "interrupted", "restart", "closed_elsewhere"],
      waiting: ["questions", "planner_questions", "approve_plan", "approve_split", "approval", "monitor_needs_you", "dependency", "one_at_a_time", "area_lock", "queued", "release", "stopped", "bug_first"],
      disabled: ["cancelled", "superseded", "issue_closed"],
    };
    for (const [sem, kinds] of Object.entries(expected)) for (const k of kinds) expect(m.KIND_SEMANTIC[k], k).toBe(sem);
    expect(m.semanticOf("approval")).toBe("waiting");
    expect(m.semanticOf("nope")).toBe("neutral");
    expect(m.semanticOf("toString")).toBe("neutral");
  });

  it("maps watcher states", () => {
    expect(m.watcherSemanticOf("active")).toBe("success");
    expect(m.watcherSemanticOf("error")).toBe("danger");
    expect(m.watcherSemanticOf("disabled")).toBe("disabled");
  });

  it("draws a pill with icon and text, and refuses bad input", () => {
    const p = m.statusPill("success", "done", "x") as FakeElement;
    expect(p.attrs.class).toBe("pill sem-success x");
    expect(p.textContent).toBe("done");
    expect(p.all("svg")).toHaveLength(1);
    expect(() => m.statusPill("success", "")).toThrow();
    expect(() => m.statusPill("nope", "x")).toThrow();
  });
});

describe("flow name and transcript", () => {
  it("labels a flow with errors", () => {
    const bad = m.flowNameMark({ name: "f", error: "x" }) as FakeElement;
    const svg = bad.all("svg");
    expect(svg).toHaveLength(1);
    expect(svg[0]!.attrs.role).toBe("img");
    expect(svg[0]!.attrs["aria-label"]).toBe("Has errors");
    expect(bad.textContent).toBe("f");
    expect((m.flowNameMark({ name: "f" }) as FakeElement).all("svg")).toHaveLength(0);
  });

  it("labels a failed tool call", () => {
    const ev = (isError: boolean) => [{ kind: "tool", name: "Bash", input: { command: "x" }, isError, result: "" }];
    const failed = runs.transcriptView(ev(true)) as FakeElement;
    const svg = failed.all("summary")[0]!.all("svg");
    expect(svg).toHaveLength(1);
    expect(svg[0]!.attrs["aria-label"]).toBe("Failed");
    expect(svg[0]!.attrs.role).toBe("img");
    expect((runs.transcriptView(ev(false)) as FakeElement).all("svg")).toHaveLength(0);
  });
});

describe("source", () => {
  const src = readFileSync("ui/icons.js", "utf8");
  const css = readUiCss();

  it("has no innerHTML, address or inline style, and the licence note", () => {
    expect(src).not.toContain("innerHTML");
    expect(src).not.toMatch(/https?:|\/\/[a-z]+\./i);
    expect(src).not.toMatch(/style/);
    expect(src).toContain("Icons from Lucide (ISC License, © Lucide Contributors)");
  });

  it("styles every pill semantic with its own pair, before the older rules", () => {
    for (const s of SEMANTICS) expect(css).toContain(`.pill.sem-${s} { background: var(--color-${s}-soft); color: var(--color-${s}); }`);
    const sem = css.indexOf(".pill.sem-neutral");
    expect(sem).toBeGreaterThan(-1);
    expect(sem).toBeLessThan(css.indexOf(".pill.kind-running"));
    expect(sem).toBeLessThan(css.indexOf(".pill.who-you"));
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .ico.spin { animation: none; } }");
  });

  it("uses the helper in the sidebar", () => {
    expect(readFileSync("ui/app.js", "utf8")).toContain("flowNameMark(f)");
  });
});
