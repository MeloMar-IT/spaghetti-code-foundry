import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextStep } from "../src/next-step.js";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// The Foundry's character (#939): drawn by one helper, in the "nothing needs you" and "no runs" states and as the Ask Foundry avatar,
// and never next to an error, a permission notice or a decision. Fake DOM, no browser.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ch: any, turn: any, today: any, simpleHome: any, simpleModel: any, runStates: any, states: any, display: any, askView: any, live: any;
beforeAll(async () => {
  restore = installFakeDom();
  ch = await import("../ui/character.js" as string);
  turn = await import("../ui/turn.js" as string);
  today = await import("../ui/today.js" as string);
  simpleHome = await import("../ui/simple-home.js" as string);
  simpleModel = await import("../ui/simple-model.js" as string);
  runStates = await import("../ui/run-states.js" as string);
  states = await import("../ui/states.js" as string);
  display = await import("../ui/kit/display.js" as string);
  askView = await import("../ui/ask-view.js" as string);
  live = await import("../ui/live.js" as string);
});
afterAll(() => restore());

const box = (nodes: unknown): FakeElement => {
  const root = new FakeElement("div");
  root.append(...(([] as unknown[]).concat(nodes as never)).flat(Infinity).filter(Boolean) as FakeElement[]);
  return root;
};
const pics = (root: FakeElement) => root.all("img").filter((i) => (i.attrs.src ?? "").startsWith("/brand/character"));

describe("character()", () => {
  it("draws a picture with a WebP source, a PNG image, its size and a text", () => {
    const p = ch.character() as FakeElement;
    expect(p.tag).toBe("picture");
    expect(p.attrs.class).toBe("scf-character scf-character-empty");
    const src = p.all("source")[0]!;
    expect(src.attrs.type).toBe("image/webp");
    expect(src.attrs.srcset).toBe("/brand/character-1x.webp 1x, /brand/character-2x.webp 2x");
    const img = p.all("img")[0]!;
    expect(img.attrs.src).toBe("/brand/character-1x.png");
    expect(img.attrs.srcset).toBe("/brand/character-1x.png 1x, /brand/character-2x.png 2x");
    expect([img.attrs.width, img.attrs.height]).toEqual(["140", "226"]);
    expect((img.attrs.alt ?? "").length).toBeGreaterThan(20);
    expect(img.attrs.alt).not.toContain("Al Dente");
    expect(audit(box(p))).toEqual([]);
  });

  it("has an avatar kind and falls back to the empty kind", () => {
    expect((ch.character("avatar") as FakeElement).attrs.class).toContain("scf-character-avatar");
    expect((ch.character("other") as FakeElement).attrs.class).toContain("scf-character-empty");
  });
});

describe("Your turn", () => {
  const handlers = { onDismiss() {}, onRestore() {}, onLeave() {} };
  const item = (next: unknown) => ({ key: "k", repo: "o/a", what: "Five", next, since: "2026-10-01T10:00:00Z", unblocks: 0, dismissable: true, watcher: "w1" });
  const data = (items: unknown[], extra = {}) => ({ count: items.length, groups: items.length ? [{ repo: "o/a", items }] : [], dismissed: 0, ...(items.length ? {} : { empty: "Nothing needs you." }), ...extra });
  const draw = (d: unknown, opts = {}) => box(turn.turnView(d, handlers, opts));

  it("shows one character when empty, none when embedded in Home", () => {
    expect(pics(draw(data([])))).toHaveLength(1);
    expect(pics(draw(data([]), { embedded: true }))).toHaveLength(0);
  });

  it("shows none next to a decision", () => {
    expect(pics(draw(data([item(nextStep("approval", { repo: "o/a", issue: 6 }))])))).toHaveLength(0);
  });
});

describe("Today", () => {
  const model = (over: Record<string, unknown> = {}) => today.todayModel([], [], { role: "user", ...over });
  const draw = (m: unknown, opts = {}) => box(today.todayView(m, opts));

  it("shows one character when nothing needs the person", () => {
    expect(pics(draw(model()))).toHaveLength(1);
    expect(pics(draw(model(), { character: false }))).toHaveLength(0);
  });

  it("shows none when the answer is unknown or something needs the person", () => {
    expect(pics(draw(model({ needsUnknown: true })))).toHaveLength(0);
    expect(pics(draw(model({ extraNeeds: 1 })))).toHaveLength(0);
  });
});

describe("the Simple home", () => {
  const iso = new Date(Date.UTC(2026, 0, 1, 11, 0)).toISOString();
  const run = (id: string, kind: string, over = {}) => ({
    runId: id, flow: "issue-gitflow", task: "Show the weather (#12)", status: "running", startedAt: iso,
    vars: { github_repo: "o/app", issue: "12" }, history: [], next: nextStep(kind as never, { runId: id, repo: "o/app", title: "Show the weather (#12)" } as never), ...over,
  });
  const repos = [{ id: "r1", url: "https://github.com/o/app", github: "o/app" }];
  const home = (runs: unknown[]) => simpleModel.homeModel(runs, [], repos, simpleModel.projectsModel(repos, runs, []), {});

  it.each(["calm", "midnight", "bento"])("shows one character in the %s layout when empty and none with a stuck run", (look) => {
    expect(pics(box(simpleHome.homeLayout(home([]), look)))).toHaveLength(1);
    expect(pics(box(simpleHome.homeLayout(home([run("s", "failed", { status: "failed" })]), look)))).toHaveLength(0);
    expect(pics(box(simpleHome.homeLayout(home([run("q", "questions")]), look)))).toHaveLength(0);
  });
});

describe("noRuns()", () => {
  it("shows the character, unless told not to", () => {
    expect(pics(box(runStates.noRuns()))).toHaveLength(1);
    expect(pics(box(runStates.noRuns({ character: false })))).toHaveLength(0);
    expect(box(runStates.noRuns({ character: false })).textContent).toContain("No runs yet.");
  });
});

describe("no character next to a failure", () => {
  it("is not in the error, permission, loading and banner states", () => {
    const nodes = [
      states.errorState("Could not load.", {}), states.permissionState("No."), states.banner("error", "Failed", []), states.loadingState("Loading"), states.emptyState("Nothing."),
      display.emptyState({ title: "Nothing." }), display.banner({ tone: "fail", title: "Failed" }),
      runStates.partNote("the queue", { ok: false, status: 500, message: "x" }),
    ];
    for (const n of nodes) expect(pics(box(n))).toHaveLength(0);
  });

  it("is hidden by the page body while a refresh has failed, and back after the recovery", () => {
    const body = new FakeElement("main");
    const s = live.liveStates({ body });
    s.onState({ at: Date.now(), failed: false });
    expect(body.attrs["data-refresh-failed"]).toBeUndefined();
    s.onState({ at: Date.now(), failed: true, error: new Error("x") });
    expect(body.attrs["data-refresh-failed"]).toBe("");
    s.onState({ at: Date.now(), failed: false });
    expect(body.attrs["data-refresh-failed"]).toBeUndefined();
  });
});

describe("the Ask Foundry drawer", () => {
  const frame = () => askView.askFrame({ key() {}, attach() {}, fresh() {}, history() {}, close() {}, submit() {}, archived() {} }, { questionMax: 100 });

  it("has the avatar in the header, only there", () => {
    const f = frame();
    const head = f.drawer.all("div").find((d: FakeElement) => d.attrs.class === "ask-head");
    expect(pics(head)).toHaveLength(1);
    expect((pics(head)[0]!.attrs.alt ?? "").length).toBeGreaterThan(20);
    expect(pics(f.thread)).toHaveLength(0);
    expect(f.avatar.attrs.class).toContain("scf-character-avatar");
  });

  it("hides the avatar while an error is shown and shows it again when cleared", () => {
    const f = frame();
    expect(f.avatar.hidden).toBe(false);
    f.error.textContent = "You are not allowed to do this.";
    expect(f.avatar.hidden).toBe(true);
    expect(f.error.textContent).toBe("You are not allowed to do this.");
    f.error.textContent = "";
    expect(f.avatar.hidden).toBe(false);
  });
});
