import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyAll } from "../src/notify.js";

test("notifyAll sends once for each id", async () => {
  const sent = [];
  const send = async (id) => {
    sent.push(id);
  };
  await notifyAll(["a", "b"], send);
  assert.deepEqual(sent, ["a", "b"]);
});
