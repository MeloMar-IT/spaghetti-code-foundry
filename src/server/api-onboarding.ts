import { isDeepStrictEqual } from "node:util";
import { auditActions } from "../auth/audit.js";
import { changeDetail, configChanges } from "../auth/audit-changes.js";
import { StoreError } from "../auth/store.js";
import { configVersion, parseConfigText, STALE_CONFIG, type Config } from "../config.js";
import { parseTool, startSignIn, testCall, type OnboardingTool } from "../onboarding.js";
import { agentsView, currentValues, parseAgentsRequest, type AgentSettingKey, type AgentsView } from "../onboarding/agents.js";
import { AgentsConfigError, ConfigReadError, ConfigWriteError, readAgentAnswers, readConfigSafely, readLimitsStatus, saveAgentAnswers, StaleConfigError, type AgentsIo } from "../onboarding/agents-store.js";
import { storedConfigProblem } from "./config-view.js";
import { HttpError, readJson, send } from "./http.js";
import type { Route } from "./server.js";

function toolOf(body: Record<string, unknown>): OnboardingTool {
  try {
    return parseTool(body.tool);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

export interface AgentsDeps {
  /** The config the server runs on now. */
  runtime: () => Config;
  reload: () => void;
  audit: (details: string[]) => void;
  io?: AgentsIo;
}

/** A store or config file problem as an HTTP error: 500, with the kind and never a value from a file. */
function serverProblem(e: unknown, what: string): HttpError | undefined {
  if (e instanceof StoreError) return new HttpError(500, `the onboarding answers could not be ${what} (${e.kind}); try again`);
  if (e instanceof ConfigReadError) return new HttpError(500, e.message);
  return undefined;
}

/** `GET /api/onboarding/agents`: the stored answers, the settings they give, what is in effect, and what an admin set by hand. */
export function getAgents(readConfig: () => string = readConfigSafely): { version: string; reply: AgentsView } {
  let text: string;
  try {
    text = readConfig();
  } catch (e) {
    throw serverProblem(e, "read") ?? e;
  }
  let config: Config;
  try {
    config = parseConfigText(text);
  } catch (e) {
    throw new HttpError(400, `invalid config: ${storedConfigProblem(e)}`);
  }
  try {
    return { version: configVersion(text), reply: agentsView(readAgentAnswers(), config, configVersion(text), readLimitsStatus()) };
  } catch (e) {
    throw serverProblem(e, "read") ?? e;
  }
}

const WARNING = { store: "a cleanup step failed and is finished the next time", unlock: "the lock could not be released cleanly", audit: "the audit entry could not be written" };

/** `PUT /api/onboarding/agents`: save the answers and write the settings they give. Testable without a server. */
export function putAgents(body: unknown, sentVersion: string | undefined, deps: AgentsDeps, now = new Date()): { version: string; reply: AgentsView & { changed: AgentSettingKey[]; warning?: string } } {
  let req: ReturnType<typeof parseAgentsRequest>;
  try {
    req = parseAgentsRequest(body);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  let r: ReturnType<typeof saveAgentAnswers>;
  try {
    r = saveAgentAnswers({ ...req, sentVersion, now, io: deps.io });
  } catch (e) {
    if (e instanceof StaleConfigError) throw new HttpError(409, STALE_CONFIG);
    if (e instanceof AgentsConfigError) throw new HttpError(400, `invalid config: ${e.message}`);
    if (e instanceof ConfigWriteError) throw new HttpError(500, "config.yaml could not be written; try again");
    throw serverProblem(e, "saved") ?? e;
  }
  const warnings: (keyof typeof WARNING)[] = [...r.warnings];
  if (r.configWritten) {
    try {
      deps.audit(configChanges(r.before, r.config).map((c) => changeDetail(c)));
    } catch {
      warnings.push("audit");
    }
  }
  if (r.configWritten || !isDeepStrictEqual(currentValues(deps.runtime()), currentValues(r.config))) deps.reload();
  const view = agentsView(r.stored, r.config, configVersion(r.text), readLimitsStatus());
  return {
    version: configVersion(r.text),
    reply: { ...view, changed: r.changed, ...(warnings.length ? { warning: `saved; ${warnings.map((w) => WARNING[w]).join("; ")}` } : {}) },
  };
}

/** `/api/onboarding/…`: sign in to Claude Code or Codex and check it (POST sign-in, test-call); the answers about both tools (GET and PUT agents). */
export const onboardingRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "onboarding" || seg.length !== 2) return false;
  if (seg[1] === "agents") {
    if (method === "GET") {
      const out = getAgents();
      res.setHeader("x-config-version", out.version);
      return send(res, 200, out.reply), true;
    }
    if (method !== "PUT") throw new HttpError(405, "method not allowed");
    const sent = req.headers["x-config-version"];
    const out = putAgents(await readJson(req), typeof sent === "string" ? sent : undefined, {
      runtime: ctx.fileConfig,
      reload: ctx.reloadConfig,
      audit: (d) => auditActions(ctx.diagLog, user.id, "settings-change", "config.yaml", d),
    });
    res.setHeader("x-config-version", out.version);
    return send(res, 200, out.reply), true;
  }
  if (method !== "POST" || (seg[1] !== "sign-in" && seg[1] !== "test-call")) return false;
  const tool = toolOf(await readJson(req));
  const o = { claudeBin: ctx.opts.claudeBin };
  return send(res, 200, seg[1] === "sign-in" ? await startSignIn(tool, o) : await testCall(tool, o)), true;
};
