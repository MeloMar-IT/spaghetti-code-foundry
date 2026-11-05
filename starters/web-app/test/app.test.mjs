import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAppServer, dataPath, portFromEnv } from "../server.mjs";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));

async function withServer(dataFile, run) {
  const server = createAppServer({ dataFile });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "web-app-"));
  try {
    await run(dir, join(dir, "entries.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const post = (base, body) =>
  fetch(base + "/api/entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("the page has a form", () =>
  withDir((dir, file) =>
    withServer(file, async (base) => {
      const res = await fetch(base + "/");
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/html/);
      assert.match(await res.text(), /<form/);
    }),
  ));

test("the list is empty at the start and no file is made", () =>
  withDir((dir, file) =>
    withServer(file, async (base) => {
      const res = await fetch(base + "/api/entries");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
      assert.equal(existsSync(file), false);
    }),
  ));

test("an entry is added, listed and stored", () =>
  withDir((dir, file) =>
    withServer(file, async (base) => {
      const res = await post(base, { text: "  Hello  " });
      assert.equal(res.status, 201);
      const entry = await res.json();
      assert.equal(entry.text, "Hello");
      assert.ok(!Number.isNaN(Date.parse(entry.at)));
      const list = await (await fetch(base + "/api/entries")).json();
      assert.deepEqual(list, [entry]);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), list);
    }),
  ));

test("a new server reads what an old one stored", () =>
  withDir(async (dir, file) => {
    await withServer(file, async (base) => assert.equal((await post(base, { text: "kept" })).status, 201));
    await withServer(file, async (base) => {
      const list = await (await fetch(base + "/api/entries")).json();
      assert.equal(list.length, 1);
      assert.equal(list[0].text, "kept");
    });
  }));

test("two posts at the same time both stay", () =>
  withDir((dir, file) =>
    withServer(file, async (base) => {
      const results = await Promise.all([post(base, { text: "a" }), post(base, { text: "b" })]);
      assert.deepEqual(results.map((r) => r.status), [201, 201]);
      assert.equal((await (await fetch(base + "/api/entries")).json()).length, 2);
    }),
  ));

test("bad input gives 400 and writes nothing", () =>
  withDir((dir, file) =>
    withServer(file, async (base) => {
      for (const body of ["not json", {}, { text: 5 }, { text: "   " }, { text: "x".repeat(201) }]) {
        assert.equal((await post(base, body)).status, 400);
      }
      assert.equal(existsSync(file), false);
    }),
  ));

test("a body that is too big gives 413", () =>
  withDir((dir, file) =>
    withServer(file, async (base) => {
      assert.equal((await post(base, JSON.stringify({ text: "x".repeat(20000) }))).status, 413);
      assert.equal(existsSync(file), false);
    }),
  ));

test("a damaged data file is never overwritten", () =>
  withDir(async (dir, file) => {
    for (const content of ["{ broken", '{"a": 1}']) {
      await writeFile(file, content);
      await withServer(file, async (base) => {
        assert.equal((await fetch(base + "/api/entries")).status, 500);
        assert.equal((await post(base, { text: "x" })).status, 500);
      });
      assert.equal(await readFile(file, "utf8"), content);
      assert.deepEqual(await readdir(dir), ["entries.json"]);
    }
  }));

test("a failed write gives 500, keeps the old entries and the server still works", () =>
  withDir(async (dir) => {
    const blocker = join(dir, "sub");
    await writeFile(blocker, "I am a file");
    const file = join(blocker, "entries.json");
    await withServer(file, async (base) => {
      assert.equal((await post(base, { text: "first" })).status, 500);
      assert.equal(await readFile(blocker, "utf8"), "I am a file");
      await rm(blocker);
      assert.equal((await post(base, { text: "second" })).status, 201);
      const list = await (await fetch(base + "/api/entries")).json();
      assert.deepEqual(list.map((e) => e.text), ["second"]);
      assert.deepEqual(await readdir(join(dir, "sub")), ["entries.json"]);
    });
  }));

test("wrong paths and methods", () =>
  withDir((dir, file) =>
    withServer(file, async (base) => {
      assert.equal((await fetch(base + "/nope")).status, 404);
      assert.equal((await fetch(base + "/api/entries", { method: "DELETE" })).status, 405);
      assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
    }),
  ));

test("dataPath", () => {
  const before = process.env.DATA_FILE;
  try {
    delete process.env.DATA_FILE;
    assert.ok(dataPath().endsWith(join("data", "entries.json")));
    process.env.DATA_FILE = "mine.json";
    assert.ok(dataPath().endsWith("mine.json"));
    assert.notEqual(dataPath(), "mine.json");
    const abs = join(tmpdir(), "x.json");
    process.env.DATA_FILE = abs;
    assert.equal(dataPath(), abs);
  } finally {
    if (before === undefined) delete process.env.DATA_FILE;
    else process.env.DATA_FILE = before;
  }
});

test("portFromEnv", () => {
  assert.equal(portFromEnv(undefined), 3000);
  assert.equal(portFromEnv(""), 3000);
  assert.equal(portFromEnv("0"), 0);
  assert.equal(portFromEnv("8080"), 8080);
  for (const bad of ["abc", "-1", "70000", "1.5"]) {
    assert.throws(() => portFromEnv(bad), /PORT must be/);
  }
});

test("PORT=0 starts the server on a free port", async () => {
  const child = spawn(process.execPath, [serverPath], {
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

test("a bad PORT stops the server with a message", () => {
  const run = spawnSync(process.execPath, [serverPath], {
    env: { ...process.env, PORT: "abc" },
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /PORT must be/);
});
