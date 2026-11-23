// OSV scanner findings for the weekly dependency check: a finding marks the update row of the same package and version as security.
import { isObj, oneLine, toolFailure, type ToolRun } from "./ecosystems.js";

export const OSV_ARGS = ["--format", "json", "--recursive", "."];
export const OSV_TIMEOUT_MS = 5 * 60_000;
export const OSV_MISSING_NOTE = "osv-scanner is not installed; only npm audit marks updates as security";

export interface OsvFinding { ecosystem: string; name: string; version: string }
export interface OsvResult { installed: boolean; ok: boolean; note?: string; findings: OsvFinding[] }

/** The OSV ecosystem → the tools whose update rows it marks. */
export const OSV_TOOLS: Record<string, string[]> = {
  npm: ["npm"], Maven: ["maven", "gradle"], PyPI: ["pip"], Go: ["go"], "GitHub Actions": ["actions"],
};

/** The same package in the report of a tool and in the report of OSV: pip names are PEP 503 names, a leading "v" is dropped. */
export function osvKey(tool: string, name: string, version: string): string {
  const n = tool === "pip" ? name.toLowerCase().replace(/[-_.]+/g, "-") : tool === "actions" ? name.toLowerCase() : name;
  return `${tool}\u0000${n}\u0000${version.replace(/^v/, "")}`;
}

/** The packages with at least one vulnerability in the JSON report of osv-scanner. undefined when it is not a report. */
export function parseOsvReport(text: string): OsvFinding[] | undefined {
  let j: unknown;
  try {
    j = JSON.parse(String(text ?? "").trim() || "{}");
  } catch {
    return undefined;
  }
  if (!isObj(j)) return undefined;
  const out: OsvFinding[] = [];
  const seen = new Set<string>();
  for (const res of Array.isArray(j.results) ? j.results : []) {
    if (!isObj(res)) continue;
    for (const p of Array.isArray(res.packages) ? res.packages : []) {
      if (!isObj(p) || !isObj(p.package) || !Array.isArray(p.vulnerabilities) || p.vulnerabilities.length === 0) continue;
      const { name, version, ecosystem } = p.package;
      if (typeof name !== "string" || typeof version !== "string" || typeof ecosystem !== "string" || name.length > 300 || version.length > 100) continue;
      const eco = ecosystem.split(":")[0]!;
      const key = `${eco}\u0000${name}\u0000${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ecosystem: eco, name, version });
    }
  }
  return out;
}

/** Exit 0 (nothing found) and 1 (something found) are normal; 128 means the scanner found no package files. */
export function osvFromRun(r: ToolRun): OsvResult {
  const none = (note: string): OsvResult => ({ installed: true, ok: false, note, findings: [] });
  if (r.error?.code === "ENOENT") return { installed: false, ok: false, findings: [] };
  const f = toolFailure("osv-scanner", r, OSV_TIMEOUT_MS);
  if (f) return none(f);
  if (r.status === 128) return { installed: true, ok: true, findings: [] };
  if (r.status !== 0 && r.status !== 1) return none(`osv-scanner failed with exit code ${r.status ?? "none"}`);
  const findings = parseOsvReport(r.stdout ?? "");
  if (!findings) return none(oneLine("the output of osv-scanner is not a JSON report"));
  return { installed: true, ok: true, findings };
}
