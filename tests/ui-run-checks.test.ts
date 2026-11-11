import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let rc: any;
let rh: any;
let runs: any;
beforeAll(async () => {
  restore = installFakeDom();
  rc = await import("../ui/run-checks.js" as string);
  rh = await import("../ui/run-header.js" as string);
  runs = await import("../ui/runs.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const CHECKS = [{ id: "plan-1", try: "Open the page", expect: "A red button" }, { id: "plan-2", try: "Click it", expect: "A dialog opens" }];
const waiting = (over: Record<string, unknown> = {}) => ({
  runId: "r1", flow: "walk", status: "waiting", task: "Do it", startedAt: "2026-01-01T11:00:00Z", vars: {}, history: [], state: { next: "b" },
  next: nextStep("approval", { runId: "r1" } as any), checks: CHECKS, checksRev: "rev1", ...over,
});
const btn = (root: FakeElement, focus: string) => root.all("button").find((b) => b.attrs["data-focus"] === focus)!;
const count = (el: FakeElement) => el.all("p").find((p) => p.attrs["aria-live"] === "polite")!.textContent;

describe("personChecks, openChecks, approveLabel", () => {
  it("gives no rows unless a waiting run has usable checks", () => {
    expect(rc.personChecks(waiting({ status: "running" }))).toEqual([]);
    expect(rc.personChecks(waiting({ checks: undefined }))).toEqual([]);
    expect(rc.personChecks(waiting({ checks: [] }))).toEqual([]);
    expect(rc.personChecks(waiting({ checks: [{ id: "x", try: "a" }, null, { id: "", try: "a", expect: "b" }] }))).toEqual([]);
    expect(rc.personChecks(null)).toEqual([]);
  });
  it("reads the marks and ignores an unknown one", () => {
    const rows = rc.personChecks(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" }, "plan-2": { mark: "bad", at: "t" } } }));
    expect(rows.map((r: any) => [r.id, r.mark])).toEqual([["plan-1", "works"], ["plan-2", null]]);
    expect(rows[0].rev).toBe("rev1");
  });
  it("counts the open checks and words the Approve label", () => {
    expect(rc.approveLabel(waiting({ checks: [] }))).toBe("Approve");
    expect(rc.approveLabel(waiting())).toBe("Approve — 2 checks not marked yet");
    const one = waiting({ checkMarks: { "plan-1": { mark: "not-quite", at: "t" } } });
    expect(rc.openChecks(one)).toBe(1);
    expect(rc.approveLabel(one)).toBe("Approve — 1 check not marked yet");
    expect(rc.approveLabel(one, "✔ Approve")).toBe("✔ Approve — 1 check not marked yet");
    expect(rc.approveLabel(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" }, "plan-2": { mark: "works", at: "t" } } }))).toBe("Approve");
  });
});

describe("createCheckList", () => {
  it("is hidden without checks, and shows the rows and the count with them", () => {
    const list = rc.createCheckList({ onMark: vi.fn() });
    list.update(waiting({ checks: [] }));
    expect(list.el.hidden).toBe(true);
    list.update(waiting());
    expect(list.el.hidden).toBe(false);
    expect(list.el.all("li")).toHaveLength(2);
    expect(list.el.textContent).toContain("Try: Open the page");
    expect(list.el.textContent).toContain("Expect: A red button");
    expect(count(list.el)).toBe("0 of 2 done");
    list.update(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" } } }));
    expect(count(list.el)).toBe("1 of 2 done");
    expect(btn(list.el, "check-works-plan-1").getAttribute("aria-pressed")).toBe("true");
    expect(btn(list.el, "check-works-plan-1").textContent).toBe("✓ Works");
    expect(btn(list.el, "check-not-quite-plan-1").getAttribute("aria-pressed")).toBe("false");
  });
  it("sends the mark, and null when the pressed button is clicked again", async () => {
    const onMark = vi.fn(async () => ({}));
    const list = rc.createCheckList({ onMark });
    list.update(waiting());
    btn(list.el, "check-works-plan-1").click();
    await flush();
    expect(onMark).toHaveBeenLastCalledWith("plan-1", "works", "rev1");
    list.update(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" } } }));
    btn(list.el, "check-works-plan-1").click();
    await flush();
    expect(onMark).toHaveBeenLastCalledWith("plan-1", null, "rev1");
    btn(list.el, "check-not-quite-plan-2").click();
    await flush();
    expect(onMark).toHaveBeenLastCalledWith("plan-2", "not-quite", "rev1");
  });
  it("ignores a second click while a call is out, and draws the marks the call returns", async () => {
    let finish!: (v: unknown) => void;
    const onMark = vi.fn(() => new Promise((r) => { finish = r; }));
    const list = rc.createCheckList({ onMark });
    list.update(waiting());
    const b = btn(list.el, "check-works-plan-1");
    b.click();
    expect(b.getAttribute("aria-disabled")).toBe("true");
    b.click();
    expect(onMark).toHaveBeenCalledTimes(1);
    finish({ checkMarks: { "plan-1": { mark: "works", at: "t" } } });
    await flush();
    expect(b.getAttribute("aria-disabled")).toBeNull();
    expect(count(list.el)).toBe("1 of 2 done");
    expect(b.getAttribute("aria-pressed")).toBe("true");
  });
  it("shows an error and clears the busy state when the call fails", async () => {
    const list = rc.createCheckList({ onMark: vi.fn(async () => { throw new Error("this change moved on; load it again"); }) });
    list.update(waiting());
    const b = btn(list.el, "check-works-plan-1");
    b.click();
    await flush();
    expect(list.el.all("p").find((p) => p.attrs.role === "alert")!.textContent).toBe("this change moved on; load it again");
    expect(b.getAttribute("aria-disabled")).toBeNull();
  });
  it("shows words, not buttons, without onMark", () => {
    const list = rc.createCheckList();
    list.update(waiting({ checkMarks: { "plan-1": { mark: "not-quite", at: "t" } } }));
    expect(list.el.all("button")).toHaveLength(0);
    expect(list.el.textContent).toContain("Not quite");
    expect(list.el.textContent).toContain("Not tried yet");
  });
  it("keeps the same button nodes across updates, and rebuilds when the checks change", () => {
    const list = rc.createCheckList({ onMark: vi.fn() });
    list.update(waiting());
    const before = btn(list.el, "check-works-plan-1");
    list.update(waiting({ checkMarks: { "plan-2": { mark: "works", at: "t" } } }));
    expect(btn(list.el, "check-works-plan-1")).toBe(before);
    list.update(waiting({ checks: [{ id: "plan-1", try: "New", expect: "New" }] }));
    expect(btn(list.el, "check-works-plan-1")).not.toBe(before);
    expect(list.el.all("li")).toHaveLength(1);
  });
});

describe("Not quite sends the change back", () => {
  const form = (list: any, id = "plan-1") => list.el.all("div").find((d: FakeElement) => d.attrs["data-part"] === `check-saw-${id}`);
  const input = (list: any, name: string) => list.el.all("input").find((i: FakeElement) => i.attrs["data-focus"] === name);
  const alertOf = (list: any) => list.el.all("p").find((p: FakeElement) => p.attrs.role === "alert")?.textContent;
  const setup = (over: Record<string, unknown> = {}) => {
    const onMark = vi.fn(async () => ({ checkMarks: { "plan-1": { mark: "not-quite", at: "t" } } }));
    const onSendBack = vi.fn(async () => undefined);
    const list = rc.createCheckList({ onMark, onSendBack, ...over });
    list.update(waiting());
    return { list, onMark, onSendBack };
  };

  it("opens the form without marking, and Cancel closes it", () => {
    const { list, onMark } = setup();
    expect(form(list).hidden).toBe(true);
    btn(list.el, "check-not-quite-plan-1").click();
    expect(form(list).hidden).toBe(false);
    expect(form(list).textContent).toContain("What did you see?");
    expect(onMark).not.toHaveBeenCalled();
    btn(list.el, "check-cancel-plan-1").click();
    expect(form(list).hidden).toBe(true);
  });
  it("sends nothing for an empty sentence", async () => {
    const { list, onMark, onSendBack } = setup();
    btn(list.el, "check-not-quite-plan-1").click();
    btn(list.el, "check-send-back-plan-1").click();
    await flush();
    expect(alertOf(list)).toBe("Write what you saw first.");
    expect(onMark).not.toHaveBeenCalled();
    expect(onSendBack).not.toHaveBeenCalled();
  });
  it("marks the check, then sends the note with the check and the sentence", async () => {
    const { list, onMark, onSendBack } = setup();
    btn(list.el, "check-not-quite-plan-1").click();
    input(list, "check-saw-plan-1").value = "  a grey\nbutton ";
    btn(list.el, "check-send-back-plan-1").click();
    await flush();
    expect(onMark).toHaveBeenCalledWith("plan-1", "not-quite", "rev1");
    expect(onSendBack).toHaveBeenCalledWith("Not quite — Try: Open the page — Expect: A red button — What I saw: a grey button");
    expect(onMark.mock.invocationCallOrder[0]).toBeLessThan(onSendBack.mock.invocationCallOrder[0]!);
    expect(form(list).hidden).toBe(true);
    expect(alertOf(list)).toBeFalsy();
  });
  it("shows an error and does not send when marking fails", async () => {
    const { list, onSendBack } = setup({ onMark: vi.fn(async () => { throw new Error("this change moved on; load it again"); }) });
    btn(list.el, "check-not-quite-plan-1").click();
    input(list, "check-saw-plan-1").value = "x";
    btn(list.el, "check-send-back-plan-1").click();
    await flush();
    expect(alertOf(list)).toBe("this change moved on; load it again");
    expect(onSendBack).not.toHaveBeenCalled();
    expect(form(list).hidden).toBe(false);
  });
  it("keeps the sentence when the send-back fails or answers false, and works again on retry", async () => {
    const onSendBack = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
    const { list, onMark } = setup({ onSendBack });
    btn(list.el, "check-not-quite-plan-1").click();
    input(list, "check-saw-plan-1").value = "it broke";
    btn(list.el, "check-send-back-plan-1").click();
    await flush();
    expect(alertOf(list)).toBe("boom");
    expect(input(list, "check-saw-plan-1").value).toBe("it broke");
    btn(list.el, "check-send-back-plan-1").click();
    await flush();
    expect(alertOf(list)).toBe("It could not be sent back. Try again.");
    expect(form(list).hidden).toBe(false);
    btn(list.el, "check-send-back-plan-1").click();
    await flush();
    expect(onSendBack).toHaveBeenCalledTimes(3);
    expect(onMark).toHaveBeenCalledTimes(1); // the mark was already set
    expect(form(list).hidden).toBe(true);
    expect(alertOf(list)).toBeFalsy();
  });
  it("takes a Not quite mark back without the form, and is as before without onSendBack", async () => {
    const { list, onMark } = setup();
    list.update(waiting({ checkMarks: { "plan-1": { mark: "not-quite", at: "t" } } }));
    btn(list.el, "check-not-quite-plan-1").click();
    await flush();
    expect(onMark).toHaveBeenLastCalledWith("plan-1", null, "rev1");
    expect(form(list).hidden).toBe(true);
    const plain = rc.createCheckList({ onMark });
    plain.update(waiting());
    expect(form(plain)).toBeUndefined();
    btn(plain.el, "check-not-quite-plan-1").click();
    await flush();
    expect(onMark).toHaveBeenLastCalledWith("plan-1", "not-quite", "rev1");
  });
  it("notQuiteNote is one line and cuts the sentence", () => {
    const note = rc.notQuiteNote({ try: "a\nb", expect: "c" }, `x\n${"y".repeat(400)}`);
    expect(note).not.toContain("\n");
    expect(note.startsWith("Not quite — Try: a b — Expect: c — What I saw: x yyy")).toBe(true);
    expect(Array.from(note.split("What I saw: ")[1]!)).toHaveLength(300);
  });
});

describe("+ Add a check, Your check and Worked before", () => {
  const addB = (list: any) => btn(list.el, "check-add");
  const field = (list: any, name: string) => list.el.all("input").find((i: FakeElement) => i.attrs["data-focus"] === name);
  const alertOf = (list: any) => list.el.all("p").find((p: FakeElement) => p.attrs.role === "alert")?.textContent;
  it("asks for both parts, then adds and draws the answer's checks", async () => {
    const answer = { id: "person-1", checks: [...CHECKS, { id: "person-1", try: "T", expect: "E", source: "person" }], checksRev: "rev2", checkMarks: {} };
    const onAdd = vi.fn(async () => answer);
    const list = rc.createCheckList({ onMark: vi.fn(), onAdd });
    list.update(waiting());
    addB(list).click();
    field(list, "check-add-try").value = "T";
    btn(list.el, "check-add-save").click();
    await flush();
    expect(alertOf(list)).toBe("Write what to try and what to expect.");
    expect(onAdd).not.toHaveBeenCalled();
    field(list, "check-add-expect").value = "E";
    btn(list.el, "check-add-save").click();
    await flush();
    expect(onAdd).toHaveBeenCalledWith("T", "E", "rev1");
    expect(list.el.all("li")).toHaveLength(3);
    expect(list.el.textContent).toContain("Your check");
    expect(field(list, "check-add-try").getAttribute("maxlength")).toBe("300");
    expect(alertOf(list)).toBeFalsy();
  });
  it("shows an error and keeps the text when adding fails", async () => {
    const list = rc.createCheckList({ onMark: vi.fn(), onAdd: vi.fn(async () => { throw new Error("a change keeps at most 4 checks of your own"); }) });
    list.update(waiting());
    addB(list).click();
    field(list, "check-add-try").value = "T";
    field(list, "check-add-expect").value = "E";
    btn(list.el, "check-add-save").click();
    await flush();
    expect(alertOf(list)).toBe("a change keeps at most 4 checks of your own");
    expect(field(list, "check-add-try").value).toBe("T");
  });
  it("shows the section for a waiting change without checks, only with onAdd", () => {
    const list = rc.createCheckList({ onMark: vi.fn(), onAdd: vi.fn() });
    list.update(waiting({ checks: undefined }));
    expect(list.el.hidden).toBe(false);
    expect(list.el.all("li")).toHaveLength(0);
    expect(addB(list)).toBeDefined();
    list.update(waiting({ checks: undefined, status: "running" }));
    expect(list.el.hidden).toBe(true);
    const none = rc.createCheckList({ onMark: vi.fn() });
    none.update(waiting({ checks: undefined }));
    expect(none.el.hidden).toBe(true);
  });
  it("labels the person's own checks and the ones that worked before", () => {
    const list = rc.createCheckList({ onMark: vi.fn() });
    list.update(waiting({ checks: [{ ...CHECKS[0], worked: "t" }, { id: "person-1", try: "T", expect: "E", source: "person" }] }));
    expect(list.el.textContent).toContain("Worked before — try it again");
    expect(list.el.textContent).toContain("Your check");
    expect(list.el.all("li")[0]!.textContent).not.toContain("Your check");
    expect(rc.personChecks(waiting({ checks: [{ ...CHECKS[0], worked: "t" }] }))[0]).toMatchObject({ source: "plan", worked: "t" });
  });
  it("the run header passes the send-back and add handlers on", () => {
    const head = rh.createRunHeader({ onAction: vi.fn(), onMark: vi.fn(), onSendBack: vi.fn(), onAddCheck: vi.fn() });
    head.update(waiting());
    expect(head.el.all("button").some((b: FakeElement) => b.attrs["data-focus"] === "check-add")).toBe(true);
    expect(head.el.all("input").some((b: FakeElement) => b.attrs["data-focus"] === "check-saw-plan-1")).toBe(true);
  });
});

describe("the run header", () => {
  const labels = (head: any) => head.el.all("div").find((d: FakeElement) => d.attrs.class === "run-actions").all("button").map((b: FakeElement) => b.textContent);
  const section = (head: any) => head.el.all("section").find((s: FakeElement) => s.attrs["aria-label"] === "Checks to try");
  it("puts the checks between Now and the buttons, and words Approve by the open checks", () => {
    const head = rh.createRunHeader({ onAction: vi.fn(), onMark: vi.fn() });
    head.update(waiting());
    const kids = head.el.children.map((c: FakeElement) => c.attrs["aria-label"] ?? c.attrs.class);
    const at = (x: string) => kids.indexOf(x);
    expect(at("Now")).toBeLessThan(at("Checks to try"));
    expect(at("Checks to try")).toBeLessThan(at("run-actions"));
    expect(labels(head)).toContain("Approve — 2 checks not marked yet");
    head.update(waiting({ checkMarks: { "plan-1": { mark: "works", at: "t" }, "plan-2": { mark: "works", at: "t" } } }));
    expect(labels(head)[0]).toBe("Approve");
  });
  it("looks as before without checks, and shows no section for a running run", () => {
    const head = rh.createRunHeader({ onAction: vi.fn(), onMark: vi.fn() });
    head.update(waiting({ checks: undefined }));
    expect(labels(head)).toEqual(["Approve", "Reject", "Stop this change…"]);
    expect(section(head).hidden).toBe(true);
    const running = rh.createRunHeader({ onAction: vi.fn(), onMark: vi.fn() });
    running.update(waiting({ status: "running", next: nextStep("running") }));
    expect(section(running).hidden).toBe(true);
  });
  it("the admin Approve button says how many checks are open", () => {
    const labelsOf = (s: any) => runs.actions(s).map((b: FakeElement) => b.textContent);
    expect(labelsOf(waiting())).toContain("✔ Approve — 2 checks not marked yet");
    expect(labelsOf(waiting({ checks: undefined }))).toContain("✔ Approve");
  });
});
