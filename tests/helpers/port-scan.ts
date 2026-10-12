import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Built from pieces so this file does not flag itself.
const RANDOM = ["Math", "random("].join(".");
const SUM_RE = new RegExp(String.raw`\b\d{4,5}\s*\+\s*Math\.floor\(\s*Math\.` + String.raw`random\(`);
const HINT = "use startTestServer() or freePort() from tests/helpers/port.ts";

/** Lines of `source` with a self-chosen port, as "<line number>: <trimmed line>" (1-based). */
export function scanPorts(source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, i) => {
    if (line.includes(RANDOM) && (/port/i.test(line) || SUM_RE.test(line))) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

function walk(dir: string, root: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path, root, out);
    else if (/\.(ts|mjs|js)$/.test(e.name)) out.push(relative(root, path).split(sep).join("/"));
  }
}

/** Files under <root>/tests (.ts, .mjs, .js, subfolders too) with a self-chosen port, and stale `allowed` entries. */
export function scanTestPorts(root = ".", allowed: string[] = []): { where: string; problems: string[] }[] {
  const files: string[] = [];
  walk(join(root, "tests"), root, files);
  const out: { where: string; problems: string[] }[] = [];
  const hitsOf = (where: string): string[] => scanPorts(readFileSync(join(root, where), "utf8"));
  for (const where of files) {
    if (allowed.includes(where)) continue;
    const hits = hitsOf(where);
    if (hits.length > 0) out.push({ where, problems: hits.map((h) => `${h} — ${HINT}`) });
  }
  for (const where of allowed) {
    if (!existsSync(join(root, where)) || hitsOf(where).length === 0) {
      out.push({ where, problems: ["no self-chosen port any more — remove it from the allowlist in tests/test-ports.test.ts"] });
    }
  }
  return out.sort((a, b) => a.where.localeCompare(b.where));
}
