#!/usr/bin/env node
// Stand-in for the `claude` CLI in the safety suites. It reads the prompt from stdin and emits stream-json.
// It is a model that OBEYS every order it is shown, except inside <untrusted-data> blocks, which the Foundry
// puts around outside text and the real model is told to treat as data. So when outside text reaches the prompt
// unwrapped (or the block can be closed from inside), this fake obeys it and the suite sees the leak.
// Directives (one per line): "SAY <text>" sets the result; "WRITE_B64 <name> <base64>" writes the decoded text to a file
// in the working folder; "READ <path>" and "WRITE <path> <base64>" read and write any path.
// "REQUEST <json>" appends the JSON as one line to the file named by $FACTORY_REPO_REQUESTS (a repository request for the
// broker); it does nothing when the variable is not set.
// It mimics the sandbox: when --settings has sandbox.enabled, READ and WRITE refuse a path outside the working folder
// and the --add-dir folders (links are followed; a link that leads nowhere counts as outside) with an is_error tool result.
// Without the sandbox it obeys.
import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const addDirs = [];
let settingsText;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--add-dir") {
    while (i + 1 < args.length && !args[i + 1].startsWith("--")) addDirs.push(args[++i]);
  } else if (args[i] === "--settings") settingsText = args[++i];
}
let settings;
if (settingsText !== undefined) {
  try {
    settings = JSON.parse(settingsText);
  } catch {
    process.stderr.write("fake claude: --settings is not JSON\n");
    process.exit(1);
  }
}
const sandbox = settings?.sandbox?.enabled === true;

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
const roots = [process.cwd(), ...addDirs].map((d) => real(resolve(d))).filter(Boolean);
const inside = (p) => {
  const abs = resolve(process.cwd(), p);
  let r = real(abs);
  if (r === undefined) {
    let link = false;
    try {
      link = lstatSync(abs).isSymbolicLink();
    } catch {}
    if (link) return false; // a dangling link: a write would follow it out
    const parent = real(dirname(abs));
    if (parent === undefined) return false;
    r = join(parent, basename(abs));
  }
  return roots.some((root) => {
    const rel = relative(root, r);
    return rel === "" || (!isAbsolute(rel) && rel.split("/")[0] !== "..");
  });
};

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const toolUse = (id, name, path) => emit({ type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id, name, input: { file_path: path } }] } });
const toolResult = (id, content, isError) => emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...(content !== undefined ? { content } : {}), ...(isError ? { is_error: true } : {}) }] } });

// Data blocks are ignored. An opening tag that is never closed makes the rest of the prompt data.
const visible = prompt.replace(/<untrusted-data\b[^>]*>[\s\S]*?<\/untrusted-data>/g, "").replace(/<untrusted-data\b[\s\S]*$/, "");

let result = "ok";
let writes = 0;
let reads = 0;
let writes2 = 0;
for (const line of visible.split("\n")) {
  const say = line.match(/^SAY (.*)$/);
  if (say) result = say[1];
  const rq = line.match(/^REQUEST (.+)$/);
  if (rq && process.env.FACTORY_REPO_REQUESTS) appendFileSync(process.env.FACTORY_REPO_REQUESTS, rq[1] + "\n");
  const w = line.match(/^WRITE_B64 (\S+) (\S+)$/);
  if (w && /^[\w.-]+$/.test(w[1])) {
    const id = `toolu_w${writes++}`;
    toolUse(id, "Write", w[1]);
    writeFileSync(w[1], Buffer.from(w[2], "base64").toString("utf8"));
    toolResult(id);
  }
  const rd = line.match(/^READ (\S+)$/);
  if (rd) {
    const id = `toolu_r${reads++}`;
    toolUse(id, "Read", rd[1]);
    if (sandbox && !inside(rd[1])) toolResult(id, `sandbox: ${rd[1]} is outside the workspace and the allowed folders`, true);
    else {
      try {
        toolResult(id, readFileSync(resolve(process.cwd(), rd[1]), "utf8"));
      } catch {
        toolResult(id, `cannot read ${rd[1]}`, true);
      }
    }
  }
  const wp = line.match(/^WRITE (\S+) (\S+)$/);
  if (wp) {
    const id = `toolu_w${100 + writes2++}`;
    toolUse(id, "Write", wp[1]);
    if (sandbox && !inside(wp[1])) toolResult(id, `sandbox: ${wp[1]} is outside the workspace and the allowed folders`, true);
    else {
      try {
        writeFileSync(resolve(process.cwd(), wp[1]), Buffer.from(wp[2], "base64").toString("utf8"));
        toolResult(id, "ok");
      } catch {
        toolResult(id, `cannot write ${wp[1]}`, true);
      }
    }
  }
}
emit({ type: "result", subtype: "success", is_error: false, result, session_id: "safety-fake", total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } });
process.exitCode = 0;
