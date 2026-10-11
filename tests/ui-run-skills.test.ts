import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { markPlanCheckFailed } from "../src/engine/plan-carry.js";
import { runSkillView } from "../src/server/skill-view.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/run-skills.js" as string);
});
afterAll(() => restore());

const row = (over: any = {}) => ({ id: "a", version: "1.0.0", requiredBy: [], integrity: "verified", ...over });
const req = (over: any = {}) => ({ id: "a", by: "plan", state: "selected", ...over });
const view = (over: any = {}) => ({ lock: "ok", requested: [], resolved: [], ...over });
const text = (el: FakeElement | null) => el?.textContent ?? "";
const card = (v: any, o: any = {}) => ui.skillsCard(v, o) as FakeElement;
const headings = (el: FakeElement, tag: string) => el.all(tag).map((x) => x.textContent);
const cells = (el: FakeElement) => el.all("tbody").flatMap((b) => b.all("tr")).map((tr) => tr.all("td"));

describe("skillsCard", () => {
  it("gives null without a view", () => {
    expect(ui.skillsCard(undefined)).toBeNull();
    expect(ui.skillsCard(null)).toBeNull();
  });

  it("is a labelled section with the two headings", () => {
    const c = card(view({ requested: [req()], resolved: [row()] }));
    expect(c.tag).toBe("section");
    expect(c.attrs["aria-label"]).toBe("Skills");
    expect(headings(c, "h2")).toEqual(["Skills"]);
    expect(headings(c, "h3")).toEqual(["Requested", "Resolved"]);
  });

  it("says so when nothing is used or requested", () => {
    expect(text(card(view({ requested: [req({ state: "missing" })] })))).toContain("No skills are used.");
    expect(text(card(view({ resolved: [row()] })))).toContain("None.");
  });

  it.each([
    ["selected", "Selected", "ok"], ["missing", "Missing", "fail"], ["conflicting", "Conflicting", "fail"],
    ["not-approved", "Not approved", "fail"], ["too-large", "Too large", "fail"], ["not-checked", "Not checked", ""],
  ])("draws the requested state %s as %s", (state, label, cls) => {
    const c = card(view({ requested: [req({ state })] }));
    const pill = c.all("span").find((s) => s.textContent === label)!;
    expect(pill.attrs.class).toBe(`pill ${cls}`.trim());
  });

  it("says who asked for a requested skill and shows reason, evidence and message", () => {
    const c = card(view({ requested: [
      req({ reason: "Needed for the change", evidence: [{ kind: "path", text: "src/a.ts" }], message: "Fix it.", state: "missing" }),
      req({ id: "m", by: "administrator", version: "2.0.0" }),
    ] }));
    const t = text(c);
    expect(t).toContain("asked for by the plan");
    expect(t).toContain("always included by the administrator");
    expect(t).toContain("Needed for the change");
    expect(t).toContain("src/a.ts");
    expect(t).toContain("Fix it.");
    expect(t).toContain("m@2.0.0");
  });
});

describe("the resolved table", () => {
  it("holds version, category, reason, evidence, tokens and integrity in the row", () => {
    const c = card(view({ resolved: [row({ category: "testing", estimatedTokens: 120, selection: "requested", reason: "Because", evidence: [{ kind: "catalogue", text: "a" }] })] }));
    const [r] = cells(c);
    expect(text(r![0]!)).toBe("a@1.0.0");
    expect(text(r![1]!)).toBe("testing");
    expect(text(r![2]!)).toContain("Because");
    expect(text(r![2]!)).toContain("catalogue a");
    expect(text(r![3]!)).toBe("about 120 tokens");
    expect(text(r![4]!)).toBe("Verified");
    expect(headings(c, "th")).toEqual(["Skill", "Category", "Why", "Context estimate", "Integrity", "In the session"]);
  });
  it("names the skills a dependency is needed by", () => {
    const [r] = cells(card(view({ resolved: [row({ selection: "dependency", requiredBy: ["x", "y"] })] })));
    expect(text(r![2]!)).toContain("Needed by x, y");
  });
  it("draws an unknown integrity as it is and missing fields as a dash", () => {
    const [r] = cells(card(view({ resolved: [row({ integrity: "odd-value" })] })));
    expect(text(r![4]!)).toBe("odd-value");
    expect(text(r![1]!)).toBe("—");
    expect(text(r![3]!)).toBe("—");
    expect(text(r![5]!)).toBe("—");
  });
  it.each([
    ["verified", "ok"], ["changed", "fail"], ["missing", "fail"], ["unpinned", "fail"], ["unapproved", "fail"],
    ["unverified", "locked"], ["not-checked", "locked"], ["not-locked", "locked"],
  ])("draws the integrity %s as a %s pill", (integrity, cls) => {
    const [r] = cells(card(view({ resolved: [row({ integrity })] })));
    const pill = r![4]!.all("span")[0]!;
    expect(pill.attrs.class).toBe(`pill ${cls}`);
    expect(text(pill)).toBe(ui.INTEGRITY_LABELS[integrity]);
  });
  it.each([
    ["loaded", "Loaded at implement"], ["reloaded", "Reloaded at implement"], ["reused", "Reused at implement"], ["omitted", "Left out (over budget) at implement"],
  ])("draws the session state %s", (context, expected) => {
    const [r] = cells(card(view({ resolved: [row({ context, contextStep: "implement" })] })));
    expect(text(r![5]!)).toBe(expected);
  });
  it("says when review checks were given", () => {
    const [r] = cells(card(view({ resolved: [row({ context: "loaded", contextStep: "s", review: true })] })));
    expect(text(r![5]!)).toContain("Review checks given");
  });
  it("has Source and Digest only for an administrator", () => {
    const v = view({ resolved: [row({ source: "builtin", digest: `sha256:${"a".repeat(64)}` }), row({ id: "b", source: "admin" })] });
    expect(headings(card(v), "th")).not.toContain("Digest");
    expect(text(card(v))).not.toContain("sha256");
    const c = card(v, { admin: true });
    expect(headings(c, "th").slice(-2)).toEqual(["Source", "Digest"]);
    const rows = cells(c);
    expect(text(rows[0]![6]!)).toBe("built-in");
    expect(text(rows[1]![6]!)).toBe("administrator folder");
    const digest = rows[0]![7]!;
    expect(text(digest)).toBe(`sha256:${"a".repeat(12)}`);
    expect(digest.attrs.title).toBe(`sha256:${"a".repeat(64)}`);
    expect(text(rows[1]![7]!)).toBe("—");
  });
});

describe("evidence", () => {
  const evidence = (e: any, repo?: string) => ui.evidenceItem(e, repo) as FakeElement;
  it("shows a path as text, not as a link", () => {
    const el = evidence({ kind: "path", text: "src/a.ts" }, "acme/app");
    expect(el.tag).not.toBe("a");
    expect(text(el)).toContain("src/a.ts");
  });
  it("links an issue only when the repository is owner/name", () => {
    const a = evidence({ kind: "issue", text: "12" }, "acme/app");
    expect(a.tag).toBe("a");
    expect(a.attrs.href).toBe("https://github.com/acme/app/issues/12");
    expect(a.attrs.rel).toBe("noopener");
    expect(a.attrs.target).toBe("_blank");
    for (const repo of ["/srv/x", "", undefined, "a/b/c", "../x"]) expect(evidence({ kind: "issue", text: "12" }, repo).tag).toBe("span");
    expect(evidence({ kind: "issue", text: "omitted" }, "acme/app").tag).toBe("span");
    expect(evidence({ kind: "issue", text: "12/../x" }, "acme/app").tag).toBe("span");
  });
  it("keeps markup as text", () => {
    const c = card(view({
      requested: [req({ reason: "<img src=x onerror=alert(1)>", evidence: [{ kind: "path", text: "<img onerror=alert(1)>" }] })],
      resolved: [row({ reason: "<b>x</b>", evidence: [{ kind: "catalogue", text: "<img onerror=alert(2)>" }] })],
    }));
    expect(text(c)).toContain("<img onerror=alert(1)>");
    expect(text(c)).toContain("<b>x</b>");
    expect(c.all("img")).toHaveLength(0);
    expect(c.all("b").filter((b) => b.textContent === "x")).toHaveLength(0);
  });
});

describe("status sentences", () => {
  const sentence = (over: any) => text(card(view({ requested: [req()], ...over })));
  it("names a lock that is missing or changed", () => {
    expect(sentence({ lock: "missing" })).toContain("The skill lock of this run is missing or was changed.");
    expect(sentence({ lock: "changed" })).toContain("The skill lock of this run is missing or was changed.");
    expect(sentence({ lock: "ok" })).not.toContain("skill lock of this run");
  });
  it("says when the run planned again", () => expect(sentence({ planChanged: true })).toContain("The run planned again. New skills are locked at the next agent step."));
  it("says when the run stopped", () => expect(sentence({ action: "stop" })).toContain("The run stopped because a skill cannot be used."));
  it("says the size of the skill context and when integrity was checked", () => {
    const t = sentence({ resolved: [row()], estimatedTokens: 300, checkedAt: "2026-01-02T00:00:00.000Z" });
    expect(t).toContain("About 300 tokens of skill context.");
    expect(t).toContain("Integrity checked 2026-01-02T00:00:00.000Z.");
  });
});

describe("planRecordNote", () => {
  const note = (rec: any) => ui.planRecordNote({ planRecord: rec }) as string | null;
  it("has one sentence per outcome", () => {
    for (const o of ["none", "record-purged", "comment-missing", "comment-changed", "newer-plan", "check-unreadable", "invalid", "failed", "record"]) {
      expect(note({ outcome: o })).toContain(ui.PLAN_RECORD_NOTES[o]);
    }
  });
  it("says how a stop and a warning end", () => {
    expect(note({ outcome: "comment-changed", stopped: true })).toContain("Plan the issue again, then resume.");
    expect(note({ outcome: "newer-plan" })).toContain("The run goes on without the plan's skills.");
    expect(note({ outcome: "none" })).toContain("codes without the plan's skills");
  });
  it("lists the changes of a record and ignores unknown words", () => {
    expect(note({ outcome: "record", changes: ["code", "technology", "x"] })).toContain("Changed since the plan: code, technology.");
  });
  it("a failed gh call reaches the card as: resume to check again, not plan again", () => {
    const run: any = {
      runId: "r", runDir: "/x", history: [{ id: "plan_check", type: "shell", ok: false, visit: 1, output: "" }],
      flowDef: { name: "f", steps: [{ id: "plan_check", type: "shell", run: "gh issue view | node $FACTORY_TOOLS/plan-comment" }] },
      skillCarry: { stale: true },
    };
    markPlanCheckFailed(run, "plan_check");
    const v = runSkillView(run, { admin: false, readLock: () => ({ ok: false, reason: "missing" }) });
    const t = text(card(v));
    expect(t).toContain("The plan comments could not be read.");
    expect(t).toContain("resume to check again");
    expect(t).not.toContain("Plan the issue again");
    expect(t).not.toContain("goes on without");
  });
  it("draws nothing for an unknown outcome and draws the note as text", () => {
    expect(note({ outcome: "toString" })).toBeNull();
    expect(ui.planRecordNote({})).toBeNull();
    expect(text(card(view({ planRecord: { outcome: "none" } })))).toContain("No plan record was found");
  });
});
