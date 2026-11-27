import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { makeRedactor } from "../src/credentials/redact.js";
import type { Names } from "../src/monitor/clean.js";
import { DETECTORS } from "../src/monitor/detectors.js";
import type { Finding } from "../src/monitor/findings.js";
import { Monitor } from "../src/monitor/monitor.js";
import { Reporter } from "../src/monitor/report.js";
import { markerFor } from "../src/monitor/story.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { fakeGithub } from "./helpers/fake-github.js";

// A self-update whose tests failed three times on one commit becomes one bug story, with the fake gh.
const T0 = new Date(2026, 9, 1, 12, 0, 0);
const TARGET = "acme/app";
const NAMES: Names = { target: TARGET, users: ["Jane Doe"], emails: ["jane@acme.example"], repos: [], watchers: [], complete: true };
const selfUpdate = DETECTORS.find((d) => d.name === "self-update")!;
const sha = (c: string) => c.repeat(40);
const TESTS = ["tests/a.test.ts > adds numbers", "tests/b.test.ts > jane@acme.example sees C:\\private\\data.json"];

describe("the story of a self-update whose tests fail", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => {
    gh = fakeGithub();
  });
  afterEach(() => gh.restore());

  const reporter = () =>
    new Reporter({
      config: () => ConfigSchema.parse({ monitor: { report_to: TARGET, report_limits: { per_day: 5, per_check: 3 } } }).monitor,
      buildLabel: () => "go", names: () => NAMES, builtinSteps: () => ({}), guard: () => ({ go: true }), mutes: () => [], record: () => {}, rateLimit: () => undefined, log: () => {},
      clean: { redactor: () => makeRedactor([]), scan: async (t: string) => t },
    });
  const findingFor = (state: Record<string, unknown>): Finding[] =>
    selfUpdate.run({ update: { state: state as never, broken: false } } as never).map((f) => ({ ...f, firstSeen: T0.toISOString(), lastSeen: T0.toISOString(), count: 1, gone: false }));
  const failed = (commit: string, over: Record<string, unknown> = {}) => ({ failed: { commit, stage: "test", at: T0.toISOString(), lines: ["1 failed"], ...over } });

  it("files no finding for one or two failed tries (they only write `retry`)", () => {
    expect(findingFor({ retry: { commit: sha("a"), tries: 2, at: T0.toISOString() } })).toEqual([]);
  });

  it("files one story per commit, with the failing tests and without private text", async () => {
    const a = findingFor(failed(sha("a"), { tries: 3, tests: TESTS }));
    expect(a).toHaveLength(1);
    expect(await reporter().storyNow(a, a[0]!.fingerprint, T0, "admin-1", () => {})).toMatchObject({ ok: true, made: true });
    const made = gh.createdBodies();
    expect(made).toHaveLength(1);
    const { body } = made[0]!;
    expect(body).toContain("tests/a.test.ts > adds numbers");
    expect(body).toContain(markerFor(`self-update|test|${sha("a")}`));
    expect(body).toContain("Commit: `aaaaaaa`");
    for (const bad of ["jane", "Jane", "acme.example", "C:\\", "/Users", sha("a")]) expect(body).not.toContain(bad);

    // the same commit again is the same finding (the same marker); a new commit has its own and gets its own story
    expect(findingFor(failed(sha("a"), { tries: 3, tests: TESTS }))[0]!.fingerprint).toBe(a[0]!.fingerprint);
    const b = findingFor(failed(sha("b"), { tries: 3, tests: TESTS }));
    expect(b[0]!.fingerprint).not.toBe(a[0]!.fingerprint);
    expect(await reporter().storyNow(b, b[0]!.fingerprint, T0, "admin-1", () => {})).toMatchObject({ ok: true, made: true });
    expect(gh.createdBodies()).toHaveLength(2);
    expect(gh.createdBodies()[1]!.body).toContain(markerFor(`self-update|test|${sha("b")}`));
  });
});

describe("the automatic story of a self-update whose tests fail (monitor checks)", () => {
  const MIN = 60_000;
  const at = (min: number) => new Date(T0.getTime() + min * MIN);
  let gh: ReturnType<typeof fakeGithub>;
  let savedHome: string | undefined;
  let state: Record<string, unknown>;
  let clock: number;

  beforeEach(() => {
    gh = fakeGithub();
    savedHome = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = join(gh.tmp, "home"); // a fresh guard file, log and lock for every test
    state = {};
    clock = 0;
  });
  afterEach(() => {
    process.env.FACTORY_HOME = savedHome;
    gh.restore();
  });

  const monitor = () => {
    const reporter = new Reporter({
      config: () => ConfigSchema.parse({ monitor: { report_to: TARGET, report_limits: { per_day: 10, per_check: 3 } } }).monitor,
      buildLabel: () => "go", names: () => NAMES, builtinSteps: () => ({}), guard: () => ({ go: true }), mutes: () => [], record: () => {}, rateLimit: () => undefined, log: () => {},
      clean: { redactor: () => makeRedactor([]), scan: async (t: string) => t },
    });
    return new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
      scheduler: new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ConfigSchema.parse({}) }), watchers: () => [], thresholds: () => ConfigSchema.parse({}).monitor,
      log: () => {}, file: join(gh.tmp, "monitor-findings.json"), now: () => at(clock), reporter, detectors: [selfUpdate],
      selfUpdate: () => ({ state: state as never, broken: false }), guard: {},
    });
  };
  /** One check, six minutes after the last one, so no two checks share a window. */
  const check = async (m: Monitor) => {
    clock += 6;
    await m.tick();
  };
  const failTries = (commit: string) => {
    state = { failed: { commit, stage: "test", at: at(clock).toISOString(), lines: ["1 failed"], tries: 3, tests: TESTS } };
  };
  const storiesFor = (commit: string) => gh.createdBodies().filter((b) => b.body.includes(markerFor(`self-update|test|${commit}`)));

  it("files one story at the second check after the third failed try, and no more for the same commit", async () => {
    const m = monitor();
    const a = sha("a");
    state = { retry: { commit: a, tries: 1, at: at(0).toISOString() } };
    await check(m);
    state = { retry: { commit: a, tries: 2, at: at(clock).toISOString() } };
    await check(m);
    expect(gh.createdBodies()).toHaveLength(0);

    failTries(a);
    await check(m); // the first check that sees the third failure: the problem must last
    expect(gh.createdBodies()).toHaveLength(0);
    await check(m); // the second check in a row
    expect(storiesFor(a)).toHaveLength(1);
    const body = gh.createdBodies()[0]!.body;
    expect(body).toContain("tests/a.test.ts > adds numbers");
    for (const bad of ["jane", "Jane", "acme.example", "C:\\", sha("a")]) expect(body).not.toContain(bad);

    // more checks, and the same commit fails three more times after its record was cleared: still one story
    for (let i = 0; i < 3; i++) await check(m);
    state = {};
    await check(m);
    failTries(a);
    for (let i = 0; i < 3; i++) await check(m);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  it("files a second story for a new commit that fails three times", async () => {
    const m = monitor();
    const a = sha("a");
    const b = sha("b");
    failTries(a);
    await check(m);
    await check(m);
    expect(gh.createdBodies()).toHaveLength(1);
    failTries(b);
    await check(m);
    await check(m);
    expect(gh.createdBodies()).toHaveLength(2);
    expect(storiesFor(b)).toHaveLength(1);
  });
});
