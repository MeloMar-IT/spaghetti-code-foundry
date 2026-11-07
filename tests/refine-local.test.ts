import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRepoName } from "../src/auth/local-name.js";
import { NO_RUN_OWNER, addRepo, repoAccess } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { stepRepoAccess } from "../src/engine/repo-access.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { REFINE_BRIEF_FLOW, REFINE_ROUND_FLOW } from "../src/flow/usage.js";
import { formatStoryFile } from "../src/stories/story-file.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const HEADINGS = ["What already exists", "Code the idea would touch", "Open issues that overlap", "Rules that apply", "Could not find out"];
const GOOD = HEADINGS.map((h) => `## ${h}\n- Nothing found.`).join("\n");

let gh: ReturnType<typeof fakeGithub>;
let admin: { id: string };
let user: { id: string };
let dir: string;
let name: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();

beforeEach(async () => {
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
  dir = mkdtempSync(join(gh.tmp, "proj-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  mkdirSync(join(dir, ".scf", "stories"), { recursive: true });
  writeFileSync(join(dir, ".scf", "stories", "1-existing.md"), formatStoryFile({ number: 1, title: "Existing", state: "open", kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: "b", comments: [] }));
  git("add", ".");
  git("commit", "-qm", "init");
  git("checkout", "-q", "-b", "develop");
  writeFileSync(join(dir, "only-on-develop.txt"), "x\n");
  git("add", ".");
  git("commit", "-qm", "develop");
  git("checkout", "-q", "main");
  name = localRepoName(addRepo(admin.id, { url: dir, method: "local" }));
});
afterEach(() => gh.restore());

const run = (flow: string, vars: Record<string, string>) =>
  runFlow(loadFlow(flow, gh.tmp).flow, { task: "Export a report", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin, vars });
const out = (s: { history: { id: string; output: string }[] }, id: string) => s.history.find((h) => h.id === id)?.output ?? "";
const ghCalls = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh "));

describe("refinement flows on a local project", { timeout: 30_000 }, () => {
  it("refine-brief clones the folder (develop), reads its stories, and calls no gh", async () => {
    process.env.FAKE_BRIEF = GOOD;
    const head = git("rev-parse", "HEAD");
    const s = await run("refine-brief", { github_repo: name });
    expect(s.status).toBe("succeeded");
    expect(out(s, "clone")).toContain("branch: develop");
    expect(existsSync(join(s.workdir!, "repo", "only-on-develop.txt"))).toBe(true);
    expect(readFileSync(join(s.workdir!, "issues.md"), "utf8")).toContain("=== ISSUE #1 ===");
    expect(ghCalls()).toEqual([]);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("refine-round works for ask=round and ask=impact, and impact reads the local stories", async () => {
    process.env.FAKE_ROUND = JSON.stringify({ questions: [] });
    const round = await run("refine-round", { github_repo: name, ask: "round" });
    expect(round.history.find((h) => h.id === "clone")?.output).toContain("branch: develop");
    const impact = await run("refine-round", { github_repo: name, ask: "impact" });
    expect(impact.history.find((h) => h.id === "clone")?.output).toContain("branch: develop");
    expect(readFileSync(join(impact.workdir!, "issues.md"), "utf8")).toContain("=== ISSUE #1 ===");
    expect(ghCalls()).toEqual([]);
  });

  it("fails for a valid name that is not registered, without a gh call", async () => {
    const s = await run("refine-brief", { github_repo: "local:nope-0123abcd" });
    expect(s.status).toBe("failed");
    expect(out(s, "clone")).toContain("the folder of this local project is not known to the Foundry");
    expect(ghCalls()).toEqual([]);
  });

  it.each(["local:", "local:Bad-0123abcd", "local:../x", "local:app", "-x", "a/b/c", `local:${"a".repeat(41)}-0123abcd`])("refuses the name %s", async (bad) => {
    const s = await run("refine-brief", { github_repo: bad });
    expect(s.status).toBe("failed");
    expect(out(s, "clone")).toContain("set the variable github_repo to owner/name");
    expect(ghCalls()).toEqual([]);
  });

  it("lets a 40-character slug past the name check", async () => {
    const s = await run("refine-brief", { github_repo: `local:${"a".repeat(40)}-0123abcd` });
    expect(out(s, "clone")).toContain("not known to the Foundry");
  });
});

describe("stepRepoAccess on a local project", () => {
  const clone = { id: "clone", type: "shell", repo_access: true } as const;
  const access = (owner: string | undefined, source: string, flow = REFINE_BRIEF_FLOW) => stepRepoAccess(clone, 0, flow, { source, owner }, { github_repo: name });

  it("gives the owner of a refinement run the server, and refuses another account or no owner", () => {
    expect(access(admin.id, "refinement x")).toEqual({ kind: "server" });
    expect(access(user.id, "refinement x")).toMatchObject({ kind: "refused", reason: `"${name}" is not one of your repositories` });
    expect(access(undefined, "refinement x")).toMatchObject({ kind: "refused", reason: NO_RUN_OWNER });
  });

  it("is unchanged for a run that is no refinement", () => {
    const flow = "issue-plan";
    const was = repoAccess(admin.id, name, { unlisted: "admin-server" });
    expect(stepRepoAccess(clone, 0, flow, { source: "issues", owner: admin.id }, { github_repo: name })).toEqual(was);
    expect(access(admin.id, "refinement x", REFINE_ROUND_FLOW)).toEqual({ kind: "server" });
  });
});
