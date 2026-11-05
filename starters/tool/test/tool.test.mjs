import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { count, createTryServer, describeCount, portFromEnv, runTool } from "../tool.mjs";

const toolPath = fileURLToPath(new URL("../tool.mjs", import.meta.url));

test("portFromEnv", () => {
  assert.equal(portFromEnv(undefined), 3000);
  assert.equal(portFromEnv(""), 3000);
  assert.equal(portFromEnv("0"), 0);
  assert.equal(portFromEnv("8080"), 8080);
  for (const bad of ["abc", "-1", "70000", "1.5"]) {
    assert.throws(() => portFromEnv(bad), /PORT must be/);
  }
});

test("PORT=0 starts the try page on a free port", async () => {
  const child = spawn(process.execPath, [toolPath, "--serve"], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const line = await new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).once("line", resolve);
      child.once("exit", (code) => reject(new Error(`exited with ${code}`)));
    });
    const port = Number(line.match(/:(\d+)$/)[1]);
    assert.ok(port > 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
});

test("a bad PORT stops the try page with a message", () => {
  const run = spawnSync(process.execPath, [toolPath, "--serve"], {
    env: { ...process.env, PORT: "abc" },
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /PORT must be/);
});

test("count", () => {
  assert.deepEqual(count(""), { words: 0, lines: 0, characters: 0 });
  assert.deepEqual(count("hello world"), { words: 2, lines: 1, characters: 11 });
  const two = count("a\nb\n");
  assert.equal(two.words, 2);
  assert.equal(two.lines, 2);
  assert.equal(count("héllo 🙂").characters, 7);
  assert.equal(count(" \t \n ").words, 0);
});

test("describeCount uses the singular for 1", () => {
  assert.equal(describeCount({ words: 1, lines: 1, characters: 1 }), "1 word, 1 line, 1 character");
});

test("runTool", () => {
  const help = runTool(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage/);
  const bad = runTool(["--nope"]);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /unknown option/);
  assert.equal(runTool([]).code, 2);
  const piped = runTool([], "a b");
  assert.equal(piped.code, 0);
  assert.match(piped.out, /2 words/);
  assert.equal(runTool(["hello", "world"]).out, "2 words, 1 line, 11 characters");
});

test("the real command", () => {
  const run = spawnSync(process.execPath, [toolPath, "hello", "world"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), "2 words, 1 line, 11 characters");
  const piped = spawnSync(process.execPath, [toolPath], { input: "one two three", encoding: "utf8" });
  assert.equal(piped.status, 0);
  assert.match(piped.stdout, /3 words/);
  const bad = spawnSync(process.execPath, [toolPath, "--nope"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option/);
});

async function withServer(run) {
  const server = createTryServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

const run = (base, body) =>
  fetch(base + "/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("the try page", () =>
  withServer(async (base) => {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<textarea/);
    const ok = await run(base, { text: "a b" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { code: 0, output: "2 words, 1 line, 3 characters" });
    assert.equal((await run(base, "not json")).status, 400);
    assert.equal((await run(base, { text: "x".repeat(20000) })).status, 413);
    assert.equal((await fetch(base + "/nope")).status, 404);
  }));
