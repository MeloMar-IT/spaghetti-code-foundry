import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATE_MESSAGES, type AutoSkillFailure } from "../src/skills/auto-updates.js";
import { failureIssueSettings, failureIssueText, openFailureIssues, type FailureIssueInput } from "../src/skill-import/update-issues.js";
import { FAKE_GH, SENTINEL } from "./helpers/skill-update-world.js";

// The issues for the skills the automatic update left out (#800): called directly, with the fake gh and no git repository.

const SOURCE = { id: "ver", repository: "https://github.com/example/verified", repositoryKey: "github.com/example/verified" } as FailureIssueInput["source"];
const fail = (skill: string, gate: AutoSkillFailure["gate"] = "evaluation", message?: string): AutoSkillFailure => ({ skill, gate, message: message ?? GATE_MESSAGES[gate] });

let dir: string;
let log: string;
let authLog: string;
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, FACTORY_GH_BIN: FAKE_GH, FAKE_GH_LOG: log, FAKE_GH_CLI_ISSUES: "1", FAKE_GH_AUTH_LOG: authLog, ...extra });
const stored = (): { number: number; repo: string; title: string; body: string; labels: { name: string }[]; state: string }[] => JSON.parse(readFileSync(`${log}.cli-issues.json`, "utf8"));
const calls = (): string[] => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("gh "));
const creates = () => calls().filter((c) => c.startsWith("gh issue create"));

function input(over: Partial<FailureIssueInput> & { failed: AutoSkillFailure[] }) {
  const lines: string[] = [];
  const audit: [boolean, string][] = [];
  const o: FailureIssueInput = {
    source: SOURCE,
    label: "Factory_go",
    env: env(),
    cwd: dir,
    signal: new AbortController().signal,
    tick: async () => {},
    access: async () => ({ ok: true }),
    out: (l) => void lines.push(l),
    audit: (ok, d) => void audit.push([ok, d]),
    ...over,
  };
  return { o, lines, audit };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scf-issues-"));
  log = join(dir, "gh.log");
  authLog = join(dir, "auth.log");
  writeFileSync(log, "");
});
afterEach(() => {
  failureIssueSettings.maxPerRun = 20;
  rmSync(dir, { recursive: true, force: true });
});

describe("the text of an issue", () => {
  it("has a fixed title and the Foundry's own sentence, never the stored message", () => {
    const t = failureIssueText(fail("ver-b-abc", "evaluation", SENTINEL), "ver");
    expect(t.title).toBe("Skill ver-b-abc failed the evaluation gate");
    expect(t.body).toContain("evaluation");
    expect(t.body).toContain(GATE_MESSAGES.evaluation);
    expect(t.body).toContain("`ver`");
    expect(t.body).not.toContain(SENTINEL);
  });
});

describe("opening issues", () => {
  it("opens one issue for the first failure, with the label, and audits it", async () => {
    const { o, lines, audit } = input({ failed: [fail("ver-b-abc")] });
    const r = await openFailureIssues(o);
    expect(r.failed).toBe(false);
    expect(r.made).toEqual([{ skill: "ver-b-abc", gate: "evaluation", number: 101, url: "https://github.com/example/verified/issues/101" }]);
    expect(creates()).toHaveLength(1);
    expect(creates()[0]).toContain("--repo example/verified --title Skill ver-b-abc failed the evaluation gate --body-file - --label Factory_go");
    const [issue] = stored();
    expect(issue!.title).toBe("Skill ver-b-abc failed the evaluation gate");
    expect(issue!.body).toContain(GATE_MESSAGES.evaluation);
    expect(issue!.labels).toEqual([{ name: "Factory_go" }]);
    expect(audit).toEqual([[true, "ver-b-abc evaluation #101"]]);
    expect(lines).toContain("NOTE opened https://github.com/example/verified/issues/101 for ver-b-abc (evaluation)");
  });

  it("opens nothing while an issue with the same title is open, and a new one once it is closed", async () => {
    await openFailureIssues(input({ failed: [fail("ver-b-abc")] }).o);
    const second = input({ failed: [fail("ver-b-abc")] });
    const r = await openFailureIssues(second.o);
    expect(r.open).toBe(1);
    expect(r.made).toEqual([]);
    expect(creates()).toHaveLength(1);
    expect(second.lines.some((l) => l.includes("is open already"))).toBe(true);
    expect(second.audit.some(([ok]) => ok)).toBe(false);

    writeFileSync(`${log}.cli-issues.json`, JSON.stringify(stored().map((i) => ({ ...i, state: "CLOSED" }))));
    const third = await openFailureIssues(input({ failed: [fail("ver-b-abc")] }).o);
    expect(third.made.map((m) => m.number)).toEqual([102]);
    expect(creates()).toHaveLength(2);
  });

  it("skips a bad skill id or gate and opens one issue for two failures with the same title", async () => {
    const bad = { skill: "../x", gate: "evaluation", message: "x" } as AutoSkillFailure;
    const odd = { skill: "ver-c", gate: "nope", message: "x" } as unknown as AutoSkillFailure;
    const r = await openFailureIssues(input({ failed: [bad, odd, fail("ver-b-abc"), fail("ver-b-abc", "evaluation", "other")] }).o);
    expect(r.made).toHaveLength(1);
    expect(creates()).toHaveLength(1);
  });

  it("stops at the first failed create and shows none of gh's text", async () => {
    const { o, lines, audit } = input({ failed: [fail("ver-a"), fail("ver-b")], env: env({ FAKE_GH_FAIL: "issue create", FAKE_GH_FAIL_TEXT: "SECRET" }) });
    const r = await openFailureIssues(o);
    expect(r.failed).toBe(true);
    expect(creates()).toHaveLength(1);
    expect(lines.join("\n")).toContain("could not be opened with gh; the update goes on");
    expect(lines.join("\n")).not.toContain("SECRET");
    expect(audit).toEqual([[false, "ver-a evaluation not opened"]]);
  });

  it("opens nothing when the list fails", async () => {
    const { o, lines, audit } = input({ failed: [fail("ver-a")], env: env({ FAKE_GH_FAIL: "issue list", FAKE_GH_FAIL_TEXT: "SECRET" }) });
    const r = await openFailureIssues(o);
    expect(r.failed).toBe(true);
    expect(creates()).toHaveLength(0);
    expect(lines.join("\n")).toContain("could not be listed with gh; no issue was opened");
    expect(lines.join("\n")).not.toContain("SECRET");
    expect(audit).toEqual([[false, "list"]]);
  });

  it("opens nothing when the list may be cut", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, repo: "example/verified", title: `t${i}`, body: "", labels: [], state: "OPEN" }));
    writeFileSync(`${log}.cli-issues.json`, JSON.stringify(many));
    const { o, audit } = input({ failed: [fail("ver-a")] });
    await openFailureIssues(o);
    expect(creates()).toHaveLength(0);
    expect(audit).toEqual([[false, "list cut"]]);
  });

  it("opens at most maxPerRun issues and says so", async () => {
    failureIssueSettings.maxPerRun = 2;
    const { o, lines } = input({ failed: [fail("ver-a"), fail("ver-b"), fail("ver-c")] });
    const r = await openFailureIssues(o);
    expect(r.made).toHaveLength(2);
    expect(creates()).toHaveLength(2);
    expect(lines).toContain("NOTE 1 more failed skills got no issue in this run (at most 2)");
  });

  it("makes no gh call for a repository that is not on GitHub", async () => {
    const { o, lines, audit } = input({ failed: [fail("ver-a")], source: { ...SOURCE, repository: "https://gitlab.com/x/y", repositoryKey: "gitlab.com/x/y" } });
    await openFailureIssues(o);
    expect(calls()).toEqual([]);
    expect(lines.join("\n")).toContain("is not a GitHub repository");
    expect(audit).toEqual([[false, "not on GitHub"]]);
  });
});

describe("a private source", () => {
  const priv = { ...SOURCE, access: { repo: "acme/skills" } } as unknown as FailureIssueInput["source"];

  it("uses the app token and drops the host's tokens", async () => {
    const { o } = input({ failed: [fail("ver-a")], source: priv, env: env({ GITHUB_TOKEN: "host", GH_ENTERPRISE_TOKEN: "host2" }), access: async () => ({ ok: true, credential: { username: "x-access-token", password: "tok-1" } }) });
    await openFailureIssues(o);
    const rows = readFileSync(authLog, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.slice(0, 3)).toEqual(["tok-1", "-", "-"]);
    expect(creates()).toHaveLength(1);
  });

  it("opens nothing and writes the fixed sentence when the access fails", async () => {
    const { o, lines, audit } = input({ failed: [fail("ver-a")], source: priv, access: async () => ({ ok: false, problem: "a fixed sentence" }) });
    const r = await openFailureIssues(o);
    expect(r.failed).toBe(true);
    expect(calls()).toEqual([]);
    expect(lines.join("\n")).toContain("a fixed sentence");
    expect(audit).toEqual([[false, "access"]]);
  });
});

describe("cancellation", () => {
  it("opens nothing when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    const r = await openFailureIssues(input({ failed: [fail("ver-a")], signal: c.signal }).o);
    expect(r.failed).toBe(false);
    expect(calls()).toEqual([]);
  });

  it("stops creating issues once the signal is aborted after the first create", async () => {
    const c = new AbortController();
    let ticks = 0;
    // tick 1: before the list, tick 2: before the first create (with the label call after it), tick 3 (label), tick 4: before the second create
    const tick = async () => {
      if (++ticks === 4) c.abort();
    };
    const r = await openFailureIssues(input({ failed: [fail("ver-a"), fail("ver-b"), fail("ver-c")], signal: c.signal, tick }).o);
    expect(r.failed).toBe(false);
    expect(creates()).toHaveLength(1);
    expect(calls().at(-1)).toContain("issue create");
  });
});
