import type { IncomingMessage, ServerResponse } from "node:http";
import { open, realpath } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { MAX_FILE_BYTES } from "../plugins/ui.js";
import { requireSession } from "./api-auth.js";
import { HttpError } from "./http.js";
import { authorizePlugin, findPluginRule } from "./permissions.js";
import type { ApiContext } from "./server.js";
import { USER_ERROR } from "./user-view.js";

/** The files of plugins are served under /plugins/<name>/<file>. */
export const PLUGIN_PATH = "/plugins/";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const NOT_FOUND = "not found";
const UNREADABLE = "plugin file could not be read";

const inside = (file: string, folder: string) => file === folder || file.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/** Reads a registered file by its real path, which must lie inside the real folder and outside every blocked one. Nothing is written to `res` here. */
async function readRegistered(dir: string, blocked: readonly string[], rel: string): Promise<Buffer> {
  let real: string;
  let root: string;
  try {
    [root, real] = await Promise.all([realpath(dir), realpath(join(dir, rel))]);
  } catch {
    throw new HttpError(404, NOT_FOUND);
  }
  if (!inside(real, root) || blocked.some((b) => inside(real, b))) throw new HttpError(404, NOT_FOUND);
  let handle;
  try {
    handle = await open(real, "r");
    const st = await handle.stat();
    if (!st.isFile()) throw new HttpError(404, NOT_FOUND);
    if (st.size > MAX_FILE_BYTES) throw new HttpError(500, UNREADABLE);
    return await handle.readFile();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, UNREADABLE);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Answers a request under /plugins/. In this order: session (401), rule (404), role (403), then the file is read, and only
 * then the headers are written. Every failure answers a fixed text: no path, no error message.
 */
export async function servePluginFile(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? "GET";
  const send = (status: number, text: string) => void res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
  try {
    const user = await requireSession(ctx, req, method);
    const [plugin, ...rest] = path.slice(PLUGIN_PATH.length).split("/");
    const entries = ctx.plugins?.ui ?? [];
    const rule = findPluginRule(entries, method, plugin ?? "", rest.join("/"));
    if (!rule) throw new HttpError(404, NOT_FOUND);
    authorizePlugin(user, rule);
    const entry = entries.find((e) => e.name === rule.plugin)!;
    const body = await readRegistered(entry.dir, entry.blocked, rule.path);
    res.writeHead(200, { "content-type": TYPES[extname(rule.path)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(body);
  } catch (e) {
    if (res.headersSent) return void res.destroy();
    if (e instanceof HttpError) return send(e.status, e.message);
    ctx.opts.log?.(`plugin file ${path.slice(0, 200)}: ${(e as Error).message}`);
    send(500, USER_ERROR);
  }
}
