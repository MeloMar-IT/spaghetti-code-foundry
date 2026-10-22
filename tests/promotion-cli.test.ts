import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = resolve("dist/cli.js");
const open = "dataClassification: internal\n    credential: none\n    timeoutMs: null\n    maxConcurrent: null\n    outputCapBytes: null\n    approval: none\n";
const PROFILE = `version: 1\nprofile: { id: p, version: "1" }\ngrants:\n  - kind: files\n    operations: [read]\n    targets: ["src/*"]\n    ${open}`;
const SELECTOR = "budget: { maxSources: 10, maxSourceBytes: 1000, maxTotalBytes: 5000 }\n";

let base: string;
const put = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
/** Every path under `dir` with its mode, size, mtime and content. */
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = statSync(p);
      out[p.slice(dir.length)] = `${st.mode}:${st.size}:${st.mtimeMs}:${e.isDirectory() ? "" : readFileSync(p, "utf8")}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
};
const scf = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });

beforeEach(() => {
  if (!existsSync(cli)) throw new Error(`${cli} is missing — run \`npm run build\` first`);
  base = mkdtempSync(join(tmpdir(), "components-cli-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("scf components as a separate process", () => {
  it("lists with an explicit home and leaves it as it was", () => {
    const home = join(base, "home");
    put(home, "config.yaml", "router:\n  fallback: [claude-sonnet-5-5]\n");
    put(home, "tool-profiles/p.yaml", PROFILE);
    put(home, "context-selectors/s.yaml", SELECTOR);
    put(home, "flows/demo.yaml", "name: demo\nsteps:\n  - id: one\n    type: shell\n    run: echo one\n");
    const before = snapshot(home);
    const r = scf(["components"], { ...process.env, FACTORY_HOME: home });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^COMPONENT flow demo v0 sha256:[0-9a-f]{64}$/m);
    expect(r.stdout).toMatch(/^COMPONENT tool-profile p v- sha256:[0-9a-f]{64} unrecorded$/m);
    expect(r.stdout).toMatch(/^COMPONENT context-selector s v- sha256:[0-9a-f]{64} unrecorded$/m);
    expect(snapshot(home)).toEqual(before);
  });

  it("does not migrate or lock the old data folder when no home is set", () => {
    const user = join(base, "user");
    const old = join(user, ".claude-factory");
    put(old, "config.yaml", "router:\n  fallback: [claude-sonnet-5-5]\n");
    put(old, "tool-profiles/p.yaml", PROFILE);
    const before = snapshot(user);
    const env = { ...process.env, HOME: user, USERPROFILE: user };
    for (const k of ["FACTORY_HOME", "SCF_HOME"]) delete env[k];
    const r = scf(["components", "tool-profile"], env);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^COMPONENT tool-profile p v- sha256:[0-9a-f]{64} unrecorded$/m);
    expect(r.status).toBe(0);
    expect(existsSync(join(user, ".spaghetti-code-foundry"))).toBe(false);
    expect(snapshot(user)).toEqual(before);
  });

  it("keeps both entries when two recorders run at once", async () => {
    const home = join(base, "home");
    put(home, "tool-profiles/p.yaml", PROFILE);
    put(home, "context-selectors/s.yaml", SELECTOR);
    const env = { ...process.env, FACTORY_HOME: home };
    const go = (kind: string) =>
      new Promise<number | null>((done) => {
        const child = spawn(process.execPath, [cli, "components", "record", kind], { env, stdio: "ignore" });
        child.on("exit", done);
      });
    expect(await Promise.all([go("tool-profile"), go("context-selector")])).toEqual([0, 0]);
    const book = JSON.parse(readFileSync(join(home, "promotions/versions.json"), "utf8"));
    expect(Object.keys(book.components).sort()).toEqual(["context-selector/s", "tool-profile/p"]);
  });

  it("is in the help", () => {
    const help = scf(["--help"], { ...process.env, FACTORY_HOME: join(base, "home") });
    expect(help.stdout).toContain("scf components [kind]");
    expect(help.stdout).toContain("scf components record [kind]");
  });
});
