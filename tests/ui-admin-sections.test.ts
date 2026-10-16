import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STEP_ENV_NAME as SERVER_NAME, STEP_ENV_REFUSED as SERVER_REFUSED, ConfigSchema } from "../src/config.js";
import { describeSettings } from "../src/settings/describe.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let sections: any;
beforeAll(async () => {
  restore = installFakeDom();
  sections = await import("../ui/admin-sections.js" as string);
});
afterAll(() => restore());

const described = describeSettings();
const by = (key: string) => described.find((d) => d.key === key)!;
const section = (title: string, ...children: unknown[]) => {
  const el = new FakeElement("div");
  const h3 = new FakeElement("h3");
  h3.append(title);
  el.append(h3, ...(children.flat(Infinity).filter(Boolean) as FakeElement[]));
  return el;
};
const alerts = (el: FakeElement) => el.all("div").filter((d) => d.attrs.role === "alert");

describe("the checks mirror the server", () => {
  it("uses the same regular expressions as src/config.ts", () => {
    expect(sections.STEP_ENV_NAME.source).toBe(SERVER_NAME.source);
    expect(sections.STEP_ENV_REFUSED.source).toBe(SERVER_REFUSED.source);
  });

  it("agrees with ConfigSchema on step_env names", () => {
    for (const n of ["HTTPS_PROXY", "AWS_*", "GH_TOKEN", "GITHUB_X", "FACTORY_A", "SSH_AUTH_SOCK", "1BAD", "A-B", "X_*_Y", ""]) {
      for (const key of ["step_env.pass", "step_env.agent_pass"]) {
        const short = key.split(".")[1]!;
        const ok = ConfigSchema.safeParse({ step_env: { [short]: [n] } }).success;
        expect(sections.settingProblem(by(key), [n]) === undefined, `${key} ${JSON.stringify(n)}`).toBe(ok);
      }
    }
  });

  it("agrees with ConfigSchema on user_read paths", () => {
    for (const p of ["/opt/node", "rel/p", "./x", "~/x"]) {
      const ok = ConfigSchema.safeParse({ sandbox: { user_read: [p] } }).success;
      expect(sections.settingProblem(by("sandbox.user_read"), [p]) === undefined, p).toBe(ok);
    }
  });

  it("limits the number of items", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `V_${i}`);
    expect(sections.settingProblem(by("step_env.pass"), names(101))).toBe("At most 100 items; this list has 101.");
    expect(sections.settingProblem(by("step_env.pass"), names(100))).toBeUndefined();
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `/p/${i}`);
    expect(sections.settingProblem(by("sandbox.user_read"), paths(51))).toBe("At most 50 items; this list has 51.");
    expect(sections.settingProblem(by("sandbox.user_read"), paths(50))).toBeUndefined();
  });

  it("says what is wrong and names the item", () => {
    const gh = sections.settingProblem(by("step_env.pass"), ["GH_TOKEN"]);
    expect(gh).toContain('"GH_TOKEN"');
    expect(gh).toContain("FACTORY_, SCF_, GH_, GITHUB_, GIT_ or SSH_");
    expect(sections.settingProblem(by("step_env.pass"), ["A-B"])).toContain('"A-B" is not a variable name');
    expect(sections.settingProblem(by("sandbox.user_read"), ["rel/p"])).toBe('"rel/p" is not an absolute path: it must start with /.');
    expect(sections.settingProblem(by("failure_summary.model"), "anything")).toBeUndefined();
  });
});

describe("hintFor and hinted", () => {
  it("builds the hint of a described key without the list format, and adds the extra", () => {
    const t = sections.hintFor(described, "sandbox.user_read", "Extra.");
    expect(t).toContain(by("sandbox.user_read").help);
    expect(t).toContain("Default: none.");
    expect(t).toContain("Takes effect when a run starts or resumes.");
    expect(t.endsWith("Extra.")).toBe(true);
    expect(t).not.toContain("One per line");
  });

  it("gives just the extra for a key that is not described", () => {
    expect(sections.hintFor(described, "nope", "Only this.")).toBe("Only this.");
    expect(sections.hintFor(described, "nope")).toBe("");
  });

  it("links the control to the small text", () => {
    const row = new FakeElement("label");
    const control = new FakeElement("input");
    control.setAttribute("aria-describedby", "other");
    const out = sections.hinted(row, control, "Hint text.");
    const small = out.all("small")[0] as FakeElement;
    expect(small.textContent).toBe("Hint text.");
    expect(control.getAttribute("aria-describedby")).toBe(`other ${small.attrs.id}`);
    expect(sections.hinted(row, control, "")).toBe(row);
  });
});

describe("describedSections", () => {
  const config = () => ConfigSchema.parse({});
  const make = (over: Record<string, unknown> = {}, readOnly = false) => sections.describedSections({ ...config(), ...over }, described, { section, readOnly });
  const change = (el: any, value: string) => {
    el.value = value;
    el.fire("change", { target: el });
  };

  it("draws two cards with three controls each", () => {
    const s = make();
    expect(s.cards).toHaveLength(2);
    expect(s.cards[0].all("input")).toHaveLength(3);
    expect(s.cards[0].all("textarea")).toHaveLength(0);
    expect(s.cards[1].all("textarea")).toHaveLength(3);
    expect(Object.keys(s.inputs())).toEqual(["isolate_agents", "failure_summary", "pass", "agent_pass", "user_read"]);
    expect(s.inputs().failure_summary.attrs.type).toBe("text");
  });

  it("shows the message at the field, checks to the first bad control and clears it when fixed", () => {
    const s = make();
    change(s.inputs().pass, "GH_TOKEN");
    expect(alerts(s.cards[1])).toHaveLength(1);
    expect(s.inputs().pass.attrs["aria-invalid"]).toBe("true");
    const bad = s.check();
    expect(bad).toBe(s.inputs().pass);
    change(s.inputs().pass, "HTTPS_PROXY");
    expect(alerts(s.cards[1])).toHaveLength(0);
    expect(s.check()).toBeUndefined();
    expect(s.values().step_env.pass).toEqual(["HTTPS_PROXY"]);
  });

  it("does not draw a control again while its message stays the same", () => {
    const s = make();
    change(s.inputs().pass, "GH_TOKEN");
    const first = s.inputs().pass;
    change(first, "GH_TOKEN\nGH_OTHER");
    expect(s.inputs().pass).toBe(first);
  });

  it("restores the marks that a page cleared", () => {
    const s = make();
    change(s.inputs().user_read, "rel");
    s.inputs().user_read.removeAttribute("aria-invalid");
    s.restore();
    expect(s.inputs().user_read.attrs["aria-invalid"]).toBe("true");
  });

  it("gives the default model for an empty one and keeps what the config had", () => {
    const s = make({ failure_summary: { enabled: false, model: "sonnet" } });
    expect(s.values().failure_summary).toEqual({ enabled: false, model: "sonnet" });
    change(s.inputs().failure_summary, "   ");
    expect(s.values().failure_summary.model).toBe("haiku");
  });

  it("keeps the lock when a control is drawn again", () => {
    const s = make({}, true);
    change(s.inputs().pass, "GH_TOKEN");
    expect(s.inputs().pass.readOnly).toBe(true);
  });

  it("passes a value through when its key is not described", () => {
    const s = sections.describedSections({ ...config(), isolate_agents: false }, [], { section });
    expect(s.cards[0].all("input")).toHaveLength(0);
    expect(s.values().isolate_agents).toBe(false);
    expect(s.check()).toBeUndefined();
    expect(s.inputs()).toEqual({});
  });
});

describe("generatedSection", () => {
  const stored = { enabled: false, sensitive_patterns: [" secret ", "a\nb", "x"], disabled_accounts: ["8f14e45f-ceea-467f-a0e6-1d2f9b5b5c11"], keep_days: 30 };
  const make = (help: Record<string, unknown> = stored, readOnly = false, list = described) => sections.generatedSection("Ask SCF", "help.", { help }, list, { section, readOnly });
  const change = (el: any, value: string) => {
    el.value = value;
    el.fire("change", { target: el });
  };

  it("draws one control per described help key, none for the two exceptions", () => {
    const s = make();
    const keys = described.filter((d) => d.key.startsWith("help.")).map((d) => d.key);
    expect(keys).toHaveLength(12);
    expect(Object.keys(s.inputs())).toEqual(keys);
    expect(keys).not.toContain("help.sensitive_patterns");
    expect(keys).not.toContain("help.disabled_accounts");
    expect(s.card.all("h3")[0].textContent).toBe("Ask SCF");
  });

  it("keeps the stored private patterns and accounts exactly, and drops an emptied optional number", () => {
    const s = make();
    change(s.inputs()["help.max_queued"], "5");
    change(s.inputs()["help.keep_days"], "");
    const v = s.values();
    expect(v.sensitive_patterns).toEqual([" secret ", "a\nb", "x"]);
    expect(v.disabled_accounts).toEqual(stored.disabled_accounts);
    expect(v.max_queued).toBe(5);
    expect("keep_days" in v).toBe(false);
    expect(ConfigSchema.safeParse({ help: v }).success).toBe(true);
  });

  it("locks the controls when read-only", () => {
    const s = make(stored, true);
    expect(s.inputs()["help.keep_days"].readOnly).toBe(true);
  });

  it("returns the stored object and no card when nothing is described", () => {
    const s = make(stored, false, []);
    expect(s.card).toBeNull();
    expect(s.values()).toBe(stored);
    expect(s.check()).toBeUndefined();
  });
});

describe("startupSection", () => {
  it("shows label, value and how to change it, with no input", () => {
    const card = sections.startupSection([{ key: "port", label: "Port", value: 4000, change: "Start with --port.", effectText: "after a restart" }], section);
    expect(card.textContent).toContain("Port: 4000");
    expect(card.textContent).toContain("Start with --port. Takes effect after a restart.");
    expect(card.all("input")).toHaveLength(0);
    expect(card.all("textarea")).toHaveLength(0);
  });
});
