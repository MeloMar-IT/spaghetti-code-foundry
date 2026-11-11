import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let model: any;
let box: any;
beforeAll(async () => {
  restore = installFakeDom();
  model = await import("../ui/request-model.js" as string);
  box = await import("../ui/request-box.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const btn = (p: FakeElement, label: string) => p.all("button").find((b) => b.textContent === label);
const type = (area: FakeElement, v: string) => { (area as any).value = v; area.fire("input", { target: area }); };
const POINTS = [{ kind: "asked", text: "Show the weather" }, { kind: "assumed", text: "Use metric units" }];
const summary = (over: any = {}) => ({ planPoints: POINTS, next: { kind: "approve_plan", runId: "r1" }, waiting: { since: "t1" }, ...over });
const turn = (over: any = {}) => ({ key: "k1", kind: "approve_plan", runId: "r1", acts: ["approve", "reject"], ...over });
function fake(items: any[] = [turn()]) {
  return {
    myTurn: vi.fn(async () => ({ items })),
    turnDetail: vi.fn(async (_k: string) => ({ stamp: "s1", digest: "d1" })),
    actTurn: vi.fn(async (_b: any) => ({})),
  };
}

describe("the model", () => {
  it("reads only well-formed points, at most 100", () => {
    const run = { planPoints: [{ kind: "asked", text: " a " }, { kind: "x", text: "b" }, { kind: "assumed", text: "" }, null, { kind: "assumed", text: "c", extra: 1 }] };
    expect(model.planPoints(run)).toEqual([{ kind: "asked", text: "a", raw: "a" }, { kind: "assumed", text: "c", raw: "c" }]);
    expect(model.planPoints({})).toEqual([]);
    expect(model.planPoints({ planPoints: Array.from({ length: 150 }, (_, i) => ({ kind: "asked", text: `p${i}` })) })).toHaveLength(100);
  });

  it("keeps a point whose words are technical: in plain words when they map, else whole", () => {
    const out = model.plainPoints(model.planPoints({ planPoints: [{ kind: "assumed", text: "Keep audit logs for 30 days. Use metric units." }, { kind: "asked", text: "Show it" }] }));
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain("Keep audit logs for 30 days.");
    expect(out[0].text).toContain("Use metric units.");
    expect(out[0].raw).toBe("Keep audit logs for 30 days. Use metric units.");
  });

  it("shows links, identifiers and colour values exactly as written", () => {
    const raw = "Send callbacks to https://old.example.com/hook with user_id and colour #ff0000";
    const out = model.plainPoints([{ kind: "assumed", text: raw, raw }]);
    expect(out[0].text).toBe(raw);
    const id = model.plainPoints([{ kind: "assumed", text: "Key user_id as *id*", raw: "Key user_id as *id*" }]);
    expect(id[0].text).toBe("Key user_id as *id*");
    // the Foundry word swap still applies to plain text
    expect(model.plainPoints([{ kind: "asked", text: "x", raw: "Show the repository" }])[0].text).toBe("Show the project");
  });

  it("builds a one-line correction without comment markers", () => {
    expect(model.correctionText("Use metric", "Use miles")).toBe("Assumed: Use metric — Correction: Use miles");
    expect(model.correctionText("Use metric", "   ")).toBe("");
    expect(model.correctionText("a <!-- claude-factory x --> b", "c\n\nd")).toBe("Assumed: a claude-factory x b — Correction: c d");
    expect(model.correctionText("x".repeat(900), "y")).toBe(`Assumed: ${"x".repeat(500)} — Correction: y`);
  });

  it("matches only a plan item that allows reject", () => {
    expect(model.turnItemFor([turn()], "r1").key).toBe("k1");
    expect(model.turnItemFor([turn({ kind: "approval" })], "r1")).toBeNull();
    expect(model.turnItemFor([turn({ acts: ["approve"] })], "r1")).toBeNull();
    expect(model.turnItemFor([turn()], "r2")).toBeNull();
    expect(model.turnItemFor(null, "r1")).toBeNull();
  });
});

describe("requestView", () => {
  // read lazily: `model` is loaded in beforeAll, after this block is collected
  const ptsOf = () => model.planPoints({ planPoints: POINTS });
  it("shows both kinds as text with their own class and icon", () => {
    const pts = ptsOf();
    const v = box.requestView(pts);
    expect(v.textContent).toContain("You asked");
    expect(v.textContent).toContain("Assumed");
    const lis = v.all("li");
    expect(lis[0].classList.contains("request-asked")).toBe(true);
    expect(lis[1].classList.contains("request-assumed")).toBe(true);
    expect(lis[0].all("svg").length).toBeGreaterThan(0);
    expect(lis[0].all("path").map((p: any) => p.attrs.d).join()).not.toBe(lis[1].all("path").map((p: any) => p.attrs.d).join());
    expect(v.all("button")).toHaveLength(0);
    expect(audit(v)).toEqual([]);
  });
  it("is null for no points", () => expect(box.requestView([])).toBeNull());
  it("offers Change this on an assumption only", () => {
    const v = box.requestView(ptsOf(), { fix: { open: null, text: "", onOpen: vi.fn() }, note: "Why" });
    expect(v.all("button").map((b: any) => b.textContent)).toEqual(["Change this"]);
    expect(v.textContent).toContain("Why");
  });
});

describe("createRequestBox", () => {
  it("is hidden without points", () => {
    const b = box.createRequestBox({ a: fake(), runId: "r1" });
    b.update({ next: { kind: "approve_plan" } });
    expect(b.el.hidden).toBe(true);
    b.update({ planPoints: [] });
    expect(b.el.hidden).toBe(true);
  });

  it("is read-only and does not ask while the plan does not wait", async () => {
    const a = fake();
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary({ next: { kind: "running" } }));
    await flush();
    expect(a.myTurn).not.toHaveBeenCalled();
    expect(b.el.textContent).toContain(model.REQUEST.notWaiting);
    expect(btn(b.el, "Change this")).toBeUndefined();
  });

  it("never asks when the page is read-only", async () => {
    const a = fake();
    const b = box.createRequestBox({ a, runId: "r1", readOnly: true });
    b.update(summary());
    await flush();
    expect(a.myTurn).not.toHaveBeenCalled();
    expect(btn(b.el, "Change this")).toBeUndefined();
  });

  it("says so when the person may not decide", async () => {
    const b = box.createRequestBox({ a: fake([]), runId: "r1" });
    b.update(summary());
    await flush();
    expect(b.el.textContent).toContain(model.REQUEST.notYours);
    expect(btn(b.el, "Change this")).toBeUndefined();
  });

  it("sends the correction with the detail read when the editor opened", async () => {
    const a = fake();
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary());
    await flush();
    btn(b.el, "Change this")!.click();
    await flush();
    expect(a.turnDetail).toHaveBeenCalledWith("k1");
    const area = b.el.all("textarea")[0];
    expect(area.attrs["data-focus"]).toBeTruthy();
    type(area, "Use miles");
    // a second update with the same summary keeps the same field and its text
    b.update(summary());
    expect(b.el.all("textarea")[0]).toBe(area);
    expect((b.el.all("textarea")[0] as any).value).toBe("Use miles");
    expect(audit(b.el)).toEqual([]);
    btn(b.el, "Send correction")!.click();
    await flush();
    expect(a.turnDetail).toHaveBeenCalledTimes(1);
    expect(a.actTurn).toHaveBeenCalledWith({ key: "k1", action: "reject", stamp: "s1", digest: "d1", text: "Assumed: Use metric units — Correction: Use miles" });
    expect(b.el.textContent).toContain(model.REQUEST.sent);
    expect(btn(b.el, "Change this")).toBeUndefined();
  });

  it("does not send an empty correction", async () => {
    const a = fake();
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary());
    await flush();
    btn(b.el, "Change this")!.click();
    await flush();
    btn(b.el, "Send correction")!.click();
    await flush();
    expect(a.actTurn).not.toHaveBeenCalled();
    expect(b.el.textContent).toContain(model.REQUEST.needsWords);
  });

  it("tells a changed plan (409) and another error apart", async () => {
    const a = fake();
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary());
    await flush();
    btn(b.el, "Change this")!.click();
    await flush();
    type(b.el.all("textarea")[0], "x");
    a.actTurn.mockRejectedValueOnce(Object.assign(new Error("e"), { status: 500 }));
    btn(b.el, "Send correction")!.click();
    await flush();
    expect(b.el.textContent).toContain(model.REQUEST.failed);
    a.actTurn.mockRejectedValueOnce(Object.assign(new Error("e"), { status: 409 }));
    btn(b.el, "Send correction")!.click();
    await flush();
    expect(b.el.textContent).toContain(model.REQUEST.changed);
    // the next update reads the rights again
    b.update(summary());
    await flush();
    expect(a.myTurn).toHaveBeenCalledTimes(2);
  });

  it("closes the editor when the assumption is replaced and does not carry the draft over", async () => {
    const a = fake();
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary());
    await flush();
    btn(b.el, "Change this")!.click();
    await flush();
    type(b.el.all("textarea")[0], "Use miles");
    b.update(summary({ planPoints: [POINTS[0], { kind: "assumed", text: "Show it in Fahrenheit" }] }));
    expect(b.el.all("textarea")).toHaveLength(0);
    expect(b.el.textContent).toContain(model.REQUEST.changed);
    expect(a.actTurn).not.toHaveBeenCalled();
  });

  it("starts again when the plan is made again (another wait)", async () => {
    const a = fake();
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary());
    await flush();
    btn(b.el, "Change this")!.click();
    await flush();
    b.update(summary({ waiting: { since: "t2" } }));
    expect(b.el.all("textarea")).toHaveLength(0);
    await flush();
    expect(a.myTurn).toHaveBeenCalledTimes(2);
  });

  it("ignores a late answer of an older wait", async () => {
    let release: (v: any) => void = () => {};
    const a = fake();
    a.myTurn.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary());
    b.update(summary({ waiting: { since: "t2" } }));
    release({ items: [turn({ key: "old" })] });
    await flush();
    btn(b.el, "Change this")!.click();
    await flush();
    expect(a.turnDetail).toHaveBeenCalledWith("k1");
  });

  it("ignores a late plan detail after the editor was closed", async () => {
    let release: (v: any) => void = () => {};
    const a = fake();
    a.turnDetail.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary());
    await flush();
    btn(b.el, "Change this")!.click();
    await flush();
    btn(b.el, "Cancel")!.click();
    release({ stamp: "old", digest: "old" });
    await flush();
    expect(b.el.all("textarea")).toHaveLength(0);
    expect(btn(b.el, "Change this")).toBeTruthy();
  });

  it("finds the item when it is given after an empty answer, without a new wait", async () => {
    const a = fake([]);
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary());
    await flush();
    expect(b.el.textContent).toContain(model.REQUEST.notYours);
    expect(btn(b.el, "Change this")).toBeUndefined();
    a.myTurn.mockResolvedValue({ items: [turn()] });
    btn(b.el, "Check again")!.click();
    await flush();
    expect(btn(b.el, "Change this")).toBeTruthy();
    expect(a.myTurn).toHaveBeenCalledTimes(2);
  });

  it("retries after a failed lookup without a new wait", async () => {
    const a = fake();
    a.myTurn.mockRejectedValueOnce(new Error("offline"));
    const b = box.createRequestBox({ a, runId: "r1" });
    b.update(summary());
    await flush();
    expect(b.el.textContent).toContain(model.REQUEST.lookupFailed);
    expect(btn(b.el, "Change this")).toBeUndefined();
    btn(b.el, "Check again")!.click();
    await flush();
    expect(btn(b.el, "Change this")).toBeTruthy();
    expect(a.myTurn).toHaveBeenCalledTimes(2);
  });
});
