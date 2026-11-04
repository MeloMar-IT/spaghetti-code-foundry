import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/setup-check.js" as string);
});
afterAll(() => restore());

const item = (id: string, name: string, state: string, over: any = {}) => ({ id, name, needed: true, state, explain: "", ...over });
const REPORT = {
  platform: "macos",
  items: [
    item("git", "Git", "ok"),
    item("claude", "Claude Code", "ok"),
    item("claude-sign-in", "Claude Code sign-in", "signed-out", { explain: "Claude Code is not signed in.", command: "claude" }),
    item("codex", "Codex", "missing", { needed: false, explain: "Codex is not on this computer.", command: "npm install -g @openai/codex", link: { label: "How to install Codex", url: "https://developers.openai.com/codex/cli" } }),
    item("node", "Node.js", "unknown", { explain: "The Foundry could not check whether Node.js is on this computer." }),
  ],
  ready: false,
  problems: 1,
  unchecked: 1,
  checkedAt: "2026-01-01T00:00:00.000Z",
};
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const draw = async (o: any = {}, report: any = REPORT) => {
  const box = new FakeElement("div");
  const a = { setupCheck: vi.fn(async () => report) };
  const notes: string[] = [];
  const cleanup = await ui.renderSetupCheck(box, { a, admin: true, notify: (t: string) => void notes.push(t), ...o });
  return { box, a, notes, cleanup };
};
const button = (box: FakeElement, label: string) => box.all("button").filter((b) => b.textContent === label);

describe("the Next link", () => {
  it("leads an admin to Claude and Codex, and the ask-admin card has no link", async () => {
    const { box } = await draw();
    const next = box.all("a").find((l) => l.textContent === "Next: Claude and Codex");
    expect(next?.getAttribute("href")).toBe("#/agents");
    const { box: other } = await draw({ admin: false });
    expect(other.all("a")).toHaveLength(0);
  });
});

describe("the rows", () => {
  it("shows a tick, a cross and a question mark, with command, Copy and link", async () => {
    const { box } = await draw();
    const text = box.textContent;
    expect(text).toContain("✔");
    expect(text).toContain("✘");
    expect(text).toContain("?");
    expect(text).toContain("Claude Code is not signed in.");
    expect(text).toContain("(optional)");
    expect(box.all("code").map((c) => c.textContent)).toEqual(["claude", "npm install -g @openai/codex"]);
    expect(button(box, "Copy")).toHaveLength(2);
    const link = box.all("a")[0]!;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(box.all("input")).toHaveLength(0);
    expect(box.all("textarea")).toHaveLength(0);
  });

  it("has Check again at the top and on each problem row only", async () => {
    const { box } = await draw();
    expect(button(box, "Check again")).toHaveLength(1 + 3);
  });

  it("summarises", () => {
    expect(ui.summaryText({ ready: true })).toBe("Everything is ready.");
    expect(ui.summaryText({ ready: false, problems: 2, unchecked: 0 })).toBe("2 things to fix.");
    expect(ui.summaryText({ ready: false, problems: 0, unchecked: 1 })).toContain("could not be checked");
  });

  it("reads the tools asked for from the address", () => {
    expect(ui.needsOf("need=node")).toEqual(["node"]);
    expect(ui.needsOf("?need=node,python&need=node")).toEqual(["node"]);
    expect(ui.needsOf("")).toEqual([]);
  });
});

describe("Copy", () => {
  it("writes the command to the clipboard", async () => {
    const clipboard = { writeText: vi.fn(async () => {}) };
    const { box, notes } = await draw({ clipboard });
    button(box, "Copy")[0]!.click();
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith("claude");
    expect(notes).toEqual(["Copied"]);
  });

  it("says to select the command when there is no clipboard", async () => {
    const { box, notes } = await draw({ clipboard: undefined });
    button(box, "Copy")[0]!.click();
    await flush();
    expect(notes).toEqual(["Select the command and copy it"]);
  });
});

describe("Check again", () => {
  it("asks again with the same needs, disables the buttons meanwhile and redraws", async () => {
    let release!: (r: any) => void;
    const box = new FakeElement("div");
    const a = { setupCheck: vi.fn().mockResolvedValueOnce(REPORT).mockImplementationOnce(() => new Promise((r) => (release = r))) };
    await ui.renderSetupCheck(box, { a, admin: true, needs: ["node"], notify: () => {} });
    expect(a.setupCheck).toHaveBeenLastCalledWith(["node"]);
    button(box, "Check again")[1]!.click();
    expect(a.setupCheck).toHaveBeenCalledTimes(2);
    expect(button(box, "Check again").every((b) => b.getAttribute("disabled") !== null)).toBe(true);
    release({ ...REPORT, items: [item("git", "Git", "ok")], ready: true, problems: 0, unchecked: 0 });
    await flush();
    expect(box.textContent).toContain("Everything is ready.");
    expect(a.setupCheck).toHaveBeenLastCalledWith(["node"]);
  });

  it("shows an error with Retry, and Retry works", async () => {
    const box = new FakeElement("div");
    const a = { setupCheck: vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(REPORT) };
    await ui.renderSetupCheck(box, { a, admin: true, notify: () => {} });
    expect(box.all("div").some((d) => d.getAttribute("role") === "alert")).toBe(true);
    button(box, "Retry")[0]!.click();
    await flush();
    expect(box.textContent).toContain("1 thing to fix.");
  });

  it("does nothing after cleanup", async () => {
    let release!: (r: any) => void;
    const box = new FakeElement("div");
    const a = { setupCheck: vi.fn().mockResolvedValueOnce(REPORT).mockImplementationOnce(() => new Promise((r) => (release = r))) };
    const cleanup = await ui.renderSetupCheck(box, { a, admin: true, notify: () => {} });
    button(box, "Check again")[0]!.click();
    const before = box.textContent;
    cleanup();
    release({ ...REPORT, ready: true, items: [] });
    await flush();
    expect(box.textContent).toBe(before);
  });
});

describe("who sees it", () => {
  it.each([["a user", { admin: false }], ["a preview", { admin: true, readOnly: true }]])("shows a plain card to %s and makes no call", async (_n, o) => {
    const { box, a } = await draw(o);
    expect(box.textContent).toContain("Ask the person who runs it");
    expect(a.setupCheck).not.toHaveBeenCalled();
    expect(box.all("button")).toHaveLength(0);
  });
});
