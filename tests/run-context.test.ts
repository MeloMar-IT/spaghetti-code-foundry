import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { ContextSchemaError } from "../src/context/version.js";
import { ContextRepositoryError, gitHead } from "../src/context/repository.js";
import { contextBeforeStep, contextPending, contextSelectFacts, lockRunContext, RUN_CONTEXT_CODES, unlockRunContext, writeRunContext, type RunContextDeps } from "../src/engine/run-context.js";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { COMMIT, memorySnapshot } from "./helpers/context-fixture.js";

let tmp: string;
const T0 = Date.parse("2026-02-01T10:00:00.000Z");

const FLOW = parseFlow(`name: t
steps:
  - {id: pull_ticket, type: shell, run: 'gh issue view > issue.json'}
  - {id: plan, type: claude, prompt: hi}
`);
const rec = (id: string, more: Partial<StepRecord> = {}): StepRecord => ({ id, type: "shell", visit: 1, ok: true, output: "", startedAt: new Date(T0 - 60_000).toISOString(), durationMs: 1, logFile: "", ...more });

function summary(more: Partial<RunSummary> = {}): RunSummary {
  const runDir = join(tmp, "run");
  return { runId: "20260201-100000-abc", flowDef: FLOW, vars: { issue: "12", github_repo: "acme/app" }, runDir, workdir: join(tmp, "repo"), history: [rec("pull_ticket")], ...more } as unknown as RunSummary;
}
const files = (comments = '{"id":1,"body":"hi","updated_at":"2026-01-30T10:00:00Z"}\n') => {
  writeFileSync(join(tmp, "run", "issue.json"), JSON.stringify({ number: 12, title: "T", body: "B", updatedAt: "2026-01-30T09:00:00Z" }));
  writeFileSync(join(tmp, "run", "issue-comments.jsonl"), comments);
};
const engineOf = (s: RunSummary, config: Record<string, unknown> = {}) => {
  const lines: string[] = [];
  return { engine: { summary: s, config: ConfigSchema.parse(config), log: (m: string) => lines.push(m) }, lines };
};
const fakes = (more: RunContextDeps = {}): RunContextDeps => ({ now: () => T0, gitHead: () => COMMIT, openRepository: () => memorySnapshot(), ...more });
const settings = ConfigSchema.parse({}).context;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-runctx-"));
  mkdirSync(join(tmp, "run"));
  mkdirSync(join(tmp, "repo"));
});
afterEach(() => {
  try {
    chmodSync(join(tmp, "run"), 0o700);
  } catch {
    /* gone */
  }
  unlockRunContext(join(tmp, "run"));
  rmSync(tmp, { recursive: true, force: true });
});

describe("contextPending", () => {
  it("is true for an issue run before any agent step", () => {
    expect(contextPending(summary())).toBe(true);
  });

  it("is false without a pull_ticket step that saves issue.json, or without an ok top-level record", () => {
    expect(contextPending(summary({ flowDef: parseFlow("name: t\nsteps:\n  - {id: a, type: shell, run: 'true'}") }))).toBe(false);
    expect(contextPending(summary({ flowDef: parseFlow("name: t\nsteps:\n  - {id: pull_ticket, type: shell, run: 'true'}") }))).toBe(false);
    expect(contextPending(summary({ history: [rec("pull_ticket", { ok: false })] }))).toBe(false);
    expect(contextPending(summary({ history: [rec("pull_ticket", { parent: "x/y" })] }))).toBe(false);
  });

  it("is false once any agent, parallel or flow record exists, at any depth", () => {
    for (const type of ["claude", "parallel", "flow"] as const) expect(contextPending(summary({ history: [rec("pull_ticket"), rec("s", { type })] }))).toBe(false);
    expect(contextPending(summary({ history: [rec("pull_ticket"), rec("t", { type: "claude", parent: "build" })] }))).toBe(false);
  });

  it("is false when the marker, the bundle file or the folder is there, a dangling link included", () => {
    for (const name of ["context.attempt", "context.json", "context"]) {
      const p = join(tmp, "run", name);
      symlinkSync(join(tmp, "nowhere"), p);
      expect(contextPending(summary())).toBe(false);
      rmSync(p);
      expect(contextPending(summary())).toBe(true);
    }
  });

  it("stays true across a daily WAIT: stop and resume (no agent record, no second fetch)", () => {
    expect(contextPending(summary({ history: [rec("pull_ticket"), rec("daily_branch", { output: "WAIT: x" }), rec("wait_for_merge"), rec("daily_branch")] }))).toBe(true);
  });
});

describe("contextBeforeStep", () => {
  it("skips a run that is not pending and logs nothing", () => {
    const { engine, lines } = engineOf(summary({ history: [] }));
    expect(contextBeforeStep(engine, fakes())).toBe("skipped");
    expect(lines).toEqual([]);
    expect(existsSync(join(tmp, "run", "context.attempt"))).toBe(false);
  });

  it("writes a read-only bundle, one log line without paths, and skips a second time", () => {
    files('{"id":1,"body":"hi","updated_at":"2026-01-30T10:00:00Z"}\n{"id":2,"body":"x","updated_at":"2026-01-30T10:00:00Z"}\nnot json-ish: {"id":"x"}\n'.replace('not json-ish: {"id":"x"}', '{"id":"x"}'));
    const { engine, lines } = engineOf(summary());
    const r = contextBeforeStep(engine, fakes());
    expect(r).toMatchObject({ written: { skippedComments: 1 } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^· context: \d+ sources, \d+ left out, commit cccccccccccc, 1 comments skipped$/);
    expect(lines[0]).not.toContain(tmp);
    const run = join(tmp, "run");
    expect(lstatSync(join(run, "context.json")).mode & 0o777).toBe(0o400);
    expect(lstatSync(join(run, "context.attempt")).mode & 0o777).toBe(0o400);
    expect(lstatSync(join(run, "context")).mode & 0o777).toBe(0o500);
    const bundle = JSON.parse(readFileSync(join(run, "context.json"), "utf8"));
    expect(bundle.repository).toMatchObject({ commit: COMMIT });
    expect(contextBeforeStep(engine, fakes())).toBe("skipped");
    expect(lines).toHaveLength(1);
  });

  it("plain success line has no comments part, and max_sources leaves the rest out", () => {
    files();
    const { engine, lines } = engineOf(summary(), { context: { max_sources: 1 } });
    contextBeforeStep(engine, fakes());
    expect(lines[0]).toMatch(/^· context: 1 sources, \d+ left out, commit [0-9a-f]{12}$/);
    const bundle = JSON.parse(readFileSync(join(tmp, "run", "context.json"), "utf8"));
    expect(bundle.omitted.some((o: { reason: string }) => o.reason === "over-budget")).toBe(true);
  });

  const failing = (code: string, setup: () => void, deps: RunContextDeps = {}, bundleKept = false) => {
    it(`fails with ${code}: one line, ${bundleKept ? "foreign path kept" : "nothing stored"}`, () => {
      setup();
      const { engine, lines } = engineOf(summary());
      expect(contextBeforeStep(engine, fakes(deps))).toEqual({ failed: code });
      expect(lines).toEqual([`! context: CONTEXT_FAILED ${code}`]);
      expect(existsSync(join(tmp, "run", "context.json"))).toBe(false);
      expect(existsSync(join(tmp, "run", "context.attempt"))).toBe(code !== "marker-failed");
    });
  };
  failing("issue-unreadable", () => {});
  failing("comments-unreadable", () => {
    files();
    rmSync(join(tmp, "run", "issue-comments.jsonl"));
  });
  failing("marker-failed", () => {
    files();
    chmodSync(join(tmp, "run"), 0o500);
  });
  failing("repository-no-commit", files, { gitHead: () => "nothex" });
  failing("repository-timeout", files, { gitHead: () => { throw new ContextRepositoryError("timeout"); } });
  failing("repository-read-failed", files, { openRepository: () => ({ ...memorySnapshot(), read: () => { throw new ContextRepositoryError("read-failed"); } }) });
  failing("internal", files, { gitHead: () => { throw new Error("boom"); } });
  failing("bundle-invalid", files, { openRepository: () => { throw new ContextSchemaError("invalid", "x"); } });

  it("fails with select-invalid for settings that are not valid", () => {
    files();
    const { engine, lines } = engineOf(summary());
    (engine.config as unknown as { context: unknown }).context = { max_sources: 0 };
    expect(contextBeforeStep(engine, fakes())).toEqual({ failed: "select-invalid" });
    expect(lines).toEqual(["! context: CONTEXT_FAILED select-invalid"]);
  });

  it("fails with store-exists when the bundle appears after the check for pending", () => {
    files();
    const run = join(tmp, "run");
    const { engine } = engineOf(summary());
    const r = contextBeforeStep(engine, fakes({ openRepository: () => (writeFileSync(join(run, "context.json"), "{}"), memorySnapshot()) }));
    expect(r).toEqual({ failed: "store-exists" });
    expect(readFileSync(join(run, "context.json"), "utf8")).toBe("{}");
  });

  it("fails with store-write-failed and keeps a foreign folder", () => {
    files();
    const run = join(tmp, "run");
    const r = contextBeforeStep(engineOf(summary()).engine, fakes({ storeHooks: { afterCheck: () => mkdirSync(join(run, "context")) } }));
    expect(r).toEqual({ failed: "store-write-failed" });
    expect(existsSync(join(run, "context"))).toBe(true);
    expect(existsSync(join(run, "context.json"))).toBe(false);
    const r2 = contextBeforeStep(engineOf(summary()).engine, fakes());
    expect(r2).toBe("skipped");
  });

  it("on lock-failed removes only its own paths and keeps the marker", () => {
    files();
    const run = join(tmp, "run");
    const r = contextBeforeStep(engineOf(summary()).engine, fakes({ lock: () => { throw new Error("no"); }, storeHooks: { afterOpen: (p) => p.endsWith("context.json") && writeFileSync(join(run, "context", "foreign"), "x") } }));
    expect(r).toEqual({ failed: "lock-failed" });
    expect(existsSync(join(run, "context.json"))).toBe(false);
    expect(existsSync(join(run, "context", "foreign"))).toBe(true);
    expect(existsSync(join(run, "context.attempt"))).toBe(true);
  });

  it("never throws, even when log does", () => {
    files();
    const { engine } = engineOf(summary());
    engine.log = () => {
      throw new Error("log");
    };
    expect(() => contextBeforeStep(engine, fakes())).not.toThrow();
  });
});

describe("evidence and policy", () => {
  /** An engine whose evidence and policy only note what they were told, in order, together with the log lines. */
  const watched = (s: RunSummary, config: Record<string, unknown> = {}, throwing = false) => {
    const calls: unknown[][] = [];
    const base = engineOf(s, config);
    const fail = () => {
      if (throwing) throw new Error("boom");
    };
    const engine = {
      ...base.engine,
      log: (m: string) => calls.push(["log", m]),
      evidence: { contextBundled: (r: unknown) => (calls.push(["evidence", r]), fail()) },
      policy: { at: (b: string, f: unknown, st?: unknown) => (calls.push(["policy", b, f, st]), fail()) },
    };
    return { engine: engine as unknown as Parameters<typeof contextBeforeStep>[0], calls };
  };

  it("records the bundle, then asks context.select with no step, then logs", () => {
    files();
    const { engine, calls } = watched(summary());
    contextBeforeStep(engine, fakes());
    expect(calls.map((c) => c[0])).toEqual(["evidence", "policy", "log"]);
    const bundle = JSON.parse(readFileSync(join(tmp, "run", "context.json"), "utf8"));
    expect((calls[0]![1] as { bundle: { sources: unknown[] } }).bundle.sources).toHaveLength(bundle.sources.length);
    const [, boundary, facts, step] = calls[1]!;
    expect([boundary, step]).toEqual(["context.select", undefined]);
    expect(facts).toMatchObject({ contextSources: bundle.sources.length, contextOmitted: bundle.omitted.length, contextClassification: settings.classification });
    expect((facts as { contextBytes: number }).contextBytes).toBe(bundle.sources.reduce((n: number, s: { content: { bytes: number } }) => n + s.content.bytes, 0));
  });

  it("counts what max_sources left out", () => {
    files();
    const { engine, calls } = watched(summary(), { context: { max_sources: 1 } });
    contextBeforeStep(engine, fakes());
    expect((calls[1]![2] as { contextSources: number; contextOmitted: number }).contextSources).toBe(1);
    expect((calls[1]![2] as { contextOmitted: number }).contextOmitted).toBeGreaterThanOrEqual(1);
  });

  it("records a failure with its code and does not ask policy", () => {
    files();
    const { engine, calls } = watched(summary());
    contextBeforeStep(engine, fakes({ gitHead: () => { throw new ContextRepositoryError("timeout"); } }));
    expect(calls.map((c) => c[0])).toEqual(["evidence", "log"]);
    expect(calls[0]![1]).toEqual({ failed: "repository-timeout" });
  });

  it("records nothing for a run that is not pending", () => {
    const { engine, calls } = watched(summary({ history: [] }));
    expect(contextBeforeStep(engine, fakes())).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("does not throw when evidence or policy throws, and still logs", () => {
    files();
    const { engine, calls } = watched(summary(), {}, true);
    expect(() => contextBeforeStep(engine, fakes())).not.toThrow();
    expect(calls.map((c) => c[0])).toEqual(["evidence", "policy", "log"]);
  });
});

describe("contextSelectFacts", () => {
  const source = (classification: string) => ({ classification, content: { bytes: 10 } });
  const bundleOf = (classes: string[]) => ({ sources: classes.map(source), omitted: [{ reason: "stale" }] }) as unknown as Parameters<typeof contextSelectFacts>[0];

  it("leaves the classification out when there are no sources", () => {
    expect(contextSelectFacts(bundleOf([]))).toEqual({ contextSources: 0, contextBytes: 0, contextOmitted: 1 });
  });

  it("gives the most private class", () => {
    expect(contextSelectFacts(bundleOf(["public", "confidential", "internal"]))).toEqual({ contextSources: 3, contextBytes: 30, contextOmitted: 1, contextClassification: "confidential" });
  });
});

describe("RUN_CONTEXT_CODES", () => {
  it("has no code twice and holds the codes the attempts above give", () => {
    expect(new Set(RUN_CONTEXT_CODES).size).toBe(RUN_CONTEXT_CODES.length);
    for (const code of ["marker-failed", "select-invalid", "timeout", "lock-failed", "internal", "repository-no-commit", "store-exists", "store-write-failed"]) expect(RUN_CONTEXT_CODES).toContain(code);
  });
});

describe("deadline", () => {
  it("gives gitHead and the repository the same deadline and clock", () => {
    files();
    const seen: number[] = [];
    const now = () => T0;
    contextBeforeStep(engineOf(summary()).engine, {
      now,
      gitHead: (_d, deadline, n) => (seen.push(deadline), expect(n).toBe(now), COMMIT),
      openRepository: (_d, _c, o) => (seen.push(o.deadlineMs as number), expect(o.now).toBe(now), memorySnapshot()),
    });
    expect(seen).toEqual([T0 + 30_000, T0 + 30_000]);
  });

  it("stores nothing when the deadline passes inside selection", () => {
    files();
    let t = T0;
    const snap = memorySnapshot();
    const read = snap.read.bind(snap);
    snap.read = (p) => {
      const d = read(p);
      t = T0 + 31_000;
      return d;
    };
    const { engine, lines } = engineOf(summary());
    expect(contextBeforeStep(engine, fakes({ now: () => t, openRepository: () => snap }))).toEqual({ failed: "timeout" });
    expect(existsSync(join(tmp, "run", "context.json"))).toBe(false);
    expect(existsSync(join(tmp, "run", "context"))).toBe(false);
    expect(lines).toEqual(["! context: CONTEXT_FAILED timeout"]);
  });

  it("takes the bundle away when storing or locking ends late", () => {
    for (const late of ["store", "lock"]) {
      rmSync(join(tmp, "run"), { recursive: true, force: true });
      mkdirSync(join(tmp, "run"));
      files();
      let t = T0;
      const deps = late === "store" ? fakes({ now: () => t, storeHooks: { afterOpen: () => (t = T0 + 31_000) } }) : fakes({ now: () => t, lock: (d) => (lockRunContext(d), (t = T0 + 31_000)) as unknown as void });
      expect(contextBeforeStep(engineOf(summary()).engine, deps)).toEqual({ failed: "timeout" });
      expect(existsSync(join(tmp, "run", "context.json"))).toBe(false);
      expect(existsSync(join(tmp, "run", "context"))).toBe(false);
      expect(existsSync(join(tmp, "run", "context.attempt"))).toBe(true);
    }
  });

  it("gitHead starts no git when no time is left", () => {
    expect(() => gitHead(join(tmp, "repo"), T0, () => T0)).toThrow(/timeout/);
  });
});

describe("zero sources", () => {
  // Every source is above the highest classification allowed, so the bundle has no source but still has `context/`.
  const none = { context: { max_classification: "public" } };
  const emptyRepo = { openRepository: () => memorySnapshot({}) };

  it("rolls back the empty context folder when locking fails", () => {
    files();
    const run = join(tmp, "run");
    const r = writeRunContext({ summary: summary(), settings: none.context, commit: COMMIT, deadlineMs: T0 + 30_000 }, fakes({ ...emptyRepo, lock: () => { throw new Error("no"); } }));
    expect(r).toEqual({ failed: "lock-failed" });
    expect(existsSync(join(run, "context"))).toBe(false);
    expect(existsSync(join(run, "context.json"))).toBe(false);
  });

  it("rolls back the empty context folder when the deadline passes after locking", () => {
    files();
    const run = join(tmp, "run");
    let t = T0;
    const r = writeRunContext({ summary: summary(), settings: none.context, commit: COMMIT, deadlineMs: T0 + 30_000 }, { now: () => t, gitHead: () => COMMIT, openRepository: () => memorySnapshot({}), lock: (d) => { lockRunContext(d); t = T0 + 31_000; } });
    expect(r).toEqual({ failed: "timeout" });
    expect(existsSync(join(run, "context"))).toBe(false);
    expect(existsSync(join(run, "context.json"))).toBe(false);
  });
});

describe("retrievedAt", () => {
  it("is the startedAt of the latest ok pull_ticket, so the issue is not stale", () => {
    files();
    const old = new Date(T0 - 3_600_000).toISOString();
    const fresh = new Date(T0 - 10_000).toISOString();
    const history = [rec("pull_ticket", { startedAt: old }), rec("baseline_tests", { ok: false }), rec("pull_ticket", { startedAt: fresh })];
    const { engine } = engineOf(summary({ history }), { context: { task_max_age_seconds: 60 } });
    expect(contextBeforeStep(engine, fakes())).toMatchObject({ written: {} });
    const bundle = JSON.parse(readFileSync(join(tmp, "run", "context.json"), "utf8"));
    const issue = bundle.sources.find((s: { kind: string }) => s.kind === "issue");
    expect(JSON.stringify(issue)).toContain(fresh);
    expect(bundle.omitted.some((o: { reason: string }) => o.reason === "stale")).toBe(false);
  });

  it("keeps the original fetch time on a daily resume", () => {
    files();
    const at = new Date(T0 - 5_000).toISOString();
    const history = [rec("pull_ticket", { startedAt: at }), rec("daily_branch"), rec("daily_branch", { startedAt: new Date(T0).toISOString() })];
    expect(writeRunContext({ summary: summary({ history }), settings, commit: COMMIT, deadlineMs: T0 + 30_000 }, fakes())).toMatchObject({ written: {} });
    expect(readFileSync(join(tmp, "run", "context.json"), "utf8")).toContain(at);
  });
});

describe("locking", () => {
  it("sets 0400 and 0500, and unlock sets the folder back to 0700", () => {
    files();
    contextBeforeStep(engineOf(summary()).engine, fakes());
    const src = readdirOf(join(tmp, "run", "context"));
    expect(src.length).toBeGreaterThan(0);
    for (const f of src) expect(lstatSync(f).mode & 0o777).toBe(0o400);
    unlockRunContext(join(tmp, "run"));
    expect(lstatSync(join(tmp, "run", "context")).mode & 0o777).toBe(0o700);
  });

  it("refuses a link and does not follow it", () => {
    const run = join(tmp, "run");
    mkdirSync(join(run, "context"));
    writeFileSync(join(run, "context.json"), "{}");
    writeFileSync(join(tmp, "target"), "x", { mode: 0o644 });
    symlinkSync(join(tmp, "target"), join(run, "context", "l"));
    expect(() => lockRunContext(run)).toThrow();
    expect(lstatSync(join(tmp, "target")).mode & 0o777).toBe(0o644);
  });

  it("unlock never throws for a missing folder or a file", () => {
    const run = join(tmp, "run");
    expect(() => unlockRunContext(run)).not.toThrow();
    writeFileSync(join(run, "context"), "x");
    expect(() => unlockRunContext(run)).not.toThrow();
  });
});

describe("real git", () => {
  it("uses HEAD, not the working tree, and leaves the repository alone", () => {
    files();
    const repo = join(tmp, "repo");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, stdio: "pipe" }).toString();
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "first\n");
    git("add", ".");
    git("commit", "-qm", "one");
    writeFileSync(join(repo, "README.md"), "second\n");
    git("commit", "-qam", "two");
    const head = git("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "README.md"), "dirty\n");
    writeFileSync(join(repo, "untracked.md"), "u\n");
    const before = git("status", "--porcelain=v1");
    const mtime = lstatSync(join(repo, ".git", "index")).mtimeMs;
    const { engine, lines } = engineOf(summary());
    expect(contextBeforeStep(engine, { now: () => Date.now() })).toMatchObject({ written: { commit: head } });
    expect(lines[0]).toContain(head.slice(0, 12));
    const bundle = JSON.parse(readFileSync(join(tmp, "run", "context.json"), "utf8"));
    expect(bundle.repository).toMatchObject({ commit: head });
    const texts = readdirOf(join(tmp, "run", "context")).map((f) => readFileSync(f, "utf8"));
    expect(texts).toContain("second\n");
    expect(texts).not.toContain("dirty\n");
    expect(lstatSync(join(repo, ".git", "index")).mtimeMs).toBe(mtime);
    expect(git("status", "--porcelain=v1")).toBe(before);
  });

  it("gives repository-no-commit for an empty repository and leaves repository out of a bad name", () => {
    files();
    execFileSync("git", ["init", "-q"], { cwd: join(tmp, "repo") });
    expect(contextBeforeStep(engineOf(summary()).engine)).toEqual({ failed: "repository-no-commit" });
    rmSync(join(tmp, "run", "context.attempt"), { force: true });
    const s = summary({ vars: { issue: "12", github_repo: "not a repo" } });
    expect(writeRunContext({ summary: s, settings, commit: COMMIT, deadlineMs: T0 + 30_000 }, fakes())).toMatchObject({ written: {} });
    const bundle = JSON.parse(readFileSync(join(tmp, "run", "context.json"), "utf8"));
    expect(bundle.repository).not.toHaveProperty("name");
  });
});

function readdirOf(dir: string): string[] {
  return (execFileSync("find", [dir, "-type", "f"]).toString().trim().split("\n") as string[]).filter(Boolean);
}
