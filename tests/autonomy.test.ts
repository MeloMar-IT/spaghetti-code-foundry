import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, repoIdsOf } from "../src/auth/repos.js";
import { StoreError } from "../src/auth/store.js";
import { AUTONOMY_LEVELS, autonomyLine, autonomyOfRun, AutonomyLevelSchema, lowerLevel } from "../src/governance/autonomy.js";
import {
  AutonomyError,
  autonomyFile,
  effectiveLevel,
  levelOfFlow,
  levelOfRepo,
  levelsOf,
  MAX_AUTONOMY_BYTES,
  readAutonomy,
  serializeAutonomy,
  setLevel,
  setLevelLocked,
} from "../src/governance/autonomy-store.js";
import { recordRunAutonomy, runAutonomyAtStart } from "../src/governance/run-autonomy.js";
import { jsonFiles } from "../src/home-migrate.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(20);
const ADMIN = randomUUID();

describe("autonomy levels", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FACTORY_HOME;
    home = mkdtempSync(join(tmpdir(), "autonomy-"));
    process.env.FACTORY_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });
  const bytes = () => readFileSync(autonomyFile());
  const fails = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    throw new Error("did not throw");
  };

  it("orders the levels and takes the lower of two", () => {
    expect(AUTONOMY_LEVELS).toEqual(["observe", "plan-only", "guarded-write", "delivery-handoff"]);
    for (const [i, a] of AUTONOMY_LEVELS.entries()) for (const [j, b] of AUTONOMY_LEVELS.entries()) expect(lowerLevel(a, b)).toBe(AUTONOMY_LEVELS[Math.min(i, j)]);
    expect(AutonomyLevelSchema.safeParse("full").success).toBe(false);
  });

  it("reads a run without a field as delivery-handoff and garbage as observe", () => {
    expect(autonomyOfRun({})).toBe("delivery-handoff");
    expect(autonomyOfRun({ autonomy: { level: "plan-only", flow: "plan-only" } })).toBe("plan-only");
    expect(autonomyOfRun({ autonomy: { level: "full" } })).toBe("observe");
    expect(autonomyLine({ level: "observe", repository: "observe", flow: "plan-only" })).toBe("autonomy: observe (repository observe, flow plan-only)");
    expect(autonomyLine({ level: "plan-only", flow: "plan-only" })).toBe("autonomy: plan-only (no repository, flow plan-only)");
  });

  it("gives delivery-handoff without a file or entry", () => {
    expect(readAutonomy()).toEqual({ version: 1, repos: {}, flows: {} });
    expect(levelOfRepo(randomUUID())).toBe("delivery-handoff");
    expect(levelOfFlow("x")).toBe("delivery-handoff");
    expect(effectiveLevel(undefined, "x")).toBe("delivery-handoff");
    expect(levelOfFlow("constructor")).toBe("delivery-handoff");
    expect(levelOfFlow("__proto__")).toBe("delivery-handoff");
  });

  it("stores a level at mode 0600, trimmed, and takes the lower of repository and flow", () => {
    const repo = randomUUID();
    const e = setLevel("flows", "issue-gitflow", "plan-only", "system:monitor", " test ");
    expect(e.reason).toBe("test");
    expect(new Date(e.since).toISOString()).toBe(e.since);
    expect(statSync(autonomyFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    setLevel("repos", repo, "guarded-write", "system:connect");
    expect(effectiveLevel(repo, "issue-gitflow")).toBe("plan-only");
    expect(effectiveLevel(undefined, "issue-gitflow")).toBe("plan-only");
    setLevel("repos", repo, "observe", ADMIN);
    expect(effectiveLevel(repo, "other")).toBe("observe");
    expect(readAutonomy().flows["issue-gitflow"]!.level).toBe("plan-only"); // setting again keeps the others
  });

  it("round-trips a flow named __proto__ as an own key, and reads it back", () => {
    setLevel("flows", "__proto__", "plan-only", ADMIN);
    expect(bytes().toString()).toContain('"__proto__": {');
    const store = readAutonomy();
    expect(Object.hasOwn(store.flows, "__proto__")).toBe(true);
    expect(levelOfFlow("__proto__")).toBe("plan-only");
    expect(effectiveLevel(undefined, "__proto__")).toBe("plan-only");
    expect(levelOfFlow("constructor")).toBe("delivery-handoff");
    expect(({} as Record<string, unknown>).level).toBeUndefined(); // no prototype was changed
    setLevel("flows", "other", "observe", ADMIN);
    expect(levelOfFlow("__proto__")).toBe("plan-only");
  });

  it("takes the lowest of several repositories and leaves `repository` out with none", () => {
    const a = randomUUID();
    const b = randomUUID();
    setLevel("repos", a, "plan-only", ADMIN);
    const store = readAutonomy();
    expect(levelsOf(store, [a, b], "f")).toEqual({ level: "plan-only", repository: "plan-only", flow: "delivery-handoff" });
    expect("repository" in levelsOf(store, [], "f")).toBe(false);
  });

  it("refuses bad input and writes nothing", () => {
    const repo = randomUUID();
    const refused = [
      () => setLevel("repos", repo, "full" as never, ADMIN),
      () => setLevel("repos", "not-a-uuid", "observe", ADMIN),
      () => setLevel("flows", "a\nb", "observe", ADMIN),
      () => setLevel("flows", "x".repeat(201), "observe", ADMIN),
      () => setLevel("flows", "f", "observe", "alice"),
      () => setLevel("flows", "f", "observe", "system:"),
      () => setLevel("flows", "f", "observe", ADMIN, "a\nb"),
      () => setLevel("flows", "f", "observe", ADMIN, "x".repeat(201)),
      () => setLevel("flows", "f", "observe", ADMIN, `uses ${TOKEN}`),
    ];
    for (const fn of refused) {
      const e = fails(fn);
      expect(e).toBeInstanceOf(AutonomyError);
      expect(String((e as Error).message)).not.toContain(TOKEN);
    }
    expect(() => readFileSync(autonomyFile())).toThrow();
    expect(setLevel("flows", "f", "observe", ADMIN, "   ").reason).toBeUndefined();
  });

  it("needs the lock", () => {
    expect(() => setLevelLocked("flows", "f", "observe", ADMIN)).toThrow(/inside withAuthLock/);
    writeFileSync(join(home, "auth.lock"), String(process.pid));
    const e = fails(() => setLevel("flows", "f", "observe", ADMIN, undefined, { waitMs: 0 }));
    expect((e as StoreError).kind).toBe("locked");
  });

  it("refuses to read or change a broken file and leaves the bytes", () => {
    const cases: [string, StoreError["kind"]][] = [
      ["{", "not-json"],
      ['{"version":1}', "wrong-format"],
      [JSON.stringify({ version: 1, repos: {}, flows: { f: { level: "full", since: "2026-01-01T00:00:00.000Z", by: "system:x" } } }), "wrong-format"],
    ];
    for (const [text, kind] of cases) {
      writeFileSync(autonomyFile(), text);
      expect((fails(() => readAutonomy()) as StoreError).kind).toBe(kind);
      expect((fails(() => setLevel("flows", "f", "observe", ADMIN)) as StoreError).kind).toBe(kind);
      expect(bytes().toString()).toBe(text);
    }
    rmSync(autonomyFile());
    writeFileSync(join(home, "real.json"), "{}");
    symlinkSync(join(home, "real.json"), autonomyFile());
    expect((fails(() => readAutonomy()) as StoreError).kind).toBe("unreadable");
    rmSync(autonomyFile());
    writeFileSync(autonomyFile(), " ".repeat(MAX_AUTONOMY_BYTES + 1));
    expect((fails(() => readAutonomy()) as StoreError).kind).toBe("unreadable");
  });

  it("refuses an update that would pass the size limit and leaves the file as it was", () => {
    // entries without a reason (~130 bytes) fill the file to within 230 bytes of the limit; the new entry has a 200-character reason
    const flows: Record<string, { level: "observe"; since: string; by: string }> = {};
    const entry = { level: "observe" as const, since: "2026-01-01T00:00:00.000Z", by: "system:x" };
    const size = (f: object) => Buffer.byteLength(JSON.stringify({ version: 1, repos: {}, flows: f }, null, 2));
    const each = size({ "flow-0000": entry, "flow-0001": entry }) - size({ "flow-0000": entry });
    for (let i = 0; i < Math.floor((MAX_AUTONOMY_BYTES - 100) / each); i++) flows[`flow-${String(i).padStart(4, "0")}`] = entry;
    expect(Buffer.byteLength(JSON.stringify({ version: 1, repos: {}, flows }, null, 2))).toBeLessThan(MAX_AUTONOMY_BYTES);
    writeFileSync(autonomyFile(), JSON.stringify({ version: 1, repos: {}, flows }, null, 2) + "\n");
    const before = bytes();
    const e = fails(() => setLevel("flows", "one-more", "observe", ADMIN, "r".repeat(200)));
    expect((e as StoreError).kind).toBe("cannot-write");
    expect(bytes().equals(before)).toBe(true);
    expect(readAutonomy().flows["flow-0000"]!.level).toBe("observe");
    expect((fails(() => serializeAutonomy({ version: 1, repos: {}, flows: {} }, 5)) as StoreError).kind).toBe("cannot-write");
  });

  it("does not list autonomy.json among the files the move rewrites", () => {
    setLevel("flows", "f", "observe", ADMIN);
    writeFileSync(join(home, "other.json"), "{}");
    expect(jsonFiles(home).map((p) => p.slice(home.length + 1))).toEqual(["other.json"]);
  });

  describe("at the start of a run", () => {
    const connect = (url: string, owner = randomUUID()) => addRepo(owner, url, { ownerOk: () => true }).id;

    it("finds a repository of another account by its GitHub name", () => {
      const id = connect("https://github.com/Acme/App.git");
      setLevel("repos", id, "plan-only", "system:connect");
      expect(repoIdsOf("acme/app")).toEqual([id]);
      expect(repoIdsOf("not a name")).toEqual([]);
      expect(runAutonomyAtStart({ githubRepo: "acme/app", flow: "f" })).toEqual({ autonomy: { level: "plan-only", repository: "plan-only", flow: "delivery-handoff" }, problems: [] });
    });

    it("gives no repository for no name, a bad name or an unconnected one", () => {
      for (const githubRepo of [undefined, "owner/repo", "nope"]) {
        expect(runAutonomyAtStart({ githubRepo, flow: "f" }).autonomy).toEqual({ level: "delivery-handoff", flow: "delivery-handoff" });
      }
    });

    it("counts as observe when a store cannot be read", () => {
      connect("https://github.com/acme/app");
      writeFileSync(autonomyFile(), "{");
      const a = runAutonomyAtStart({ githubRepo: "acme/app", flow: "f" });
      expect(a.autonomy).toEqual({ level: "observe", repository: "observe", flow: "observe" });
      expect(a.problems).toEqual(["autonomy.json could not be read (not-json); this run counts as observe"]);
      rmSync(autonomyFile());
      writeFileSync(join(home, "repos.json"), "{");
      const b = runAutonomyAtStart({ githubRepo: "acme/app", flow: "f" });
      expect(b.autonomy.level).toBe("observe");
      expect(b.problems).toHaveLength(1);
    });

    it("records the event first and tries every line when the logger throws", () => {
      const seen: string[] = [];
      let calls = 0;
      const evidence = { runAutonomy: () => void calls++ };
      const start = { autonomy: { level: "observe" as const, flow: "observe" as const }, problems: ["x"] };
      recordRunAutonomy(
        start,
        (l) => {
          seen.push(l);
          throw new Error("boom");
        },
        evidence,
      );
      expect(calls).toBe(1);
      expect(seen).toEqual(["! autonomy: x", "autonomy: observe (no repository, flow observe)"]);
    });
  });

  it("keeps the folder free of other files", () => {
    mkdirSync(join(home, "runs"));
    setLevel("flows", "f", "observe", ADMIN);
    expect(readdirSync(home).sort()).toEqual(["autonomy.json", "runs"]);
  });
});
