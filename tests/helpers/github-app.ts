import { createVerify, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/** What the fake answers instead of the normal answer, for the lookup or the token call. */
export type Forced = { status: number; body?: string; headers?: Record<string, string> } | "network" | "hang" | { raw: string };

export interface FakeGithubApp {
  appId: string;
  slug: string;
  /** The private key file (0600, made at run time). */
  keyPath: string;
  /** The PEM text of the private key, to check that no answer or log holds a line of it. */
  pem: string;
  /** The installations as "owner/name" (lower case) → installation id. */
  installs: Map<string, number>;
  /** Every request to https://api.github.com/, in order. */
  calls: { method: string; path: string; body?: unknown; hasBody: boolean }[];
  /** Every token the fake made. */
  tokens: string[];
  /** Forces the answer of the lookup (`GET /repos/…/installation`) or the token call. */
  force: { lookup?: Forced; token?: Forced };
  /** The config.yaml section for this app. */
  config: (over?: object) => { app_id: string; private_key_path: string; slug: string };
  restore: () => void;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Stands in for api.github.com (the global `fetch` for that host only; every other address goes to the real one, because the
 * API tests call the local server with it). It checks the RS256 signature and `iss` of every JWT.
 */
export function fakeGithubApp(): FakeGithubApp {
  const dir = mkdtempSync(join(tmpdir(), "fake-github-app-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyPath = join(dir, "app.pem");
  writeFileSync(keyPath, pem, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const pub: KeyObject = publicKey;
  const app: FakeGithubApp = {
    appId: String(100000 + (randomBytes(2).readUInt16BE() % 800000)),
    slug: "foundry-test-app",
    keyPath,
    pem,
    installs: new Map(),
    calls: [],
    tokens: [],
    force: {},
    config: (over = {}) => ({ app_id: app.appId, private_key_path: keyPath, slug: app.slug, ...over }),
    restore: () => {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  const real = globalThis.fetch;

  const signedBy = (auth: string | null): boolean => {
    const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth ?? "");
    if (!m) return false;
    try {
      const ok = createVerify("RSA-SHA256").update(`${m[1]}.${m[2]}`).verify(pub, Buffer.from(m[3]!, "base64url"));
      const payload = JSON.parse(Buffer.from(m[2]!, "base64url").toString()) as { iss?: string; exp?: number; iat?: number };
      return ok && payload.iss === app.appId && typeof payload.exp === "number" && payload.exp > Date.now() / 1000;
    } catch {
      return false;
    }
  };

  const forced = (f: Forced | undefined, signal: AbortSignal | null | undefined): Promise<Response> | undefined => {
    if (!f) return undefined;
    if (f === "network") return Promise.reject(new TypeError("fetch failed"));
    if (f === "hang") {
      return new Promise((_, reject) => {
        const stop = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop);
      });
    }
    if ("raw" in f) return Promise.resolve(new Response(f.raw, { status: 200 }));
    return Promise.resolve(new Response(f.body ?? "{}", { status: f.status, ...(f.headers ? { headers: f.headers } : {}) }));
  };

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.github.com/")) return real(input as never, init);
    const path = url.slice("https://api.github.com".length);
    const method = (init?.method ?? "GET").toUpperCase();
    const hasBody = init?.body !== undefined;
    app.calls.push({ method, path, hasBody, ...(hasBody ? { body: JSON.parse(String(init!.body)) } : {}) });
    const headers = new Headers(init?.headers);
    if (!signedBy(headers.get("authorization"))) return json(401, { message: "A JSON web token could not be decoded" });
    const lookup = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
    if (method === "GET" && lookup) {
      const f = forced(app.force.lookup, init?.signal);
      if (f) return f;
      const id = app.installs.get(`${decodeURIComponent(lookup[1]!)}/${decodeURIComponent(lookup[2]!)}`.toLowerCase());
      return id === undefined ? json(404, { message: "Not Found" }) : json(200, { id });
    }
    const tok = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(path);
    if (method === "POST" && tok) {
      const f = forced(app.force.token, init?.signal);
      if (f) return f;
      const id = Number(tok[1]);
      const mine = [...app.installs.entries()].filter(([, v]) => v === id).map(([k]) => k);
      if (!mine.length) return json(404, { message: "Not Found" });
      const wanted = (JSON.parse(String(init?.body ?? "{}")) as { repositories?: string[] }).repositories;
      if (wanted && !wanted.every((n) => mine.some((k) => k.split("/")[1] === n.toLowerCase()))) return json(422, { message: "Validation Failed" });
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      app.tokens.push(token);
      return json(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return json(404, { message: "Not Found" });
  });
  return app;
}
