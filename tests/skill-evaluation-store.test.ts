import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEvaluationRecord, type EvaluationRecord } from "../src/skills/evaluation.js";
import { EVALUATION_STORE_LIMITS } from "../src/skills/evaluation-rules.js";
import {
  EvaluationStoreError, evaluationsDir, evaluationStoreSettings, findNewestRecordOf, readNewestRecord, recordFileName, writeEvaluationRecord,
} from "../src/skills/evaluation-store.js";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const D1 = "sha256:" + "1".repeat(64);
const D2 = "sha256:" + "2".repeat(64);
const SUITE = "sha256:" + "3".repeat(64);

function record(over: { id?: string; digest?: string; commit?: string; source?: string; at?: string; selection?: number } = {}): EvaluationRecord {
  const parsed = parseEvaluationRecord({
    schema: 1,
    candidate: { id: over.id ?? "lib-kafka", version: "1.0.0", digest: over.digest ?? D1, fingerprint: "fp-1", source: over.source ?? "lib", repositoryKey: "github.com/example/skills", commit: over.commit ?? COMMIT },
    suite: { digest: SUITE, scenarios: [] },
    runtime: { foundry: "test" },
    evaluatedAt: over.at ?? "2026-10-13T10:00:00Z",
    dimensions: { selection: [over.selection ?? 1], conflicts: [1], context: [1], tools: [1] },
    findings: [],
    evidence: [],
  });
  if (!("record" in parsed)) throw new Error(parsed.problem);
  return parsed.record;
}

const made: string[] = [];
let home: string;
const realLink = evaluationStoreSettings.link;
const realRealpath = evaluationStoreSettings.realpath;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skilleval-store-")));
  made.push(home);
});
afterEach(() => {
  evaluationStoreSettings.link = realLink;
  evaluationStoreSettings.realpath = realRealpath;
  for (const d of made.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // gone
    }
    rmSync(d, { recursive: true, force: true });
  }
});
const dir = (commit = COMMIT, source = "lib") => evaluationsDir(source, commit, home);
const tmps = (d = dir()) => readdirSync(d).filter((n) => n.startsWith(".tmp-"));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("writeEvaluationRecord", () => {
  it("makes 0700 folders and a 0600 file with the first sequence; the next write keeps the first", () => {
    const first = writeEvaluationRecord(record(), { home });
    expect(first).toEqual({ file: "lib-kafka--0000000001.json", seq: 1 });
    for (const d of [join(home, "skill-evaluations"), join(home, "skill-evaluations", "lib"), dir()]) expect(mode(d)).toBe(0o700);
    expect(mode(join(dir(), first.file))).toBe(0o600);
    const text = readFileSync(join(dir(), first.file), "utf8");
    expect(JSON.parse(text)).toEqual(record());
    expect(writeEvaluationRecord(record({ selection: 0.5 }), { home }).file).toBe("lib-kafka--0000000002.json");
    expect(readFileSync(join(dir(), first.file), "utf8")).toBe(text);
    expect(tmps()).toEqual([]);
  });

  it("the sequence, not the time, sets the newest: equal times, and numeric order", () => {
    writeEvaluationRecord(record({ selection: 1 }), { home });
    writeEvaluationRecord(record({ selection: 0.5 }), { home });
    const r = readNewestRecord("lib", COMMIT, "lib-kafka", { home });
    expect(r.state === "ok" && (r.raw as EvaluationRecord).dimensions.selection).toEqual([0.5]);
    // 9 published first, 10 later: 10 wins (zero-padded names sort in numeric order)
    const d = dir();
    writeFileSync(join(d, recordFileName("lib-kafka", 9)), JSON.stringify(record({ selection: 1 })), { mode: 0o600 });
    writeFileSync(join(d, recordFileName("lib-kafka", 10)), JSON.stringify(record({ selection: 0.25 })), { mode: 0o600 });
    const n = readNewestRecord("lib", COMMIT, "lib-kafka", { home });
    expect(n.state === "ok" && n.file).toContain("0000000010");
  });

  it("takes the next number when another writer got the number first", () => {
    writeEvaluationRecord(record(), { home });
    let first = true;
    evaluationStoreSettings.link = (from, to) => {
      if (first) {
        first = false;
        writeFileSync(to, "{}", { mode: 0o600 }); // a concurrent writer took number 2
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      linkSync(from, to);
    };
    expect(writeEvaluationRecord(record({ selection: 0.5 }), { home }).seq).toBe(3);
    expect(tmps()).toEqual([]);
  });

  it("gives up after linkTries, and leaves no tmp file", () => {
    let n = 0;
    evaluationStoreSettings.link = () => {
      n++;
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    expect(() => writeEvaluationRecord(record(), { home })).toThrow(/busy/);
    expect(n).toBe(EVALUATION_STORE_LIMITS.linkTries);
    expect(readdirSync(dir())).toEqual([]);
  });

  it("refuses a link, a wrong mode, another realpath and a failing link, with nothing left behind", () => {
    mkdirSync(join(home, "real"), { mode: 0o700 });
    symlinkSync(join(home, "real"), join(home, "skill-evaluations"));
    expect(() => writeEvaluationRecord(record(), { home })).toThrow(EvaluationStoreError);
    expect(readdirSync(join(home, "real"))).toEqual([]);
    rmSync(join(home, "skill-evaluations"));

    mkdirSync(join(home, "skill-evaluations"), { mode: 0o755 });
    chmodSync(join(home, "skill-evaluations"), 0o755);
    expect(() => writeEvaluationRecord(record(), { home })).toThrow(/mode 0700; nothing was changed/);
    expect(readdirSync(join(home, "skill-evaluations"))).toEqual([]);
    chmodSync(join(home, "skill-evaluations"), 0o700);

    evaluationStoreSettings.realpath = () => "/somewhere/else";
    expect(() => writeEvaluationRecord(record(), { home })).toThrow(/not inside the data folder/);
    evaluationStoreSettings.realpath = realRealpath;

    evaluationStoreSettings.link = () => {
      throw Object.assign(new Error("boom"), { code: "EIO" });
    };
    expect(() => writeEvaluationRecord(record(), { home })).toThrow("the evaluation folder cannot be written (EIO)");
    expect(readdirSync(dir())).toEqual([]);
  });

  it("refuses a name that would make an unsafe path before any folder is made", () => {
    const bad = (c: Partial<EvaluationRecord["candidate"]>): EvaluationRecord => ({ ...record(), candidate: { ...record().candidate, ...c } });
    expect(() => writeEvaluationRecord(bad({ source: "../x" }), { home })).toThrow(EvaluationStoreError);
    expect(() => writeEvaluationRecord(bad({ commit: "main" }), { home })).toThrow(EvaluationStoreError);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("readNewestRecord", () => {
  it("none for a missing folder or data folder; nothing is created", () => {
    expect(readNewestRecord("lib", COMMIT, "lib-kafka", { home })).toEqual({ state: "none" });
    expect(readNewestRecord("lib", COMMIT, "lib-kafka", { home: join(home, "missing") })).toEqual({ state: "none" });
    expect(readdirSync(home)).toEqual([]);
  });

  it("is invalid for a wrong folder mode, a link folder, a wrong file mode, a link, a large file, bad JSON or another commit", () => {
    const { file } = writeEvaluationRecord(record(), { home });
    const path = join(dir(), file);
    const read = () => readNewestRecord("lib", COMMIT, "lib-kafka", { home });
    expect(read().state).toBe("ok");

    chmodSync(path, 0o644);
    expect(read()).toMatchObject({ state: "invalid", problem: expect.stringContaining("wrong mode") });
    chmodSync(path, 0o600);

    writeFileSync(path, "x".repeat(EVALUATION_STORE_LIMITS.recordBytes + 1), { mode: 0o600 });
    expect(read()).toMatchObject({ state: "invalid", problem: expect.stringContaining("too large") });
    writeFileSync(path, "not json", { mode: 0o600 });
    expect(read()).toMatchObject({ state: "invalid", problem: expect.stringContaining("not valid JSON") });
    writeFileSync(path, JSON.stringify(record({ commit: OTHER })), { mode: 0o600 });
    expect(read()).toMatchObject({ state: "invalid", problem: expect.stringContaining("another skill, source or commit") });

    rmSync(path);
    symlinkSync(join(dir(), "elsewhere"), path);
    expect(read()).toMatchObject({ state: "invalid", problem: expect.stringContaining("is a link") });
    rmSync(path);
    writeFileSync(path, JSON.stringify(record()), { mode: 0o600 });
    expect(read().state).toBe("ok");

    chmodSync(dir(), 0o755);
    expect(read()).toMatchObject({ state: "invalid", problem: expect.stringContaining("0700") });
    chmodSync(dir(), 0o700);
    chmodSync(join(home, "skill-evaluations", "lib"), 0o755);
    expect(read().state).toBe("invalid");
  });

  it("a link in place of the commit folder is invalid", () => {
    mkdirSync(join(home, "skill-evaluations", "lib"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(home, "elsewhere"), dir());
    expect(readNewestRecord("lib", COMMIT, "lib-kafka", { home }).state).toBe("invalid");
  });

  it("an unreadable newest record is reported, not skipped for an older one", () => {
    writeEvaluationRecord(record(), { home });
    const second = writeEvaluationRecord(record({ selection: 0.5 }), { home });
    chmodSync(join(dir(), second.file), 0o644);
    expect(readNewestRecord("lib", COMMIT, "lib-kafka", { home }).state).toBe("invalid");
  });
});

describe("findNewestRecordOf", () => {
  it("finds a record in another source or commit folder by id and digest, and ignores another digest", () => {
    writeEvaluationRecord(record({ id: "admin-kafka", digest: D1, source: "adm", commit: OTHER }), { home });
    writeEvaluationRecord(record({ id: "admin-kafka", digest: D2, source: "adm", commit: OTHER }), { home });
    const r = findNewestRecordOf("admin-kafka", D1, { home });
    expect(r.state === "ok" && (r.raw as EvaluationRecord).candidate.digest).toBe(D1);
    expect(findNewestRecordOf("admin-kafka", "sha256:" + "9".repeat(64), { home })).toEqual({ state: "none" });
    expect(findNewestRecordOf("nobody", D1, { home })).toEqual({ state: "none" });
  });

  it("within one folder the higher sequence wins at the same time", () => {
    writeEvaluationRecord(record({ id: "admin-kafka", source: "adm", commit: OTHER, selection: 1 }), { home });
    writeEvaluationRecord(record({ id: "admin-kafka", source: "adm", commit: OTHER, selection: 0.5 }), { home });
    const r = findNewestRecordOf("admin-kafka", D1, { home });
    expect(r.state === "ok" && (r.raw as EvaluationRecord).dimensions.selection).toEqual([0.5]);
  });

  it("different folders at the same time are ambiguous; a later time wins", () => {
    writeEvaluationRecord(record({ id: "admin-kafka", source: "adm", commit: OTHER }), { home });
    writeEvaluationRecord(record({ id: "admin-kafka", source: "lib", commit: COMMIT }), { home });
    expect(findNewestRecordOf("admin-kafka", D1, { home })).toMatchObject({ state: "invalid", problem: expect.stringContaining("ambiguous") });
    writeEvaluationRecord(record({ id: "admin-kafka", source: "lib", commit: COMMIT, at: "2026-10-14T10:00:00Z" }), { home });
    const r = findNewestRecordOf("admin-kafka", D1, { home });
    expect(r.state === "ok" && r.file).toContain("lib/aaaaaaaaaaaa");
  });

  it("a corrupt older record does not matter once a newer valid one exists, but a corrupt newest one does", () => {
    const first = writeEvaluationRecord(record({ id: "admin-kafka", source: "adm", commit: OTHER }), { home });
    const second = writeEvaluationRecord(record({ id: "admin-kafka", source: "adm", commit: OTHER, selection: 0.5 }), { home });
    chmodSync(join(dir(OTHER, "adm"), first.file), 0o644);
    const r = findNewestRecordOf("admin-kafka", D1, { home });
    expect(r.state === "ok" && (r.raw as EvaluationRecord).dimensions.selection).toEqual([0.5]);
    chmodSync(join(dir(OTHER, "adm"), second.file), 0o644);
    expect(findNewestRecordOf("admin-kafka", D1, { home }).state).toBe("invalid");
  });

  it("after a clock rollback the highest sequence of each folder is compared, not every record", () => {
    writeEvaluationRecord(record({ id: "admin-kafka", source: "lib", commit: COMMIT, at: "2026-10-13T10:00:20Z", selection: 0.9 }), { home });
    writeEvaluationRecord(record({ id: "admin-kafka", source: "adm", commit: OTHER, at: "2026-10-13T10:00:30Z", selection: 0.8 }), { home });
    writeEvaluationRecord(record({ id: "admin-kafka", source: "adm", commit: OTHER, at: "2026-10-13T10:00:10Z", selection: 0.7 }), { home });
    const r = findNewestRecordOf("admin-kafka", D1, { home });
    expect(r.state === "ok" && (r.raw as EvaluationRecord).dimensions.selection).toEqual([0.9]);
  });

  it("an unreadable file of the same id makes it invalid", () => {
    const w = writeEvaluationRecord(record({ id: "admin-kafka", source: "adm", commit: OTHER }), { home });
    chmodSync(join(dir(OTHER, "adm"), w.file), 0o644);
    expect(findNewestRecordOf("admin-kafka", D1, { home }).state).toBe("invalid");
  });
});
