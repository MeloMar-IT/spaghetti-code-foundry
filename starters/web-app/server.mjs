import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_DATA_FILE = "data/entries.json";
export const MAX_TEXT = 200;
export const MAX_BODY = 10 * 1024;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web app</title>
</head>
<body>
<h1>Web app</h1>
<form id="add">
  <input name="text" maxlength="${MAX_TEXT}" required>
  <button type="submit">Add</button>
</form>
<p id="message"></p>
<ul id="entries"></ul>
<script>
const list = document.getElementById("entries");
const message = document.getElementById("message");
async function load() {
  const res = await fetch("/api/entries");
  const entries = await res.json();
  list.textContent = "";
  if (!Array.isArray(entries)) { message.textContent = entries.error || "Could not load."; return; }
  for (const entry of entries) {
    const li = document.createElement("li");
    li.textContent = entry.text;
    list.appendChild(li);
  }
}
document.getElementById("add").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = event.target.elements.text;
  const res = await fetch("/api/entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: input.value }),
  });
  if (res.ok) { input.value = ""; message.textContent = ""; } else { message.textContent = (await res.json()).error; }
  await load();
});
load();
</script>
</body>
</html>
`;

/** Path of the data file. Relative paths are resolved against this folder. */
export function dataPath(dataFile) {
  const file = dataFile || process.env.DATA_FILE || DEFAULT_DATA_FILE;
  return isAbsolute(file) ? file : join(HERE, file);
}

/** All entries in the file. [] when the file is missing; throws when it is damaged. */
export async function readEntries(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("the data file is not a list");
  return data;
}

async function writeEntries(file, entries) {
  const tmp = `${file}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(entries, null, 2) + "\n");
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too big"), { tooBig: true }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A server for the page and the API. */
export function createAppServer(options = {}) {
  const file = dataPath(options.dataFile);
  let chain = Promise.resolve();

  async function add(text) {
    const entries = await readEntries(file);
    const entry = { text, at: new Date().toISOString() };
    entries.push(entry);
    await writeEntries(file, entries);
    return entry;
  }

  async function handle(req, res) {
    let path;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path === "/") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : PAGE);
      return;
    }
    if (path === "/api/entries") {
      if (req.method === "GET") {
        try {
          send(res, 200, await readEntries(file));
        } catch {
          send(res, 500, { error: "could not read the entries" });
        }
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "GET, POST" }).end();
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        if (error.tooBig) send(res, 413, { error: "the request is too big" });
        else res.destroy();
        return;
      }
      let text;
      try {
        const data = JSON.parse(body);
        if (data && typeof data === "object" && typeof data.text === "string") text = data.text.trim();
      } catch {
        // handled below
      }
      if (text === undefined) {
        send(res, 400, { error: 'send JSON like {"text": "…"}' });
        return;
      }
      if (text === "" || [...text].length > MAX_TEXT) {
        send(res, 400, { error: `the text must have 1 to ${MAX_TEXT} characters` });
        return;
      }
      const job = chain.then(() => add(text));
      chain = job.then(
        () => {},
        () => {},
      );
      try {
        send(res, 201, await job);
      } catch {
        send(res, 500, { error: "could not store the entry" });
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "something went wrong" });
      else res.destroy();
    });
  });
}

/** The port from PORT: 3000 when it is not set, 0 asks for a free port. Anything else that is not 0–65535 throws. */
export function portFromEnv(value = process.env.PORT) {
  if (value === undefined || value === "") return 3000;
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    throw new Error(`PORT must be a number from 0 to 65535, not "${value}"`);
  }
  return Number(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let port;
  try {
    port = portFromEnv();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  if (port !== undefined) {
    const server = createAppServer();
    server.listen(port, "127.0.0.1", () => console.log(`Listening on http://127.0.0.1:${server.address().port}`));
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
  }
}
