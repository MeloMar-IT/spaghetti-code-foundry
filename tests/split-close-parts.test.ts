import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { DEPS_MARK, DEPS_MARK_END, foundryDependsOn } from "../src/queue/deps.js";
import { nextStepEnv } from "../src/next-step.js";
import { flowPath } from "./helpers/fake-github.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "close-parts-"));
  mkdirSync(join(home, "bin"));
  symlinkSync(resolve("tests/fixtures/fake-gh.sh"), join(home, "bin", "gh"));
  chmodSync(resolve("tests/fixtures/fake-gh.sh"), 0o755);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Fake = { number: number; title?: string; state?: string; body?: string; labels?: { name: string }[] };
const baseEnv = (issues: Fake[], issue: number, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${join(home, "bin")}:${process.env.PATH}`, FAKE_GH_LOG: join(home, "gh.log"),
  FAKE_GH_ISSUES: JSON.stringify(issues.map((i) => ({ title: `Issue ${i.number}`, body: "", labels: [], ...i }))),
  FACTORY_VAR_GITHUB_REPO: "acme/app", FACTORY_VAR_ISSUE: String(issue), FACTORY_TOOLS: resolve("tools"), FACTORY_RUN_ID: "r-1",
  FACTORY_FIRST_INFO: "**First line**", FACTORY_VAR_TRIGGER_LABEL: "Factory_go",
  ...extra,
});
const reset = () => {
  for (const f of ["gh.log", "gh.log.closed", "gh.log.edits", "gh.log.issue-bodies.json"]) rmSync(join(home, f), { force: true });
};
const ghLog = () => {
  try {
    return readFileSync(join(home, "gh.log"), "utf8");
  } catch {
    return "";
  }
};
const closeParts = (issues: Fake[], issue: number, extra: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [resolve("tools/split-family"), "close-parts"], { encoding: "utf8", env: baseEnv(issues, issue, extra) });
  return { status: r.status, out: r.stdout, err: r.stderr, last: r.stdout.trim().split("\n").at(-1), log: ghLog() };
};
const part = (k: number, of: number, parent: number) => `Part ${k} of ${of} of #${parent} (x), split by Spaghetti Code Foundry.\n\nBody.`;
const foundryPart = (...n: number[]) => `${DEPS_MARK}\n${n.map((x) => `- #${x}`).join("\n")}\n_Added by the Spaghetti Code Foundry._\n${DEPS_MARK_END}`;
const lab = (...names: string[]) => names.map((name) => ({ name }));
const writes = (log: string) => log.split("\n").filter((l) => /^gh (issue (close|edit|comment)|--- comment)/.test(l) || l.startsWith("--- comment on"));
const bodyOf = (log: string, n: number) => {
  const m = [...log.matchAll(new RegExp(`--- issue body edit: issue edit ${n} [^\\n]*\\n([\\s\\S]*?)(?=gh (?:issue|pr) |\\n--- )`, "g"))];
  return m.at(-1)?.[1] ?? "";
};

const REOPENED: Fake[] = [
  { number: 721, title: "Original" },
  { number: 722, body: part(1, 2, 721) },
  { number: 723, body: part(2, 2, 721), labels: lab("factory:needs-info", "Factory_go", "enhancement") },
  { number: 730, body: "### Depends on\n#723" },
  { number: 731, body: `Text.\n### Depends on\n${foundryPart(722, 721)}` },
  { number: 732, body: "### Depends on\n#999" },
];

describe("split-family close-parts", () => {
  it("says none and writes nothing for an issue without open parts", () => {
    const r = closeParts([{ number: 5 }, { number: 6, body: part(1, 2, 7) }], 5);
    expect(r.status).toBe(0);
    expect(r.last).toBe("CLOSE_PARTS: none");
    expect(writes(r.log)).toEqual([]);
  });

  it("rejects an unknown argument", () => {
    const r = spawnSync(process.execPath, [resolve("tools/split-family"), "nope"], { encoding: "utf8", env: baseEnv([{ number: 1 }], 1) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usage");
  });

  it("closes the parts of a reopened parent and rewires their dependants", () => {
    const r = closeParts(REOPENED, 721);
    expect(r.status).toBe(0);
    expect(r.last).toBe("CLOSE_PARTS: closed #722 #723");
    const log = r.log;
    for (const n of [722, 723]) {
      expect(log).toContain(`gh issue close ${n} --repo acme/app --reason not planned`);
      expect(log).toContain(`--- comment on #${n}:\n**First line**\n\nClosed as a duplicate of #721: it is built as one change.`);
    }
    const edit723 = log.indexOf("gh issue edit 723 --repo acme/app --remove-label factory:needs-info --remove-label Factory_go");
    expect(edit723).toBeGreaterThan(log.indexOf("gh issue close 723"));
    expect(log).not.toContain("--remove-label enhancement");
    // #730 waits for #721 before #723 is closed; its own text still names #723
    const add730 = log.indexOf("gh issue edit 730 --repo acme/app --body-file -");
    expect(add730).toBeGreaterThan(-1);
    expect(add730).toBeLessThan(log.indexOf("gh issue close 723"));
    const b730 = bodyOf(log, 730);
    expect(foundryDependsOn(b730)).toEqual([721]);
    expect(b730).toContain(`${DEPS_MARK_END}\n#723`);
    // #731 lists #721 once and loses #722
    expect(foundryDependsOn(bodyOf(log, 731))).toEqual([721]);
    expect(log).not.toContain("gh issue edit 732");
    const summary = log.slice(log.indexOf("--- comment on #721:"));
    expect(summary).toContain("**First line**");
    expect(summary).toContain("<!-- claude-factory parts-closed run=r-1 handled=722,723 pending= -->");
  });

  it("does not add the built issue twice", () => {
    const r = closeParts([{ number: 721 }, { number: 722, body: part(1, 1, 721) }, { number: 731, body: `### Depends on\n${foundryPart(721)}\n#722` }], 721);
    expect(r.last).toBe("CLOSE_PARTS: closed #722");
    expect(r.log).not.toContain("gh issue edit 731"); // already waits for #721; the closed #722 is only in the person's text
  });

  it("keeps the text someone wrote between the list and the write", () => {
    const view = REOPENED.map((i) => (i.number === 730 ? { ...i, body: "Changed by a person.\n### Depends on\n#723" } : i));
    const r = closeParts(REOPENED, 721, { FAKE_GH_VIEW_ISSUES: JSON.stringify(view) });
    expect(bodyOf(r.log, 730)).toContain("Changed by a person.");
  });

  it("leaves a part with an open pull request", () => {
    for (const pr of [{ number: 800, title: "Fix", body: "Closes #723", headRefName: "x" }, { number: 801, title: "T", body: "", headRefName: "feature/723-thing" }]) {
      const r = closeParts(REOPENED, 721, { FAKE_GH_PRS: JSON.stringify([pr]) });
      expect(r.last).toBe("CLOSE_PARTS: closed #722; left open #723");
      expect(r.log).toContain(`- #723 left open: it has an open pull request (#${pr.number})`);
      expect(r.log).not.toContain("gh issue close 723");
      expect(r.log).not.toContain("gh issue edit 730");
      expect(r.log).toContain("handled=722 pending= -->");
      reset();
    }
  });

  it("leaves a part with a run in progress or already done", () => {
    for (const [label, reason] of [["factory:working", "a run is working on it"], ["Factory_waiting-approval", "a run is working on it"], ["factory:done", "it already has the done label"]]) {
      const issues = REOPENED.map((i) => (i.number === 723 ? { ...i, labels: lab(label!) } : i));
      const r = closeParts(issues, 721);
      expect(r.log, label).toContain(`- #723 left open: ${reason}`);
      expect(r.log).not.toContain("gh issue close 723");
      reset();
    }
  });

  it("leaves a part that got a working label after the list was read", () => {
    const view = REOPENED.map((i) => (i.number === 723 ? { ...i, labels: lab("factory:working") } : i));
    const r = closeParts(REOPENED, 721, { FAKE_GH_VIEW_ISSUES: JSON.stringify(view) });
    expect(r.log).toContain("- #723 left open: a run is working on it");
    expect(r.log).not.toContain("gh issue close 723");
  });

  it("sees a custom working label that the flow passes", () => {
    const issues = REOPENED.map((i) => (i.number === 723 ? { ...i, labels: lab("Busy") } : i));
    const r = closeParts(issues, 721, { FACTORY_WORKING_LABELS: "busy, other" });
    expect(r.log).toContain("- #723 left open: a run is working on it");
  });

  it("keeps the labels and the handled list of a part whose close fails, and tries it again", () => {
    const r = closeParts(REOPENED, 721, { FAKE_GH_FAIL_ON: "issue close 722" });
    expect(r.status).toBe(0);
    expect(r.last).toBe("CLOSE_PARTS: closed #723; left open #722");
    expect(r.log).toContain("- #722 left open: boom");
    expect(r.log).toContain("handled=723 pending= -->");
    // the next run sees #723 closed, and #722 is tried again
    const again = REOPENED.map((i) => (i.number === 723 ? { ...i, state: "closed" } : i));
    const second = closeParts(again, 721, { FAKE_GH_COMMENTS_FROM_LOG: "1" });
    expect(second.last).toBe("CLOSE_PARTS: closed #722");
  });

  it("keeps a part open when a dependant cannot be rewired", () => {
    const r = closeParts(REOPENED, 721, { FAKE_GH_FAIL_ON: "issue edit 730" });
    expect(r.last).toBe("CLOSE_PARTS: closed #722; left open #723");
    expect(r.log).not.toContain("gh issue close 723");
    expect(r.log).toContain("handled=722 pending= -->");
  });

  it("rewires a part that stays open and depends on a closed part", () => {
    const r = closeParts([
      { number: 721, title: "Original" },
      { number: 722, body: part(1, 2, 721) },
      { number: 723, body: `${part(2, 2, 721)}\n\n### Depends on\n#722` },
    ], 721, { FAKE_GH_PRS: JSON.stringify([{ number: 800, title: "Fix", body: "Closes #723", headRefName: "x" }]) });
    expect(r.last).toBe("CLOSE_PARTS: closed #722; left open #723");
    expect(foundryDependsOn(bodyOf(r.log, 723))).toEqual([721]);
    expect(r.log.indexOf("issue edit 723 --repo acme/app --body-file -")).toBeLessThan(r.log.indexOf("gh issue close 722"));
  });

  it("finishes the label cleanup of a closed part on the next run", () => {
    const first = closeParts(REOPENED, 721, { FAKE_GH_FAIL_ON: "--remove-label factory:needs-info" });
    expect(first.last).toBe("CLOSE_PARTS: closed #722 #723; pending #723");
    expect(first.log).toContain("handled=722 pending=723 -->");
    const again = REOPENED.map((i) => (i.number === 722 || i.number === 723 ? { ...i, state: "closed" } : i));
    const second = closeParts(again, 721, { FAKE_GH_COMMENTS_FROM_LOG: "1" });
    expect(second.last).toBe("CLOSE_PARTS: cleaned #723");
    expect(second.log).toContain("issue edit 723 --repo acme/app --remove-label factory:needs-info --remove-label Factory_go");
    expect(second.log).toContain("handled=723 pending= -->");
  });

  it("finishes the Depends on cleanup of a closed part on the next run", () => {
    const issues: Fake[] = [
      { number: 721, title: "Original" },
      { number: 722, body: part(1, 1, 721) },
      { number: 734, body: `Text.\n### Depends on\n${foundryPart(722)}` },
    ];
    const first = closeParts(issues, 721, { FAKE_GH_FAIL_EDIT_AFTER: "1" });
    expect(first.last).toBe("CLOSE_PARTS: closed #722; pending #722");
    expect(foundryDependsOn(bodyOf(first.log, 734))).toEqual([721, 722]);
    const again = issues.map((i) => (i.number === 722 ? { ...i, state: "closed" } : i));
    const second = closeParts(again, 721, { FAKE_GH_COMMENTS_FROM_LOG: "1" });
    expect(second.last).toBe("CLOSE_PARTS: cleaned #722");
    expect(foundryDependsOn(bodyOf(second.log, 734))).toEqual([721]);
  });

  it("closes nothing when the pull requests cannot be checked", () => {
    const r = closeParts(REOPENED, 721, { FAKE_GH_FAIL: "pr list" });
    expect(r.last).toBe("CLOSE_PARTS: left open #722 #723");
    expect(r.log).not.toContain("gh issue close");
    expect(r.log).toContain("- #722 left open: could not check its pull requests");
    expect(r.log).toContain("- #723 left open: could not check its pull requests");
  });

  it("does nothing the second time", () => {
    const first = closeParts(REOPENED, 721);
    expect(first.last).toBe("CLOSE_PARTS: closed #722 #723");
    const before = ghLog();
    const second = closeParts(REOPENED, 721, { FAKE_GH_COMMENTS_FROM_LOG: "1" });
    expect(second.last).toBe("CLOSE_PARTS: already done");
    expect(writes(second.log.slice(before.length))).toEqual([]);
    const closed = REOPENED.map((i) => (i.number === 722 || i.number === 723 ? { ...i, state: "closed" } : i));
    expect(closeParts(closed, 721).last).toBe("CLOSE_PARTS: none");
  });

  it("finds parts through a closed part", () => {
    const r = closeParts([{ number: 721 }, { number: 724, state: "closed", body: part(1, 1, 721) }, { number: 740, body: part(1, 2, 724) }], 721);
    expect(r.last).toBe("CLOSE_PARTS: closed #740");
  });

  it("builds a named root as one change", () => {
    const family: Fake[] = [{ number: 721, state: "closed" }, { number: 722, body: part(1, 2, 721) }, { number: 723, body: part(2, 2, 721) }, { number: 730, body: "### Depends on\n#722" }];
    const r = closeParts([...family, { number: 750, body: "Build #721 as one change." }], 750);
    expect(r.last).toBe("CLOSE_PARTS: closed #722 #723");
    expect(r.log).toContain("Closed as a duplicate of #750: it is built as one change.");
    expect(foundryDependsOn(bodyOf(r.log, 730))).toEqual([750]);
    rmSync(join(home, "gh.log"));
    for (const body of ["```\nBuild #721 as one change.\n```", "`Build #721 as one change`", "Build this as one change.", "Build #721 in one go."]) {
      expect(closeParts([...family, { number: 750, body }], 750).last, body).toBe("CLOSE_PARTS: none");
    }
    reset();
    const other = closeParts([...family, { number: 900, body: part(1, 2, 901) }, { number: 750, body: "Build #721 as one change; leave #900 separate" }], 750);
    expect(other.last).toBe("CLOSE_PARTS: closed #722 #723");
  });

  it("never closes itself or its own parents", () => {
    const r = closeParts([{ number: 721, state: "closed" }, { number: 722, body: part(1, 2, 721) }, { number: 723, body: `${part(2, 2, 721)}\nBuild #721 as one change.` }], 723);
    expect(r.last).toBe("CLOSE_PARTS: closed #722");
    expect(r.log).not.toContain("gh issue close 723");
  });

  it("fails without writing when the open issues cannot be read", () => {
    const r = closeParts(REOPENED, 721, { FAKE_GH_FAIL: "issue list" });
    expect(r.status).toBe(1);
    expect(writes(r.log)).toEqual([]);
  });
});

describe("close_parts step", () => {
  const flow = parseFlow(readFileSync(flowPath("issue-gitflow"), "utf8"), flowPath("issue-gitflow"));
  const step = (id: string) => flow.steps.find((x) => x.id === id)!;
  it("runs after risk_gate and approve_plan, before claim_areas", () => {
    expect(step("risk_gate").on_success).toBe("close_parts");
    expect(step("approve_plan").on_success).toBe("close_parts");
    expect(step("close_parts").on_success).toBe("claim_areas");
  });
  it("lets the run go on when the tool fails", () => {
    const s = step("close_parts");
    if (s.type !== "shell") throw new Error("shell");
    const r = spawnSync("sh", ["-c", s.run], { encoding: "utf8", env: { ...nextStepEnv(), ...baseEnv(REOPENED, 721, { FAKE_GH_FAIL: "issue list" }) } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("coding goes on");
  });
});
