import http from "node:http";
import https from "node:https";
import { isShareEndpoint } from "../config.js";
import type { ShareReport } from "./report.js";

// One exchange with the metrics receiver (#889). This is the only network call of the shared metrics.
// node:http/node:https instead of fetch: fetch adds headers of its own, and only the report and a fixed User-Agent may go out.
// No agent (no connection reuse), no redirect is followed (http.request never does), no cookie is kept or sent.
// Of the answer only the status and an optional `retry_after` (seconds, in a JSON body of at most 4 KB) are read.

/** Only this much of an answer is read. */
export const MAX_ANSWER_BYTES = 4096;
/** The longest `retry_after` that is taken, in seconds. */
export const MAX_RETRY_AFTER_S = 86_400;

export interface PushResult {
  /** "error": the report could not be built, so nothing was sent. */
  result: "accepted" | "refused" | "unreachable" | "error";
  status?: number;
  retryAfterS?: number;
}

export interface PushTarget {
  endpoint: string;
  timeoutMs: number;
  /** The Foundry version, for the User-Agent. */
  version: string;
}

export const userAgent = (version: string): string => `spaghetti-code-foundry/${/^[\w.+-]{1,64}$/.test(version) ? version : "unknown"}`;

/** `<endpoint>/<install>`. */
export const deleteUrl = (endpoint: string, install: string): string => `${endpoint.replace(/\/+$/, "")}/${install}`;

/** `retry_after` of a JSON answer: a whole number of seconds from 1 to 86400, else undefined. */
export function retryAfterOf(body: string): number | undefined {
  try {
    const v = (JSON.parse(body) as { retry_after?: unknown } | null)?.retry_after;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_RETRY_AFTER_S ? v : undefined;
  } catch {
    return undefined;
  }
}

function exchange(method: "POST" | "DELETE", url: string, body: Buffer | undefined, t: PushTarget, signal?: AbortSignal): Promise<PushResult> {
  return new Promise<PushResult>((resolve) => {
    if (!isShareEndpoint(url) || signal?.aborted) return resolve({ result: "unreachable" });
    let done = false;
    let req: http.ClientRequest | undefined;
    const finish = (r: PushResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      req?.destroy();
      resolve(r);
    };
    const onAbort = () => finish({ result: "unreachable" });
    const timer = setTimeout(() => finish({ result: "unreachable" }), t.timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const u = new URL(url);
      const headers: Record<string, string> = {
        "User-Agent": userAgent(t.version),
        "Content-Length": String(body?.length ?? 0),
        Connection: "close",
      };
      if (body) headers["Content-Type"] = "application/json";
      const mod = u.protocol === "https:" ? https : http;
      req = mod.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname, method, headers, agent: false }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          // a success is final as soon as the status arrives: the body is neither waited for nor read
          res.resume();
          return finish({ result: "accepted", status });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const answer = () => {
          const retryAfterS = size <= MAX_ANSWER_BYTES ? retryAfterOf(Buffer.concat(chunks).toString("utf8")) : undefined;
          finish({ result: "refused", ...(status >= 100 && status <= 999 ? { status } : {}), ...(retryAfterS ? { retryAfterS } : {}) });
        };
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) return answer(); // the rest is ignored
          chunks.push(c);
        });
        res.on("end", answer);
        res.on("error", answer);
        res.on("aborted", answer);
      });
      req.on("error", () => finish({ result: "unreachable" }));
      req.end(body);
    } catch {
      finish({ result: "unreachable" });
    }
  });
}

/** POSTs the report to the endpoint. Never rejects. */
export function sendReport(t: PushTarget, report: ShareReport, signal?: AbortSignal): Promise<PushResult> {
  return exchange("POST", t.endpoint, Buffer.from(JSON.stringify(report)), t, signal);
}

/** DELETEs what the install sent: `DELETE <endpoint>/<install>`. Never rejects. */
export function sendDelete(t: PushTarget, install: string, signal?: AbortSignal): Promise<PushResult> {
  if (!/^[0-9a-f]{32}$/.test(install)) return Promise.resolve({ result: "unreachable" });
  return exchange("DELETE", deleteUrl(t.endpoint, install), undefined, t, signal);
}
