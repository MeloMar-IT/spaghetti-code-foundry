import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { deniedReason } from "../src/engine/policy-hooks.js";
import { runFlow, type RunSummary } from "../src/engine/runner.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { parseFlow } from "../src/flow/load.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);

let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let user: { id: string };

beforeEach(async () => {
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
});
afterEach(() => {
  rmSync(join(process.env.FACTORY_HOME!, "policies"), { recursive: true, force: true });
  kc.remove();
  gh.restore();
});

// no policies/org.json: the mandatory policy is unavailable
const cfg = (): Config => ConfigSchema.parse({ protected_branches: [], policy: { mandatory: ["org"] } });
const flowOf = (steps: string) => parseFlow(`name: iso\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${steps}`, "iso.yaml");
const sh = (id: string, run: string, extra = "") => `  - id: ${id}\n    type: shell\n${extra}    run: ${JSON.stringify(run)}\n`;
const agent = (id: string, prompt: string, extra = "") => `  - id: ${id}\n    type: claude\n${extra}    prompt: ${JSON.stringify(prompt)}\n`;
const go = (flow: ReturnType<typeof flowOf>) =>
  runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin, codexBin, vars: { github_repo: "acme/app" }, config: cfg(), owner: user.id });
const noneRepo = () => addRepo(user.id, { url: "acme/app", method: "none" });
const tokenRepo = () => addRepo(user.id, { url: "acme/app", method: "github-token", token: TOKEN });
const events = (s: Pick<RunSummary, "runDir">): EvidenceEvent[] => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
type Decided = Extract<EvidenceEvent, { type: "policy.decided" }>;
const org = (s: Pick<RunSummary, "runDir">, boundary: string) => events(s).filter((e): e is Decided => e.type === "policy.decided" && e.decision.policy.id === "org" && e.decision.boundary === boundary);
const denied = (s: Pick<RunSummary, "runDir">) => events(s).filter((e) => e.type === "step.denied");

describe("fail closed in isolated runs", { timeout: 60_000 }, () => {
  it("lets an isolated read-only agent step run", async () => {
    noneRepo();
    const s = await go(flowOf(agent("a", "SAY hi", "    permission_mode: plan\n")));
    expect(s.status).toBe("succeeded");
    const access = org(s, "repository.access").filter((e) => e.step?.id === "a");
    expect(access).toHaveLength(1);
    expect(access[0]!.decision.mode).toBe("observe");
    expect(denied(s)).toHaveLength(0);
  });

  it("lets an isolated shell step without repo_access run", async () => {
    noneRepo();
    const s = await go(flowOf(sh("a", "echo ok")));
    expect(s.status).toBe("succeeded");
    expect(denied(s)).toHaveLength(0);
  });

  it("denies an isolated writing agent at agent.write", async () => {
    noneRepo();
    const s = await go(flowOf(agent("a", "WRITE out.txt hi")));
    expect(s.status).toBe("failed");
    expect(s.history[0]).toMatchObject({ id: "a", accessFailed: true, error: deniedReason("org", "policy.unavailable", "agent.write") });
    expect(org(s, "agent.write")[0]!.decision.mode).toBe("enforce");
    expect(denied(s)).toHaveLength(1);
  });

  it("denies a shell step with a stored token", async () => {
    tokenRepo();
    const s = await go(flowOf(sh("a", "echo ok", "    repo_access: true\n")));
    expect(s.status).toBe("failed");
    const reason = deniedReason("org", "policy.unavailable", "repository.access");
    expect(s.history[0]).toMatchObject({ id: "a", accessFailed: true, error: reason });
    const d = org(s, "repository.access").find((e) => e.step?.id === "a")!;
    expect(d.decision.mode).toBe("enforce");
    expect(JSON.stringify(s.history)).not.toContain(TOKEN);
    expect(denied(s)).toHaveLength(1);
  });
});
