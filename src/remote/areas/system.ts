import { cols, fields, table } from "../render.js";
import type { Cmd } from "../spec.js";

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
  { area: "watchers", action: "tick", method: "POST", path: "watchers/:id/tick", args: ["id"], help: "run a watcher's check now" },
];
