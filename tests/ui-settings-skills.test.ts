import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { describeSettings } from "../src/settings/describe.js";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let m: any;
beforeAll(async () => {
  restore = installFakeDom();
  m = await import("../ui/settings-skills.js" as string);
});
afterAll(() => restore());

const skills = () => ConfigSchema.parse({}).skills as any;
const descriptions = () => describeSettings();
const covered = () => descriptions().filter((d) => m.groupOf(d.key) !== undefined);
const control = (el: FakeElement, label: string) => {
  const l = el.all("label").find((x) => x.textContent === label || x.textContent.startsWith(label));
  if (!l) return el.all("div").find((g) => g.attrs.role === "group" && g.all("span").some((s) => s.attrs.id === g.attrs["aria-labelledby"] && s.textContent === label))!; // a row editor
  const id = l.attrs.for;
  if (!id) return l.all("input")[0]!; // a switch: the input is inside its label
  return el.all("input").concat(el.all("select"), el.all("textarea")).find((c) => c.attrs.id === id)!;
};
const withKey = (key: string, v: unknown) => m.withValue(skills(), key, v);

describe("valueAt and withValue", () => {
  it("reads nested paths", () => {
    expect(m.valueAt({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(m.valueAt({ a: 1 }, "a.b")).toBeUndefined();
    expect(m.valueAt({}, "x.y.z")).toBeUndefined();
  });
  it("copies the path, keeps siblings and never changes its input", () => {
    const input = skills();
    const snap = structuredClone(input);
    const out = m.withValue(input, "selection.max_skills", 3);
    expect(out.selection.max_skills).toBe(3);
    expect(input).toEqual(snap);
    expect(out.releases).toBe(input.releases);
    expect(out.tools).toEqual(snap.tools);
  });
  it("creates missing parents", () => {
    expect(m.withValue({}, "a.b.c", 1)).toEqual({ a: { b: { c: 1 } } });
  });
});

describe("groups", () => {
  it("gives every skills key a group, including approved releases and tools", () => {
    expect(covered().length).toBe(descriptions().filter((d) => d.key.startsWith("skills.")).length);
    expect(m.groupOf("skills.releases.approved")).toBe("Where skills come from");
    expect(m.groupOf("skills.tools.shell")).toBe("Tools a skill may ask for");
    expect(m.groupOf("skills.tools.missing")).toBe("Tools a skill may ask for");
    expect(m.groupOf("skills.unresolved.high_risk")).toBe("Skills that cannot be used");
    expect(m.groupOf("skills.update_check.folder")).toBe("Skill source checks");
    expect(m.groupOf("skills.update_check.every")).toBe("Skill source checks");
  });
});

describe("update_check", () => {
  const sentence = "The server checks the skill sources in this catalogue clone by itself: it commits, pushes branches and opens pull requests there with its own git and gh sign-in. It never merges or approves.";
  const texts = (a: unknown, b: unknown) => m.riskyChanges(a, b).map((r: any) => r.text);
  const at = (folder: unknown, every = "1h") => ({ ...skills(), update_check: folder === undefined ? { every } : { folder, every } });
  it("warns when the folder is set or changed", () => {
    expect(texts(at(undefined), at("/srv/cat"))).toEqual([sentence]);
    expect(texts(at("/srv/cat"), at("/srv/other"))).toEqual([sentence]);
  });
  it("asks nothing for unchanged, cleared or empty folders or a new interval", () => {
    expect(texts(at("/srv/cat"), at("/srv/cat"))).toEqual([]);
    expect(texts(at("/srv/cat"), at(undefined))).toEqual([]);
    expect(texts(at(undefined), at(""))).toEqual([]);
    expect(texts(at("/srv/cat"), at("/srv/cat", "6h"))).toEqual([]);
  });
  it("draws text inputs for both fields", () => {
    const s = m.skillsSection(descriptions(), skills());
    for (const k of ["skills.update_check.folder", "skills.update_check.every"]) {
      const c = control(s.el, descriptions().find((d) => d.key === k)!.label);
      expect([c.tag, c.attrs.type]).toEqual(["input", "text"]);
    }
  });
});

describe("riskyChanges", () => {
  const texts = (a: unknown, b: unknown) => m.riskyChanges(a, b).map((r: any) => r.text);
  it("repository turned on only", () => {
    const off = withKey("repository", false);
    const on = withKey("repository", true);
    expect(texts(off, on)).toEqual(["The skills folder of the repository a run works on is read too; anyone who can push to that repository decides what is in it. Repository skills are listed but never selected for a run."]);
    expect(texts(on, on)).toEqual([]);
    expect(texts(on, off)).toEqual([]);
  });
  it("allow_unreleased turned on", () => {
    expect(texts(skills(), withKey("releases.allow_unreleased", true))).toEqual(["Skill folders that are not an approved catalogue release are loaded; each skill must still match its pin. For development only."]);
  });
  it("a folder added, not removed or reordered", () => {
    const sentence = "Skills in a new folder can reach the agents once they are pinned; make sure only administrators can write to it.";
    expect(texts(withKey("roots", []), withKey("roots", ["/a"]))).toEqual([sentence]);
    expect(texts(withKey("roots", []), withKey("roots", ["/a", "/b"]))).toEqual([sentence]);
    expect(texts(withKey("roots", ["/a", "/b"]), withKey("roots", ["/a"]))).toEqual([]);
    expect(texts(withKey("roots", ["/a", "/b"]), withKey("roots", ["/b", "/a"]))).toEqual([]);
    expect(texts({}, withKey("roots", ["/a"]))).toEqual([sentence]);
  });
  it("each unresolved action changed to warn", () => {
    const words = { unknown: "unknown", missing: "not installed", untrusted: "not from an approved release", conflict: "in conflict", oversized: "too large" };
    for (const [k, w] of Object.entries(words)) {
      const stop = withKey(`unresolved.${k}`, "stop");
      const warn = withKey(`unresolved.${k}`, "warn");
      expect(texts(stop, warn)).toEqual([`A requested skill that is ${w} no longer stops the run; it only gives a warning.`]);
      expect(texts(warn, warn)).toEqual([]);
      expect(texts(warn, stop)).toEqual([]);
    }
  });
  it("a high-risk term removed, not added", () => {
    const terms: string[] = skills().unresolved.high_risk;
    expect(terms.length).toBeGreaterThan(0);
    expect(texts(skills(), withKey("unresolved.high_risk", terms.slice(1)))).toEqual([`A skill marked high-risk by ${terms[0]} no longer always stops the run.`]);
    expect(texts(skills(), withKey("unresolved.high_risk", []))).toHaveLength(terms.length);
    expect(texts(skills(), withKey("unresolved.high_risk", [...terms, "new"]))).toEqual([]);
  });
  it("network turned on only", () => {
    const sentence = "Skills that ask for network access may pass the plan gate.";
    const off = withKey("tools.network", false);
    const on = withKey("tools.network", true);
    expect(texts(off, on)).toEqual([sentence]);
    expect(texts(on, on)).toEqual([]);
    expect(texts(on, off)).toEqual([]);
  });
  it("missing tools set to degrade only", () => {
    const sentence = "A skill whose tool is not available no longer stops the run; it runs without that tool.";
    const stop = withKey("tools.missing", "stop");
    const degrade = withKey("tools.missing", "degrade");
    expect(texts(stop, degrade)).toEqual([sentence]);
    expect(texts(degrade, degrade)).toEqual([]);
    expect(texts(degrade, stop)).toEqual([]);
  });
  it("shell off and filesystem read are stricter and ask nothing", () => {
    expect(texts(skills(), withKey("tools.shell", false))).toEqual([]);
    expect(texts(skills(), withKey("tools.filesystem", "read"))).toEqual([]);
  });
  it("several risks come in RISKS order with a key", () => {
    let d = withKey("repository", true);
    d = m.withValue(d, "releases.allow_unreleased", true);
    d = m.withValue(d, "tools.network", true);
    const r = m.riskyChanges(m.withValue(skills(), "tools.network", false), d);
    expect(r.map((x: any) => x.key)).toEqual(["skills.repository", "skills.releases.allow_unreleased", "skills.tools.network"]);
  });
});

describe("issueKey and issueText", () => {
  const keys = () => covered().map((d) => d.key);
  it("finds the longest key that is the path or a dotted prefix", () => {
    expect(m.issueKey("skills.catalogue.include.0", keys())).toBe("skills.catalogue.include");
    expect(m.issueKey("skills.catalogue.include", keys())).toBe("skills.catalogue.include");
    expect(m.issueKey("skills.catalogue.include_x", keys())).toBeUndefined();
    for (const p of ["notify.slack_webhook", "skills"]) expect(m.issueKey(p, keys())).toBeUndefined();
    expect(m.issueKey("skills.tools.shell", keys())).toBe("skills.tools.shell");
    expect(m.issueKey("skills.a.b.0", ["skills.a", "skills.a.b"])).toBe("skills.a.b");
    expect(m.issueKey(5, keys())).toBeUndefined();
  });
  it("words the message for lists, records and scalars", () => {
    const list = { kind: "list" };
    const records = { kind: "list", fields: [{ key: "digest" }] };
    expect(m.issueText("skills.roots.1", "skills.roots", "m", list)).toBe("Line 2: m");
    expect(m.issueText("skills.roots", "skills.roots", "m", list)).toBe("m");
    expect(m.issueText("skills.roots.x", "skills.roots", "m", list)).toBe("m");
    expect(m.issueText("skills.releases.approved.2.digest", "skills.releases.approved", "m", records)).toBe("Row 3, digest: m");
    expect(m.issueText("skills.releases.approved.2", "skills.releases.approved", "m", records)).toBe("Row 3: m");
    expect(m.issueText("skills.selection.max_skills", "skills.selection.max_skills", "m", { kind: "number" })).toBe("m");
  });
});

describe("showIssues", () => {
  const errorsIn = (el: FakeElement, label: string) => {
    const f = control(el, label).parent!;
    return f.all("div").filter((d: FakeElement) => d.attrs.role === "alert");
  };
  const label = (key: string) => descriptions().find((d) => d.key === key)!.label;
  const issues = [
    { path: "skills.selection.include.0", message: '"x" is also in exclude' },
    { path: "skills.selection.include.0", message: 'a mandatory skill is excluded from the catalogue ("x")' },
    { path: "skills.catalogue.include", message: "more pinned skills than max_candidates" },
    { path: "skills.roots.1", message: "personal agent folders are never scanned" },
  ];
  it("shows each issue at its control and returns the others", () => {
    const s = m.skillsSection(descriptions(), skills());
    const other = [{ path: "concurrency", message: "b" }];
    const before = structuredClone(s.value());
    expect(s.showIssues([...issues, ...other])).toEqual(other);
    const selected = errorsIn(s.el, label("skills.selection.include")).map((e: FakeElement) => e.textContent).join("|");
    expect(selected).toContain('Line 1: "x" is also in exclude');
    expect(selected).toContain('Line 1: a mandatory skill is excluded from the catalogue ("x")');
    expect(errorsIn(s.el, label("skills.catalogue.include")).map((e: FakeElement) => e.textContent)).toEqual([issues[2].message]);
    expect(errorsIn(s.el, label("skills.roots")).map((e: FakeElement) => e.textContent)).toEqual([`Line 2: ${issues[3].message}`]);
    expect(control(s.el, label("skills.roots")).attrs["aria-invalid"]).toBe("true");
    expect(s.value()).toEqual(before);
    expect(s.showIssues([])).toEqual([]);
    expect(s.el.all("div").filter((d: FakeElement) => d.attrs.role === "alert")).toHaveLength(0);
  });
  it("names the line an entry is on now, after blank lines are inserted", () => {
    const s = m.skillsSection(descriptions(), skills());
    const set = (text: string) => {
      const a = control(s.el, label("skills.roots")) as any;
      a.value = text;
      a.fire("change", { target: a });
    };
    set("/a\n/b/.claude");
    s.showIssues([{ path: "skills.roots.1", message: "m" }]);
    expect(errorsIn(s.el, label("skills.roots"))[0].textContent).toBe("Line 2: m");
    set("\n\n/a\n\n/b/.claude");
    s.showIssues([{ path: "skills.roots.1", message: "m" }]);
    const area = control(s.el, label("skills.roots")) as any;
    const n = Number(/Line (\d+)/.exec(errorsIn(s.el, label("skills.roots"))[0].textContent)![1]);
    expect(area.value.split("\n")[n - 1]).toBe("/b/.claude");
    expect(area.value).not.toContain("\n\n");
  });
  const rec = (n: string) => ({ catalogue: n, version: "1.0.0", digest: `sha256:${n.repeat(64).slice(0, 64)}` });
  const approvedGroup = (s: any) => control(s.el, label("skills.releases.approved"));
  const rowInput = (s: any, name: string) => approvedGroup(s).all("input").find((i: FakeElement) => i.attrs["aria-label"] === name)!;
  it("shows a server issue in an approved release as Row N, field", () => {
    const s = m.skillsSection(descriptions(), m.withValue(skills(), "releases.approved", [rec("a")]));
    const path = "skills.releases.approved.0.digest";
    expect(s.showIssues([{ path, message: "must be sha256: and 64 hex digits" }])).toEqual([]);
    const g = approvedGroup(s);
    const alerts = g.all("div").filter((d: FakeElement) => d.attrs.role === "alert");
    expect(alerts.map((a: FakeElement) => a.textContent)).toEqual(["Row 1, digest: must be sha256: and 64 hex digits"]);
    expect(g.attrs["aria-describedby"]).toContain(alerts[0].attrs.id);
  });
  it("numbers rows by the saved value after empty rows are dropped", () => {
    const [a, b] = [rec("a"), rec("b")];
    const s = m.skillsSection(descriptions(), m.withValue(skills(), "releases.approved", [a]));
    const add = () => approvedGroup(s).all("button").find((x: FakeElement) => x.textContent === "Add a row")!;
    add().click();
    add().click();
    for (const k of ["catalogue", "version", "digest"]) {
      const i = rowInput(s, `Row 3, ${k}`);
      i.fire("change", { target: { value: (b as any)[k] } });
    }
    expect(s.value().releases.approved).toEqual([a, b]);
    s.showIssues([{ path: "skills.releases.approved.1.catalogue", message: "bad" }]);
    expect(rowInput(s, "Row 2, catalogue").value).toBe("b");
    expect(rowInput(s, "Row 3, catalogue")).toBeUndefined();
    expect(approvedGroup(s).all("div").filter((d: FakeElement) => d.attrs.role === "alert")[0].textContent).toBe("Row 2, catalogue: bad");
  });
  it("keeps a disabled card disabled and locks it while busy", () => {
    const s = m.skillsSection(descriptions(), skills(), { disabled: true });
    s.showIssues([{ path: "skills.roots.0", message: "m" }]);
    expect(control(s.el, label("skills.roots")).attrs.disabled).not.toBeUndefined();
    const t = m.skillsSection(descriptions(), skills());
    t.busy(true);
    expect(control(t.el, label("skills.roots")).attrs.disabled).not.toBeUndefined();
    t.busy(false);
    expect(control(t.el, label("skills.roots")).attrs.disabled).toBeUndefined();
  });
  it("passes issues through when nothing is described", () => {
    const s = m.skillsSection([], skills());
    expect(s.showIssues(issues)).toEqual(issues);
  });
});

describe("skillsSection", () => {
  it("has one control for each covered description, in groups", () => {
    const s = m.skillsSection(descriptions(), skills());
    expect(s.el.all("h3").map((x: FakeElement) => x.textContent)).toEqual(["Skills"]);
    expect(s.el.all("h4").map((x: FakeElement) => x.textContent)).toEqual(m.SKILL_GROUPS.map((g: any) => g.title));
    for (const d of covered()) {
      const c = control(s.el, d.label);
      expect(c, d.key).toBeDefined();
      const hint = s.el.all("small").map((x: FakeElement) => x.textContent).find((t: string) => t.startsWith(d.help))!;
      expect(hint).toContain("Default: ");
      expect(hint).toContain(`Takes effect ${d.effectText}.`);
    }
    expect(audit(s.el)).toEqual([]);
  });
  const byKey = (s: any, key: string) => control(s.el, descriptions().find((d) => d.key === key)!.label);
  it("builds the right control kinds", () => {
    const s = m.skillsSection(descriptions(), skills());
    const n = byKey(s, "skills.catalogue.max_candidates");
    expect(n.tag).toBe("input");
    expect([n.attrs.type, n.attrs.min, n.attrs.max]).toEqual(["number", "1", "50"]);
    const sw = byKey(s, "skills.builtin");
    expect([sw.attrs.type, sw.attrs.role]).toEqual(["checkbox", "switch"]);
    for (const k of ["skills.roots", "skills.catalogue.include", "skills.unresolved.high_risk"]) expect(byKey(s, k).tag).toBe("textarea");
    expect(byKey(s, "skills.unresolved.missing").all("option").map((o: FakeElement) => o.value)).toEqual(["stop", "warn"]);
    for (const k of ["skills.tools.shell", "skills.tools.network"]) expect(byKey(s, k).attrs.role).toBe("switch");
    expect(byKey(s, "skills.tools.filesystem").all("option").map((o: FakeElement) => o.value)).toEqual(["read", "write"]);
    expect(byKey(s, "skills.tools.missing").all("option").map((o: FakeElement) => o.value)).toEqual(["stop", "degrade"]);
    expect(byKey(s, "skills.releases.approved").attrs.role).toBe("group");
  });
  it("changes the value, keeps other keys and the input", () => {
    const input = skills();
    const snap = structuredClone(input);
    const s = m.skillsSection(descriptions(), input);
    byKey(s, "skills.selection.max_skills").value = "3";
    byKey(s, "skills.selection.max_skills").fire("change", { target: byKey(s, "skills.selection.max_skills") });
    expect(s.value().selection.max_skills).toBe(3);
    expect(s.value().releases.approved).toEqual(snap.releases.approved);
    expect(s.value().tools).toEqual(snap.tools);
    expect(input).toEqual(snap);
  });
  it("asks only for a change since the last save", () => {
    const s = m.skillsSection(descriptions(), skills());
    const box = byKey(s, "skills.repository");
    box.checked = true;
    box.fire("change", { target: box });
    expect(s.risks()).toHaveLength(1);
    s.saved(s.value());
    expect(s.risks()).toEqual([]);
    box.checked = false;
    box.fire("change", { target: box });
    box.checked = true;
    box.fire("change", { target: box });
    expect(s.risks()).toEqual([]);
  });
  it("shows a message and keeps skills when nothing is described", () => {
    const input = skills();
    for (const d of [undefined, [], [{ key: "other.thing" }]]) {
      const s = m.skillsSection(d, input);
      expect(s.el.textContent).toContain("The skills settings could not be described by the server.");
      expect(s.value()).toBe(input);
      expect(s.risks()).toEqual([]);
    }
  });
  it("disables every control", () => {
    const s = m.skillsSection(descriptions(), skills(), { disabled: true });
    const all = ["input", "select", "textarea", "button"].flatMap((t) => s.el.all(t));
    expect(all.length).toBeGreaterThan(10);
    expect(all.every((c: FakeElement) => c.disabled || "disabled" in c.attrs)).toBe(true);
  });
});
