import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRedactor } from "../src/credentials/redact.js";
import { parsePreview } from "../src/preview/config.js";
import { freePort, PreviewRunner } from "../src/preview/runner.js";
import { BUILTIN_STARTERS } from "../src/starters/starters.js";

const ids = readdirSync(BUILTIN_STARTERS).filter((n) => existsSync(join(BUILTIN_STARTERS, n, "starter.yaml")));
const previewText = (id: string) => readFileSync(join(BUILTIN_STARTERS, id, ".factory/preview.yaml"), "utf8");

let runner: PreviewRunner | undefined;
afterEach(async () => {
  await runner?.stopAll();
  runner = undefined;
});

/** Runs `node server.mjs` of the Website starter and returns the first "Listening" line. */
async function listenLine(env: Record<string, string>): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: join(BUILTIN_STARTERS, "website"),
    env: { PATH: process.env.PATH ?? "", ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return await new Promise<string>((res, rej) => {
      let out = "";
      child.on("error", rej);
      child.on("close", () => rej(new Error(`exited early: ${out}`)));
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const url = /Listening on (\S+)/.exec(out)?.[1];
        if (url !== undefined) res(url);
      });
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    });
  } finally {
    child.kill();
  }
}

describe("starter previews", () => {
  it("there is at least one built-in starter", () => {
    expect(ids).toContain("website");
  });

  it.each(ids)("%s has a preview file that parsePreview accepts", (id) => {
    const cfg = parsePreview(previewText(id));
    expect(cfg.port).toBe("auto");
    expect(cfg.ready).toMatch(/^\//);
    expect(cfg.command.trim()).not.toBe("");
    expect(cfg.env).not.toHaveProperty("PORT");
    expect(cfg.env).not.toHaveProperty("HOST");
  });

  it("the Website app listens on the HOST it is given", async () => {
    expect(await listenLine({ HOST: "localhost" })).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it("the Website app listens on 127.0.0.1 when HOST is not set", async () => {
    expect(await listenLine({})).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("the Website starter is ready through the preview runner, without network", async () => {
    runner = new PreviewRunner({
      probeEveryMs: 20,
      probeTimeoutMs: 500,
      readyTimeoutMs: 20_000,
      redactor: () => makeRedactor([]),
      providers: () => ({ providers: {} }),
    });
    const text = previewText("website");
    const info = await runner.start("starter-website", join(BUILTIN_STARTERS, "website"), text);
    expect(info.state, runner.output("starter-website")).toBe("ready");
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await fetch(info.url + parsePreview(text).ready.slice(1));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/<h1>/);
    expect(runner.output("starter-website")).toContain(`Listening on http://127.0.0.1:${info.appPort}`);
  }, 30_000);
});
