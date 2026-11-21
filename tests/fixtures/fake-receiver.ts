import http from "node:http";
import type { AddressInfo } from "node:net";

// A fake metrics receiver on 127.0.0.1 (#889): records every request and answers with what `answer` says.

export interface Got { method: string; url: string; headers: http.IncomingHttpHeaders; rawHeaders: string[]; body: string }
/** `hold`: the status and headers go out, the body never ends. */
export type Answer = { status: number; body?: string; headers?: Record<string, string>; hold?: boolean } | "hang";

export interface FakeReceiver {
  /** http://127.0.0.1:<port> */
  base: string;
  /** base + /api/metrics */
  endpoint: string;
  got: Got[];
  answer: (g: Got) => Answer;
  close(): Promise<void>;
}

export async function fakeReceiver(answer: (g: Got) => Answer = () => ({ status: 200, body: "{}" })): Promise<FakeReceiver> {
  const r: FakeReceiver = { base: "", endpoint: "", got: [], answer, close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const g: Got = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString("utf8") };
      r.got.push(g);
      const a = r.answer(g);
      if (a === "hang") return;
      if (a.hold) {
        res.writeHead(a.status, a.headers ?? {});
        res.write("{");
        return;
      }
      res.writeHead(a.status, a.headers ?? {});
      res.end(a.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  r.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  r.endpoint = `${r.base}/api/metrics`;
  r.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return r;
}
