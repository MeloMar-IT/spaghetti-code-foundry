import { z } from "zod";
import { guardedLine, type GuardOptions } from "../help/guard.js";
import type { ToolResult } from "../help/tools.js";
import type { Source } from "../help/turn.js";
import { stateId } from "./help-evidence.js";

/**
 * The `github_status` look-up of Ask Foundry: GitHub's public status page. The address is fixed, nothing of the person
 * or the Foundry goes with the request (no token, no redirect is followed), and both the time and the size of the answer
 * are limited while it is read. Every text of the page is untrusted.
 */

export const STATUS_URL = "https://www.githubstatus.com/api/v2/summary.json";
export const STATUS_PAGE = "https://www.githubstatus.com";
export const STATUS_UNREADABLE = "GitHub's status page could not be read, or did not answer in time.";
/** The time for the headers and the body together, and the largest answer that is read. */
export const STATUS_TIMEOUT_MS = 5000;
export const STATUS_BYTES_MAX = 512_000;
const INCIDENTS = 5;
const PARTS = 10;

export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: "error"; headers: Record<string, string> }) => Promise<Response>;

export interface StatusOptions {
  /** Tests inject it; otherwise Node's `fetch`. */
  fetch?: FetchLike;
  statusTimeoutMs?: number;
}

const SummarySchema = z.object({
  status: z.object({ indicator: z.string(), description: z.string() }),
  components: z.array(z.object({ name: z.string(), status: z.string(), group: z.boolean().nullish() })),
  incidents: z.array(z.object({ name: z.string(), status: z.string(), impact: z.string().nullish() })),
});
type Summary = z.infer<typeof SummarySchema>;

const drop = (what: { cancel(): Promise<unknown> } | null | undefined): void => {
  // never waited for: a cancel may hang
  try {
    void what?.cancel().catch(() => {});
  } catch {
    // a locked or broken stream: the abort of the request ends it
  }
};

/** The body of the answer as text, within the time and size limits. Throws for anything else. */
async function readSummary(o: StatusOptions): Promise<string> {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  /** One race for the headers and every part of the body: a fetch that ignores the abort cannot hold the look-up. */
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("too slow")), o.statusTimeoutMs ?? STATUS_TIMEOUT_MS);
  });
  late.catch(() => {});
  let body: Response["body"] | undefined;
  let reader: ReturnType<NonNullable<Response["body"]>["getReader"]> | undefined;
  let done = false;
  try {
    const get: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
    const pending = get(STATUS_URL, { signal: abort.signal, redirect: "error", headers: { accept: "application/json" } });
    // an answer that comes after the limit is let go
    pending.then((r) => abort.signal.aborted && drop(r.body), () => {});
    const response = await Promise.race([pending, late]);
    body = response.body;
    if (!response.ok) throw new Error("not OK");
    if (Number(response.headers.get("content-length") ?? 0) > STATUS_BYTES_MAX) throw new Error("too large");
    if (!body) throw new Error("no body");
    reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), late]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > STATUS_BYTES_MAX) throw new Error("too large");
      chunks.push(part.value);
    }
    done = true;
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    if (!done) {
      abort.abort();
      drop(reader ?? body);
    }
  }
}

function statusSources(s: Summary, guard: GuardOptions): Source[] {
  const observedAt = new Date().toISOString();
  const word = (v: string) => guardedLine(v, guard, 30);
  const more = (total: number, shown: number) => (total > shown ? [`and ${total - shown} more`] : []);
  const source = (part: string, title: string, lines: string[]): Source => ({
    id: stateId("github-status", part),
    kind: "state",
    title,
    ref: STATUS_PAGE,
    observedAt,
    excerpt: [`Observed by the server at ${observedAt}, from GitHub's public status page.`, ...lines].join("\n"),
  });
  const incidents = s.incidents.filter((i) => i.status !== "resolved" && i.status !== "postmortem");
  const broken = s.components.filter((c) => c.status !== "operational" && c.group !== true);
  const out = [
    source("overall", "GitHub's status: overall and open incidents", [
      `overall: ${guardedLine(s.status.description, guard, 100)} (${word(s.status.indicator)})`,
      ...(incidents.length ? ["open incidents:"] : ["open incidents: none"]),
      ...incidents.slice(0, INCIDENTS).map((i) => `- ${guardedLine(i.name, guard, 90)} · ${word(i.status)}${i.impact ? ` · impact ${word(i.impact)}` : ""}`),
      ...more(incidents.length, INCIDENTS),
    ]),
  ];
  if (broken.length) {
    out.push(
      source("parts", "GitHub's status: parts that are not operational", [
        ...broken.slice(0, PARTS).map((c) => `- ${guardedLine(c.name, guard, 50)}: ${word(c.status)}`),
        ...more(broken.length, PARTS),
      ]),
    );
  }
  return out;
}

export async function githubStatusTool(guard: GuardOptions, o: StatusOptions = {}): Promise<ToolResult> {
  let summary: Summary;
  try {
    summary = SummarySchema.parse(JSON.parse(await readSummary(o)));
  } catch {
    return { note: STATUS_UNREADABLE, sources: [] };
  }
  return { note: "Read GitHub's status page.", sources: statusSources(summary, guard) };
}
