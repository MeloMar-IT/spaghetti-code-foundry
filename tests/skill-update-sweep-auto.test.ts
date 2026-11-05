import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MONITOR_ACTOR } from "../src/auth/audit.js";
import { ConfigSchema } from "../src/config.js";
import { skillUpdateSweeper } from "../src/server/skill-update-sweep.js";

// The default runner of the sweeper: it runs `--due` with the monitor as the audit actor and the live skill settings, so an
// `update.auto` source is released and approved with the right actor and the current approval keys (#799).

const calls: { opts: Record<string, unknown> }[] = [];
vi.mock("../src/skill-import/update-due.js", () => ({
  updateDue: vi.fn(async (_o: unknown, out: (l: string) => void, opts: Record<string, unknown>) => {
    calls.push({ opts });
    out("CHECKED 0 sources: 0 UNCHANGED, 0 OPEN, 0 UPDATED, 0 OK, 0 PROBLEM");
    return 0;
  }),
}));

let dir: string;
let repo: string;
beforeEach(() => {
  calls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "sweep-auto-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", repo]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the default runner", () => {
  it("passes the monitor as the audit actor and the live skill settings", async () => {
    let skills = ConfigSchema.parse({}).skills;
    const first = skills;
    const sweeper = skillUpdateSweeper({
      config: () => ({ folder: repo, everyMs: 1 }),
      log: () => {},
      findingsIdle: (fn) => Promise.resolve(fn()),
      file: join(dir, "findings.json"),
      skills: () => skills,
      userHome: join(dir, "home"),
    });
    await sweeper.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toMatchObject({ cwd: repo, auditBy: MONITOR_ACTOR, skills: first });
    skills = ConfigSchema.parse({ skills: { builtin: false } }).skills;
    await new Promise((r) => setTimeout(r, 5));
    await sweeper.tick();
    expect(calls).toHaveLength(2);
    expect((calls[1]!.opts.skills as { builtin: boolean }).builtin).toBe(false);
    sweeper.stop();
  });

  it("works without live settings", async () => {
    const sweeper = skillUpdateSweeper({ config: () => ({ folder: repo, everyMs: 1 }), log: () => {}, findingsIdle: (fn) => Promise.resolve(fn()), file: join(dir, "findings.json"), userHome: join(dir, "home") });
    await sweeper.tick();
    expect(calls[0]!.opts).toMatchObject({ auditBy: MONITOR_ACTOR });
    expect(calls[0]!.opts.skills).toBeUndefined();
    sweeper.stop();
  });
});
