import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionAuditEvent } from "../../src/auth/audit.js";
import { createUser, type User } from "../../src/auth/users.js";
import { ConfigSchema, type Config } from "../../src/config.js";
import { saveRun, type RunSummary } from "../../src/engine/state.js";
import { parseFlow } from "../../src/flow/load.js";
import { ACTIONS, type Reply } from "../../src/help/contract.js";
import { ActionGrants } from "../../src/help/grants.js";
import { addQuestion, finishTurn } from "../../src/help/store.js";
import { Scheduler } from "../../src/queue/scheduler.js";
import { helpAllowed } from "../../src/server/api-help.js";
import type { ActionDeps } from "../../src/server/help-actions.js";
import type { ApiContext } from "../../src/server/server.js";
import { TEST_PASSWORD } from "./session.js";

export const QUICK = parseFlow(`name: quick
workspace: empty
steps:
  - {id: a, type: shell, run: "true"}
`);
export const SLOW = parseFlow(`name: slow
workspace: empty
steps:
  - {id: a, type: shell, run: "sleep 30"}
`);
export const STUBBORN = parseFlow(`name: stubborn
workspace: empty
steps:
  - {id: a, type: shell, run: "trap '' TERM; sleep 3"}
`);
/** Works, then stops the run as "stopped" (it needs a person). */
export const STOPS = parseFlow(`name: stops
workspace: empty
steps:
  - {id: a, type: shell, run: "true", on_success: stop}
`);

export interface Env {
  home: string;
  runsDir: string;
  config: Config;
  setConfig(help?: Record<string, unknown>, top?: Record<string, unknown>): void;
  scheduler: Scheduler;
  ctx: ApiContext;
  admin: User;
  admin2: User;
  ann: User;
  bob: User;
  grants: ActionGrants;
  clock: { t: number };
  audit: { by: string; e: ActionAuditEvent }[];
  logs: string[];
  deps(over?: Partial<ActionDeps>): ActionDeps;
  close(): void;
}

/** The users are made once per data folder (they are slow to make); `makeEnv` gives every test its own runs, scheduler and settings. */
export async function makeUsers(): Promise<Users> {
  const admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  const admin2 = await createUser({ name: "Admin Two", email: "admin2@example.com", password: TEST_PASSWORD, role: "admin" });
  const ann = await createUser({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD, role: "user" });
  const bob = await createUser({ name: "Bob", email: "bob@example.com", password: TEST_PASSWORD, role: "user" });
  return { admin, admin2, ann, bob };
}

export interface Users {
  admin: User;
  admin2: User;
  ann: User;
  bob: User;
}

export function makeEnv(users: Users,help: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "help-actions-"));
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const build = (h: Record<string, unknown>, t: Record<string, unknown>): Config => {
    const { concurrency = 1, ...rest } = t;
    // the schema wants a positive number; 0 (nothing starts, every job waits) is set after it
    return { ...ConfigSchema.parse({ ...rest, help: { enabled: true, actions: true, ...h } }), concurrency: concurrency as number };
  };
  const box = { config: build(help, top) };
  const scheduler = new Scheduler({ runsDir, config: () => box.config, claudeBin: "unused" });
  const logs: string[] = [];
  const ctx = { scheduler, config: () => box.config, watchers: { tracked: () => [] }, diagLog: (m: string) => void logs.push(m), opts: {} } as unknown as ApiContext;
  const clock = { t: Date.parse("2026-03-01T10:00:00.000Z") };
  const grants = new ActionGrants({ now: () => clock.t });
  const audit: Env["audit"] = [];
  const env: Env = {
    home: root,
    runsDir,
    get config() {
      return box.config;
    },
    setConfig(h = {}, t = {}) {
      box.config = build(h, t);
    },
    scheduler,
    ctx,
    ...users,
    grants,
    clock,
    audit,
    logs,
    deps: (over = {}) => ({
      allow: (a) => helpAllowed(ctx, a),
      grants,
      gate: async () => ({ ok: true }),
      audit: (by, e) => void audit.push({ by, e }),
      ...over,
    }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
  return env;
}

/** Plants a run on disk, as after a restart. */
export function plantRun(env: Env, id: string, o: { status: RunSummary["status"]; owner?: string; flowDef?: RunSummary["flowDef"] | null; next?: string | null; extra?: Partial<RunSummary> }): RunSummary {
  const runDir = join(env.runsDir, id);
  mkdirSync(join(runDir, "workspace"), { recursive: true });
  mkdirSync(join(runDir, "logs"), { recursive: true });
  const flowDef = o.flowDef === null ? undefined : (o.flowDef ?? QUICK);
  const s = {
    runId: id,
    flow: "quick",
    ...(flowDef ? { flowDef } : {}),
    task: "t",
    vars: {},
    repo: env.home,
    status: o.status,
    reason: o.status === "stopped" ? "interrupted" : undefined,
    runDir,
    workdir: join(runDir, "workspace"),
    owner: o.owner ?? env.admin.id,
    startedAt: "2026-03-01T09:00:00.000Z",
    ...(o.status === "running" || o.status === "waiting" ? {} : { finishedAt: "2026-03-01T09:30:00.000Z" }),
    totalCostUsd: 0,
    history: [],
    state: { next: o.next === undefined ? "a" : o.next, steps: {}, visits: {} },
    ...o.extra,
  } as unknown as RunSummary;
  saveRun(s);
  return s;
}

export function runFileOf(env: Env, id: string): string {
  return join(env.runsDir, id, "run.json");
}

/** A finished reply that proposes one action about a run. */
export function plantConversation(owner: string, runId: string, action: "resume-run" | "cancel-run" = "cancel-run"): { conversation: string; message: string } {
  const def = ACTIONS.find((a) => a.id === action)!;
  const turn = addQuestion(owner, { question: "What can I do about this run?" });
  const reply: Reply = {
    type: "status",
    summary: "SUMMARY-TEXT-OF-THE-MODEL",
    explanation: "EXPLANATION-TEXT-OF-THE-MODEL",
    certainty: "confirmed",
    evidence: [],
    recommendations: [],
    links: [],
    drafts: [],
    actions: [{ id: def.id, title: def.title, impact: def.effect, source: "state-x", about: { kind: "run", id: runId } }],
  };
  finishTurn(turn.conversation.id, { message: turn.reply.id, tries: 1 }, reply);
  return { conversation: turn.conversation.id, message: turn.reply.id };
}

export const waitFor = async (fn: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

export const writeText = (file: string, text: string) => writeFileSync(file, text);
