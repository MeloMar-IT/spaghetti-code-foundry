import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { parsePreview, PreviewConfigError } from "../src/preview/config.js";
import { previewEnv } from "../src/preview/support.js";

const fails = (text: string, ...parts: string[]) => {
  let msg = "";
  try {
    parsePreview(text);
  } catch (e) {
    expect(e).toBeInstanceOf(PreviewConfigError);
    msg = (e as Error).message;
  }
  expect(msg).not.toBe("");
  for (const p of parts) expect(msg).toContain(p);
};
const withKey = (key: string, value: unknown) => `command: npm start\n${key}: ${JSON.stringify(value)}\n`;

describe("parsePreview", () => {
  it("fills the defaults for a minimal file", () => {
    expect(parsePreview("command: npm start\n")).toEqual({ command: "npm start", port: "auto", ready: "/", env: {}, version: "develop" });
  });

  it("accepts a full file", () => {
    const text = "command: |\n  npm ci\n  npm start\nport: 3000\nready: /health\nenv:\n  NODE_ENV: production\nversion: checking\n";
    expect(parsePreview(text)).toEqual({ command: "npm ci\nnpm start", port: 3000, ready: "/health", env: { NODE_ENV: "production" }, version: "checking" });
    expect(parsePreview(withKey("port", "auto")).port).toBe("auto");
  });

  it("checks the command", () => {
    fails("port: 3000\n", "command");
    fails(withKey("command", "   ").replace("command: npm start\n", ""), "command");
    fails(withKey("command", "x".repeat(501)).replace("command: npm start\n", ""), "command");
    fails(withKey("command", "a\0b").replace("command: npm start\n", ""), "command");
    fails(withKey("command", "a\u001bb").replace("command: npm start\n", ""), "command");
    expect(parsePreview(`command: ${"x".repeat(500)}\n`).command).toHaveLength(500);
  });

  it("checks the port", () => {
    for (const p of [1023, 80, 65536, 70000, 3.5, "8080"]) fails(withKey("port", p), "port");
    expect(parsePreview(withKey("port", 1024)).port).toBe(1024);
  });

  it("checks the ready path", () => {
    for (const r of ["health", "/a b", `/${"a".repeat(300)}`]) fails(withKey("ready", r), "ready");
    expect(parsePreview(withKey("ready", "/health")).ready).toBe("/health");
  });

  it("checks the env names and values", () => {
    for (const n of ["lower", "1ABC", "FACTORY_X", "SCF_X", "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) fails(withKey("env", { [n]: "v" }), `env.${n}`);
    fails("command: x\nenv:\n  DEBUG: 1\n", "env.DEBUG");
    expect(parsePreview(withKey("env", { NODE_ENV: "production" })).env).toEqual({ NODE_ENV: "production" });
  });

  it("checks the version", () => {
    fails(withKey("version", "main"), "version");
    expect(parsePreview(withKey("version", "checking")).version).toBe("checking");
  });

  it("refuses unknown keys, broken YAML, an empty file and a list", () => {
    fails("command: x\nfoo: 1\n", "foo");
    fails("command: [", "is not valid YAML");
    fails("", "is empty");
    fails("- a\n", "is not valid");
  });
});

describe("previewEnv", () => {
  const source = { PATH: "/bin", HOME: "/home/x", FACTORY_HOME: "/f", GH_TOKEN: "g", RANDOM_VAR: "r", CLAUDECODE: "1" };
  const conf = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ protected_branches: [], ...over });

  it("holds the short names, the file's env, PORT and HOST only", () => {
    const env = previewEnv({ env: { APP_MODE: "x", PORT: "1" } }, 4321, conf(), source);
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x", APP_MODE: "x", PORT: "4321", HOST: "127.0.0.1" });
  });

  it("does not pass a name the config uses as a provider key variable", () => {
    const env = previewEnv({ env: {} }, 1, conf({ providers: { p: { kind: "anthropic-compatible", base_url: "http://x", api_key_env: "HOME" } } }), source);
    expect(env.HOME).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});
