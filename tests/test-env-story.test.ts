import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import type { RunSummary } from "../src/engine/state.js";
import type { RestIssue } from "../src/github.js";
import type { StoryStore } from "../src/stories/store.js";
import { reportDockerApi } from "../src/test-env-report.js";
import { fileDockerApiStories, readDockerApi } from "../src/test-env-story.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "docker-story-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const FACT = {
  version: 1, testcontainers: "1.19.3", buildFile: "pom.xml", clientApi: "1.32", minApi: "1.44", engine: "29.0.1",
  firstWorking: { "1.x": "1.21.4", "2.x": "2.0.2" }, at: "2026-11-26T10:00:00Z",
};
let n = 0;
function run(fact: unknown = FACT, extra: Partial<RunSummary> = {}): RunSummary {
  const runDir = join(tmp, `r${++n}`);
  mkdirSync(runDir);
  writeFileSync(join(runDir, "docker-api.json"), typeof fact === "string" ? fact : JSON.stringify(fact));
  return { runId: `r${n}`, runDir, status: "failed", vars: { github_repo: "acme/app" }, ...extra } as unknown as RunSummary;
}

/** A store that keeps what it makes; `fail` makes `create` throw, after it saved the story when `saved`. */
function fakeStore(o: { fail?: (labels: string[]) => { error: string; saved?: boolean } | undefined } = {}) {
  const issues: RestIssue[] = [];
  const calls: { title: string; body: string; labels: string[] }[] = [];
  const state = { cut: false, hidden: false };
  const store = {
    listAll: async () => ({ issues: state.hidden ? [] : issues, cut: state.cut }),
    create: async (s: { title: string; body: string; labels: string[] }) => {
      calls.push(s);
      const bad = o.fail?.(s.labels);
      const made = { number: issues.length + 1, html_url: "https://example.test/1", title: s.title, body: s.body, created_at: new Date().toISOString() } as RestIssue;
      if (!bad || bad.saved) issues.push(made);
      if (bad) throw new Error(bad.error);
      return made;
    },
  } as unknown as Pick<StoryStore, "listAll" | "create">;
  return { store, issues, calls, state };
}
const file = (store: Pick<StoryStore, "listAll" | "create">, runs: RunSummary[]) =>
  fileDockerApiStories({ repo: "acme/app", runs, store, stateFile: join(tmp, "state.json"), log: () => {} });

describe("the Docker version story", () => {
  it("is filed once, with the version advice, also for a second failed run", async () => {
    const f = fakeStore();
    const first = run();
    await file(f.store, [first]);
    await file(f.store, [first]);
    await file(f.store, [run()]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.labels).toEqual(["bug"]);
    for (const text of ["1.19.3", "1.21.4", "2.0.2", "<!-- claude-factory docker-api="]) expect(f.calls[0]!.body).toContain(text);
    expect(f.calls[0]!.title).toContain("1.19.3");
  });

  it("is not made again when GitHub made it and the answer got lost, also with another label error", async () => {
    const f = fakeStore({ fail: () => ({ error: "connection reset", saved: true }) });
    const r = run();
    await expect(file(f.store, [r])).rejects.toThrow("connection reset");
    await file(f.store, [r]);
    expect(f.calls).toHaveLength(1);
    expect(existsSync(join(r.runDir, "docker-api-story.json"))).toBe(true);
  });

  it("is not made while a cut list cannot show that a pending one is missing", async () => {
    const f = fakeStore({ fail: () => ({ error: "timed out", saved: true }) });
    const r = run();
    await expect(file(f.store, [r])).rejects.toThrow();
    f.state.cut = true;
    f.state.hidden = true;
    await file(f.store, [r]);
    expect(f.calls).toHaveLength(1);
    expect(existsSync(join(r.runDir, "docker-api-story.json"))).toBe(false);
  });

  it("is made without a label only when the label itself is refused", async () => {
    const f = fakeStore({ fail: (labels) => (labels.length ? { error: 'HTTP 422: Validation Failed (field "labels")' } : undefined) });
    await file(f.store, [run()]);
    expect(f.calls.map((c) => c.labels)).toEqual([["bug"], []]);
    expect(f.issues).toHaveLength(1);
  });

  it("ignores runs that still run, broken files and fields that fail their check", async () => {
    const bad = [
      run(FACT, { status: "running" }), run(FACT, { status: "waiting" }), run("{not json"), run({ ...FACT, minApi: "1.44; rm" }),
      run({ ...FACT, testcontainers: "@someone" }), run({ ...FACT, buildFile: "../../etc/passwd" }), run({ ...FACT, firstWorking: { "1.x": "x y", "2.x": "2.0.2" } }),
      run({ ...FACT, pad: "x".repeat(9000) }),
    ];
    for (const r of bad) expect(readDockerApi(r)).toBeUndefined();
    const f = fakeStore();
    await file(f.store, bad);
    expect(f.calls).toHaveLength(0);
    // a release check succeeds and reports its red checks: its facts count too
    expect(readDockerApi(run(FACT, { status: "succeeded" }))?.testcontainers).toBe("1.19.3");
  });
});

describe("filing when a run ends, with no watcher", () => {
  const report = (r: RunSummary, f: ReturnType<typeof fakeStore>, logs: string[] = [], others: RunSummary[] = []) =>
    reportDockerApi({ run: r, others: () => others, runsDir: join(tmp, "runs"), config: () => ConfigSchema.parse({}), store: () => f.store, log: (m) => logs.push(m) });

  it("files the story for a run without an owner", async () => {
    const f = fakeStore();
    await report(run(), f);
    expect(f.calls).toHaveLength(1);
  });

  it("never uses the server's login for a team's run without a sign-in", async () => {
    const f = fakeStore();
    const logs: string[] = [];
    await report(run(FACT, { workspace: "team-a", owner: "u1" }), f, logs);
    expect(f.calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("no sign-in");
  });

  it("does nothing for a local test, and never rejects", async () => {
    const f = fakeStore({ fail: () => ({ error: "boom" }) });
    await report(run(FACT, { localTest: true }), f);
    expect(f.calls).toHaveLength(0);
    const logs: string[] = [];
    await report(run(), f, logs);
    expect(logs.join("\n")).toContain("could not be filed");
  });
});
