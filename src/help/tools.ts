import { z } from "zod";
import { sinceMs } from "../since-date.js";
import { guardExcerpt, type GuardOptions } from "./guard.js";
import type { Asker, Source } from "./turn.js";

/**
 * The look-ups Ask Foundry can ask the server for while it answers: a fixed list of read-only tools. Pure: what the
 * tools are, how a request of a model is checked, and the words about them. The server carries a call out
 * (`server/help-tools.ts`). A model call itself never has a tool: a request is only a text it answers with.
 */

export const TOOL_NAMES = ["list_runs", "show_run"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const ListRunsSchema = z
  .object({
    status: z.enum(["running", "succeeded", "failed", "cancelled", "stopped", "waiting"]).optional(),
    repo: z.string().max(200).regex(/^[\w.-]+\/[\w.-]+$/).optional(),
    flow: z.string().regex(/^[\w.-]{1,100}$/).optional(),
    q: z.string().min(1).max(100).optional(),
    since: z.string().max(40).refine((v) => sinceMs(v) !== undefined).optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type ListRunsArgs = z.infer<typeof ListRunsSchema>;

const ShowRunSchema = z.object({ id: z.string().regex(/^[\w-]{1,100}$/) }).strict();
export type ShowRunArgs = z.infer<typeof ShowRunSchema>;

export type ToolCall = { tool: "list_runs"; args: ListRunsArgs } | { tool: "show_run"; args: ShowRunArgs };

export interface ToolDef {
  name: ToolName;
  readOnly: true;
  /** The API call that reads the same thing: its rule decides who may make the look-up. */
  call: { method: "GET"; path: "runs" | "runs/:id" };
  description: string;
  args: z.ZodType;
}

export const TOOLS: readonly ToolDef[] = [
  {
    name: "list_runs",
    readOnly: true,
    call: { method: "GET", path: "runs" },
    description: 'The newest runs this person may see. `args`, all optional: "status" (running, succeeded, failed, cancelled, stopped or waiting), "repo" ("owner/name"), "flow", "q" (words to search for), "since" (an ISO date), "archived" (true or false).',
    args: ListRunsSchema,
  },
  {
    name: "show_run",
    readOnly: true,
    call: { method: "GET", path: "runs/:id" },
    description: 'The detail of one run: its steps, errors, status and what happens next. `args`: "id" (the id of the run).',
    args: ShowRunSchema,
  },
];

/** What a look-up gave: a short note for the log, and the sources a reply may cite. */
export interface ToolResult {
  note: string;
  sources: Source[];
}

/** Carries one checked call out, for the asking account as it is now. */
export type ToolRunner = (asker: Asker, call: ToolCall) => Promise<ToolResult>;

export const REFUSED = ["unknown-tool", "bad-request", "bad-arguments"] as const;
export type Refused = (typeof REFUSED)[number];

/** The only words about a refused request: nothing a model sent is repeated. */
export const REFUSED_WORDS: Record<Refused, string> = {
  "unknown-tool": "Refused: there is no such look-up.",
  "bad-request": 'Refused: a look-up request holds only "tool" and "args".',
  "bad-arguments": "Refused: the arguments of this look-up are not accepted.",
};

/** The longest note of a look-up in the log. */
export const NOTE_MAX = 300;

export type ParsedCall = { kind: "reply" } | { kind: "tool"; call: ToolCall } | { kind: "refused"; code: Refused };

const refused = (code: Refused): ParsedCall => ({ kind: "refused", code });

/**
 * What a model's answer asks for. Anything without its own `tool` key is a reply. A request is checked against the
 * list before any tool runs; a free text of it that the guard would change or hold back is not accepted.
 * Throws `GuardError` when a text cannot be checked.
 */
export function parseToolCall(raw: unknown, guard: GuardOptions = {}): ParsedCall {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !Object.hasOwn(raw, "tool")) return { kind: "reply" };
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "tool" && k !== "args")) return refused("bad-request");
  const def = TOOLS.find((t) => t.name === o.tool);
  if (!def) return refused("unknown-tool");
  const args = def.args.safeParse(o.args === undefined ? {} : o.args);
  if (!args.success) return refused("bad-arguments");
  const values = args.data as Record<string, unknown>;
  for (const key of ["q", "repo", "flow"]) {
    const v = values[key];
    if (typeof v !== "string") continue;
    const g = guardExcerpt(v, guard);
    if (g.withheld || g.removed.length > 0 || g.text !== v) return refused("bad-arguments");
  }
  return { kind: "tool", call: { tool: def.name, args: values } as ToolCall };
}

/** The part of the prompt that offers the look-ups; `left` is how many can still be made. */
export function toolsPart(left: number): string[] {
  return [
    `TOOLS (read-only look-ups the server can do for this person; at most ${left} more). To make one, answer with only this JSON object instead of a reply: {"tool": the name, "args": {…}}. Make one only when the answer needs it; then you are asked again, with what it gave.`,
    ...TOOLS.map((t) => `- ${t.name}: ${t.description}`),
  ];
}
