import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let folder: string | undefined;

/** A temporary repository folder that holds the flow `github-issue`, so stub runs of that flow are not retired. */
export function flowRepo(): string {
  if (folder) return folder;
  folder = mkdtempSync(join(tmpdir(), "flow-repo-"));
  const dir = join(folder, ".claude-factory", "flows");
  mkdirSync(dir, { recursive: true });
  copyFileSync(new URL("../fixtures/flows/github-issue.yaml", import.meta.url), join(dir, "github-issue.yaml"));
  return folder;
}
