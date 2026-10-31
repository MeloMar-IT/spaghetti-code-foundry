import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBlock } from "../src/flow/blocks.js";

const TOOL = resolve("tools/pr-output");
const LIB = resolve("dist/engine/run-outputs.js");
const URL_OK = "https://github.com/acme/app/pull/12";
let tmp: string;
let runDir: string;
const outFile = () => join(runDir, "outputs.json");
const needBuild = () => {
  if (!existsSync(LIB)) throw new Error("dist/engine/run-outputs.js is missing — run `npm run build` first");
};

beforeEach(() => {
  needBuild();
  tmp = mkdtempSync(join(tmpdir(), "pr-output-"));
  runDir = join(tmp, "run");
  mkdirSync(runDir);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const tool = (...args: string[]) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
const read = () => JSON.parse(readFileSync(outFile(), "utf8"));

describe("tools/pr-output", () => {
  it("merges a valid URL into outputs.json and keeps other keys", () => {
    writeFileSync(outFile(), '{"release_url":"x"}');
    const r = tool(runDir, URL_OK);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(read()).toEqual({ release_url: "x", pull_request: URL_OK });
  });

  it("creates the file when there is none", () => {
    expect(tool(runDir, URL_OK).status).toBe(0);
    expect(read()).toEqual({ pull_request: URL_OK });
  });

  it("takes the last non-empty line, trimmed", () => {
    tool(runDir, "Creating pull request for x\n\nhttps://github.com/acme/app/pull/7  \n\n");
    expect(read()).toEqual({ pull_request: "https://github.com/acme/app/pull/7" });
  });

  it.each([
    "not a url",
    "",
    "https://github.com/acme/app/pull/0",
    "http://github.com/acme/app/pull/1",
    "https://github.com/acme/app/issues/1",
    "https://github.com/-acme/app/pull/1",
    "https://github.com/acme/app/pull/1?x=1",
    "https://github.com/acme/app/pull/12345678901",
  ])("leaves the file as it was for %j", (bad) => {
    writeFileSync(outFile(), '{"a":"b"}');
    const r = tool(runDir, bad);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^pr-output: /);
    expect(readFileSync(outFile(), "utf8")).toBe('{"a":"b"}');
  });

  it("reports missing arguments", () => {
    for (const args of [[], [runDir]]) {
      const r = tool(...args);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/^pr-output: usage/);
    }
  });

  it("reports a missing run folder and creates nothing", () => {
    const gone = join(tmp, "gone");
    const r = tool(gone, URL_OK);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^pr-output: /);
    expect(existsSync(gone)).toBe(false);
  });

  it("keeps a file with 20 keys when writeRunOutputs refuses", () => {
    const full = JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v"])));
    writeFileSync(outFile(), full);
    const r = tool(runDir, URL_OK);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("pr-output: outputs: more than 20 keys");
    expect(readFileSync(outFile(), "utf8")).toBe(full);
  });

  it.each(["{not json", '{"release_url":"x","attempt":1}', "[]"])("keeps an existing invalid file %j", (content) => {
    writeFileSync(outFile(), content);
    const r = tool(runDir, URL_OK);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^pr-output: /);
    expect(readFileSync(outFile(), "utf8")).toBe(content);
  });
});

describe("open_pr shell text", () => {
  let script: string;
  beforeEach(() => {
    const block = parseBlock(readFileSync("blocks/open-pr.yaml", "utf8"));
    const step = block.steps.find((s) => s.id === "open_pr");
    const text = step && "run" in step ? String(step.run ?? "") : "";
    expect(text).toContain("{{run.dir}}");
    script = text.split("{{run.dir}}").join(runDir);
    mkdirSync(join(tmp, "bin"));
    const gh = join(tmp, "bin", "gh");
    writeFileSync(
      gh,
      [
        "#!/bin/sh",
        'case "$1 $2" in',
        '  "pr view") [ -n "$FAKE_EXISTING" ] && { echo "$FAKE_EXISTING"; exit 0; }; exit 1 ;;',
        '  "issue view") exit 1 ;;',
        '  "pr create") cat >/dev/null; printf \'%s\\n\' "$FAKE_CREATE_OUT"; exit "${FAKE_CREATE_EXIT:-0}" ;;',
        "esac",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(gh, 0o755);
  });

  const exec = (fake: Record<string, string>) =>
    spawnSync("/bin/sh", ["-c", script], {
      cwd: tmp,
      encoding: "utf8",
      env: {
        PATH: `${join(tmp, "bin")}:${dirname(process.execPath)}:${process.env.PATH}`,
        FACTORY_TOOLS: resolve("tools"),
        FACTORY_VAR_GITHUB_REPO: "acme/app",
        FACTORY_VAR_ISSUE: "",
        FACTORY_OUT_IMPLEMENT: "x",
        FACTORY_RUN_ID: "r1",
        GIT_CEILING_DIRECTORIES: tmp,
        ...fake,
      },
    });

  it("fails the step when gh pr create fails", () => {
    const r = exec({ FAKE_CREATE_EXIT: "1", FAKE_CREATE_OUT: "boom" });
    expect(r.status).toBe(1);
    expect(existsSync(outFile())).toBe(false);
  });

  it("fails the step with the exit code of gh pr create", () => {
    expect(exec({ FAKE_CREATE_EXIT: "4", FAKE_CREATE_OUT: "boom" }).status).toBe(4);
  });

  it("passes and records nothing when create prints no URL", () => {
    const r = exec({ FAKE_CREATE_OUT: "Warning: something" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("pr-output:");
    expect(existsSync(outFile())).toBe(false);
  });

  it("records the URL a create prints", () => {
    const r = exec({ FAKE_CREATE_OUT: URL_OK });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(URL_OK);
    expect(read().pull_request).toBe(URL_OK);
  });

  it("records an existing pull request", () => {
    const url = "https://github.com/acme/app/pull/5";
    const r = exec({ FAKE_EXISTING: url, FAKE_CREATE_EXIT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(url);
    expect(read().pull_request).toBe(url);
  });
});
