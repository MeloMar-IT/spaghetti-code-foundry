import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* Pictures on the Ask for a change page (#835). */
/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let page: any;
let words: any;
let cm: any;
beforeAll(async () => {
  restore = installFakeDom();
  words = await import("../ui/simple-words.js" as string);
  cm = await import("../ui/simple-change-model.js" as string);
  page = await import("../ui/simple-change.js" as string);
});
afterAll(() => restore());
afterEach(() => cm.clearChangeDraft("r1"));

const CHANGE: any = new Proxy({}, { get: (_t, k) => words.CHANGE[k] });
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
};
const btn = (p: FakeElement, text: string) => p.all("button").find((b) => b.textContent === text)!;
const buttons = (p: FakeElement, text: string) => p.all("button").filter((b) => b.textContent === text);
const off_ = (e: FakeElement) => e.disabled || "disabled" in e.attrs;
const type = (el: FakeElement, v: string) => { el.value = v; el.fire("input", {}); };
const repos = [{ id: "r1", github: "o/app", name: "app" }];
const thinking = { id: "c1", repo: "o/app", text: "x", state: "thinking", created: "2026-01-01T10:00:00Z", updated: "2026-01-01T10:00:00Z" };
const file = (name: string, mime: string, size = 100) => ({ name, type: mime, size });
const png = (name = "a.png", size = 100) => file(name, "image/png", size);

function fake(over: Record<string, any> = {}) {
  return {
    repos: vi.fn(async () => repos),
    changes: vi.fn(async () => ({ changes: [] })),
    change: vi.fn(async () => thinking),
    createChange: vi.fn(async () => thinking),
    ...over,
  } as any;
}
async function open(a: any, extra: any = {}) {
  const main = new FakeElement("div");
  const off = await page.renderSimpleChange(main, { id: "r1", a, every: 1_000_000, readFile: async (f: any) => `B64:${f.name}`, ...extra });
  return { main, off };
}
const input = (main: FakeElement) => main.all("input").find((i) => i.attrs.type === "file")!;
function choose(main: FakeElement, files: any[]) {
  const el: any = input(main);
  el.files = files;
  el.fire("change", { target: el });
}

describe("the picture picker", () => {
  it("shows a file picker, previews with alt text, and removes one", async () => {
    const { main, off } = await open(fake());
    expect(input(main).attrs.accept).toBe("image/png,image/jpeg,image/webp");
    choose(main, [png("a.png"), file("b.jpg", "image/jpeg")]);
    await until(() => main.all("img").length === 2);
    expect(main.all("img").map((i) => i.attrs.alt)).toEqual([CHANGE.pictureAlt(1, "a.png"), CHANGE.pictureAlt(2, "b.jpg")]);
    expect(main.all("img")[0]!.attrs.src).toBe("data:image/png;base64,B64:a.png");
    expect(buttons(main, "Remove")).toHaveLength(2);
    buttons(main, "Remove")[0]!.click();
    await until(() => main.all("img").length === 1);
    expect(main.all("img")[0]!.attrs.alt).toBe(CHANGE.pictureAlt(1, "b.jpg"));
    expect(audit(main)).toEqual([]);
    off();
  });

  it("refuses a sixth, a wrong type, an empty and a too large file with a plain message", async () => {
    const { main, off } = await open(fake());
    choose(main, [png("1.png"), png("2.png"), png("3.png"), png("4.png"), png("5.png"), png("6.png")]);
    await until(() => main.all("img").length === 5);
    expect(main.textContent).toContain(CHANGE.pictureTooMany("6.png"));
    buttons(main, "Remove").forEach(() => btn(main, "Remove").click());
    await until(() => main.all("img").length === 0);
    choose(main, [file("g.gif", "image/gif"), png("e.png", 0), png("big.png", 5 * 1024 * 1024 + 1)]);
    await until(() => main.textContent.includes(CHANGE.pictureTooBig("big.png")));
    expect(main.textContent).toContain(CHANGE.pictureWrongType("g.gif"));
    expect(main.textContent).toContain(CHANGE.pictureEmpty("e.png"));
    expect(main.all("img")).toHaveLength(0);
    off();
  });

  it("never goes over 5 with two overlapping choices, and Send waits until both are read", async () => {
    const waits: (() => void)[] = [];
    const readFile = (f: any) => new Promise<string>((res) => waits.push(() => res(`B64:${f.name}`)));
    const a = fake();
    const { main, off } = await open(a, { readFile });
    type(main.all("textarea")[0]!, "Look at this");
    choose(main, [png("1.png"), png("2.png"), png("3.png")]);
    choose(main, [png("4.png"), png("5.png"), png("6.png")]);
    expect(main.textContent).toContain(CHANGE.pictureTooMany("6.png"));
    expect(waits).toHaveLength(5);
    expect(off_(btn(main, "Send"))).toBe(true);
    btn(main, "Send").click();
    await tick();
    expect(a.createChange).not.toHaveBeenCalled();
    waits.forEach((w) => w());
    await until(() => main.all("img").length === 5);
    expect(off_(btn(main, "Send"))).toBe(false);
    off();
  });

  it("gives the slot back when a read fails", async () => {
    const { main, off } = await open(fake(), { readFile: async (f: any) => { if (f.name === "bad.png") throw new Error("no"); return "B64"; } });
    choose(main, [png("bad.png"), png("ok.png")]);
    await until(() => main.all("img").length === 1);
    expect(main.textContent).toContain(CHANGE.pictureReadFailed("bad.png"));
    expect(off_(btn(main, "Send"))).toBe(false);
    off();
  });

  it("sends the pictures with the text, and sends only repo and text without pictures", async () => {
    const a = fake();
    const { main, off } = await open(a);
    type(main.all("textarea")[0]!, "Plain");
    btn(main, "Send").click();
    await until(() => a.createChange.mock.calls.length === 1);
    expect(a.createChange).toHaveBeenCalledWith({ repo: "o/app", text: "Plain" });
    off();

    const b = fake();
    const second = await open(b);
    type(second.main.all("textarea")[0]!, "With pictures");
    choose(second.main, [png("a.png"), file("b.webp", "image/webp")]);
    await until(() => second.main.all("img").length === 2);
    btn(second.main, "Send").click();
    await until(() => b.createChange.mock.calls.length === 1);
    expect(b.createChange).toHaveBeenCalledWith({ repo: "o/app", text: "With pictures", pictures: ["B64:a.png", "B64:b.webp"] });
    second.off();
  });

  it("keeps text and pictures when the server refuses a picture", async () => {
    const refuse = vi.fn(async () => { throw Object.assign(new Error("picture 1 is not a PNG, JPEG or WebP picture"), { status: 400 }); });
    const a = fake({ createChange: refuse });
    const { main, off } = await open(a);
    type(main.all("textarea")[0]!, "Keep me");
    choose(main, [png("a.png")]);
    await until(() => main.all("img").length === 1);
    btn(main, "Send").click();
    await until(() => main.textContent.includes(CHANGE.picturesRefused));
    expect(main.all("img")).toHaveLength(1);
    expect(main.all("textarea")[0]!.value).toBe("Keep me");
    expect(a.change).not.toHaveBeenCalled();
    expect(off_(btn(main, "Send"))).toBe(false);
    off();
  });
});

describe("the picture helpers", () => {
  it("checks a file against the limits", () => {
    expect(cm.pictureProblem(png(), 0)).toBeNull();
    expect(cm.pictureProblem(png(), 5)).toBe("many");
    expect(cm.pictureProblem(file("x.svg", "image/svg+xml"), 0)).toBe("type");
    expect(cm.pictureProblem(png("e", 0), 0)).toBe("empty");
    expect(cm.pictureProblem(png("b", cm.PICTURE_MAX_BYTES + 1), 0)).toBe("big");
    expect(cm.pictureProblem(png("b", cm.PICTURE_MAX_BYTES), 4)).toBeNull();
  });

  it("reads a file as the same base64 as Buffer, across the chunk sizes", async () => {
    for (const n of [0, 1, 2, 3, 32767, 32768, 32769, 65537, 5 * 1024 * 1024]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      const f = { arrayBuffer: async () => bytes.buffer };
      expect(await cm.readAsBase64(f)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});
