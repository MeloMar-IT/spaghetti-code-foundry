import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isGalleryPath } from "../src/server/http.js";
import { CSP } from "../src/server/net.js";
import { startServer } from "../src/server/server.js";

// The gallery (ui/gallery/) is served only with `dev`: #326.

interface Reply { status: number; type: string; csp: string; body: string }
interface Srv { port: number; close: () => void }

/** A raw request: the path goes out as written (encoded slashes, `..`). */
function get(port: number, path: string): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `localhost:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        ok({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), csp: String(res.headers["content-security-policy"] ?? ""), body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", fail);
    req.end();
  });
}

// Other test files pick from 20000-40000 without a retry; stay out of their range so this file cannot make them collide.
const randomPort = () => 40500 + Math.floor(Math.random() * 8000);

let tmp: string;
let saved: string | undefined;
const servers: Srv[] = [];
let on: Srv;
let off: Srv;

async function boot(dev: boolean): Promise<Srv> {
  for (let i = 0; ; i++) {
    const port = randomPort();
    try {
      const s = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, watchers: false, dev, log: () => {} });
      const srv = { port, close: () => s.close() };
      servers.push(srv);
      return srv;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i > 8) throw e;
    }
  }
}

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "factory-gallery-"));
  mkdirSync(join(tmp, "home"));
  process.env.FACTORY_HOME = join(tmp, "home");
  on = await boot(true);
  off = await boot(false);
});
afterAll(() => {
  for (const s of servers) s.close();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("with dev", () => {
  it("serves the page", async () => {
    for (const p of ["/gallery/", "/gallery"]) {
      const r = await get(on.port, p);
      expect(r.status, p).toBe(200);
      expect(r.type).toContain("text/html");
      expect(r.body).toContain("/gallery/gallery.js");
    }
  });
  it("serves its scripts and style, and 404 for a file that is not there", async () => {
    for (const p of ["/gallery/gallery.js", "/gallery/registry.js", "/gallery/view.js"]) {
      const r = await get(on.port, p);
      expect(r.status, p).toBe(200);
      expect(r.type, p).toContain("javascript");
    }
    expect(await get(on.port, "/gallery/nope.js")).toMatchObject({ status: 404 });
    expect((await get(on.port, "/css/pages/gallery.css")).status).toBe(200);
  });
  it("keeps the content security policy", async () => {
    expect((await get(on.port, "/gallery/")).csp).toBe(CSP);
  });
});

describe("without dev", () => {
  it.each([
    "/gallery", "/gallery/", "/gallery/index.html", "/gallery/gallery.js", "/gallery/registry.js",
    "/Gallery/", "/GALLERY/gallery.js",
    "/x/..%2fgallery/gallery.js", "/gallery%2fgallery.js", "/user/..%2fgallery/", "/x/%2e%2e/gallery/", "/x%5c..%5cgallery/gallery.js",
  ])("answers 404 for %s", async (p) => {
    expect((await get(off.port, p)).status).toBe(404);
  });
  it("still serves the rest of the UI", async () => {
    for (const p of ["/", "/style.css", "/kit/kit.css", "/user/", "/accessibility.html"]) expect((await get(off.port, p)).status, p).toBe(200);
  });
});

describe("isGalleryPath", () => {
  it("is true for every spelling that reaches the gallery", () => {
    for (const p of ["/gallery", "/gallery/", "/gallery/a.js", "/Gallery/a", "/x/../gallery/a", "/x\\..\\gallery/a", "/./gallery"]) expect(isGalleryPath(p), p).toBe(true);
  });
  it("is false for other paths", () => {
    for (const p of ["/", "/style.css", "/gallery.js", "/gallery-old/a", "/kit/gallery/a", "/user/", "/gallery/../style.css"]) expect(isGalleryPath(p), p).toBe(false);
  });
});

describe("the commands pass --dev to the server", () => {
  const CLI = resolve("dist/cli.js");
  const children: ChildProcess[] = [];
  afterAll(() => {
    for (const c of children) c.kill();
  });

  /** Starts `scf <args>` unsupervised, waits for its banner and returns the status of /gallery/. */
  async function galleryStatus(args: string[]): Promise<number> {
    if (!existsSync(CLI)) throw new Error("dist/cli.js is missing — run `npm run build` first");
    const port = randomPort();
    const repo = join(tmp, "cli-repo");
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env, FACTORY_HOME: join(tmp, "cli-home"), FACTORY_NO_SUPERVISE: "1", FACTORY_NO_OPEN: "1", FACTORY_NO_NOTIFY: "1" };
    const child = spawn(process.execPath, [CLI, ...args, "--port", String(port), "--repo", repo], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const until = Date.now() + 20_000;
    while (!out.includes("Ctrl+C to stop") && child.exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    if (!out.includes("Ctrl+C to stop")) throw new Error(`the server did not start: ${out}`);
    try {
      return (await get(port, "/gallery/")).status;
    } finally {
      child.kill();
    }
  }

  it("scf ui --dev and scf serve --dev serve /gallery/, scf serve does not", async () => {
    mkdirSync(join(tmp, "cli-home"), { recursive: true });
    const [ui, serve, plain] = await Promise.all([galleryStatus(["ui", "--dev", "--no-open"]), galleryStatus(["serve", "--dev"]), galleryStatus(["serve"])]);
    expect({ ui, serve, plain }).toEqual({ ui: 200, serve: 200, plain: 404 });
  }, 60_000);
});
