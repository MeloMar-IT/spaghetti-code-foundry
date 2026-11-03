#!/usr/bin/env node
// Stand-in for `scf` (FACTORY_CLI_BIN): only `skills effect <folder>`. Logs its arguments to FAKE_SCF_LOG (one JSON line) and prints a run line
// and the EFFECT line with the verdict FAKE_SCF_EFFECT ("helps" by default). FAKE_SCF_FAIL makes it exit 1 as a failed measurement does.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_SCF_LOG) appendFileSync(process.env.FAKE_SCF_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_SCF_FAIL) {
  console.log("PROBLEM the measurement failed");
  process.exit(1);
}
const verdict = process.env.FAKE_SCF_EFFECT ?? "helps";
console.log("RUN demo@1.0.0 with first-task 1/4 run r1: 1");
console.log(`EFFECT demo@1.0.0 ${verdict} (${verdict === "helps" ? "improved" : "no-difference"}): with 12/12, without ${verdict === "helps" ? "3/12" : "12/12"}, difference +0.75, p 0.0010; tokens 1 vs 1; time 1 s vs 1 s`);
console.log("STORED skill-effects/demo/effect--0000000001.json");
