import { cols, fields, table } from "../render.js";
import type { Cmd } from "../spec.js";

interface PluginsAnswer {
  plugins?: { label: string; version: string; module: string; registered?: { point: string; name: string }[] }[];
  problems?: { plugin: string; reason: string }[];
}

function pluginsText(d: unknown): string {
  const a = (d ?? {}) as PluginsAnswer;
  const rows = (a.plugins ?? []).map((p) => ({
    plugin: p.label, version: p.version, module: p.module,
    registered: p.registered?.length ? p.registered.map((x) => `${x.point} ${x.name}`).join(", ") : "nothing yet",
  }));
  const problems = (a.problems ?? []).map((p) => `problem: ${p.plugin}: ${p.reason}`);
  return [table(rows, cols("plugin", "version", "registered", "module"), "no plugins loaded"), ...problems].join("\n");
}

interface ServicesAnswer {
  services?: { name: string; state: string; restarts: number; lastExit?: { code: number | null; signal: string | null; at: string }; problem?: string }[];
}

function servicesText(d: unknown): string {
  const rows = ((d ?? {}) as ServicesAnswer).services ?? [];
  return table(rows.map((s) => ({
    name: s.name, state: s.state, restarts: String(s.restarts),
    "last exit": s.lastExit ? `${s.lastExit.code !== null ? `code ${s.lastExit.code}` : `signal ${s.lastExit.signal}`} at ${s.lastExit.at}` : "",
    problem: s.problem ?? "",
  })), cols("name", "state", "restarts", "last exit", "problem"), "no services configured");
}

/** The server itself and its watchers: the template for the other areas. */
export const SYSTEM: Cmd[] = [
  { area: "server", action: "info", method: "GET", path: "info", show: (d) => fields(d) },
  { area: "server", action: "health", method: "GET", path: "health" },
  { area: "server", action: "queue", method: "GET", path: "queue" },
  { area: "server", action: "stats", method: "GET", path: "stats" },
  { area: "server", action: "clean", method: "POST", path: "clean", confirm: "This removes the workspaces of old runs.", fixed: { dryRun: false },
    flags: { "older-than": { type: "string", as: "number", key: "olderThanDays", help: "only runs older than this many days (default 7)" }, "evidence-older-than": { type: "string", as: "number", key: "evidenceOlderThanDays", help: "also remove the evidence of cleaned runs older than this many days" }, purge: { type: "boolean", help: "remove the runs too, not only their workspaces" }, "include-paused": { type: "boolean", help: "also clean paused runs" }, "dry-run": { type: "boolean", help: "only say what would be removed" } } },
  { area: "watchers", action: "list", method: "GET", path: "watchers",
    show: (d) => table(Array.isArray(d) ? d : ((d as { watchers?: unknown[] })?.watchers ?? []), [...cols("id", "source", "flow", "every", "enabled"), { key: "github_repo", head: "repository" }], "no watchers") },
  { area: "plugins", action: "list", method: "GET", path: "plugins", help: "the plugins loaded at server start, in order", show: pluginsText },
  { area: "services", action: "list", method: "GET", path: "health", help: "the managed services: state, restarts and last exit", show: servicesText },
  { area: "watchers", action: "tick", method: "POST", path: "watchers/:id/tick", args: ["id"], help: "run a watcher's check now" },
  { area: "watchers", action: "pause", method: "POST", path: "watchers/:id/pause", args: ["id"], help: "pause a watcher: no new runs, running runs go on", show: (d) => fields(d) },
  { area: "watchers", action: "resume", method: "POST", path: "watchers/:id/resume", args: ["id"], help: "resume a paused watcher", show: (d) => fields(d) },
];
