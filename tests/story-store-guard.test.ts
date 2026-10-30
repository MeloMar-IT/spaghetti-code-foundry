import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The story store (src/stories/) is the one place that talks to GitHub about stories. Files that still do it themselves are listed
// below. The list can only shrink: a new story call elsewhere fails this test, and so does a listed file that has no call left.

const SUBS = "view|list|create|edit|close|reopen|comment|merge|ready|checks|checkout|diff|status|delete|develop|lock|unlock|pin|unpin|transfer|review|update-branch";

/** A call that works on an issue, a pull request, a label or a check run: `gh issue …`, `gh pr …`, or `gh api` on those paths. */
export function storyCallIn(text: string, file: string): boolean {
  const ts = /\.(ts|mts|cts)$/.test(file);
  const patterns: RegExp[] = [
    // Argument arrays and calls: ["pr", "list", …], gh("pr", "list", …). The second word must be a real subcommand.
    new RegExp(`[\\[(]\\s*["'\`](?:issue|pr)["'\`]\\s*,\\s*["'\`](?:${SUBS})["'\`]`),
    // REST paths: repos/<o>/<n>/issues, a path built from a variable (`${base}/issues?…`), check runs.
    /repos\/[^\s"'`]*\/(?:issues|pulls|labels)\b/,
    /\}\/(?:issues|pulls|labels)\b/,
    /check-runs\b/,
    // The issue-state GraphQL query.
    /\bissue\(number:/,
  ];
  // The shell form is a command line. In YAML, scripts and tools it is a call anywhere. In TypeScript it is a call only when a
  // string literal starts with it (execSync("gh issue list …")); a regex or a sentence that names it is not.
  patterns.push(ts ? new RegExp(`["'\`]\\s*gh\\s+(?:issue|pr)\\s+(?:${SUBS})\\b`) : new RegExp(`\\bgh\\s+(?:issue|pr)\\s+(?:${SUBS})\\b`));
  // Comment lines are left out, and a web address (https://github.com/o/r/issues/3) is a link, not a call. The text is
  // scanned as a whole, so an argument array that spans lines is found too.
  const code = text
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("#"));
    })
    .map((line) => line.replace(/https?:\/\/[^\s"'`]*/g, ""))
    .join("\n");
  return patterns.some((p) => p.test(code));
}

/** The files that still make story calls themselves. Remove a path as soon as its calls move to the store. */
export const ALLOWLIST: readonly string[] = [
  "blocks/ci.yaml",
  "blocks/merge.yaml",
  "blocks/open-pr.yaml",
  "blocks/pr-comments.yaml",
  "scripts/build-flows.mjs",
  "src/delivery/handoff.ts",
  "src/engine/repo-broker.ts",
  "src/ops/cli.ts",
  "src/queue/overrule.ts",
  "src/queue/waits-for.ts",
  "src/queue/watcher.ts",
  "src/release/git.ts",
  "src/repos/connect.ts",
  "src/server/since.ts",
  "src/skill-import/catalogue-git.ts",
  "tools/create-split",
  "tools/daily-branch",
  "tools/decide-questions.mjs",
  "tools/post-questions",
  "tools/split-family",
];

const EXEMPT = ["src/github.ts", "src/stories/github-store.ts"];

/** Lines a file may keep: push-result still finds its pull request with `gh pr view`. Any other call in it fails the test. */
const KEPT_LINES: Record<string, RegExp> = { "blocks/push-result.yaml": /\bgh\s+pr\s+view\b/ };
export function withoutKept(text: string, file: string): string {
  const keep = KEPT_LINES[file];
  return keep ? text.split("\n").filter((l) => !keep.test(l)).join("\n") : text;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("storyCallIn", () => {
  it.each([
    ["gh issue close 3 --repo r", "x.yaml"],
    ['gh pr merge "$b"', "x.mjs"],
    ['run(["issue", "view", n])', "x.ts"],
    ['["pr", "list", "--repo"', "x.ts"],
    ['gh("pr", "list", "--repo", repo)', "tools/daily-branch"],
    ["`repos/${r}/issues/${n}`", "x.ts"],
    ['"repos/$R/pulls/$N/comments"', "x.yaml"],
    ["repos/o/r/labels?per_page=100", "x.yaml"],
    ["/commits/x/check-runs", "x.ts"],
    ["issue(number: 4)", "x.ts"],
    // Multiline argument arrays and executable shell strings in TypeScript are calls too.
    ['gh([\n  "issue",\n  "list"\n])', "x.ts"],
    ['execSync("gh issue list --repo o/r")', "x.ts"],
    ['execFile("gh", ["pr", "merge", n])', "x.ts"],
    ['const s = "gh pr merge 3"', "x.ts"],
    ["call(`${base}/issues?per_page=1`)", "x.ts"],
    ["call(`${base}/pulls?per_page=1&state=all`)", "x.ts"],
  ])("finds %s in %s", (text, file) => {
    expect(storyCallIn(text, file)).toBe(true);
  });

  it.each([
    ["gh issue close 3 --repo r", "x.ts"],
    ["/gh issue view/", "x.ts"],
    ['["issue", "command", "agent"]', "x.ts"],
    ["// gh issue view", "x.ts"],
    ["# gh pr view", "x.yaml"],
    [" * repos/o/r/issues/3", "x.ts"],
    ["gh api rate_limit", "x.yaml"],
    ["gh repo view", "x.yaml"],
    ["gh auth status", "x.yaml"],
    ["repos/o/r/releases", "x.ts"],
    ["repos/o/r/contents/x", "x.ts"],
    ["repos/o/r/collaborators/u/permission", "x.ts"],
    ["gh release list", "x.yaml"],
    ["call(base)", "x.ts"],
    ["const url = `https://github.com/${repo}/issues/${n}`", "x.ts"],
  ])("ignores %s in %s", (text, file) => {
    expect(storyCallIn(text, file)).toBe(false);
  });
});

describe("withoutKept", () => {
  const block = "blocks/push-result.yaml";
  it("lets push-result keep gh pr view", () => {
    expect(storyCallIn(withoutKept("gh pr view 3 --json url", block), block)).toBe(false);
  });
  it("still finds an issue call added to push-result", () => {
    expect(storyCallIn(withoutKept("gh pr view 3\ngh issue comment 3 --body x", block), block)).toBe(true);
  });
  it("keeps nothing in other files", () => {
    expect(storyCallIn(withoutKept("gh pr view 3", "blocks/ci.yaml"), "blocks/ci.yaml")).toBe(true);
  });
});

describe("story calls outside the story store", () => {
  const files = [...walk("src"), ...walk("blocks"), ...walk("tools"), "scripts/build-flows.mjs"].map((f) => relative(".", f).split("\\").join("/"));
  const found = files.filter((f) => !EXEMPT.includes(f) && storyCallIn(withoutKept(readFileSync(f, "utf8"), f), f)).sort();

  it("lists no file that is gone", () => {
    expect(ALLOWLIST.filter((f) => !existsSync(f))).toEqual([]);
  });

  it("has no story call in a file that is not listed", () => {
    expect(found.filter((f) => !ALLOWLIST.includes(f)), "story call outside the story store: use storeFor(repo)").toEqual([]);
  });

  it("lists no file without a story call", () => {
    expect(ALLOWLIST.filter((f) => !found.includes(f)), "no story call left: remove the file from ALLOWLIST").toEqual([]);
  });
});
