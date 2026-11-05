import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const USAGE =
  "Usage: node tool.mjs <text…>   (or send text on stdin)\n       node tool.mjs --serve   (a page to try it)";
export const MAX_BODY = 10 * 1024;

/** Counts of a text: words, lines (one trailing newline is not counted) and characters (code points). */
export function count(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  return { words, lines, characters: [...text].length };
}

/** "2 words, 1 line, 11 characters" */
export function describeCount({ words, lines, characters }) {
  const n = (value, one, many) => `${value} ${value === 1 ? one : many}`;
  return `${n(words, "word", "words")}, ${n(lines, "line", "lines")}, ${n(characters, "character", "characters")}`;
}

/** The tool without side effects. Returns the exit code and the text to print. */
export function runTool(args, input) {
  if (args.includes("--help") || args.includes("-h")) return { code: 0, out: USAGE };
  const unknown = args.find((arg) => arg.startsWith("--"));
  if (unknown) return { code: 2, out: `unknown option: ${unknown}\n${USAGE}` };
  if (args.length > 0) return { code: 0, out: describeCount(count(args.join(" "))) };
  if (input !== undefined) return { code: 0, out: describeCount(count(input)) };
  return { code: 2, out: USAGE };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tool</title>
</head>
<body>
<h1>Tool</h1>
<p>Type a text and press Run to count its words, lines and characters.</p>
<textarea id="text" rows="6" cols="50"></textarea>
<p><button id="run" type="button">Run</button></p>
<pre id="output"></pre>
<script>
document.getElementById("run").addEventListener("click", async () => {
  const res = await fetch("/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: document.getElementById("text").value }),
  });
  const data = await res.json();
  document.getElementById("output").textContent = data.output ?? data.error ?? "";
});
</script>
</body>
</html>
`;

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

/** The Try it page: GET / and POST /run ({ text } gives { code, output }). */
export function createTryServer() {
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { Allow: "GET, HEAD" }).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : PAGE);
        return;
      }
      if (path === "/run") {
        if (req.method !== "POST") {
          res.writeHead(405, { Allow: "POST" }).end();
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
          if (data && typeof data === "object" && typeof data.text === "string") text = data.text;
        } catch {
          // handled below
        }
        if (text === undefined) {
          send(res, 400, { error: 'send JSON like {"text": "…"}' });
          return;
        }
        const { code, out } = runTool([], text);
        send(res, 200, { code, output: out });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    } catch {
      if (!res.headersSent) send(res, 500, { error: "something went wrong" });
      else res.destroy();
    }
  });
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
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
  const args = process.argv.slice(2);
  if (args[0] === "--serve") {
    let port;
    try {
      port = portFromEnv();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    if (port !== undefined) {
      const server = createTryServer();
      server.listen(port, "127.0.0.1", () => console.log(`Listening on http://127.0.0.1:${server.address().port}`));
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
    }
  } else {
    const input = args.length === 0 && !process.stdin.isTTY ? await readStdin() : undefined;
    const { code, out } = runTool(args, input);
    (code === 0 ? process.stdout : process.stderr).write(out + "\n");
    process.exitCode = code;
  }
}
