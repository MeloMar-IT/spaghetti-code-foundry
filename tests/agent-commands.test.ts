import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";

// Steps with allow_commands, run by the fake claude (RUN <command>) with fake image tools on the PATH. No time is waited for.

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const cfg = (): Config => ConfigSchema.parse({ protected_branches: [] });

let tmp: string;
let repo: string;
let runsDir: string;
let tools: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-cmds-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  tools = join(tmp, "tools");
  mkdirSync(repo);
  mkdirSync(tools);
  const fake = (name: string, body: string) => {
    writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(tools, name), 0o755);
  };
  fake("magick", 'cp "$1" "$2"');
  fake("cwebp", 'cp "$1" "$3"');
  writeFileSync(join(repo, "photo.jpg"), "jpeg");
  vi.stubEnv("PATH", `${tools}${delimiter}${process.env.PATH}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const lines = (prompt: string) => prompt.split("\n").map((l) => `      ${l}`).join("\n");
const flow = (prompt: string, extra = "", more = "") => `name: t
workspace: inplace
steps:
  - id: a
    type: claude
    prompt: |
${lines(prompt)}
${extra}${more}`;
const start = (yaml: string) => runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, config: cfg() });

describe("allow_commands: images", () => {
  const images = "    allow_commands: [images]\n";

  it("lets the step make a png and a webp, and the next step sees them", async () => {
    const s = await start(
      flow("RUN magick photo.jpg photo.png\nRUN cwebp photo.jpg -o photo.webp", images, "  - {id: check, type: shell, run: test -s photo.png && test -s photo.webp}\n"),
    );
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.denied).toBeUndefined();
    expect(existsSync(join(repo, "photo.webp"))).toBe(true);
    // the wrappers and logs of the attempt are gone
    expect(readdirSync(join(s.runDir, "image-bin"))).toEqual([]);
    expect(readdirSync(join(s.runDir, "image-log"))).toEqual([]);
  });

  it("still refuses a command outside the set, and records it", async () => {
    const s = await start(flow("RUN curl https://example.test", images));
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.denied).toEqual(["Bash: curl https://example.test"]);
  });

  it("stops when the gate refuses a path outside the workspace, even if the step answers ok", async () => {
    const s = await start(flow("RUN magick /etc/hosts out.png", images));
    expect(s.status).toBe("stopped");
    expect(existsSync(join(repo, "out.png"))).toBe(false);
    expect(s.reason).toContain("magick /etc/hosts out.png");
    expect(s.history).toHaveLength(1);
    expect(s.history[0]!.denied).toEqual(["Bash: magick /etc/hosts out.png"]);
  });

  it("stops once on the marker line, does not follow on_failure, and a resume runs the step again", async () => {
    const yaml = flow("SAY REFUSED_COMMAND: cwebp photo.jpg -o photo.webp", `${images}    on_failure: never\n`, "  - {id: never, type: shell, run: echo no}\n");
    const s = await start(yaml);
    expect(s.status).toBe("stopped");
    expect(s.reason).toContain("cwebp photo.jpg -o photo.webp");
    expect(s.history.map((h) => h.id)).toEqual(["a"]);
    expect(s.history[0]!.ok).toBe(false);
    expect(s.state.next).toBe("a");
    const again = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg() });
    expect(again.history.filter((h) => h.id === "a")).toHaveLength(2);
    expect(again.status).toBe("stopped");
  });

  it("ignores the marker in a step without allow_commands", async () => {
    const s = await start(flow("SAY REFUSED_COMMAND: cwebp x"));
    expect(s.status).toBe("succeeded");
  });

  it("stops a fix loop on the second visit that was refused the same program", async () => {
    const yaml = `name: t
workspace: inplace
steps:
  - {id: t, type: shell, run: test -f never.txt, on_failure: fix}
  - id: fix
    type: claude
    allow_commands: [images]
    max_visits: 3
    on_success: t
    prompt: |
      DENY Bash curl x
`;
    const s = await start(yaml);
    expect(s.status).toBe("stopped");
    expect(s.reason).toContain("curl x");
    expect(s.history.map((h) => h.id)).toEqual(["t", "fix", "t", "fix"]);
  });

  it("stops the parent run when a sub-flow step needs a refused command", async () => {
    const dir = join(repo, ".claude-factory", "flows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sub.yaml"), flow("SAY REFUSED_COMMAND: magick a b", images).replace("name: t", "name: sub"));
    const s = await start("name: t\nworkspace: inplace\nsteps:\n  - {id: s, type: flow, flow: sub, on_failure: never}\n  - {id: never, type: shell, run: echo no}\n");
    expect(s.status).toBe("stopped");
    expect(s.reason).toContain("magick a b");
    expect(s.history.some((h) => h.id === "never")).toBe(false);
  });
});
