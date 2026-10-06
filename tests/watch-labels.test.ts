import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
const FAKES = ["FAKE_GH_CLOSED_ISSUES", "FAKE_QUESTIONS_FOR", "FAKE_GH_COMMENTS", "FAKE_GH_FAIL"];

describe("needs-info label follows the record", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  const runsDir = () => join(gh.tmp, "runs");
  beforeEach(() => {
    gh = fakeGithub();
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of FAKES) delete process.env[k];
  });
  afterEach(() => gh.restore());

  const watcher = (extra: Record<string, unknown> = {}) => new Watcher(WatcherSchema.parse({
    id: "go", github_repo: REPO, label: "Factory_go", flow: "issue-deliver", exclude_labels: ["other"],
    status_labels: LABELS, remove_on_done: ["Factory_go"], dependency_done_labels: ["Factory_done"], ...extra,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const issues = (dep: "OPEN" | "CLOSED", six: string[]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 4, title: "issue 4", state: dep, labels: [{ name: "Factory_go" }, { name: "other" }], body: "" },
      { number: 6, title: "issue 6", state: "OPEN", labels: six.map((name) => ({ name })), body: "Depends on #4" },
    ]);
  };
  const ask = { author: { login: "bot" }, body: "questions <!-- claude-factory run=x questions -->", createdAt: "2026-01-01T00:00:00Z" };
  const answered = () => {
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [ask, { author: { login: "marcel" }, body: "/defaults", createdAt: "2026-01-01T01:00:00Z" }] });
  };
  const edits = (from = 0) => gh.ghLog().split("\n").slice(from).filter((l) => l.includes("issue edit 6 "));
  const settle = async () => { await scheduler.idle(); await new Promise((r) => setTimeout(r, 300)); };

  it("answered, waiting for a dependency: the label goes once, then the story starts", async () => {
    const w = watcher();
    issues("OPEN", ["Factory_go", "Factory_needs_info"]);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [ask] });
    await w.tick();
    expect(w.status.holds![0]!.next.kind).toBe("questions");
    expect(edits()).toHaveLength(0);

    answered();
    await w.tick();
    expect(w.status.holds![0]!.next.kind).toBe("dependency");
    const e = edits();
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("--remove-label Factory_needs_info");
    expect(e[0]).not.toContain("--add-label");

    const at = gh.ghLog().split("\n").length;
    issues("OPEN", ["Factory_go"]);
    await w.tick();
    expect(edits(at)).toHaveLength(0);

    issues("CLOSED", ["Factory_go"]);
    await w.tick();
    await settle();
    expect(scheduler.list().some((s) => s.vars.issue === "6")).toBe(true);
    expect(edits(at).join("\n")).toContain("--add-label Factory_working");
  });

  it("a failing edit is the check's error and the hold stays", async () => {
    const w = watcher();
    issues("OPEN", ["Factory_go", "Factory_needs_info"]);
    answered();
    process.env.FAKE_GH_FAIL = "issue edit";
    await w.tick().catch(() => {});
    expect(w.status.lastError).toMatch(/correcting labels/);
    expect(w.status.holds![0]!.next.kind).toBe("dependency");
    delete process.env.FAKE_GH_FAIL;
    await w.tick();
    expect(edits()).toHaveLength(2);
  });
});
