import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOBS } from "../src/ops/cli.js";
import {
  activeRuns, HELPERS, isFoundryCommand, learn, measureUsage, ownersOf, parseCpuPs, parseCpuTime, parseNames, readCpuTable, slotHolders, splitCpu, usageLine,
  type ActiveRun, type CpuRow, type Learned, type Usage, type UsageState,
} from "../src/ops/usage.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "scf-usage-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OLD = "Sun Oct 4 08:00:00 2026";
const NEW = "Sun Nov 1 03:50:30 2026";
const PREV_AT = new Date("Sun Nov 1 03:50:00 2026");
const ENTRY = "/opt/scf/dist";
const row = (pid: number, ppid: number, cpuSec: number, command = "x", start = OLD): CpuRow => ({ pid, ppid, start, cpuSec, command });
const baseline = (rows: CpuRow[]): UsageState["procs"] => Object.fromEntries(rows.map((r) => [String(r.pid), [r.start, r.cpuSec] as [string, number]]));

describe("parseCpuTime", () => {
  it("reads the forms of macOS and Linux", () => {
    expect(parseCpuTime("0:12.34")).toBeCloseTo(12.34);
    expect(parseCpuTime("123:45.67")).toBeCloseTo(123 * 60 + 45.67);
    expect(parseCpuTime("00:00:12")).toBe(12);
    expect(parseCpuTime("01:02:03")).toBe(3723);
    expect(parseCpuTime("1-02:03:04")).toBe(86400 + 7384);
  });
  it("gives undefined for anything else", () => {
    for (const t of ["", "abc", "12", "1:2:3:4", "-", "1-"]) expect(parseCpuTime(t)).toBeUndefined();
  });
});

describe("parseNames", () => {
  it("cleans the names", () => {
    const m = parseNames(["  10 Google Chrome Helper (Renderer)", "11 -zsh", "12 (node)", "13", "14 " + "a".repeat(60), "junk"].join("\n"));
    expect(m.get(10)).toBe("Google Chrome Helper (Renderer)");
    expect(m.get(11)).toBe("zsh");
    expect(m.get(12)).toBe("node");
    expect(m.get(13)).toBe("unknown");
    expect(m.get(14)).toBe("a".repeat(40));
    expect(m.size).toBe(5);
  });
});

describe("parseCpuPs", () => {
  it("reads macOS and Linux shaped lines and skips garbage", () => {
    const rows = parseCpuPs(
      [
        "  101     1   0:12.34 Sat Oct 17 08:15:22 2026 /usr/bin/python3 jobs/worker.py --token=abc",
        "  102   101 01:02:03 Sat Oct  3 08:15:22 2026 node /x/cli.js serve",
        "garbage",
        "  103   1 notatime Sat Oct 17 08:15:22 2026 cmd",
        "  104   1 0:01.00 not a date at all cmd",
      ].join("\n"),
    );
    expect(rows.map((r) => r.pid)).toEqual([101, 102]);
    expect(rows[0]).toMatchObject({ ppid: 1, cpuSec: expect.closeTo(12.34), start: "Sat Oct 17 08:15:22 2026", command: "/usr/bin/python3 jobs/worker.py --token=abc" });
    expect(rows[1]!.start).toBe("Sat Oct 3 08:15:22 2026"); // the padded day is collapsed
    expect(rows[1]!.cpuSec).toBe(3723);
  });
});

describe("isFoundryCommand", () => {
  it("accepts only this install's entry points", () => {
    expect(isFoundryCommand(`node ${ENTRY}/cli.js serve`, ENTRY)).toBe("server");
    expect(isFoundryCommand(`node ${ENTRY}/cli.js serve --port 4777`, ENTRY)).toBe("server");
    expect(isFoundryCommand(`/usr/bin/node ${ENTRY}/factory.js ui`, ENTRY)).toBe("server");
    expect(isFoundryCommand(`tsx ${ENTRY}/cli.ts serve`, ENTRY)).toBe("server");
    expect(isFoundryCommand("node /other/project/cli.js serve", ENTRY)).toBeUndefined();
    expect(isFoundryCommand("node /x/npm-cli.js run test", ENTRY)).toBeUndefined();
    expect(isFoundryCommand(`node ${ENTRY}/cli.js --help`, ENTRY)).toBeUndefined();
    expect(isFoundryCommand(`node ${ENTRY}/cli.js servers`, ENTRY)).toBeUndefined();
  });
  it("accepts every helper", () => {
    expect(HELPERS).toEqual(Object.keys(JOBS));
    for (const h of HELPERS) expect(isFoundryCommand(`node ${ENTRY}/cli.js ${h} run`, ENTRY)).toBe("server");
    expect(isFoundryCommand(`node ${ENTRY}/cli.js governor report`, ENTRY)).toBeUndefined();
  });
});

describe("ownersOf and splitCpu", () => {
  // server 50 runs two runs: A (repo acme/a) step root 100, B (acme/b) step root 200
  const runs: ActiveRun[] = [
    { runId: "A", repo: "acme/a", pid: 50, pids: [100, 999] },
    { runId: "B", repo: "acme/b", pid: 50, pids: [200, 300] },
  ];
  const rows = [
    row(50, 1, 100, `node ${ENTRY}/cli.js serve`),
    row(100, 50, 10),
    row(101, 100, 10),
    row(102, 1, 10), // left the group; its parent chain is gone: other
    row(103, 101, 10), // a grandchild
    row(200, 50, 10),
    row(201, 200, 10),
    row(300, 77, 10), // mark with a wrong ppid
    row(400, 1, 10, "make release"), // a test slot holder with no run
    row(401, 400, 10),
    row(500, 1, 10, "Xcode"),
    row(600, 100, 10, "tools/test-slot"), // a slot holder under run A stays A's
    row(700, 50, 10), // unmarked child of the server
  ];
  const owners = ownersOf(rows, runs, [400, 600], ENTRY);

  it("gives each step tree to its run, also through a chain", () => {
    expect(owners.get(100)).toEqual({ kind: "run", runId: "A", repo: "acme/a" });
    expect(owners.get(103)).toEqual({ kind: "run", runId: "A", repo: "acme/a" });
    expect(owners.get(201)).toEqual({ kind: "run", runId: "B", repo: "acme/b" });
    expect(owners.get(600)).toEqual({ kind: "run", runId: "A", repo: "acme/a" });
  });
  it("ignores a mark with a wrong ppid or for a missing row, and leaves orphans and strangers alone", () => {
    expect(owners.get(300)).toBeUndefined();
    expect(owners.get(999)).toBeUndefined();
    expect(owners.get(102)).toBeUndefined();
    expect(owners.get(500)).toBeUndefined();
  });
  it("counts a slot holder without a run as tests, and the server with its children as server", () => {
    expect(owners.get(400)).toEqual({ kind: "tests" });
    expect(owners.get(401)).toEqual({ kind: "tests" });
    expect(owners.get(50)).toEqual({ kind: "server" });
    expect(owners.get(700)).toEqual({ kind: "server" });
  });

  it("splits the CPU of a window by run, repository, tests, server and other programs", () => {
    const before = baseline(rows.map((r) => ({ ...r, cpuSec: 0 })));
    const names = new Map([[102, "python3"], [500, "Xcode"]]);
    const u = splitCpu(rows, names, before, PREV_AT, owners, runs, 10);
    // each of the cpu rows used 10 s in 10 s = 1 core; the server used 100 s = 10 cores
    expect(u.foundry.runs).toEqual([
      { runId: "A", repo: "acme/a", cores: 4 }, // 100, 101, 103 and the slot holder 600
      { runId: "B", repo: "acme/b", cores: 2 },
    ]);
    expect(u.foundry.repos).toEqual({ "acme/a": 4, "acme/b": 2 });
    expect(u.foundry.tests).toBe(2);
    expect(u.foundry.server).toBe(11);
    expect(u.foundry.cores).toBe(19);
    expect(u.other.cores).toBe(3); // 102, 300 and 500
    expect(u.other.top.map((p) => p.program).sort()).toEqual(["Xcode", "python3", "unknown"]);
  });

  it("separates two runs under one server pid", () => {
    const two: ActiveRun[] = [{ runId: "A", repo: "r/a", pid: 5, pids: [10] }, { runId: "B", repo: "r/b", pid: 5, pids: [20] }];
    const rs = [row(5, 1, 0), row(10, 5, 4), row(20, 5, 8)];
    const u = splitCpu(rs, new Map(), baseline(rs.map((r) => ({ ...r, cpuSec: 0 }))), PREV_AT, ownersOf(rs, two, [], ENTRY), two, 4);
    expect(u.foundry.runs.map((r) => [r.runId, r.cores])).toEqual([["A", 1], ["B", 2]]);
  });
});

describe("splitCpu: the window", () => {
  const nobody = new Map();
  it("counts a process that started inside the window in full, and gives an old one a baseline only", () => {
    const rows = [row(1, 0, 20, "a", NEW), row(2, 0, 20, "b", OLD)];
    const u = splitCpu(rows, new Map([[1, "fresh"], [2, "old"]]), {}, PREV_AT, nobody, [], 10);
    expect(u.other.cores).toBe(2);
    expect(u.other.top).toEqual([{ program: "fresh", cores: 2 }]);
  });
  it("counts nothing for a worker that ended between two checks, and does not list it as another program", () => {
    // pid 9 was busy in the previous window and is gone now: its CPU is not visible any more (ps gives live processes only)
    const prev = { "9": [OLD, 50] as [string, number], "1": [OLD, 0] as [string, number] };
    const rows = [row(1, 0, 0, "make", OLD)];
    const u = splitCpu(rows, new Map([[1, "make"]]), prev, PREV_AT, nobody, [], 10);
    expect(u.other.cores).toBe(0);
    expect(u.other.top).toEqual([]);
    expect(u.foundry.cores).toBe(0);
  });
  it("treats the same pid with a new start like a missing one", () => {
    const u = splitCpu([row(1, 0, 20, "a", OLD)], new Map(), { "1": ["Sun Sep 1 00:00:00 2026", 5] }, PREV_AT, nobody, [], 10);
    expect(u.other.cores).toBe(0);
    const v = splitCpu([row(1, 0, 20, "a", NEW)], new Map(), { "1": [OLD, 5] }, PREV_AT, nobody, [], 10);
    expect(v.other.cores).toBe(2);
  });
  it("clamps a lower CPU time to 0", () => {
    const u = splitCpu([row(1, 0, 3)], new Map(), { "1": [OLD, 9] }, PREV_AT, nobody, [], 10);
    expect(u.other.cores).toBe(0);
  });
  it("groups the top programs and shows 3", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, 0, i * 10));
    const names = new Map([[1, "a"], [2, "a"], [3, "b"], [4, "c"], [5, "d"]]);
    const u = splitCpu(rows, names, baseline(rows.map((r) => ({ ...r, cpuSec: 0 }))), PREV_AT, nobody, [], 10);
    expect(u.other.top).toEqual([{ program: "d", cores: 5 }, { program: "c", cores: 4 }, { program: "a", cores: 3 }]);
  });
});

describe("privacy", () => {
  it("keeps program names free of arguments and paths", () => {
    const text = "  7 1 0:20.00 Sat Oct 17 08:15:22 2026 /Users/John Doe/bin/python3 jobs/worker.py --token=abc\n";
    const rows = parseCpuPs(text);
    const names = parseNames("7 python3\n");
    const u = splitCpu(rows, names, { "7": [rows[0]!.start, 0] }, PREV_AT, new Map(), [], 10);
    const all = JSON.stringify(u) + usageLine(u);
    expect(all).toContain("python3");
    for (const bad of ["worker.py", "abc", "John Doe", "--token"]) expect(all).not.toContain(bad);
  });
});

describe("learn", () => {
  const usage = (cores: number, n = 1): Pick<Usage, "foundry"> => ({
    foundry: { cores: cores * n, tests: 0, server: 0, runs: Array.from({ length: n }, (_, i) => ({ runId: `r${i}`, repo: "r/a", cores })), repos: { "r/a": cores * n } },
  });
  it("takes the first reading and averages the early ones", () => {
    let l: Record<string, Learned> = {};
    l = learn(l, usage(1));
    expect(l["r/a"]).toEqual({ cores: 1, readings: 1 });
    l = learn(l, usage(1.2));
    expect(l["r/a"]!.cores).toBeCloseTo(1.1);
  });
  it("uses the mean per run of a repository", () => {
    expect(learn({}, usage(2, 3))["r/a"]!.cores).toBe(2);
  });
  it("moves less than 0.5 on an extreme second reading", () => {
    const l = learn({ "r/a": { cores: 1, readings: 1 } }, usage(21));
    expect(l["r/a"]!.cores - 1).toBeLessThan(0.5);
  });
  it("moves less than 0.5 on an extreme reading after many steady ones", () => {
    let l: Record<string, Learned> = {};
    for (let i = 0; i < 30; i++) l = learn(l, usage(1));
    l = learn(l, usage(21));
    expect(l["r/a"]!.cores - 1).toBeLessThan(0.5);
    expect(l["r/a"]!.cores).toBeGreaterThan(1);
  });
  it("keeps repositories apart and keeps one without a reading", () => {
    const l = learn({ "r/a": { cores: 1, readings: 4 }, "r/z": { cores: 3, readings: 2 } }, { foundry: { cores: 2, tests: 0, server: 0, runs: [{ runId: "x", repo: "r/b", cores: 2 }], repos: { "r/b": 2 } } });
    expect(l["r/a"]).toEqual({ cores: 1, readings: 4 });
    expect(l["r/z"]).toEqual({ cores: 3, readings: 2 });
    expect(l["r/b"]).toEqual({ cores: 2, readings: 1 });
  });
});

describe("usageLine", () => {
  it("names the cause", () => {
    const u = { foundry: { cores: 3.24, tests: 0, server: 0, runs: [], repos: {} }, other: { cores: 6.14, top: [{ program: "Xcode", cores: 3.1 }, { program: "node", cores: 1.4 }] } };
    expect(usageLine(u)).toBe("the Foundry uses 3.2 cores, other programs use 6.1 cores (top: Xcode 3.1, node 1.4)");
    expect(usageLine({ ...u, other: { cores: 0, top: [] } })).toBe("the Foundry uses 3.2 cores, other programs use 0.0 cores");
  });
});

describe("activeRuns and slotHolders", () => {
  const makeRun = (runsDir: string, id: string, o: { status?: string; pid?: number; marks?: number[]; json?: string } = {}) => {
    const d = join(runsDir, id);
    mkdirSync(join(d, "step-pids"), { recursive: true });
    for (const m of o.marks ?? []) writeFileSync(join(d, "step-pids", String(m)), "");
    writeFileSync(join(d, "run.json"), o.json ?? JSON.stringify({ runId: id, status: o.status ?? "running", pid: o.pid ?? 50, repo: "/local/repo", vars: { github_repo: "acme/app" } }));
  };
  it("loads only running runs with a mark", () => {
    const runsDir = tmp();
    makeRun(runsDir, "live", { marks: [11, 12] });
    makeRun(runsDir, "done", { status: "succeeded", marks: [13] });
    makeRun(runsDir, "bad", { marks: [14], json: "{nope" });
    makeRun(runsDir, "nomark", { marks: [] });
    const found = activeRuns(runsDir);
    expect(found).toEqual([{ runId: "live", repo: "acme/app", pid: 50, pids: [11, 12] }]);
  });
  it("never parses the run.json of a run without marks", () => {
    const runsDir = tmp();
    makeRun(runsDir, "nomark", { json: "{nope" });
    expect(activeRuns(runsDir)).toEqual([]);
  });
  it("takes the repo when the run has no github_repo", () => {
    const runsDir = tmp();
    makeRun(runsDir, "r", { marks: [1], json: JSON.stringify({ status: "running", pid: 9, repo: "/local/repo", vars: {} }) });
    expect(activeRuns(runsDir)[0]!.repo).toBe("/local/repo");
  });
  it("reads the pids of the test slots", () => {
    const slots = tmp();
    mkdirSync(join(slots, "slot-1"));
    writeFileSync(join(slots, "slot-1", "pid"), "321");
    mkdirSync(join(slots, "slot-2"));
    writeFileSync(join(slots, "cap"), "1");
    expect(slotHolders(slots)).toEqual([321]);
    expect(slotHolders(join(slots, "none"))).toEqual([]);
  });
});

describe("measureUsage", () => {
  const T0 = new Date("2026-11-01T03:00:00Z");
  const at = (s: number) => new Date(T0.getTime() + s * 1000);
  const table = (cpu: number) => ({ rows: [row(1, 0, cpu, "make"), row(2, 0, cpu * 2, "Xcode")], names: new Map([[1, "make"], [2, "Xcode"]]) });
  const setup = () => {
    const d = tmp();
    const o = { dir: join(d, "governor"), runsDir: join(d, "runs"), slotsDir: join(d, "test-slots") };
    return { o, usage: join(d, "governor", "usage.json") };
  };

  it("gives a baseline first, then figures, and keeps learned values", () => {
    const { o, usage } = setup();
    expect(measureUsage({ ...o, now: at(0), read: () => table(0) })).toBeUndefined();
    expect(existsSync(usage)).toBe(true);
    const u = measureUsage({ ...o, now: at(60), read: () => table(60) })!;
    expect(u.other.cores).toBe(3);
    expect(u.other.top[0]).toEqual({ program: "Xcode", cores: 2 });
    expect(JSON.parse(readFileSync(usage, "utf8")).procs["1"]).toEqual([OLD, 60]);
  });
  it("starts a new baseline after a long gap and keeps learned values", () => {
    const { o, usage } = setup();
    mkdirSync(o.dir, { recursive: true });
    writeFileSync(usage, JSON.stringify({ at: at(0).toISOString(), procs: {}, learned: { "r/a": { cores: 2, readings: 5 } } }));
    expect(measureUsage({ ...o, now: at(3600), read: () => table(5) })).toBeUndefined();
    const s = JSON.parse(readFileSync(usage, "utf8"));
    expect(s.learned).toEqual({ "r/a": { cores: 2, readings: 5 } });
    expect(s.at).toBe(at(3600).toISOString());
  });
  it("changes nothing for a gap under 20 s, or when ps gives nothing", () => {
    const { o, usage } = setup();
    measureUsage({ ...o, now: at(0), read: () => table(0) });
    const before = readFileSync(usage, "utf8");
    expect(measureUsage({ ...o, now: at(10), read: () => table(5) })).toBeUndefined();
    expect(measureUsage({ ...o, now: at(60), read: () => undefined })).toBeUndefined();
    expect(measureUsage({ ...o, now: at(60), read: () => ({ rows: [], names: new Map() }) })).toBeUndefined();
    expect(measureUsage({ ...o, now: at(60), read: () => { throw new Error("boom"); } })).toBeUndefined();
    expect(readFileSync(usage, "utf8")).toBe(before);
  });
  it("starts fresh from a broken usage.json", () => {
    const { o, usage } = setup();
    mkdirSync(o.dir, { recursive: true });
    writeFileSync(usage, "{broken");
    expect(measureUsage({ ...o, now: at(0), read: () => table(0) })).toBeUndefined();
    expect(JSON.parse(readFileSync(usage, "utf8")).learned).toEqual({});
  });
  it("leaves no temp file behind", () => {
    const { o } = setup();
    measureUsage({ ...o, now: at(0), read: () => table(0) });
    expect(readdirSync(o.dir)).toEqual(["usage.json"]);
  });
});

describe("readCpuTable", () => {
  const fake = (body: string) => {
    const f = join(tmp(), "ps");
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  it("gives undefined when ps fails", () => {
    vi.stubEnv("FACTORY_TEST_SLOT_PS", "/usr/bin/false");
    expect(readCpuTable()).toBeUndefined();
  });
  it("gives undefined for output that cannot be read", () => {
    vi.stubEnv("FACTORY_TEST_SLOT_PS", fake("echo garbage; echo more"));
    expect(readCpuTable()).toBeUndefined();
  });
  it("gives undefined when ps is too slow", () => {
    vi.stubEnv("FACTORY_TEST_SLOT_PS", fake("exec sleep 5"));
    expect(readCpuTable(200)).toBeUndefined();
  });
  it("reads rows and names, and falls back to unknown programs when the names call fails", () => {
    vi.stubEnv(
      "FACTORY_TEST_SLOT_PS",
      fake(`case "$*" in *ucomm*) echo "  7 python3";; *) echo "  7 1 0:20.00 Sat Oct 17 08:15:22 2026 /usr/bin/python3 jobs/worker.py";; esac`),
    );
    const t = readCpuTable()!;
    expect(t.rows).toHaveLength(1);
    expect(t.names.get(7)).toBe("python3");
    vi.stubEnv("FACTORY_TEST_SLOT_PS", fake(`case "$*" in *ucomm*) exit 1;; *) echo "  7 1 0:20.00 Sat Oct 17 08:15:22 2026 cmd";; esac`));
    expect(readCpuTable()!.names.size).toBe(0);
  });
});
