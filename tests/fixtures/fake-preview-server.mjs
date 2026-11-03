// A small app for the preview runner tests. Listens on $HOST:$PORT. FAKE_PREVIEW_MODE: ok (default), 503, hang, exit, child.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";

const mode = process.env.FAKE_PREVIEW_MODE ?? "ok";
const print = process.env.FAKE_PREVIEW_PRINT;
const bulk = process.env.FAKE_PREVIEW_BULK;

if (print) {
  if (process.env.FAKE_PREVIEW_SPLIT) {
    const bytes = Buffer.from(print + "é", "utf8"); // the two bytes of é in separate writes
    process.stdout.write(bytes.subarray(0, bytes.length - 1));
    setTimeout(() => {
      process.stdout.write(bytes.subarray(bytes.length - 1), () => process.exit(0));
    }, 30);
    await new Promise(() => {});
  }
  process.stdout.write(process.env.FAKE_PREVIEW_NONL ? print : `${print}\n`);
  if (process.env.FAKE_PREVIEW_NONL) process.exit(0);
}
if (bulk) process.stdout.write(`${bulk === "multi" ? "€".repeat(40_000) : "x".repeat(100_000)}\nEND\n`);
if (process.env.FAKE_PREVIEW_INTERLEAVE) {
  // a secret split across stdout, with a stderr line between its halves
  process.stdout.write("my s3cret-", () => {
    process.stderr.write("noise\n", () => process.stdout.write("value\nEND\n"));
  });
}

if (mode === "exit") {
  process.stderr.write("boom\n");
  process.exit(3);
}

let grandchild = 0;
if (mode === "child") {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
  grandchild = c.pid;
}

let openPartial = 0; // responses of mode "partial" whose body never ends and that are still open

const server = createServer((req, res) => {
  if (req.url === "/open") return void res.end(String(openPartial));
  if (mode === "hang") return; // never answers
  if (mode === "partial") {
    openPartial++;
    res.on("close", () => openPartial--);
    res.writeHead(503);
    return void res.write("not yet"); // the body never ends
  }
  if (mode === "503") {
    res.statusCode = 503;
    return void res.end("not yet");
  }
  if (req.url === "/env") {
    res.setHeader("content-type", "application/json");
    return void res.end(JSON.stringify({ env: process.env, nice: os.getPriority() }));
  }
  if (req.url === "/child") return void res.end(String(grandchild));
  res.end("hello");
});
server.listen(Number(process.env.PORT), process.env.HOST, () => console.log(`listening ${process.env.PORT}`));
process.on("SIGTERM", () => process.exit(0));
