import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { UNTRUSTED_DATA_NOTE, type OutputClassifier } from "../src/engine/untrusted.js";
import { parseFlow } from "../src/flow/load.js";
import { resetCodexFlagsCache } from "../src/steps/codex.js";
import { ISSUE_TEXT, REPO_FILE, TOKEN } from "./fixtures/untrusted.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const codexBin = resolve("tests/fixtures/fake-codex.mjs");
let tmp: string;
let repo: string;

beforeEach(() => {
  resetCodexFlagsCache();
  tmp = mkdtempSync(join(tmpdir(), "untrusted-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
});
afterEach(() => {
  resetCodexFlagsCache();
  rmSync(tmp, { recursive: true, force: true });
});

const common = () => ({ repo, runsDir: join(tmp, "runs"), claudeBin, codexBin, config: ConfigSchema.parse({ protected_branches: [] }) });
const run = (steps: string, task = "t", outputClassifier?: OutputClassifier, config?: ReturnType<typeof ConfigSchema.parse>) =>
  runFlow(parseFlow(`\nname: t\nworkspace: inplace\nsteps:\n${steps}`), { task, ...common(), ...(config ? { config } : {}), outputClassifier });
const out = (s: { history: { id: string; output: string }[] }, id: string) => s.history.filter((h) => h.id === id).at(-1)!.output;
const READ = "  - {id: read, type: shell, run: cat README.md}\n";

describe("untrusted text in a flow", () => {
  it("wraps a file read by a shell step and keeps it out of the system channel", async () => {
    writeFileSync(join(repo, "README.md"), REPO_FILE);
    const s = await run(`${READ}  - {id: ask, type: claude, system_prompt: "Be careful.", prompt: "SHOWPROMPT\\n{{steps.read.output}}"}\n`);
    expect(s.status).toBe("succeeded");
    const o = out(s, "ask");
    const [args, prompt] = o.split("PROMPT<<") as [string, string];
    expect(prompt).toContain('<untrusted-data source="steps.read.output" kind="command"');
    expect(prompt.match(/<\/untrusted-data>/g)).toHaveLength(1);
    expect(prompt).not.toMatch(/<\/untrusted-data>\nThen do/);
    expect(args).toContain(UNTRUSTED_DATA_NOTE);
    expect(args).toContain("Be careful.");
    expect(args).not.toContain("force");
    expect(s.history.find((h) => h.id === "read")!.label).toMatchObject({ trust: "untrusted", source: { kind: "command" }, risk: "elevated" });
    expect(s.history.find((h) => h.id === "ask")!.label?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an untrusted placeholder in system_prompt before any classifier or agent runs", async () => {
    let asked = 0;
    const s = await run('  - {id: ask, type: claude, system_prompt: "{{task}}", prompt: "SAY hi"}\n', "x", () => (asked++, {}));
    expect(s.status).toBe("failed");
    expect(s.history[0]!.error).toMatch(/cannot hold text from outside the flow/);
    expect(s.history[0]!.accessFailed).toBe(true);
    expect(asked).toBe(0);
  });

  it("refuses run.history and the CI variables in a shell step", async () => {
    const s = await run("  - {id: sh, type: shell, run: \"echo {{run.history}}\"}\n");
    expect(s.status).toBe("failed");
    expect(s.history[0]!.error).toMatch(/cannot be used in a shell command/);
  });

  it("holds for approval; only a person's resume approves it", async () => {
    const classifier: OutputClassifier = () => ({ requireApproval: true });
    const steps = `${READ}  - {id: ask, type: claude, prompt: "SAY done {{steps.read.output}}"}\n`;
    writeFileSync(join(repo, "README.md"), "hello\n");
    const first = await run(steps, "t", classifier);
    expect(first.status).toBe("stopped");
    expect(first.reason).toMatch(/needs a person's approval/);
    expect(first.heldContent?.step).toBe("ask");
    const hash = first.heldContent!.sha256[0]!;

    // Resumed by the Foundry itself, with no classifier: still held.
    const again = await resumeRun({ ...common(), runId: first.runId, actor: { kind: "system" } });
    expect(again.status).toBe("stopped");
    expect(again.heldContent?.step).toBe("ask");

    const done = await resumeRun({ ...common(), runId: first.runId, actor: { kind: "cli" } });
    expect(done.status).toBe("succeeded");
    expect(done.approvedContent).toContain(hash);
    expect(done.heldContent).toBeUndefined();
  });

  it("ends the run when a child of a parallel step is held, whatever on_failure says", async () => {
    writeFileSync(join(repo, "README.md"), "hello\n");
    const s = await run(
      `${READ}  - {id: p, type: parallel, steps: [c, d], on_failure: next}\n  - {id: c, type: claude, jump_only: true, prompt: "SAY x {{steps.read.output}}"}\n  - {id: d, type: shell, jump_only: true, run: echo D}\n  - {id: after, type: shell, run: echo AFTER}\n`,
      "t",
      () => ({ requireApproval: true }),
    );
    expect(s.status).toBe("failed");
    expect(s.history.find((h) => h.id === "p")!.error).toMatch(/inside a parallel step/);
    expect(s.history.some((h) => h.id === "after")).toBe(false);
  });

  it("holds an agent step whose environment carries untrusted text the prompt does not use", async () => {
    writeFileSync(join(repo, "README.md"), "hello\n");
    const first = await run(`${READ}  - {id: ask, type: claude, prompt: "SAY go"}\n`, "t", () => ({ requireApproval: true }));
    expect(first.status).toBe("stopped");
    expect(first.heldContent?.step).toBe("ask");
    expect(first.heldContent!.sha256.length).toBeGreaterThan(0);
  });

  it("withholds a quarantined environment value from the agent's environment", async () => {
    writeFileSync(join(repo, "README.md"), "hello from the repo\n");
    const s = await run(`${READ}  - {id: ask, type: claude, prompt: "SHOWVARS FACTORY_OUT_READ"}\n`, "t", (i) => (i.consumer === "env" && i.label.source.step === "read" ? { quarantine: true } : {}));
    expect(s.status).toBe("succeeded");
    const o = out(s, "ask");
    expect(o).toMatch(/FACTORY_OUT_READ=\[withheld: content from steps\.read\.output was quarantined/);
    expect(o).not.toContain("hello from the repo");
  });

  it("scrubs a secret-shaped value and a configured pattern before a shell step gets them", async () => {
    const config = ConfigSchema.parse({ protected_branches: [], help: { sensitive_patterns: ["acme-internal-\\d+"] } });
    const s = await run(
      `  - {id: src, type: shell, run: ${JSON.stringify(`printf '%s\\n' '${TOKEN}' 'acme-internal-42'`)}}\n  - {id: dst, type: shell, run: 'printf "%s" "$FACTORY_OUT_SRC"'}\n`,
      "t",
      undefined,
      config,
    );
    expect(s.status).toBe("succeeded");
    const dst = out(s, "dst");
    expect(dst).not.toContain(TOKEN);
    expect(dst).not.toContain("acme-internal-42");
    expect(dst).toContain("[removed:");
  });

  it("gives a Codex step the same blocks after its instructions", async () => {
    const s = await run('  - {id: cx, type: claude, agent: codex, system_prompt: "Be careful.", prompt: "{{task}}"}\n', ISSUE_TEXT);
    expect(s.status).toBe("succeeded");
    const stdin = out(s, "cx").split("PROMPT<<")[1]!;
    expect(stdin.startsWith("<instructions>")).toBe(true);
    expect(stdin).toContain(UNTRUSTED_DATA_NOTE);
    const end = stdin.indexOf("</instructions>");
    expect(stdin.indexOf("<untrusted-data source=")).toBeGreaterThan(end);
    expect(stdin.slice(end + "</instructions>".length)).not.toMatch(/<\s*\/?\s*instructions/i);
  });
});
