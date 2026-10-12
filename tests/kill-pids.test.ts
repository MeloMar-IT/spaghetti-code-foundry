import { describe, expect, it, vi } from "vitest";
import { killPids, pidsIn } from "./helpers/kill-pids.js";

describe("killPids", () => {
  it("ignores blank entries from a trailing newline and never signals 0 or 1", () => {
    const kill = vi.fn();
    killPids("123\n456\n\n", kill);
    killPids("\n0\n1\n-5\nabc\n99999999999999999999\n", kill);
    expect(kill.mock.calls).toEqual([
      [123, "SIGKILL"],
      [456, "SIGKILL"],
    ]);
  });

  it("goes on after a pid that is gone", () => {
    const kill = vi.fn().mockImplementationOnce(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    killPids("10 11", kill);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(pidsIn("")).toEqual([]);
  });
});
