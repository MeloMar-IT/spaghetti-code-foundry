import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createSiteServer } from "../server.mjs";

async function withServer(run) {
  const server = createSiteServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

test("the home page is served", () =>
  withServer(async (base) => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(await res.text(), /<h1>/);
  }));

test("a missing file gives 404", () =>
  withServer(async (base) => {
    assert.equal((await fetch(base + "/nope.html")).status, 404);
  }));

test("a path outside the site is refused", () =>
  withServer(async (base) => {
    const res = await fetch(base + "/..%2Fserver.mjs");
    assert.notEqual(res.status, 200);
  }));
