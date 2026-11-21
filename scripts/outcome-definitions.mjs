// Writes website/content/outcome-definitions.json from OUTCOME_DEFINITIONS in src/outcomes.ts, so the Metrics page
// on the website shows the same definitions as the app. The website build runs on plain Node and cannot import
// TypeScript. Run `npm run website:definitions` after OUTCOME_DEFINITIONS changes; tests/website-metrics.test.ts
// fails when the file is out of date.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTCOME_DEFINITIONS } from "../src/outcomes.js";

export const websiteDefinitions = () =>
  OUTCOME_DEFINITIONS.filter((d) => !d.adminOnly).map(({ id, label, unit, countOf, definition, exclusions }) => ({ id, label, unit, countOf, definition, exclusions }));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "website", "content", "outcome-definitions.json");
  writeFileSync(file, JSON.stringify(websiteDefinitions(), null, 2) + "\n");
}
