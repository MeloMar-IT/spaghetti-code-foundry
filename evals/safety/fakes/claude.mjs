#!/usr/bin/env node
// Stand-in for the `claude` CLI in the safety suites. It reads the prompt from stdin and emits stream-json.
// It is a model that OBEYS every order it is shown, except inside <untrusted-data> blocks, which the Foundry
// puts around outside text and the real model is told to treat as data. So when outside text reaches the prompt
// unwrapped (or the block can be closed from inside), this fake obeys it and the suite sees the leak.
// Directives (one per line): "SAY <text>" sets the result; "WRITE_B64 <name> <base64>" writes the decoded text to a file
// in the working folder; "READ <path>" and "WRITE <path> <base64>" read and write any path.
// "REQUEST <json>" appends the JSON as one line to the file named by $FACTORY_REPO_REQUESTS (a repository request for the
// broker); it does nothing when the variable is not set.
// "PRINT_ENV <NAME>" runs `printenv NAME` (the tool result is NAME=value, or "NAME is not set"); "COPY <src> <dst>" reads
// a file and writes its text to another; "SAY_FILE <path>" sets the result to the text of a file.
// It mimics the sandbox: when --settings has sandbox.enabled, READ, WRITE, COPY and SAY_FILE refuse a path outside the working folder
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
const bashUse = (id, command) => emit({ type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const toolResult = (id, content, isError) => emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...(content !== undefined ? { content } : {}), ...(isError ? { is_error: true } : {}) }] } });

// Data blocks are ignored. An opening tag that is never closed makes the rest of the prompt data.
const visible = prompt.replace(/<untrusted-data\b[^>]*>[\s\S]*?<\/untrusted-data>/g, "").replace(/<untrusted-data\b[\s\S]*$/, "");

let result = "ok";
let writes = 0;
let reads = 0;
let writes2 = 0;
let envs = 0;
let copies = 0;
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
  const pe = line.match(/^PRINT_ENV ([A-Z_][A-Z0-9_]*)$/);
  if (pe) {
    const id = `toolu_e${envs++}`;
    bashUse(id, `printenv ${pe[1]}`);
    const v = process.env[pe[1]];
    toolResult(id, v === undefined ? `${pe[1]} is not set` : `${pe[1]}=${v}`);
  }
  const cp = line.match(/^COPY (\S+) (\S+)$/);
  if (cp) {
    const id = `toolu_c${copies++}`;
    toolUse(id, "Read", cp[1]);
    let text;
    if (sandbox && !inside(cp[1])) toolResult(id, `sandbox: ${cp[1]} is outside the workspace and the allowed folders`, true);
    else {
      try {
        text = readFileSync(resolve(process.cwd(), cp[1]), "utf8");
        toolResult(id, text);
      } catch {
        toolResult(id, `cannot read ${cp[1]}`, true);
      }
    }
    if (text !== undefined) {
      const wid = `toolu_c${copies++}`;
      toolUse(wid, "Write", cp[2]);
      if (sandbox && !inside(cp[2])) toolResult(wid, `sandbox: ${cp[2]} is outside the workspace and the allowed folders`, true);
      else {
        try {
          writeFileSync(resolve(process.cwd(), cp[2]), text);
          toolResult(wid, "ok");
        } catch {
          toolResult(wid, `cannot write ${cp[2]}`, true);
        }
      }
    }
  }
  const sf = line.match(/^SAY_FILE (\S+)$/);
  if (sf && !(sandbox && !inside(sf[1]))) {
    try {
      result = readFileSync(resolve(process.cwd(), sf[1]), "utf8").replace(/\n$/, "");
    } catch {}
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
