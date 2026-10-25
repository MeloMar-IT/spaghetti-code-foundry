import { describe, expect, it } from "vitest";
import {
  DEPS_MARK, DEPS_MARK_END, DEP_REF_SOURCE, cleanReason, dependencies, dependencyDone, dependencyRange, dependencyText, foundryDependsOn,
  mergeDependsOn, openDependencies, removeFromDependsOn, titleIndex, withoutFoundryPart,
} from "../src/queue/deps.js";

const all = [
  { number: 1, title: "Story 1 — Publish update metadata", state: "CLOSED" },
  { number: 2, title: "Story 2 — Check for updates", state: "CLOSED" },
  { number: 12, title: "Story 12 — Audit and monitor updates", state: "OPEN" },
  { number: 6, title: "Story 6 — Prepare for installation", state: "OPEN", labels: [{ name: "Factory_done" }] },
  { number: 7, title: "Story 7 — Install the update", state: "OPEN" },
];

describe("issue dependencies", () => {
  it("reads a Depends on section up to the next heading", () => {
    expect(dependencyText("x\n### Depends on\nStory 4.\n\n### Notes\nabc")).toBe("Story 4.");
    expect(dependencyText("Depends on: #3, #4\nmore")).toContain("#3, #4");
    expect(dependencyText("Blocked by #9")).toBe("#9");
    expect(dependencyText("nothing here")).toBe("");
  });

  it("matches #N references and issue titles, not prefixes of other numbers", () => {
    const body = "### Depends on\nStory 6 — Prepare for installation; Story 7 — Install the update; #2\n";
    expect(dependencies(body, 12, all)).toEqual([2, 6, 7]);
    expect(dependencies("### Depends on\nStory 1 — Publish update metadata.", 5, all)).toEqual([1]);
    expect(dependencies("### Depends on\nStory 2 — Check for updates (for status to reflect against).", 5, all)).toEqual([2]);
    expect(dependencies("### Depends on\nNone", 5, all)).toEqual([]);
    expect(dependencies("### Depends on\n#12", 12, all)).toEqual([]); // not itself
  });

  it("finds a dependency named by a shortened title inside a longer one", () => {
    const web = [
      ...all,
      { number: 91, title: "Website Story 1 — Website source lives in this repo", state: "OPEN" },
      { number: 97, title: "Website Story 7 — Daily check for new GitHub releases", state: "OPEN" },
      { number: 99, title: "Website Story 9 — Deployment script to the web server", state: "OPEN" },
    ];
    expect(dependencies("### Depends on\nStory 7 — Daily check for new GitHub releases; Story 9 — Deployment script.", 100, web)).toEqual([97, 99]);
    // A title that starts with the text still wins (no extra matches): "Story 7 — Install the update" is #7 here.
    expect(dependencies("### Depends on\nStory 7 — Install the update", 5, web)).toEqual([7]);
    expect(dependencies("### Depends on\nStory 1 — Website source lives in this repo.", 93, web)).toEqual([91]);
    // Reworded title: the same story number in the issue's own epic.
    const web2 = [...web, { number: 95, title: "Website Story 5 — Public changelog page", state: "OPEN" },
      { number: 96, title: "Website Story 6 — Automatically generate the changelog from releases", state: "OPEN" }];
    expect(dependencies("### Depends on\nStory 6 — Automatically generate the changelog from new releases.", 95, web2)).toEqual([96]);
  });

  it("counts closed issues and done labels as done; ignores unknown issues", () => {
    expect(openDependencies([1, 6, 7, 99], all, ["Factory_done"])).toEqual([7]);
    expect(openDependencies([6], all, [])).toEqual([6]);
  });

  it("dependencyDone: closed, done labels, and the watcher's done label only with gitflow", () => {
    const open = { number: 1, title: "t", state: "OPEN" };
    const rule = { doneLabels: ["done-x"], doneLabel: "factory:done" };
    expect(dependencyDone({ ...open, state: "CLOSED" }, rule)).toBe(true);
    expect(dependencyDone({ ...open, labels: [{ name: "done-x" }] }, rule)).toBe(true);
    expect(dependencyDone({ ...open, labels: [{ name: "factory:done" }] }, { ...rule, gitflow: true })).toBe(true);
    expect(dependencyDone({ ...open, labels: [{ name: "factory:done" }] }, { ...rule, gitflow: false })).toBe(false);
    expect(dependencyDone({ ...open, labels: [{ name: "factory:done" }] }, rule)).toBe(false);
    expect(dependencyDone(undefined, rule)).toBe(true);
    expect(dependencyDone(open, rule)).toBe(false);
  });

  it("openDependencies takes a rule: the done label counts only with gitflow", () => {
    const issues = [{ number: 7, title: "x", state: "OPEN", labels: [{ name: "factory:done" }] }];
    expect(openDependencies([7], issues, { doneLabels: [], doneLabel: "factory:done", gitflow: true })).toEqual([]);
    expect(openDependencies([7], issues, { doneLabels: [], doneLabel: "factory:done", gitflow: false })).toEqual([7]);
  });
});

describe("dependencyRange", () => {
  const forms = [
    "Depends on: #3, #4\nmore\n\n## Notes\nx",
    "x\n### Depends on\n#12\n- #13\n\n### Notes\nabc",
    "a\n**Depends on:** #5 and #6\n**Notes**\nz",
    "### Depends on\n\nNone\n",
    "Depends on: #3, #4\r\nmore\r\n\r\n## Notes\r\nx",
    "x\r\n### Depends on\r\n#12\r\n- #13\r\n\r\n### Notes\r\nabc",
    "a\r\n**Depends on:** #5 and #6\r\n**Notes**\r\nz",
    "### Depends on\r\n\r\nNone\r\n",
    "### Depends on\r\n#1\r\n#2\r\n#3\r\n",
  ];
  it.each(forms)("matches dependencyText for %j", (body) => {
    const r = dependencyRange(body)!;
    expect(body.slice(r.start, r.end).trim()).toBe(dependencyText(body));
    expect(body.slice(r.start, r.end)).toBe(dependencyText(body));
  });
  it("handles other cases", () => {
    const b = "Blocked by #9";
    const r = dependencyRange(b)!;
    expect(b.slice(r.start, r.end)).toBe("#9");
    expect(dependencyRange("nothing here")).toBeUndefined();
    const e2 = dependencyRange("Depends on:")!;
    expect(e2.start).toBe(e2.end);
    const long = `### Depends on\n${"#1 ".repeat(800)}\n`;
    const lr = dependencyRange(long)!;
    expect(lr.end - lr.start).toBe(1000);
    expect(long.slice(lr.start, lr.end)).toBe(dependencyText(long));
  });
  it("keeps the line ends of a CRLF body", () => {
    expect(dependencyText("### Depends on\r\n#12\r\n- #13")).toBe("#12\r\n- #13");
    expect(dependencyText("Depends on: #3, #4\r\nmore\r\n\r\n## Notes\r\nx")).toBe("#3, #4\r\nmore");
    expect(dependencyText("### Depends on\r\n\r\nNone\r\n")).toBe("None");
    expect(dependencyText("Depends on:\r\n")).toBe("");
    const e = dependencyRange("Depends on:\r\n")!;
    expect(e.start).toBe(e.end);
    expect(dependencyText("nothing\r\nhere")).toBe("");
    expect(dependencyRange("nothing\r\nhere")).toBeUndefined();
  });
  it("finds the same dependencies with CRLF", () => {
    expect(dependencies("### Depends on\r\nStory 6 — Prepare for installation\r\n- #2\r\n\r\n### Notes\r\n#7", 12, all)).toEqual([2, 6]);
    expect(dependencies("### Depends on\r\nNone\r\n", 5, all)).toEqual([]);
  });
  it("never makes the range longer than 1000 characters, with CRLF too", () => {
    const long = `### Depends on\r\n${"#1 ".repeat(800)}\r\n`;
    const lr = dependencyRange(long)!;
    expect(lr.end - lr.start).toBe(1000);
    expect(long.slice(lr.start, lr.end)).toBe(dependencyText(long));
    const multi = `### Depends on\r\n${"a\r\n".repeat(500)}`;
    const mr = dependencyRange(multi)!;
    expect(mr.end - mr.start).toBeLessThanOrEqual(1000);
    expect(multi.slice(mr.start, mr.end)).toBe(dependencyText(multi));
  });
  it("DEP_REF_SOURCE matches a plain reference only", () => {
    const re = () => new RegExp(DEP_REF_SOURCE, "g");
    expect("see #12.".match(re())).toEqual(["#12"]);
    expect("owner/repo#12".match(re())).toBeNull();
    expect("a#12".match(re())).toBeNull();
  });
});

describe("title index", () => {
  const body = "Depends on: Story 7 — Install the update";
  it("gives the same answer as no index", () => {
    expect(dependencies(body, 99, all, titleIndex(all))).toEqual(dependencies(body, 99, all));
    expect(dependencies(body, 99, all)).toEqual([7]);
  });
  it("without an index it follows a changed title, in place or replaced", () => {
    const list = all.map((i) => ({ ...i }));
    list[4]!.title = "Story 8 — Something else";
    expect(dependencies(body, 99, list)).toEqual([]);
    list[3] = { number: 6, title: "Story 7 — Install the update", state: "OPEN" };
    expect(dependencies(body, 99, list)).toEqual([6]);
  });
});

describe("the Foundry's part (#675)", () => {
  const P = (issues: number[], reason: string, eol = "\n") =>
    [DEPS_MARK, ...issues.map((n) => `- #${n}`), reason ? `_Added by the Spaghetti Code Foundry: ${reason}_` : "_Added by the Spaghetti Code Foundry._", DEPS_MARK_END].join(eol);
  const section = "x\n### Depends on\nStory 4.\n\n### Notes\nabc";

  it("makes a section when there is none", () => {
    expect(mergeDependsOn("Intro", [12, 5], "Waits for the API")).toBe(`Intro\n\n### Depends on\n${P([5, 12], "Waits for the API")}`);
  });
  it.each([
    ["", "\n\n### Depends on\n"],
    ["  ", "  \n\n### Depends on\n"],
  ])("empty or blank body %j", (b, head) => {
    const merged = mergeDependsOn(b, [3], "r");
    expect(merged).toBe(head + P([3], "r"));
    expect(mergeDependsOn(merged, [3], "r")).toBe(merged);
    expect(foundryDependsOn(merged)).toEqual([3]);
  });
  it("blank CRLF body", () => {
    const merged = mergeDependsOn("\r\n", [3], "r");
    expect(merged).toBe("\r\n\r\n\r\n### Depends on\r\n" + P([3], "r", "\r\n"));
    expect(mergeDependsOn(merged, [3], "r")).toBe(merged);
  });
  it("goes under a header, and comes out again", () => {
    const merged = mergeDependsOn(section, [12], "r");
    expect(merged.startsWith("x\n### Depends on\n" + DEPS_MARK)).toBe(true);
    expect(withoutFoundryPart(merged)).toBe(section);
    expect(mergeDependsOn(merged, [12], "r")).toBe(merged);
    expect(removeFromDependsOn(merged, [12])).toBe(section);
  });
  it.each([
    "### Depends on", "### Depends on\n", "Depends on: #3", "Depends on: #3\nmore", "a\n**Depends on:** #5\n**Notes**\nz",
    "### Depends on\r\n", "x\r\n### Depends on\r\n#12\r\n\r\n### Notes\r\nabc", "Depends on: #3\r\n",
  ])("round trip with %j", (orig) => {
    const merged = mergeDependsOn(orig, [12], "r");
    expect(withoutFoundryPart(merged)).toBe(orig);
    expect(removeFromDependsOn(merged, [12])).toBe(orig);
    expect(mergeDependsOn(merged, [12], "r")).toBe(merged);
    expect(dependencyText(withoutFoundryPart(merged))).toBe(dependencyText(orig));
    if (orig.includes("\r\n")) expect(merged.replace(/\r\n/g, "")).not.toContain("\n");
  });
  it.each([
    ["LF", "\n", "Notes\n"],
    ["CRLF", "\r\n", "Notes\r\n"],
  ])("an existing part at the end keeps the person's line end (%s)", (_name, eol, text) => {
    const part = P([5], "why", eol);
    const body = text + part;
    expect(withoutFoundryPart(body)).toBe(text);
    expect(removeFromDependsOn(body, [5])).toBe(text);
    expect(foundryDependsOn(body)).toEqual([5]);
  });
  it("inline header: the person's and the Foundry's issues", () => {
    expect(dependencies(mergeDependsOn("Depends on: #3\nmore", [12], "r"), 100, [])).toEqual([3, 12]);
  });
  it("unions, with the newest reason", () => {
    const merged = mergeDependsOn(mergeDependsOn("x", [5], "A"), [7], "B");
    expect(foundryDependsOn(merged)).toEqual([5, 7]);
    expect(merged).toContain("Foundry: B_");
    expect(merged).not.toContain("Foundry: A_");
    expect(merged.split(DEPS_MARK + "\n").length).toBe(2);
    expect(mergeDependsOn("x", [], "r")).toBe("x");
    expect(mergeDependsOn("x", [0, -1, 1.5], "r")).toBe("x");
  });
  it("finds the part", () => {
    expect(foundryDependsOn("#3")).toEqual([]);
    expect(foundryDependsOn(`${DEPS_MARK_END} #3 ${DEPS_MARK}`)).toEqual([]);
    expect(foundryDependsOn(`${DEPS_MARK} #3`)).toEqual([]);
    expect(foundryDependsOn(`${DEPS_MARK}\n#3\n${P([9], "")}`)).toEqual([9]);
    const many = Array.from({ length: 300 }, (_, i) => i + 1);
    expect(foundryDependsOn(P(many, ""))).toHaveLength(300);
  });
  it("cleans a reason", () => {
    expect(cleanReason("a\n\n  b")).toBe("a b");
    expect(cleanReason("<!-- x -->")).toBe("!-- x --");
    expect(cleanReason("see #12")).toBe("see issue 12");
    expect(cleanReason("r".repeat(500)).length).toBeLessThanOrEqual(200);
    expect(cleanReason(undefined as never)).toBe("");
    expect(cleanReason("")).toBe("");
    const once = cleanReason("a <b> #4 " + "z ".repeat(300));
    expect(cleanReason(once)).toBe(once);
  });
  it("an empty reason has its own line", () => {
    expect(mergeDependsOn("x", [1], "")).toContain("\n_Added by the Spaghetti Code Foundry._\n");
  });
  describe("removing", () => {
    it("keeps the others and the reason", () => {
      const merged = mergeDependsOn(section, [5, 7], "why");
      const left = removeFromDependsOn(merged, [5]);
      expect(foundryDependsOn(left)).toEqual([7]);
      expect(left).toContain("Foundry: why_");
      expect(withoutFoundryPart(left)).toBe(section);
    });
    it("everything gives back the section", () => {
      expect(removeFromDependsOn(mergeDependsOn(section, [5, 7], "why"), [5, 7])).toBe(section);
    });
    it("nothing to remove: the same body", () => {
      expect(removeFromDependsOn(section, [5])).toBe(section);
      const merged = mergeDependsOn(section, [5], "why");
      expect(removeFromDependsOn(merged, [99])).toBe(merged);
    });
    it("keeps CRLF", () => {
      const merged = mergeDependsOn("x\r\n### Depends on\r\n#12\r\n", [5, 7], "why");
      const left = removeFromDependsOn(merged, [5]);
      expect(left.replace(/\r\n/g, "")).not.toContain("\n");
      expect(foundryDependsOn(left)).toEqual([7]);
    });
    it("a removed number does not come back through an edited reason", () => {
      const merged = mergeDependsOn(section, [5, 7], "r").replace("Foundry: r_", "Foundry: waiting for #5_");
      const left = removeFromDependsOn(merged, [5]);
      expect(foundryDependsOn(left)).toEqual([7]);
      expect(left).toContain("waiting for issue 5");
      expect(withoutFoundryPart(left)).toBe(section);
    });
  });
  describe("dependencies()", () => {
    it("the limit of 1000 characters is for the person's text only", () => {
      const orig = "### Depends on\n" + "x ".repeat(450) + "\n#9";
      const merged = mergeDependsOn(orig, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29], "r".repeat(250));
      expect(dependencies(orig, 100, [])).toEqual([9]);
      expect(dependencyText(merged)).not.toContain("#9");
      expect(dependencies(merged, 100, [])).toEqual([9, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    });
    it("the reason is not a title", () => {
      expect(dependencies(mergeDependsOn("x", [12], "Story 7 — Install the update"), 100, all)).toEqual([12]);
    });
    it("not itself", () => {
      expect(dependencies(mergeDependsOn("x", [4, 7], "r"), 4, all)).toEqual([7]);
    });
  });
});
