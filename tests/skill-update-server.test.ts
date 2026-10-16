import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH, saveConfig } from "../src/config.js";
import { findingsFile, readFindings } from "../src/monitor/findings.js";
import { startServer } from "../src/server/server.js";

const TICK = 7; // a delay no other timer of the server uses
const MISSING = "skill-sources: PROBLEM the skill source folder does not exist or is not a folder; nothing was checked";

describe("scheduled skill-source checks in the server", () => {
  let tmp: string;
  let lines: string[];
  let handle: unknown;
  let ticks: number;
  let waiters: Array<() => void>;
  let clear: ReturnType<typeof vi.spyOn>;
  let closeServer: (() => void) | undefined;
  let savedNo: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-upd-srv-"));
    lines = [];
    ticks = 0;
    waiters = [];
    handle = undefined;
    savedNo = process.env.FACTORY_NO_NOTIFY;
    process.env.FACTORY_NO_NOTIFY = "1";
    rmSync(CONFIG_PATH(), { force: true });
    rmSync(findingsFile(), { force: true });
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms !== TICK) return (real as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      const h = (real as (...a: unknown[]) => unknown)(
        () => {
          fn();
          ticks++;
          for (const w of waiters.splice(0)) w();
        },
        ms,
      );
      handle = h;
      return h;
    }) as unknown as typeof setInterval);
    clear = vi.spyOn(globalThis, "clearInterval");
  });
  afterEach(() => {
    closeServer?.();
    closeServer = undefined;
    vi.restoreAllMocks();
    if (savedNo === undefined) delete process.env.FACTORY_NO_NOTIFY;
    else process.env.FACTORY_NO_NOTIFY = savedNo;
    rmSync(CONFIG_PATH(), { force: true });
    rmSync(findingsFile(), { force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  const start = async () => {
    const s = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port: 0, watchers: false, skillUpdateTickMs: TICK, log: (l) => lines.push(l) });
    closeServer = s.close;
    return s;
  };
  /** Resolves after the next timer tick has run. */
  const nextTick = () => new Promise<void>((r) => waiters.push(r));
  const until = async (done: () => boolean) => {
    while (!done()) await nextTick();
  };

  it("does nothing without the key, and close() clears the timer", async () => {
    const s = await start();
    await until(() => ticks >= 3);
    expect(lines.filter((l) => l.startsWith("skill-sources: "))).toEqual([]);
    expect(existsSync(findingsFile())).toBe(false);
    expect(handle).toBeDefined();
    s.close();
    closeServer = undefined;
    expect(clear).toHaveBeenCalledWith(handle);
  });

  it("checks the folder of the key, and a reloaded config without it clears the finding", async () => {
    saveConfig({ skills: { update_check: { folder: join(tmp, "missing"), every: "5m" } } });
    const s = await start();
    await until(() => lines.includes(MISSING));
    await until(() => readFindings().findings.length > 0);
    const found = readFindings().findings;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ detector: "skill-source-check", gone: false });

    saveConfig({});
    s.ctx.reloadConfig();
    await until(() => readFindings().findings.every((f) => f.gone));
    expect(readFindings().findings).toHaveLength(1);
  });
});
