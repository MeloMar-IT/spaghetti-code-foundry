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
  const l = el.all("label").find((x) => x.textContent === label || x.textContent.startsWith(label))!;
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
  it("gives every covered key a group, and approved releases and tools none", () => {
    expect(covered().length).toBeGreaterThan(10);
    expect(m.groupOf("skills.releases.approved")).toBeUndefined();
    expect(m.groupOf("skills.tools.shell")).toBeUndefined();
    expect(m.groupOf("skills.unresolved.high_risk")).toBe("Skills that cannot be used");
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
  it("several risks come in RISKS order with a key", () => {
    let d = withKey("repository", true);
    d = m.withValue(d, "releases.allow_unreleased", true);
    const r = m.riskyChanges(skills(), d);
    expect(r.map((x: any) => x.key)).toEqual(["skills.repository", "skills.releases.allow_unreleased"]);
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
      expect(hint).toContain("Takes effect when a run starts or resumes.");
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
    const all = ["input", "select", "textarea"].flatMap((t) => s.el.all(t));
    expect(all.length).toBeGreaterThan(10);
    expect(all.every((c: FakeElement) => c.disabled || "disabled" in c.attrs)).toBe(true);
  });
});
