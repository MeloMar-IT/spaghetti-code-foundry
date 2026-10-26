import * as realFs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readIssueFiles } from "../src/context/issue-files.js";

// The strict read, with the file calls replaced: partial reads, an early end, a file that grew, and failures.
const fs = vi.hoisted(() => ({
  openSync: vi.fn(),
  fstatSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
}));
vi.mock("node:fs", async (orig) => ({ ...(await orig<typeof import("node:fs")>()), ...fs }));

const ISSUE = Buffer.from(JSON.stringify({ number: 12, title: "T", body: "B", updatedAt: "v1" }));
const COMMENTS = Buffer.from(JSON.stringify({ id: 1, body: "c", updated_at: "v1" }) + "\n");
const FILES: Record<number, Buffer> = { 10: ISSUE, 11: COMMENTS };
const paths: string[] = [];

type ReadFn = (fd: number, buf: Buffer, off: number, len: number, pos: number) => number;
let chunk = Infinity;
let override: ReadFn | undefined;

beforeEach(() => {
  paths.length = 0;
  chunk = Infinity;
  override = undefined;
  for (const m of Object.values(fs)) m.mockReset();
  fs.openSync.mockImplementation((p: string) => {
    paths.push(p);
    return p.endsWith("issue.json") ? 10 : 11;
  });
  fs.fstatSync.mockImplementation((fd: number) => ({ isFile: () => true, size: FILES[fd]!.length }));
  fs.readSync.mockImplementation((fd: number, buf: Buffer, off: number, len: number, pos: number) => {
    if (override) return override(fd, buf, off, len, pos);
    const n = Math.min(len, chunk, Math.max(0, FILES[fd]!.length - pos));
    FILES[fd]!.copy(buf, off, pos, pos + n);
    return n;
  });
});

const run = () => readIssueFiles("/run", 12, "2026-01-31T12:00:00.000Z");
const closed = () => fs.closeSync.mock.calls.map((c) => c[0]);

describe("readStrict through readIssueFiles", () => {
  it("opens without following links or blocking, and succeeds with partial reads", () => {
    chunk = 3;
    expect(run()).toMatchObject({ ok: { leftComments: 0 } });
    const flags = fs.openSync.mock.calls[0]![1] as number;
    expect(flags & realFs.constants.O_NOFOLLOW).toBe(realFs.constants.O_NOFOLLOW);
    expect(flags & realFs.constants.O_NONBLOCK).toBe(realFs.constants.O_NONBLOCK);
    expect(closed()).toEqual([10, 11]);
  });

  it("fails on an early end of the issue file, closes it, and never opens the comments", () => {
    override = (_fd, _b, _o, _l, pos) => (pos > 0 ? 0 : 2);
    expect(run()).toEqual({ failed: "issue-unreadable" });
    expect(paths).toHaveLength(1);
    expect(closed()).toEqual([10]);
  });

  it("fails when the file grew after fstat (the extra read is not 0)", () => {
    override = (fd, buf, off, len, pos) => {
      if (pos >= FILES[fd]!.length) return 1;
      const n = Math.min(len, FILES[fd]!.length - pos);
      FILES[fd]!.copy(buf, off, pos, pos + n);
      return n;
    };
    expect(run()).toEqual({ failed: "issue-unreadable" });
    expect(paths).toHaveLength(1);
    expect(closed()).toEqual([10]);
  });

  it("fails when a read throws, and closes", () => {
    override = () => {
      throw new Error("EIO");
    };
    expect(run()).toEqual({ failed: "issue-unreadable" });
    expect(closed()).toEqual([10]);
  });

  it("fails when fstat throws or the file is not regular, and closes", () => {
    fs.fstatSync.mockImplementationOnce(() => {
      throw new Error("EBADF");
    });
    expect(run()).toEqual({ failed: "issue-unreadable" });
    expect(closed()).toEqual([10]);
    fs.closeSync.mockClear();
    fs.fstatSync.mockImplementationOnce(() => ({ isFile: () => false, size: 1 }));
    expect(run()).toEqual({ failed: "issue-unreadable" });
    expect(closed()).toEqual([10]);
  });

  it("fails when open throws, without closing", () => {
    fs.openSync.mockImplementationOnce(() => {
      throw new Error("ELOOP");
    });
    expect(run()).toEqual({ failed: "issue-unreadable" });
    expect(fs.closeSync).not.toHaveBeenCalled();
  });

  it("fails when close throws after a good read", () => {
    fs.closeSync.mockImplementationOnce(() => {
      throw new Error("EIO");
    });
    expect(run()).toEqual({ failed: "issue-unreadable" });
    expect(paths).toHaveLength(1);
  });

  it("closes the comments file when its read fails", () => {
    override = (fd, buf, off, len, pos) => {
      if (fd === 11) return 0;
      const n = Math.min(len, FILES[fd]!.length - pos);
      FILES[fd]!.copy(buf, off, pos, pos + n);
      return n;
    };
    expect(run()).toEqual({ failed: "comments-unreadable" });
    expect(closed()).toEqual([10, 11]);
  });
});
