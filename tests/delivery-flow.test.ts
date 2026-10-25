import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { contractDigest, verifyDeliveryContract } from "../src/delivery/contract.js";
import { publicKeyLine } from "../src/delivery/sshsig.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, type Job } from "../src/queue/scheduler.js";

const PR = 'node "$FACTORY_TOOLS/pr-output" "{{run.dir}}" https://github.com/acme/app/pull/7';
const FLOW = `name: delivery
workspace: inplace
steps:
  - {id: open1, type: shell, run: '${PR}'}
  - {id: change, type: shell, run: 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m two && ${PR}'}
  - {id: gate, type: shell, run: 'i=0; while [ ! -e "$FACTORY_VAR_GATE" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done'}
  - {id: idle, type: shell, run: "echo ok"}
`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("delivery contracts in a run", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes a chain of signed contracts and applies a settings change from the next step", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "delivery-flow-"));
    dirs.push(tmp);
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "feature/x");
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(join(repo, "package-lock.json"), "{}\n");
    writeFileSync(join(repo, ".github/workflows/ci.yml"), "on: push\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");

    const keys = join(process.env.FACTORY_HOME as string, "delivery-keys");
    mkdirSync(keys, { recursive: true });
    const keyPath = join(keys, `flow-${Date.now()}`);
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    dirs.push(keyPath);

    let current = ConfigSchema.parse({ delivery: { signing_key_path: keyPath } });
    const gate = join(tmp, "go");
    const runsDir = join(tmp, "runs");
    const s = new Scheduler({ runsDir, queueFile: join(tmp, "queue.json"), config: () => current });
    const job: Job = { kind: "run", flow: parseFlow(FLOW), task: "t", repo, vars: { github_repo: "acme/app", gate } };
    const runId = s.submit(job, { source: "ui" });
    const runDir = join(runsDir, runId);
    const contract = (n: number) => join(runDir, "delivery", `contract-${n}.json`);

    for (let i = 0; i < 400 && !existsSync(contract(2)); i++) await sleep(50);
    expect(existsSync(contract(2))).toBe(true);
    current = ConfigSchema.parse({ delivery: { signing_key_path: keyPath, required_checks: ["ci"] } });
    writeFileSync(gate, "");
    await s.idle();

    const text = (n: number) => readFileSync(contract(n), "utf8");
    expect(existsSync(contract(3))).toBe(true);
    expect(existsSync(contract(4))).toBe(false);
    expect([1, 2, 3].map((n) => JSON.parse(text(n)).requiredChecks)).toEqual([[], [], ["ci"]]);
    expect(JSON.parse(text(1)).supersedes).toBeUndefined();
    expect(JSON.parse(text(2)).supersedes).toBe(contractDigest(text(1)));
    expect(JSON.parse(text(3)).supersedes).toBe(contractDigest(text(2)));
    const events = readFileSync(join(runDir, "evidence.jsonl"), "utf8");
    for (const n of [1, 2, 3]) {
      const sig = readFileSync(`${contract(n)}.sig`, "utf8");
      expect(verifyDeliveryContract(text(n), sig, publicKeyLine(privateKey), events).ok, `contract ${n}`).toBe(true);
    }
    const log = readFileSync(join(runDir, "live.log"), "utf8");
    expect(log.match(/delivery: contract \d+ written \(signed\)/g)).toHaveLength(3);
  }, 30_000);
});
