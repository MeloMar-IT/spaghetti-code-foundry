#!/usr/bin/env node
// Stand-in for `scf` (FACTORY_CLI_BIN): `skills effect <folder> [<suite>]` and `skills lifecycle …`. Logs its arguments to FAKE_SCF_LOG (one JSON line).
// effect: prints a run line and the EFFECT line with the verdict FAKE_SCF_EFFECT ("helps" by default) and "with" counts FAKE_SCF_WITH (default 12/12).
// A folder outside the clone (an absolute path: the old version of a change) uses FAKE_SCF_EFFECT_OLD (default FAKE_SCF_EFFECT) and FAKE_SCF_WITH_OLD (default FAKE_SCF_WITH).
// FAKE_SCF_FAIL makes effect exit 1 as a failed measurement does. effect … --screen: one SCREEN line, then "SCREEN: ok", or
// "SCREEN: retask" while the file FAKE_SCF_SCREEN_EASY names does not exist yet (the file is then made: too easy once).
// Both print a cost line (FACTORY_STEP_COST_USD) as the real command does.
// lifecycle <key>: the history (FAKE_SCF_HISTORY or "No lifecycle history"). lifecycle <key> <state> --reason: prints OK and exits 0;
// FAKE_SCF_LIFECYCLE_FAIL makes it print a problem and exit 1.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_SCF_LOG) appendFileSync(process.env.FAKE_SCF_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === "skills" && args[1] === "lifecycle") {
  // `skills lifecycle <key>` (no state): the history of the version, FAKE_SCF_HISTORY when set
  if (args.length === 3) {
    console.log(process.env.FAKE_SCF_HISTORY ?? `No lifecycle history for ${args[2]}`);
    process.exit(0);
  }
  if (process.env.FAKE_SCF_LIFECYCLE_FAIL) {
    console.log("PROBLEM the skill is not installed");
    process.exit(1);
  }
  console.log("OK");
  process.exit(0);
}
if (process.env.FAKE_SCF_FAIL) {
  console.log("PROBLEM the measurement failed");
  process.exit(1);
}
if (args.includes("--screen")) {
  const easy = process.env.FAKE_SCF_SCREEN_EASY;
  const retask = Boolean(easy) && !existsSync(easy);
  if (retask) writeFileSync(easy, "screened\n");
  console.log(`SCREEN first-task: ${retask ? "passes without the skill: too easy, it tests nothing the skill teaches" : "fails without the skill"}`);
  console.log("FACTORY_STEP_COST_USD: 0.2500");
  console.log(`SCREEN: ${retask ? "retask" : "ok"}`);
  process.exit(0);
}
const old = isAbsolute(args[2] ?? "");
const verdict = (old ? process.env.FAKE_SCF_EFFECT_OLD : undefined) ?? process.env.FAKE_SCF_EFFECT ?? "helps";
const withCounts = (old ? process.env.FAKE_SCF_WITH_OLD : undefined) ?? process.env.FAKE_SCF_WITH ?? "12/12";
console.log("RUN demo@1.0.0 with first-task 1/4 run r1: 1");
console.log(`EFFECT demo@1.0.0 ${verdict} (${verdict === "helps" ? "improved" : "no-difference"}): with ${withCounts}, without ${verdict === "helps" ? "3/12" : "12/12"}, difference +0.75, p 0.0010; tokens 1 vs 1; time 1 s vs 1 s`);
console.log("FACTORY_STEP_COST_USD: 1.5000");
console.log("STORED skill-effects/demo/effect--0000000001.json");
