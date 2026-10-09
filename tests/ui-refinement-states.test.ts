import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let st: any;
beforeAll(async () => {
  restore = installFakeDom();
  st = await import("../ui/refinement-states.js" as string);
});
afterAll(() => restore());

const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const buttons = (el: FakeElement) => walk(el).filter((e) => e.tag === "button");
const errorText = (e: any) => (e instanceof TypeError ? "Could not reach the server." : e?.message || "Something went wrong.");
const fail = (status: number, message = "boom") => Object.assign(new Error(message), { status });

describe("failState", () => {
  it("403 is a permission state without Retry", () => {
    const el = st.failState(fail(403, "no access"), { errorText, onRetry: () => {} });
    expect(el.getAttribute("data-kind")).toBe("permission");
    expect(el.textContent).toContain("no access");
    expect(buttons(el)).toHaveLength(0);
  });
  it("404 is a missing state with a link back and no Retry", () => {
    const el = st.failState(fail(404, "no such session"), { errorText, onRetry: () => {} });
    expect(el.getAttribute("data-kind")).toBe("missing");
    expect(buttons(el)).toHaveLength(0);
    const back = walk(el).find((e) => e.tag === "a")!;
    expect(back.getAttribute("href")).toBe("#/refinement");
  });
  it("500 and a network failure can be tried again, with the words of errorText", () => {
    for (const e of [fail(500, "server broke"), new TypeError("x")]) {
      const onRetry = vi.fn();
      const el = st.failState(e, { errorText, onRetry });
      expect(walk(el).find((x) => x.attrs.class === "state-what")!.textContent).toBe(errorText(e));
      const retry = buttons(el).find((b) => b.textContent === "Retry")!;
      retry.click();
      expect(onRetry).toHaveBeenCalledTimes(1);
    }
  });
  it("leaves the back link out when back is null", () => {
    const el = st.failState(fail(500), { errorText, onRetry: () => {}, back: null });
    expect(walk(el).some((e) => e.tag === "a")).toBe(false);
  });
});

describe("announcer", () => {
  it("sets a text once and clears it with an empty text", () => {
    const a = st.announcer();
    expect(a.node.getAttribute("aria-live")).toBe("polite");
    a.say("The architect is at work.");
    expect(a.node.textContent).toBe("The architect is at work.");
    let writes = 0;
    Object.defineProperty(a.node, "textContent", { configurable: true, get: () => "x", set: () => void writes++ });
    a.say("The architect is at work.");
    expect(writes).toBe(0);
    a.say("");
    expect(writes).toBe(1);
    a.say("");
    expect(writes).toBe(1);
  });
});

describe("saveStates", () => {
  it("shows saving, saved and failed with Retry", () => {
    const s = st.saveStates();
    const n = s.node("k");
    expect(n.textContent).toBe("");
    s.set("k", "saving");
    expect(n.textContent).toBe("Saving…");
    s.set("k", "saved");
    expect(n.textContent).toBe("Saved");
    const onRetry = vi.fn();
    s.set("k", "failed", { text: "Title is too long", onRetry });
    expect(n.textContent).toContain("Title is too long");
    expect(n.getAttribute("data-save")).toBe("failed");
    buttons(n).find((b) => b.textContent === "Retry")!.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    s.clear("k");
    expect(n.textContent).toBe("");
  });
  it("keeps the state of a key when the node is made again, and keys do not touch each other", () => {
    const s = st.saveStates();
    s.set("a", "saved");
    s.set("b", "failed", { text: "x", onRetry: () => {} });
    expect(s.node("a").textContent).toBe("Saved");
    expect(s.node("b").getAttribute("data-save")).toBe("failed");
    expect(s.get("a")).toBe("saved");
  });
  it("rekey moves the state and the node", () => {
    const s = st.saveStates();
    const n = s.node("old");
    s.set("old", "saving");
    s.rekey("old", "new");
    expect(s.get("old")).toBeUndefined();
    expect(n.textContent).toBe("Saving…");
    s.set("new", "saved");
    expect(n.textContent).toBe("Saved");
  });
});

describe("split conflict", () => {
  it("isSplitConflict is true for the 409 sentence only", () => {
    expect(st.isSplitConflict(fail(409, "this draft is split into parts; change a part instead"))).toBe(true);
    expect(st.isSplitConflict(fail(409, "another change came first"))).toBe(false);
    expect(st.isSplitConflict(fail(400, "this draft is split"))).toBe(false);
    expect(st.isSplitConflict(undefined)).toBe(false);
  });
  it("splitConflict has a link for each part that opens it", () => {
    const open = vi.fn();
    const el = st.splitConflict([{ id: "p1", label: "Part 1: A" }, { id: "p2", label: "Part 2: B" }], open);
    expect(el.getAttribute("data-kind")).toBe("conflict");
    expect(el.getAttribute("class")).toContain("state-error");
    const links = walk(el).filter((e) => e.tag === "a");
    expect(links.map((l) => l.textContent)).toEqual(["Part 1: A", "Part 2: B"]);
    links[1]!.click();
    expect(open).toHaveBeenCalledWith("p2");
  });
});

describe("issueLink and lostCard", () => {
  it("links only github.com addresses", () => {
    const a = st.issueLink({ published: { issue: 5, url: "https://github.com/a/b/issues/5" } });
    expect(a.tag).toBe("a");
    expect(st.issueLink({ published: { issue: 5, url: "http://evil.example/x" } })).toBe("#5");
  });
  it("lostCard lists the texts and offers Discard only when asked", () => {
    const discard = vi.fn();
    const card = st.lostCard([["Title", "My text"]], discard);
    expect(card.textContent).toContain("Title: My text");
    buttons(card).find((b) => b.textContent === "Discard")!.click();
    expect(discard).toHaveBeenCalled();
    expect(buttons(st.lostCard([["Title", "x"]], null))).toHaveLength(0);
  });
});
