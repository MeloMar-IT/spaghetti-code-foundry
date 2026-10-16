import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { addQuestion, getConversation } from "../src/help/store.js";
import { readStats, statsPath } from "../src/help/telemetry.js";
import { helpSweeper, rolloutStage } from "../src/server/api-help.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const help = (over: Record<string, unknown>) => ConfigSchema.parse({ default_model: "sonnet", help: over }).help;

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "help-rollout-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("the rollout stage", () => {
  it("is read from the settings: off, paused, administrators, pilot or everyone", () => {
    expect(rolloutStage(help({}))).toBe("off");
    expect(rolloutStage(help({ paused: true }))).toBe("off");
    expect(rolloutStage(help({ enabled: true }))).toBe("everyone");
    expect(rolloutStage(help({ enabled: true, audience: "everyone" }))).toBe("everyone");
    expect(rolloutStage(help({ enabled: true, audience: "admins" }))).toBe("admins");
    expect(rolloutStage(help({ enabled: true, audience: "pilot" }))).toBe("pilot");
    for (const audience of ["admins", "pilot", "everyone"]) expect(rolloutStage(help({ enabled: true, audience, paused: true }))).toBe("paused");
  });

  it("takes old settings as they were, and refuses a pilot list that is not account ids", () => {
    expect(help({ enabled: true, audience: "admins" })).toMatchObject({ paused: false, audience: "admins" });
    expect(help({ pilot_accounts: [OWNER] }).pilot_accounts).toEqual([OWNER]);
    expect(ConfigSchema.safeParse({ default_model: "sonnet", help: { pilot_accounts: ["ann"] } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ default_model: "sonnet", help: { paused: "yes" } }).success).toBe(false);
  });
});

describe("a restart", () => {
  it("counts a turn it ended as a failed (interrupted) turn, once", () => {
    const turn = addQuestion(OWNER, { question: "Left waiting?" });
    const sweep = helpSweeper(() => {});
    sweep();
    expect(getConversation(OWNER, turn.conversation.id).messages[1]).toMatchObject({ status: "failed", failure: { code: "interrupted" } });
    expect(readStats()[0]!.failed).toEqual({ interrupted: 1 });
    sweep();
    helpSweeper(() => {})();
    expect(readStats()[0]!.failed).toEqual({ interrupted: 1 });
  });

  it("does not end a live turn at the next sweep when the statistics are broken", () => {
    writeFileSync(statsPath(), "not json");
    const logs: string[] = [];
    const sweep = helpSweeper((m) => logs.push(m));
    sweep();
    expect(logs).toEqual(["! help: help-stats.json could not be used"]);
    // a turn that starts after the start of the server is alive
    const live = addQuestion(OWNER, { question: "Live?" });
    sweep();
    sweep();
    expect(getConversation(OWNER, live.conversation.id).messages[1]!.status).toBe("pending");
    expect(logs).toHaveLength(1);
  });
});
