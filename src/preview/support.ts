import { createServer } from "node:net";
import { KNOWN_KEY_VARS, providerKeyVars } from "../agents/targets.js";
import type { Config } from "../config.js";
import { SHORT_ENV } from "../engine/short-env.js";
import { inheritedEnv } from "../steps/process.js";
import type { PreviewConfig } from "./config.js";

export const MAX_OUTPUT = 64 * 1024;
export const HOST = "127.0.0.1";

/**
 * The whole environment of a preview: the SHORT_ENV names of the server (never a provider's key variable, also not
 * when the config names one like `HOME`), then the file's `env`, then PORT and HOST (which replace the file's).
 * Nothing else is inherited: no prefix lists, no admin pass lists.
 */
export function previewEnv(
  config: Pick<PreviewConfig, "env">,
  port: number,
  providers: Pick<Config, "providers">,
  source: NodeJS.ProcessEnv = inheritedEnv(),
): Record<string, string> {
  const keys = new Set([...providerKeyVars(providers), ...KNOWN_KEY_VARS]);
  const out: Record<string, string> = {};
  for (const name of SHORT_ENV) {
    const value = source[name];
    if (value !== undefined && !keys.has(name)) out[name] = value;
  }
  Object.assign(out, config.env);
  out.PORT = String(port);
  out.HOST = HOST;
  return out;
}

/** A free port on 127.0.0.1 (it may be taken before it is used). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Whether nothing listens on 127.0.0.1:port right now. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.on("error", () => resolve(false));
    srv.listen(port, HOST, () => srv.close(() => resolve(true)));
  });
}

/** The last `MAX_OUTPUT` UTF-8 bytes of the text pushed, cut at whole characters. */
export class OutputBuffer {
  private chunks: string[] = [];
  private bytes = 0;

  push(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.bytes += Buffer.byteLength(text, "utf8");
    while (this.bytes > MAX_OUTPUT && this.chunks.length) {
      const first = this.chunks[0]!;
      const size = Buffer.byteLength(first, "utf8");
      const excess = this.bytes - MAX_OUTPUT;
      if (excess >= size) {
        this.chunks.shift();
        this.bytes -= size;
        continue;
      }
      const buf = Buffer.from(first, "utf8");
      let cut = excess;
      while (cut < buf.length && (buf[cut]! & 0xc0) === 0x80) cut++; // not inside a character
      const rest = buf.subarray(cut).toString("utf8");
      this.chunks[0] = rest;
      this.bytes = this.bytes - size + buf.length - cut;
    }
  }

  text(): string {
    return this.chunks.join("");
  }
}
