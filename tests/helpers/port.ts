import { createServer, type AddressInfo } from "node:net";
import { startServer, type ServerOptions } from "../../src/server/server.js";

/** Starts a server on a free port picked by the system. `base` is http://127.0.0.1:<port>. */
export async function startTestServer(opts: Omit<ServerOptions, "port">): Promise<Awaited<ReturnType<typeof startServer>> & { base: string }> {
  const started = await startServer({ ...opts, port: 0 });
  return { ...started, base: `http://127.0.0.1:${started.port}` };
}

/** A port that was free a moment ago. Only for a child process that needs --port, or a port that must stay closed. */
export function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, host, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
