import { cols, fields, pick, table } from "../render.js";
import type { Cmd } from "../spec.js";

type Row = Record<string, unknown>;
const rows = (d: unknown, path: string): Row[] => {
  const v = pick(d, path);
  return Array.isArray(v) ? (v as Row[]) : [];
};

/** One conversation: its head, then every message with who wrote it. */
function showConversation(d: unknown): string {
  const head = fields({ id: pick(d, "id"), title: pick(d, "title"), state: pick(d, "state"), updated: pick(d, "updated") });
  const messages = rows(d, "messages").map((m) => `${m.role === "user" ? "You" : "Ask SCF"}${m.status === "done" ? "" : ` (${String(m.status)})`}:\n${String(m.text ?? "")}`);
  return [head, ...messages].join("\n\n");
}

/** Ask SCF, the help assistant: your own conversations. The area is `ask`, because `help` is the help of the command line. */
export const HELP: Cmd[] = [
  { area: "ask", action: "list", method: "GET", path: "help/conversations", flags: { archived: { type: "boolean", value: "1", help: "the archived conversations" } },
    show: (d) => table(rows(d, "conversations"), [...cols("id"), { key: "title", max: 50 }, ...cols("state", "messages", "updated")], "no conversations") },
  { area: "ask", action: "show", method: "GET", path: "help/conversations/:id", args: ["id"], show: showConversation },
  { area: "ask", action: "complete", method: "POST", path: "help/conversations/:id/complete", args: ["id"], show: showConversation },
  { area: "ask", action: "archive", method: "POST", path: "help/conversations/:id/archive", args: ["id"], show: showConversation },
  { area: "ask", action: "restore", method: "POST", path: "help/conversations/:id/restore", args: ["id"], show: showConversation },
  { area: "ask", action: "new", method: "POST", path: "help/conversations", args: ["question"], help: "ask a question in a new conversation; read the answer with `scf ask show <id>`", show: showConversation },
  { area: "ask", action: "more", method: "POST", path: "help/conversations/:id/messages", args: ["id", "question"], show: showConversation },
  { area: "ask", action: "retry", method: "POST", path: "help/conversations/:id/retry", args: ["id"], show: showConversation },
  { area: "ask", action: "stop", method: "POST", path: "help/conversations/:id/cancel", args: ["id"], show: showConversation },
  { area: "ask", action: "usage", method: "GET", path: "help/usage",
    show: (d) => [fields({ enabled: pick(d, "enabled"), provider: pick(d, "provider.target") ?? pick(d, "provider.problem"), "turns today": pick(d, "today.turns"), "cost today": pick(d, "today.costUsd"), running: pick(d, "now.running"), queued: pick(d, "now.queued") }), table(rows(d, "days"), [...cols("day"), { key: "ownerName", head: "account" }, ...cols("turns", "failed", "costUsd", "inputTokens", "outputTokens")], "no usage yet")].join("\n\n") },
  { area: "ask", action: "delete", method: "DELETE", path: "help/conversations/:id", args: ["id"], confirm: "This removes the conversation and its messages for good.", show: (d) => fields({ id: pick(d, "id"), state: pick(d, "state") }) },
];
