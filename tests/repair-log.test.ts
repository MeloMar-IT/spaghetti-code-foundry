import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autonomyLowered, bugStoryFixFailed, bugStoryMade, dependencyCountedDone, digestRepairLines, hotfixMergeRepair, labelCorrected, olderRepairFile, recordRepair, repairFile, repairsSince, resetRepairMemory, retryRepair, safeRestartRepair, serviceNotStarted, serviceStarted, type RepairEntry, type RepairInput } from "../src/monitor/repair-log.js";
import { isRepairName, REPAIR_NAMES, REPAIRS, type RepairName } from "../src/monitor/repairs.js";

// Unit tests of the repair log: a temporary folder, no server, no child process.

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repair-log-"));
  file = join(dir, "monitor-repairs.jsonl");
  resetRepairMemory();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const one: RepairInput = { repair: "correct-labels", what: "label of #12 set to working to match its newest run", where: "acme/app", result: "done", key: "x" };
const lines = (f = file) => readFileSync(f, "utf8").split("\n").filter(Boolean);
const read = () => repairsSince(0, { file });

describe("recordRepair", () => {
  it("writes exactly one line, read back with the time, the class and a hashed key", () => {
    expect(recordRepair(one, { file, now: new Date("2026-10-01T12:00:00Z") })).toBe(true);
    expect(lines()).toHaveLength(1);
    expect(read()).toEqual([{ at: "2026-10-01T12:00:00.000Z", repair: "correct-labels", class: "auto", what: one.what, where: "acme/app", result: "done", key: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
  });

  it("writes to the data folder by default, readable by the owner only", () => {
    expect(recordRepair({ ...one, key: `default-${dir}` })).toBe(true);
    expect(repairFile()).toBe(join(process.env.FACTORY_HOME!, "monitor-repairs.jsonl"));
    expect(statSync(repairFile()).mode & 0o777).toBe(0o600);
    rmSync(repairFile());
  });

  it("knows the same names as the repair list", () => {
    expect(REPAIRS.map((r) => r.name)).toEqual([...REPAIR_NAMES]);
    for (const n of REPAIR_NAMES) expect(isRepairName(n)).toBe(true);
    expect(isRepairName("delete-all")).toBe(false);
  });

  it("writes nothing for an unknown name or result, and does not throw", () => {
    expect(recordRepair({ ...one, repair: "delete-all" as RepairName }, { file })).toBe(false);
    expect(recordRepair({ ...one, result: "maybe" as "done" }, { file })).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("stores free text cleaned and cut, and never the key itself", () => {
    const secret = `ghp_${"a1B2".repeat(8)}`;
    recordRepair({ ...one, what: `read /Users/someone/private/notes with ${secret}`, where: `/srv/data/work ${"w ".repeat(200)}`, key: `k ${secret}` }, { file });
    const [e] = read();
    expect(e!.what).toBe("read <path> with <token>");
    expect(e!.where.startsWith("<path> w")).toBe(true);
    expect(e!.where.length).toBeLessThanOrEqual(100);
    expect(readFileSync(file, "utf8")).not.toContain(secret);
    recordRepair({ ...one, what: "ab ".repeat(400), key: "long" }, { file });
    expect(read().at(-1)!.what).toHaveLength(200);
  });

  it("skips only the same occurrence reported twice", () => {
    recordRepair(one, { file });
    expect(recordRepair(one, { file })).toBe(false);
    expect(recordRepair({ ...one, result: "failed" }, { file })).toBe(true);
    expect(recordRepair({ ...one, key: "another attempt" }, { file })).toBe(true);
    expect(lines()).toHaveLength(3);
  });

  it("keeps both files within the cap and keeps an older file", () => {
    for (let i = 0; i < 200; i++) recordRepair({ ...one, key: `k${i}`, what: `repair ${i}` }, { file, maxBytes: 4096, now: new Date(1_000_000 + i * 1000) });
    expect(statSync(file).size).toBeLessThanOrEqual(4096);
    expect(existsSync(olderRepairFile(file))).toBe(true);
    expect(statSync(olderRepairFile(file)).size).toBeLessThanOrEqual(4096);
    const got = read();
    expect(got).toHaveLength(lines().length + lines(olderRepairFile(file)).length);
    expect(got.at(-1)!.what).toBe("repair 199");
    expect(got.map((e) => Date.parse(e.at))).toEqual(got.map((e) => Date.parse(e.at)).sort((a, b) => a - b));
  });

  it("drops lines past the hard limit while another process holds the rotation lock", () => {
    mkdirSync(join(dir, "monitor-repairs.lock"));
    writeFileSync(join(dir, "monitor-repairs.lock", "pid"), String(process.pid));
    const onError = vi.fn();
    for (let i = 0; i < 100; i++) recordRepair({ ...one, key: `h${i}` }, { file, maxBytes: 1024, onError });
    expect(statSync(file).size).toBeLessThanOrEqual(2048);
  });

  it("never throws when the file cannot be written, and says so", () => {
    writeFileSync(join(dir, "plain"), "x");
    const onError = vi.fn();
    expect(recordRepair(one, { file: join(dir, "plain", "log.jsonl"), onError })).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("the repair log could not be written"));
  });
});

describe("repairsSince", () => {
  const raw = (what: string, over: Partial<RepairEntry> = {}) => JSON.stringify({ at: "2026-10-01T12:00:00.000Z", repair: "bug-story", class: "auto", what, where: "acme/app", result: "done", key: "k", ...over });

  it("gives nothing without a log", () => expect(read()).toEqual([]));

  it("skips broken lines and keeps the good ones", () => {
    writeFileSync(file, ["{garbage", "null", "[1]", raw("no result", { result: undefined as never }), raw("bad name", { repair: "x" as RepairName }), raw("good"), ""].join("\n"));
    expect(read().map((e) => e.what)).toEqual(["good"]);
  });

  it("reads the current file alone, the older file alone, and one file next to an unreadable one", () => {
    writeFileSync(file, raw("current") + "\n");
    expect(read().map((e) => e.what)).toEqual(["current"]);
    rmSync(file);
    writeFileSync(olderRepairFile(file), raw("older") + "\n");
    expect(read().map((e) => e.what)).toEqual(["older"]);
    mkdirSync(file); // reading a folder fails
    expect(read().map((e) => e.what)).toEqual(["older"]);
    rmSync(file, { recursive: true });
    rmSync(olderRepairFile(file));
    mkdirSync(olderRepairFile(file));
    writeFileSync(file, raw("current") + "\n");
    expect(read().map((e) => e.what)).toEqual(["current"]);
  });

  it("leaves out what is older than the start", () => {
    writeFileSync(file, `${raw("old", { at: "2026-09-01T00:00:00.000Z" })}\n${raw("new")}\n`);
    expect(repairsSince(Date.parse("2026-09-30T00:00:00Z"), { file }).map((e) => e.what)).toEqual(["new"]);
  });
});

describe("digestRepairLines", () => {
  const entry = (i: number, over: Partial<RepairEntry> = {}): RepairEntry => ({ at: new Date(i * 1000).toISOString(), repair: "bug-story", class: "auto", what: `w${i}`, where: "acme/app", result: "done", key: "k", ...over });

  it("lists what, where and the result, newest first, without a limit and without what asks first", () => {
    const got = digestRepairLines([entry(1, { result: "failed" }), entry(2, { class: "ask" }), entry(3)]);
    expect(got).toEqual(["w3 (acme/app): done", "w1 (acme/app): failed"]);
    expect(digestRepairLines(Array.from({ length: 60 }, (_, i) => entry(i)))).toHaveLength(60);
  });
});

describe("the entry of each repair", () => {
  it("names the repair, the result and one occurrence", () => {
    const retry = { runId: "r", repo: "acme/app", issue: "7", step: "implement", attempt: 1, of: 2, at: "t" };
    expect(retryRepair(retry, true)).toMatchObject({ repair: "retry-after-time-limit", result: "done", where: "acme/app", what: "retry 1 of 2 after a time limit in implement (issue #7)" });
    expect(retryRepair(retry, false).result).toBe("failed");
    expect(retryRepair({ ...retry, at: "u" }, true).key).not.toBe(retryRepair(retry, true).key);
    expect(bugStoryMade({ detector: "restart-loop", repo: "acme/app", issue: 3 })).toMatchObject({ repair: "bug-story", result: "done", what: "bug story #3 made for restart-loop" });
    expect(bugStoryFixFailed({ detector: "d", fingerprint: "f", issue: 3, count: 2 })).toMatchObject({ repair: "bug-story", result: "failed", where: "this server" });
    expect(autonomyLowered({ kind: "flows", id: "f1", name: "f1", detector: "d", fingerprint: "p", at: "t", from: "act", to: "ask" })).toMatchObject({ repair: "lower-autonomy", result: "done" });
    const svc = { name: "bot", restarts: 1, at: "t" };
    expect(serviceStarted(svc)).toMatchObject({ repair: "start-service", result: "done" });
    expect(serviceNotStarted(svc)).toMatchObject({ repair: "start-service", result: "failed" });
    expect(safeRestartRepair({ why: "settings", since: "s" }, "t").what).toBe("server restarted for a changed setting once no run was active");
    expect(safeRestartRepair(undefined, "t").what).toBe("server restarted once no run was active");
    expect(labelCorrected({ repo: "acme/app", issue: 4, label: undefined, runId: "r", at: "t" }, "failed")).toMatchObject({ repair: "correct-labels", result: "failed", what: "label of #4 could not be set to no status label to match its newest run" });
    expect(dependencyCountedDone({ repo: "acme/app", issue: 6, dependency: "#4" })).toMatchObject({ repair: "completed-dependency", result: "done" });
  });

  it("tells a hotfix merge that landed from one that could not", () => {
    const base = { hotfix: "on", stepId: "push_main", ok: true, output: "x\nPUSHED: main abc123", runId: "r", visit: 1, at: "t", vars: { github_repo: "acme/app", main_branch: "main", issue: "9" } };
    expect(hotfixMergeRepair(base)).toMatchObject({ repair: "hotfix-merge", result: "done", where: "acme/app", what: "hotfix of #9 merged into main" });
    for (const stepId of ["push_main", "merge_main", "red_main"]) expect(hotfixMergeRepair({ ...base, stepId, ok: false, output: "no" })).toMatchObject({ result: "failed" });
    expect(hotfixMergeRepair({ ...base, output: "main moved meanwhile — merging again\nMOVED" })).toBeUndefined();
    expect(hotfixMergeRepair({ ...base, stepId: "merge_main", output: "MERGED: x into main" })).toBeUndefined();
    expect(hotfixMergeRepair({ ...base, hotfix: "off" })).toBeUndefined();
    expect(hotfixMergeRepair({ ...base, hotfix: undefined })).toBeUndefined();
    expect(hotfixMergeRepair({ ...base, stepId: "test_main", ok: false })).toBeUndefined();
  });
});
