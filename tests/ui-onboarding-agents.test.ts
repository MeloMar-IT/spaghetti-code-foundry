import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let model: any;
let words: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/onboarding-agents.js" as string);
  model = await import("../ui/onboarding-agents-model.js" as string);
  words = await import("../ui/simple-words.js" as string);
});
afterAll(() => restore());

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const item = (id: string, name: string, state: string, over: any = {}) => ({ id, name, needed: true, state, explain: "", ...over });
const REPORT = {
  items: [
    item("git", "Git", "ok"),
    item("claude", "Claude Code", "ok"),
    item("claude-sign-in", "Claude Code sign-in", "ok"),
    item("codex", "Codex", "missing", { explain: "Codex is not on this computer. You only need it for OpenAI models.", command: "npm install -g @openai/codex" }),
  ],
  ready: false,
  problems: 1,
  unchecked: 0,
};
const BOTH_OK = { items: [...REPORT.items.slice(0, 3), item("codex", "Codex", "ok"), item("codex-sign-in", "Codex sign-in", "ok")] };
const ANSWERS = { have: "both", plans: { claude: "max", codex: "plus" }, share: "auto", busy: "normal" };
const KEYS = ["concurrency", "governor.usage_percent", "governor.priority", "default_model", "router.fallback", "router.rules"];
const VALUES = { concurrency: 2, "governor.usage_percent": 80, "governor.priority": "low", default_model: null, "router.fallback": ["codex"], "router.rules": [] };
const view = (over: any = {}) => ({ answers: ANSWERS, settings: VALUES, current: VALUES, kept: [], summary: ["Up to 2 runs at the same time."], ...over });
const NONE = view({ answers: null, settings: null, summary: [] });

const make = (over: any = {}) => ({
  onboardingAgents: vi.fn(async () => NONE),
  saveOnboardingAgents: vi.fn(async (answers: any) => view({ answers })),
  onboardingSignIn: vi.fn(async (tool: string) => ({ tool, state: "started", explain: "The sign-in has started." })),
  onboardingTestCall: vi.fn(async (tool: string) => ({ tool, state: "ok", explain: "It works.", seconds: 1 })),
  setupCheck: vi.fn(async () => REPORT),
  ...over,
});
const draw = async (a: any, o: any = {}) => {
  const box = new FakeElement("div");
  const confirm = vi.fn(async () => true);
  const cleanup = await ui.renderOnboardingAgents(box, { a, admin: true, notify: () => {}, ask: confirm, clipboard: { writeText: vi.fn(async () => {}) }, ...o });
  return { box, cleanup, confirm };
};
const buttons = (box: FakeElement, label: string) => box.all("button").filter((b) => b.textContent === label);
const press = async (box: FakeElement, label: string, n = 0) => {
  const b = buttons(box, label)[n];
  if (!b) throw new Error(`no button "${label}" in: ${box.textContent}`);
  b.click();
  await flush();
};
const pressed = (box: FakeElement) => box.all("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);

describe("the model", () => {
  const d = (have: string | null) => ({ have, plans: {}, share: "auto", busy: "normal" });
  it("lists the steps that apply", () => {
    expect(model.stepsFor(d("both"))).toEqual(["have", "plans:claude", "plans:codex", "install", "signin", "share", "busy"]);
    expect(model.stepsFor(d("claude"))).toEqual(["have", "plans:claude", "install", "signin", "busy"]);
    expect(model.stepsFor(d("codex"))).toEqual(["have", "plans:codex", "install", "signin", "busy"]);
    expect(model.stepsFor(d("none"))).toEqual(["have", "busy"]);
  });
  it("runs again only what a Change affects", () => {
    expect(model.changeSteps("busy", d("both"))).toEqual(["busy"]);
    expect(model.changeSteps("share", d("both"))).toEqual(["share"]);
    expect(model.changeSteps("plans:claude", d("both"))).toEqual(["plans:claude", "install", "signin"]);
    expect(model.changeSteps("have", d("none"))).toEqual(["have", "busy"]);
  });
  it("builds the request from the chosen tools only", () => {
    expect(model.requestOf({ have: "claude", plans: { claude: "pro", codex: "plus" }, share: "codex", busy: "little" })).toEqual({ have: "claude", plans: { claude: "pro" }, busy: "little" });
    expect(model.requestOf({ have: "none", plans: {}, share: "auto", busy: "fast" })).toEqual({ have: "none", plans: {}, busy: "fast" });
  });
  it("keeps a failed test call over a later setup check that says signed in", () => {
    const report = { ...REPORT, seq: 9 };
    expect(model.signState("claude", report, { state: "failed", seq: 1 })).toBe("test-failed");
    expect(model.signState("claude", { ...BOTH_OK, seq: 9 }, { state: "failed", seq: 1 })).toBe("test-failed");
    expect(model.signState("claude", { items: [item("claude-sign-in", "C", "signed-out")], seq: 9 }, { state: "failed", seq: 1 })).toBe("signed-out");
  });

  it("takes the newer of a test and the setup check, and shows a failed test", () => {
    const report = { ...REPORT, seq: 2 };
    expect(model.signState("claude", report, undefined)).toBe("signed-in");
    expect(model.signState("claude", report, { state: "ok", seq: 3 })).toBe("works");
    expect(model.signState("claude", report, { state: "signed-out", seq: 3 })).toBe("signed-out");
    expect(model.signState("claude", report, { state: "ok", seq: 1 })).toBe("signed-in");
    expect(model.signState("claude", { items: [item("claude", "C", "missing")], seq: 1 }, { state: "ok", seq: 0 })).toBe("missing");
    expect(model.signState("claude", report, { state: "failed", seq: 5 })).toBe("test-failed");
    expect(model.signState("codex", report, undefined)).toBe("missing");
    expect(model.signState("claude", null, undefined)).toBeNull();
  });
  it("names kept settings in plain words", () => {
    expect(model.keptText([])).toBe("");
    expect(model.keptText(["default_model", "router.rules"])).toContain("which tool does the work by default, which tool does which step");
    const rows = model.settingRows(view({ kept: ["default_model"] }));
    expect(rows).toHaveLength(6);
    expect(rows.filter((r: any) => r.kept).map((r: any) => r.key)).toEqual(["default_model"]);
    expect(rows[3].current).toBe("not set");
  });
  it("makes no claim about behaviour that kept settings may change", () => {
    const rows = model.summaryRows(ANSWERS, { kept: ["router.fallback"] });
    expect(rows.map((r: any) => r.text).join(" ")).not.toContain("takes over");
    expect(rows.find((r: any) => r.id === "share").text).toContain("set the routing by hand");
    expect(rows.find((r: any) => r.id === "busy").text).not.toContain("by hand");
    const busy = model.summaryRows(ANSWERS, { kept: ["concurrency"] }).find((r: any) => r.id === "busy").text;
    expect(busy).toContain("by hand");
  });
  it("does not say Claude Code does most of the work for the automatic choice", () => {
    const text = model.summaryRows(ANSWERS, {})[0].text;
    expect(text).not.toContain("does most of the work");
    expect(text).toContain("as the Foundry sees fit");
  });
  it("has no forbidden word in its own texts", () => {
    const all = [model.ASK_ADMIN, model.API_KEY_NOTE, model.CONFLICT, ...Object.values<string>(model.QUESTIONS),
      ...[...model.HAVE_OPTIONS, ...model.SHARE_OPTIONS, ...model.BUSY_OPTIONS, ...model.PLAN_OPTIONS.claude, ...model.PLAN_OPTIONS.codex].flatMap((o: any) => [o.label, o.note ?? ""]),
      model.keptText(KEYS)];
    for (const t of all) expect(words.forbiddenIn(t), t).toEqual([]);
    for (const kind of ["signin", "test"]) {
      for (const state of ["started", "done", "missing", "failed", "ok", "signed-out"]) {
        expect(words.forbiddenIn(model.explainAnswer(kind, "claude", { state, explain: "runs" }, true)), `${kind} ${state}`).toEqual([]);
      }
    }
  });
});

describe("question 1", () => {
  it("opens with four choices, notes and two sign-up links, and no input", async () => {
    const { box } = await draw(make());
    expect(box.all("button").map((b) => b.textContent).filter((t) => ["Claude Code", "Codex", "Both", "Neither yet"].includes(t))).toEqual(["Claude Code", "Codex", "Both", "Neither yet"]);
    expect(box.textContent).toContain("Question 1 of 1");
    expect(box.textContent).toContain("When one reaches its limit, the other takes over.");
    const links = box.all("a");
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect(l.getAttribute("target")).toBe("_blank");
      expect(l.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(box.all("input")).toHaveLength(0);
    expect(box.all("textarea")).toHaveLength(0);
    expect(audit(box)).toEqual([]);
  });
});

describe("the chain", () => {
  it("runs through both tools and saves exactly the answers", async () => {
    const a = make({ setupCheck: vi.fn(async () => REPORT) });
    const { box } = await draw(a);
    await press(box, "Both");
    expect(box.textContent).toContain("Which Claude plan do you have?");
    await press(box, "Max");
    expect(box.textContent).toContain("Which ChatGPT plan do you use for Codex?");
    await press(box, "Plus");
    expect(a.setupCheck).toHaveBeenCalledWith([]);
    expect(box.all("strong").map((s) => s.textContent)).toEqual(["Claude Code", "Codex"]);
    expect(buttons(box, "Copy")).toHaveLength(1);
    expect(box.all("code").map((c) => c.textContent)).toEqual(["npm install -g @openai/codex"]);
    await press(box, "Next");
    expect(box.textContent).toContain("Sign in and test");
    await press(box, "Sign in to Claude");
    expect(a.onboardingSignIn).toHaveBeenCalledWith("claude");
    expect(box.textContent).toContain("The sign-in has started.");
    await press(box, "Test Codex");
    expect(a.onboardingTestCall).toHaveBeenCalledWith("codex");
    await press(box, "Next");
    expect(pressed(box)).toEqual(["Let the Foundry decide (recommended)"]);
    await press(box, "Let the Foundry decide (recommended)");
    expect(box.textContent).toContain("How busy may the Foundry be?");
    expect(a.saveOnboardingAgents).not.toHaveBeenCalled();
    await press(box, "Normal");
    expect(a.saveOnboardingAgents).toHaveBeenCalledWith(ANSWERS, [], expect.anything());
  });

  it("skips the share question for one tool, and goes straight to busy for neither", async () => {
    const a = make();
    const one = await draw(a);
    await press(one.box, "Claude Code");
    await press(one.box, "Pro");
    await press(one.box, "Next");
    await press(one.box, "Next");
    expect(one.box.textContent).toContain("How busy may the Foundry be?");
    expect(one.box.textContent).not.toContain("share the work");
    const none = await draw(make());
    await press(none.box, "Neither yet");
    expect(none.box.textContent).toContain("How busy may the Foundry be?");
    await press(none.box, "A little");
    expect(none.box.textContent).toContain("neither Claude Code nor Codex");
    expect(none.box.all("a").some((l) => l.getAttribute("href") === "#/setup")).toBe(true);
  });

  it("disables the buttons of a tool while a call runs, and recovers when the call is refused", async () => {
    let fail: (e: Error) => void = () => {};
    const a = make({ onboardingTestCall: vi.fn(() => new Promise((_res, rej) => { fail = rej; })) });
    const { box } = await draw(a);
    await press(box, "Claude Code");
    await press(box, "Max");
    await press(box, "Next");
    buttons(box, "Test Claude")[0]!.click();
    await flush();
    expect("disabled" in buttons(box, "Test Claude")[0]!.attrs).toBe(true);
    expect("disabled" in buttons(box, "Sign in to Claude")[0]!.attrs).toBe(true);
    fail(Object.assign(new Error("boom"), { status: 500 }));
    await flush();
    expect("disabled" in buttons(box, "Test Claude")[0]!.attrs).toBe(false);
    expect(box.textContent).toContain("The Claude Code test could not be made.");
  });

  it("keeps a failed test in the summary after a later setup check says signed in", async () => {
    const a = make({
      onboardingAgents: vi.fn(async () => view({ answers: { have: "claude", plans: { claude: "max" }, busy: "normal" } })),
      setupCheck: vi.fn(async () => BOTH_OK),
    });
    const { box } = await draw(a);
    await flush();
    await press(box, "Change", 0);
    await press(box, "Max");
    await press(box, "Next");
    a.onboardingTestCall.mockResolvedValueOnce({ tool: "claude", state: "failed", explain: "x", seconds: 1 });
    await press(box, "Test Claude");
    await press(box, "Next");
    await flush();
    expect(a.setupCheck.mock.calls.length).toBeGreaterThan(1);
    expect(box.textContent).toContain("signed in, but the test call did not work");
  });

  it("waits for a setup check still running when Change reaches the install step", async () => {
    let answer: (v: any) => void = () => {};
    const a = make({ onboardingAgents: vi.fn(async () => view({ answers: { have: "claude", plans: { claude: "max" }, busy: "normal" } })) });
    a.setupCheck.mockImplementationOnce(() => new Promise((res) => { answer = res; }));
    const { box } = await draw(a);
    await flush();
    await press(box, "Change", 0);
    await press(box, "Max");
    expect(box.textContent).toContain("Is it installed?");
    expect(box.all("strong")).toHaveLength(0);
    answer(REPORT);
    await flush();
    expect(box.all("strong").map((s) => s.textContent)).toEqual(["Claude Code"]);
  });

  it("shows an unsuccessful test in the summary even when the setup check was fine", async () => {
    const a = make({
      onboardingAgents: vi.fn(async () => view({ answers: { have: "claude", plans: { claude: "max" }, busy: "normal" } })),
      // the check of the first summary and of the install step work; the one after the save does not, so the test result is the newest word
      setupCheck: vi.fn().mockResolvedValueOnce(BOTH_OK).mockResolvedValueOnce(BOTH_OK).mockRejectedValue(new Error("slow")),
    });
    const { box } = await draw(a);
    await flush();
    expect(box.textContent).toContain("Claude Code, Max plan, signed in");
    await press(box, "Change", 0);
    await press(box, "Max");
    await press(box, "Next");
    a.onboardingTestCall.mockResolvedValueOnce({ tool: "claude", state: "signed-out", explain: "Not signed in.", seconds: 1 });
    await press(box, "Test Claude");
    await press(box, "Next");
    await flush();
    expect(box.textContent).toContain("not signed in");
  });
});

describe("the summary", () => {
  it("has a line and a Change for every answer, in plain words", async () => {
    const a = make({ onboardingAgents: vi.fn(async () => view()), setupCheck: vi.fn(async () => BOTH_OK) });
    const { box } = await draw(a);
    await flush();
    const lines = box.all("li").map((l) => l.children.find((c) => c instanceof FakeElement && c.tag === "p") as FakeElement).map((p) => p?.textContent);
    expect(lines).toContain("Claude Code, Max plan, signed in, is used as the Foundry sees fit.");
    expect(lines).toContain("Codex, Plus plan, signed in, takes over when Claude Code reaches its limit.");
    expect(buttons(box, "Change")).toHaveLength(4);
    expect(audit(box)).toEqual([]);
  });

  it("shows the explicit choice as most of the work", async () => {
    const a = make({ onboardingAgents: vi.fn(async () => view({ answers: { ...ANSWERS, share: "claude" } })) });
    const { box } = await draw(a);
    await flush(); // the sign-in state comes from the setup check, which answers after the summary is drawn
    expect(box.textContent).toContain("Claude Code, Max plan, signed in, does most of the work.");
  });

  it("changes only the busy question, saves and comes back", async () => {
    const a = make({ onboardingAgents: vi.fn(async () => view()) });
    const { box } = await draw(a);
    await press(box, "Change", 3);
    expect(box.textContent).toContain("How busy may the Foundry be?");
    expect(box.textContent).toContain("Question 1 of 1");
    await press(box, "A little");
    expect(a.saveOnboardingAgents).toHaveBeenCalledWith({ ...ANSWERS, busy: "little" }, [], expect.anything());
    expect(box.textContent).toContain("How busy: A little.");
  });

  it("changes the Claude line: plan, install, sign-in, then save", async () => {
    const a = make({ onboardingAgents: vi.fn(async () => view()) });
    const { box } = await draw(a);
    await press(box, "Change", 0);
    expect(box.textContent).toContain("Which Claude plan");
    await press(box, "Pro");
    await press(box, "Next");
    expect(box.textContent).toContain("Sign in and test");
    await press(box, "Next");
    expect(a.saveOnboardingAgents).toHaveBeenCalledWith({ ...ANSWERS, plans: { claude: "pro", codex: "plus" } }, [], expect.anything());
  });

  it("goes back to the summary from the first question of a Change", async () => {
    const { box } = await draw(make({ onboardingAgents: vi.fn(async () => view()) }));
    await press(box, "Change", 3);
    await press(box, "Back");
    expect(buttons(box, "Change")).toHaveLength(4);
  });

  it("starts again with all questions, the old answers chosen", async () => {
    const { box } = await draw(make({ onboardingAgents: vi.fn(async () => view()) }));
    await press(box, "Start again");
    expect(box.textContent).toContain("Which do you have?");
    expect(pressed(box)).toEqual(["Both"]);
  });

  it("names kept settings, and replaces them only after a confirm", async () => {
    const kept = ["default_model", "router.rules"];
    const a = make({ onboardingAgents: vi.fn(async () => view({ kept })) });
    const { box, confirm } = await draw(a);
    expect(box.textContent).toContain("which tool does the work by default");
    expect(box.textContent).toContain("which tool does which step");
    confirm.mockResolvedValueOnce(false);
    await press(box, "Use my answers for these too");
    expect(a.saveOnboardingAgents).not.toHaveBeenCalled();
    await press(box, "Use my answers for these too");
    expect(a.saveOnboardingAgents).toHaveBeenCalledWith(ANSWERS, kept, expect.anything());
  });

  it("points the API-key answer to the Credentials page without promising key entry", async () => {
    const answers = { have: "claude", plans: { claude: "api-key" }, busy: "normal" };
    const admin = await draw(make({ onboardingAgents: vi.fn(async () => view({ answers })) }));
    const link = admin.box.all("a").find((l) => l.textContent === "Credentials");
    expect(link?.getAttribute("href")).toBe("#/credentials");
    expect(admin.box.textContent).toContain("is not entered on this page");
    const user = await draw(make({ onboardingAgents: vi.fn(async () => view({ answers })) }), { credentialsHref: "/#/credentials" });
    expect(user.box.all("a").find((l) => l.textContent === "Credentials")?.getAttribute("href")).toBe("/#/credentials");
    expect(user.box.all("input")).toHaveLength(0);
  });
});

describe("inside the Get started guide", () => {
  const SAVED = { draft: { have: "claude", plans: { claude: "pro" }, share: "auto", busy: "little" }, step: "busy" };

  it("resumes at the saved question with the saved choices pressed", async () => {
    const { box } = await draw(make(), { resume: SAVED });
    expect(box.textContent).toContain("How busy may the Foundry be?");
    expect(pressed(box)).toEqual(["A little"]);
  });

  it("resumes an unfinished draft even when answers are already saved on the server", async () => {
    const { box } = await draw(make({ onboardingAgents: vi.fn(async () => view()) }), { resume: SAVED });
    expect(box.textContent).toContain("How busy may the Foundry be?");
    expect(pressed(box)).toEqual(["A little"]);
  });

  it("ignores a draft that is not there, and shows the saved answers", async () => {
    const { box } = await draw(make({ onboardingAgents: vi.fn(async () => view()) }), { resume: null });
    expect(buttons(box, "Change").length).toBeGreaterThan(0);
  });

  it("reports the draft and the question on every answer, the last one before the save, and the completed draft on the summary", async () => {
    const seen: any[] = [];
    const a = make();
    a.saveOnboardingAgents.mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 500 }));
    const { box } = await draw(a, { onDraft: (d: any) => seen.push(d) });
    await press(box, "Claude Code");
    expect(seen.at(-1)).toEqual({ draft: { have: "claude", plans: {}, share: "auto", busy: "normal" }, step: "plans:claude" });
    await press(box, "Pro");
    await press(box, "Next");
    await press(box, "Next");
    expect(seen.at(-1).step).toBe("busy");
    await press(box, "A little");
    // the save failed: the last answer is in the draft all the same
    expect(box.textContent).toContain("could not be saved");
    expect(seen.at(-1)).toEqual({ draft: { have: "claude", plans: { claude: "pro" }, share: "auto", busy: "little" }, step: "busy" });
    await press(box, "Retry");
    expect(seen.at(-1)).toEqual({ draft: { have: "claude", plans: { claude: "pro" }, share: "auto", busy: "little" }, step: null, done: true });
  });

  it("shows the completed draft from the guide, not the answers on the server, and never reports a null", async () => {
    const seen: any[] = [];
    const DONE = { draft: { have: "claude", plans: { claude: "pro" }, share: "auto", busy: "little" }, step: null, done: true };
    const { box } = await draw(make({ onboardingAgents: vi.fn(async () => view({ answers: { have: "both", plans: { claude: "max", codex: "plus" }, share: "even", busy: "fast" } })) }), { resume: DONE, onDraft: (d: any) => seen.push(d) });
    // the summary line is the person's own ("Claude Code, Pro plan"), not the sharing line of the answers on the server
    expect(box.textContent).toContain("Claude Code, Pro plan");
    expect(box.textContent).not.toContain("How they share the work");
    expect(seen).toEqual([DONE]);
  });

  it("starts the questions again with the answers on the server chosen, and clears nothing", async () => {
    const a = make({ onboardingAgents: vi.fn(async () => view()) });
    const { box } = await draw(a, { resume: { fresh: true } });
    expect(box.textContent).toContain("Which do you have?");
    expect(pressed(box)).toEqual(["Both"]);
    expect(a.saveOnboardingAgents).not.toHaveBeenCalled();
  });

  it("is not broken by a callback that throws", async () => {
    const { box } = await draw(make(), { onDraft: () => { throw new Error("x"); } });
    await press(box, "Claude Code");
    expect(box.textContent).toContain("Which Claude plan do you have?");
  });

  it("leaves out its own Start again button with again: false", async () => {
    const a = make({ onboardingAgents: vi.fn(async () => view()) });
    expect(buttons((await draw(a, { again: false })).box, "Start again")).toHaveLength(0);
    expect(buttons((await draw(a)).box, "Start again")).toHaveLength(1);
  });
});

describe("conflicts and errors", () => {
  it("on a 409 reads the page again, resends nothing and asks again for a replacement", async () => {
    const other = view({ answers: { ...ANSWERS, busy: "fast" }, kept: ["default_model"] });
    const a = make({ onboardingAgents: vi.fn().mockResolvedValueOnce(view()).mockResolvedValue(other) });
    a.saveOnboardingAgents.mockRejectedValueOnce(Object.assign(new Error("stale"), { status: 409 }));
    const { box, confirm } = await draw(a);
    await press(box, "Change", 3);
    await press(box, "A little");
    expect(a.saveOnboardingAgents).toHaveBeenCalledTimes(1);
    expect(box.textContent).toContain("The settings were changed meanwhile");
    expect(box.textContent).toContain("How busy: As fast as it can.");
    expect(confirm).not.toHaveBeenCalled();
    await press(box, "Use my answers for these too");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(a.saveOnboardingAgents).toHaveBeenLastCalledWith({ ...ANSWERS, busy: "fast" }, ["default_model"], expect.anything());
  });

  it("shows a load error with Retry", async () => {
    const a = make({ onboardingAgents: vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(NONE) });
    const { box } = await draw(a);
    expect(box.all("div").some((d) => d.getAttribute("role") === "alert")).toBe(true);
    await press(box, "Retry");
    expect(box.textContent).toContain("Which do you have?");
  });

  it("shows a save error with Retry that saves again", async () => {
    const a = make({ onboardingAgents: vi.fn(async () => view()) });
    a.saveOnboardingAgents.mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 500 }));
    const { box } = await draw(a);
    await press(box, "Change", 3);
    await press(box, "Normal");
    expect(box.textContent).toContain("could not be saved");
    await press(box, "Retry");
    expect(a.saveOnboardingAgents).toHaveBeenCalledTimes(2);
  });

  it("does not redraw or notify after cleanup", async () => {
    let finish: (v: any) => void = () => {};
    const a = make({ onboardingAgents: vi.fn(() => new Promise((res) => { finish = res; })) });
    const box = new FakeElement("div");
    const p = ui.renderOnboardingAgents(box, { a, admin: true });
    await flush();
    const before = box.textContent;
    const cleanup = await Promise.race([p, flush().then(() => null)]);
    expect(cleanup).toBeNull();
    finish(view());
    const off = await p;
    off();
    expect(box.textContent).not.toBe("");
    expect(before).not.toContain("Change");
  });
});

describe("who sees it", () => {
  it("shows the ask-your-admin note, no buttons and no call, to a non-admin and in a preview", async () => {
    for (const o of [{ admin: false }, { readOnly: true }]) {
      const a = make();
      const { box } = await draw(a, o);
      expect(box.textContent).toContain("Ask the person who looks after it");
      expect(box.all("button")).toHaveLength(0);
      expect(words.forbiddenIn(box.textContent)).toEqual([]);
      for (const f of Object.values<any>(a)) expect(f).not.toHaveBeenCalled();
    }
  });
});

describe("Simple and Advanced", () => {
  const steps = async (a: any, o: any) => {
    const { box } = await draw(a, o);
    const seen = [box.textContent];
    await press(box, "Both");
    seen.push(box.textContent);
    await press(box, "Max");
    seen.push(box.textContent);
    await press(box, "Plus");
    seen.push(box.textContent);
    await press(box, "Next");
    await press(box, "Sign in to Claude");
    seen.push(box.textContent);
    await press(box, "Test Codex");
    seen.push(box.textContent);
    await press(box, "Next");
    seen.push(box.textContent);
    return seen;
  };

  it("uses no forbidden term in Simple, even when the server speaks of runs", async () => {
    const a = make({
      onboardingSignIn: vi.fn(async (tool: string) => ({ tool, state: "started", explain: "A window opens on the computer that runs the Foundry. Then run the test call." })),
      onboardingTestCall: vi.fn(async (tool: string) => ({ tool, state: "signed-out", explain: "Run codex login.", seconds: 1 })),
    });
    const seen = await steps(a, { simple: true });
    for (const t of seen) expect(words.forbiddenIn(t), t).toEqual([]);
    const done = await draw(make({ onboardingAgents: vi.fn(async () => view()) }), { simple: true });
    await flush();
    expect(words.forbiddenIn(done.box.textContent)).toEqual([]);
    expect(done.box.all("table")).toHaveLength(0);
  });

  it("keeps the error text free of forbidden terms in Simple", async () => {
    const a = make({ onboardingAgents: vi.fn().mockRejectedValue(Object.assign(new Error("5 runs failed on the server"), { status: 500 })) });
    const { box } = await draw(a, { simple: true });
    expect(words.forbiddenIn(box.textContent)).toEqual([]);
  });

  it("shows the settings table and the server's lines in Advanced", async () => {
    const { box } = await draw(make({ onboardingAgents: vi.fn(async () => view({ kept: ["default_model"] })) }));
    expect(box.all("table")).toHaveLength(1);
    expect(box.all("tr")).toHaveLength(1 + 6);
    expect(box.textContent).toContain("Up to 2 runs at the same time.");
  });
});
