import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { isShippedFlow } from "../engine/guards.js";
import { readPolicyFile } from "../engine/policy-hooks.js";
import { flowDir, parseFlow } from "../flow/load.js";
import type { Flow } from "../flow/schema.js";
import { flowSha256 } from "./components.js";

const MAX_FLOW_FILE_BYTES = 1 << 20;

/**
 * The id a flow has under `scf promote`: the base name of the file in the data folder's flows, then the folder's flows,
 * whose content is this flow (a job holds a parsed flow, not a path). Files are read in sorted order, so two files with the
 * same content always give the first. Undefined for a built-in flow or when no file matches. Never throws.
 * Called once, when a run job is queued: the id is saved with the job, so an edit while the job waits does not change it.
 * Also used by the governance check (#665) for a run that was saved without an id.
 */
export function flowFileId(flow: Flow, repo: string): string | undefined {
  try {
    if (isShippedFlow(flow)) return undefined;
    const want = flowSha256(flow);
    for (const dir of [flowDir("global", ""), flowDir("repo", repo)]) {
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".yaml") || n.endsWith(".yml")).sort();
      } catch {
        continue;
      }
      for (const n of names) {
        // a plain file of bounded size only: a FIFO, a link or a huge file is no match, and never blocks the server
        const read = readPolicyFile(join(dir, n), MAX_FLOW_FILE_BYTES);
        if ("problem" in read) continue;
        try {
          if (flowSha256(parseFlow(read.text, n)) === want) return basename(n, extname(n));
        } catch {
          // a file that does not parse is no match
        }
      }
    }
  } catch {
    // no id: the run uses the flow's name
  }
  return undefined;
}
