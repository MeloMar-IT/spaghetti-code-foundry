// Adds one "Plugin API: x.y" line to GitHub release notes.
// Used by .github/workflows/publish.yml: node scripts/release-notes.mjs <x.y> < old-notes > new-notes
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

export function withApiVersion(body, version) {
  if (!/^\d+\.\d+$/.test(version)) throw new Error(`Bad plugin API version "${version}" (expected x.y)`);
  const kept = String(body ?? "").split("\n").filter((l) => !l.startsWith("Plugin API: ")).join("\n").trimEnd();
  const line = `Plugin API: ${version} (see docs/PLUGIN_API.md)\n`;
  return kept ? `${kept}\n\n${line}` : line;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(withApiVersion(readFileSync(0, "utf8"), process.argv[2] ?? ""));
}
