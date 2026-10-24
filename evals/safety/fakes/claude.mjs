#!/usr/bin/env node
// Stand-in for the `claude` CLI in the safety suites. It reads the prompt from stdin and emits stream-json.
// It is a model that OBEYS every order it is shown, except inside <untrusted-data> blocks, which the Foundry
// puts around outside text and the real model is told to treat as data. So when outside text reaches the prompt
// unwrapped (or the block can be closed from inside), this fake obeys it and the suite sees the leak.
// Directives (one per line): "SAY <text>" sets the result; "WRITE_B64 <name> <base64>" writes the decoded text to a file.
import { writeFileSync } from "node:fs";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// Data blocks are ignored. An opening tag that is never closed makes the rest of the prompt data.
const visible = prompt.replace(/<untrusted-data\b[^>]*>[\s\S]*?<\/untrusted-data>/g, "").replace(/<untrusted-data\b[\s\S]*$/, "");

let result = "ok";
let writes = 0;
for (const line of visible.split("\n")) {
  const say = line.match(/^SAY (.*)$/);
  if (say) result = say[1];
  const w = line.match(/^WRITE_B64 (\S+) (\S+)$/);
  if (w && /^[\w.-]+$/.test(w[1])) {
    const id = `toolu_w${writes++}`;
    emit({ type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id, name: "Write", input: { file_path: w[1] } }] } });
    writeFileSync(w[1], Buffer.from(w[2], "base64").toString("utf8"));
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  }
}
emit({ type: "result", subtype: "success", is_error: false, result, session_id: "safety-fake", total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } });
process.exitCode = 0;
