import { parseTool, startSignIn, testCall, type OnboardingTool } from "../onboarding.js";
import { HttpError, readJson, send } from "./http.js";
import type { Route } from "./server.js";

function toolOf(body: Record<string, unknown>): OnboardingTool {
  try {
    return parseTool(body.tool);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** `POST /api/onboarding/sign-in|test-call`: start the sign-in of Claude Code or Codex on the server's computer, and check it with one tiny call. */
export const onboardingRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg[0] !== "onboarding" || seg.length !== 2 || method !== "POST") return false;
  if (seg[1] !== "sign-in" && seg[1] !== "test-call") return false;
  const tool = toolOf(await readJson(req));
  const o = { claudeBin: ctx.opts.claudeBin };
  return send(res, 200, seg[1] === "sign-in" ? await startSignIn(tool, o) : await testCall(tool, o)), true;
};
