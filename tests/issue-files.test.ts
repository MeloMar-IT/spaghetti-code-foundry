import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ISSUE_COMMENTS_FILE, ISSUE_FILE, ISSUE_FILE_MAX_BYTES, ISSUE_FOUNDRY_COMMENTS_FILE, readIssueFiles } from "../src/context/issue-files.js";
import { selectContext } from "../src/context/select.js";
import { BUDGET, NOW, TASK, input, memorySnapshot } from "./helpers/context-fixture.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, ISSUE_FILE), 0o644);
    } catch {
      /* not there */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), "issue-files-"));
  dirs.push(d);
  return d;
};
const task = TASK.issue!;
const issueJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ number: 12, title: "Rounding", body: task.text, updatedAt: task.version, url: "x", ...over });
const line = (o: Record<string, unknown>): string => JSON.stringify({ user: { login: "a" }, ...o });
const commentLine = (c: { id: number; text: string; version: string }): string => line({ id: c.id, body: c.text, updated_at: c.version });
const valid = task.comments!.map(commentLine);
const write = (d: string, issue: string | null = issueJson(), lines: string[] | null = valid): void => {
  if (issue !== null) writeFileSync(join(d, ISSUE_FILE), issue);
  if (lines !== null) writeFileSync(join(d, ISSUE_COMMENTS_FILE), lines.map((l) => `${l}\n`).join(""));
};
const read = (d: string, max?: number) => readIssueFiles(d, 12, NOW, max);
const okOf = (d: string, max?: number) => {
  const r = read(d, max);
  if (!("ok" in r)) throw new Error(`failed: ${r.failed}`);
  return r.ok;
};
const ids = (d: string): number[] => okOf(d).issue.comments!.map((c) => c.id);

describe("readIssueFiles: valid files", () => {
  it("keeps the file order and passes selectContext", () => {
    const d = fresh();
    write(d);
    const { issue, leftComments } = okOf(d);
    expect(leftComments).toBe(0);
    expect(issue.text).toBe(`Rounding\n\n${task.text}`);
    expect(issue.version).toBe(task.version);
    expect(issue.retrievedAt).toBe(NOW);
    expect(issue.comments).toEqual(task.comments!.map((c) => ({ id: c.id, text: c.text, version: c.version, retrievedAt: NOW })));
    expect(issue.comments!.map((c) => c.id)).toEqual([34, 20]);
    const sel = selectContext(input({ snapshot: memorySnapshot(), now: NOW, budget: BUDGET, task: { issue } }));
    const uris = JSON.stringify(sel);
    for (const u of ["issue:12", "issue:12/comment/20", "issue:12/comment/34"]) expect(uris).toContain(u);
  });

  it("marks the ids of the Foundry comment list, ignores unknown ids, and the result passes selectContext", () => {
    const d = fresh();
    write(d);
    writeFileSync(join(d, ISSUE_FOUNDRY_COMMENTS_FILE), "[34, 999]");
    const { issue } = okOf(d);
    expect(issue.comments!.filter((c) => "foundry" in c).map((c) => c.id)).toEqual([34]);
    const sel = selectContext(input({ snapshot: memorySnapshot(), now: NOW, budget: BUDGET, task: { issue } }));
    expect(sel.bundle.sources.filter((s) => "foundry" in s).map((s) => s.uri)).toEqual(["issue:12/comment/34"]);
  });

  it("marks nothing, and still reads, when the Foundry list is missing, invalid or not a file", () => {
    const d = fresh();
    write(d);
    const list = join(d, ISSUE_FOUNDRY_COMMENTS_FILE);
    const marked = () => okOf(d).issue.comments!.filter((c) => "foundry" in c).map((c) => c.id);
    expect(marked()).toEqual([]);
    for (const bad of ["{}", "[1.5]", "[0]", '["34"]', "[34, 0]", "not json", "", "[34,"]) {
      writeFileSync(list, bad);
      expect(marked(), bad).toEqual([]);
    }
    rmSync(list);
    mkdirSync(list);
    expect(marked()).toEqual([]);
    rmSync(list, { recursive: true });
    writeFileSync(join(d, "real.json"), "[34]");
    symlinkSync(join(d, "real.json"), list);
    expect(marked()).toEqual([]);
  });

  it("reads a null body as empty text", () => {
    const d = fresh();
    write(d, issueJson({ body: null }), [line({ id: 1, body: null, updated_at: "v1" }), line({ id: 2, updated_at: "v1" })]);
    const { issue } = okOf(d);
    expect(issue.text).toBe("Rounding\n\n");
    expect(issue.comments!.map((c) => c.text)).toEqual(["", ""]);
  });

  it("uses updated_at of an edited comment as its version", () => {
    const d = fresh();
    write(d, issueJson(), [line({ id: 5, body: "x", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" })]);
    expect(okOf(d).issue.comments![0]!.version).toBe("2026-01-02T00:00:00Z");
  });

  it("accepts a file of exactly maxBytes and rejects one byte more", () => {
    const d = fresh();
    write(d, null, []);
    const text = issueJson();
    write(d, text, []);
    expect(okOf(d, Buffer.byteLength(text)).leftComments).toBe(0);
    expect(read(d, Buffer.byteLength(text) - 1)).toEqual({ failed: "issue-unreadable" });
  });
});

describe("readIssueFiles: comments", () => {
  it("skips and counts bad lines", () => {
    const d = fresh();
    write(d, issueJson(), [
      line({ id: 34, body: "first", updated_at: "v1" }),
      line({ id: 0, body: "x", updated_at: "v1" }),
      line({ id: "34", body: "x", updated_at: "v1" }),
      line({ id: 1.5, body: "x", updated_at: "v1" }),
      line({ id: 7, body: "x", updated_at: "bad value!" }),
      line({ id: 34, body: "dup", updated_at: "v2" }),
      line({ id: 8, body: 5, updated_at: "v1" }),
      line({ id: 20, body: "ok", updated_at: "v1" }),
    ]);
    const r = okOf(d);
    expect(r.leftComments).toBe(6);
    expect(r.issue.comments!.map((c) => [c.id, c.text])).toEqual([
      [34, "first"],
      [20, "ok"],
    ]);
  });

  it("keeps a later comment whose id was only skipped before for another reason", () => {
    const d = fresh();
    write(d, issueJson(), [line({ id: 3, body: 1, updated_at: "v1" }), line({ id: 3, body: "ok", updated_at: "v1" })]);
    const r = okOf(d);
    expect(r.leftComments).toBe(1);
    expect(ids(d)).toEqual([3]);
  });

  it("skips the 10,001st comment", () => {
    const d = fresh();
    write(
      d,
      issueJson(),
      Array.from({ length: 10_001 }, (_, i) => line({ id: i + 1, body: "x", updated_at: "v1" })),
    );
    const r = okOf(d);
    expect(r.issue.comments).toHaveLength(10_000);
    expect(r.issue.comments!.at(-1)!.id).toBe(10_000);
    expect(r.leftComments).toBe(1);
  });

  it("treats an empty file as no comments, and ignores blank lines", () => {
    const d = fresh();
    write(d, issueJson(), null);
    writeFileSync(join(d, ISSUE_COMMENTS_FILE), "");
    expect(okOf(d)).toEqual({ issue: expect.objectContaining({ comments: [] }), leftComments: 0 });
    writeFileSync(join(d, ISSUE_COMMENTS_FILE), `\n${valid[0]}\n  \n\n`);
    expect(okOf(d).leftComments).toBe(0);
    expect(ids(d)).toEqual([34]);
  });

  it.each(["[1]", '"x"', "null", "not json", "5"])("fails on a line that is not an object: %s", (bad) => {
    const d = fresh();
    write(d, issueJson(), [valid[0]!, bad]);
    expect(read(d)).toEqual({ failed: "comments-unreadable" });
  });

  it("fails when the comments file is missing, a link, too big or a folder", () => {
    const missing = fresh();
    write(missing, issueJson(), null);
    expect(read(missing)).toEqual({ failed: "comments-unreadable" });

    const link = fresh();
    write(link, issueJson(), null);
    writeFileSync(join(link, "real.jsonl"), valid.join("\n"));
    symlinkSync(join(link, "real.jsonl"), join(link, ISSUE_COMMENTS_FILE));
    expect(read(link)).toEqual({ failed: "comments-unreadable" });

    const big = fresh();
    const text = issueJson();
    write(big, text, valid);
    expect(read(big, Buffer.byteLength(text))).toEqual({ failed: "comments-unreadable" });

    const dir = fresh();
    write(dir, issueJson(), null);
    mkdirSync(join(dir, ISSUE_COMMENTS_FILE));
    expect(read(dir)).toEqual({ failed: "comments-unreadable" });
  });
});

describe("readIssueFiles: issue.json that fails", () => {
  const bad = { failed: "issue-unreadable" };

  it("is missing (and the comments file is not looked at)", () => {
    const d = fresh();
    write(d, null, ["not json"]);
    expect(read(d)).toEqual(bad);
  });

  it("is not JSON, or not an object", () => {
    const d = fresh();
    write(d, "{nope", valid);
    expect(read(d)).toEqual(bad);
    write(d, "null", valid);
    expect(read(d)).toEqual(bad);
  });

  it("is a link", () => {
    const d = fresh();
    write(d, null);
    writeFileSync(join(d, "real.json"), issueJson());
    symlinkSync(join(d, "real.json"), join(d, ISSUE_FILE));
    expect(read(d)).toEqual(bad);
  });

  it("is over the cap", () => {
    const d = fresh();
    write(d);
    expect(read(d, 10)).toEqual(bad);
    expect(ISSUE_FILE_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it("is a folder", () => {
    const d = fresh();
    write(d, null);
    mkdirSync(join(d, ISSUE_FILE));
    expect(read(d)).toEqual(bad);
  });

  it("is a pipe, and does not wait for it", () => {
    const d = fresh();
    write(d, null);
    try {
      execFileSync("mkfifo", [join(d, ISSUE_FILE)]);
    } catch {
      return;
    }
    expect(read(d)).toEqual(bad);
  });

  it.skipIf(process.getuid?.() === 0)("has mode 000", () => {
    const d = fresh();
    write(d);
    chmodSync(join(d, ISSUE_FILE), 0);
    expect(read(d)).toEqual(bad);
  });

  it("has the wrong number, a bad updatedAt, or no title", () => {
    const d = fresh();
    for (const over of [{ number: 13 }, { updatedAt: "bad value!" }, { title: undefined }, { number: 12.5 }, { body: 5 }]) {
      write(d, issueJson(over));
      expect(read(d)).toEqual(bad);
    }
  });
});
