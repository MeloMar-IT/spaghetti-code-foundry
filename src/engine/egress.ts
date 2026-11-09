import { promises as dns } from "node:dns";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import type { Target } from "../agents/targets.js";
import { currentWorkspaces } from "../workspaces/index.js";

/**
 * The network of a team's step (#785). Seatbelt cannot filter by host name, so a held step may only connect to one
 * loopback port: the proxy of this file. It answers CONNECT for listed `host:port` entries only, resolves the name itself,
 * refuses addresses that are not public (DNS rebinding to the LAN or the metadata service) and connects to the address it checked.
 */

/** GitHub: what git, `gh` and a deploy key over ssh need. A missing port means 443. */
export const GITHUB_HOSTS: readonly string[] = ["github.com", "api.github.com", "codeload.github.com", "uploads.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "ssh.github.com", "github.com:22"];

/** The package registries of the usual build tools. */
export const PACKAGE_HOSTS: readonly string[] = [
  "registry.npmjs.org", "registry.yarnpkg.com", "repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "services.gradle.org", "downloads.gradle.org",
  "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "sum.golang.org", "index.crates.io", "static.crates.io",
];

export const MODEL_HOST_REFUSED = "The model endpoint of this step is not allowed in a team's run: it must be an https address, or a local one on this computer.";

/** The hosts a team's workspace lists itself (`hosts` in its settings); empty for an unknown workspace. */
export function hostsOf(ws: string): string[] {
  try {
    return [...(currentWorkspaces().find((w) => w.id === ws)?.hosts ?? [])];
  } catch {
    return [];
  }
}

/** What a shell step of a team's run may reach: GitHub, the package registries and the workspace's own list. */
export const shellHosts = (ws: string): string[] => [...GITHUB_HOSTS, ...PACKAGE_HOSTS, ...hostsOf(ws)];

/** Is `host:port` on the list? Lower case; `*.d` matches subdomains of `d` only; a missing port in an entry means 443. */
export function hostAllowed(allow: readonly string[], host: string, port: number): boolean {
  const h = host.toLowerCase();
  return allow.some((raw) => {
    const m = /^(.*?)(?::(\d+))?$/.exec(raw.toLowerCase());
    const name = m?.[1] ?? "";
    if (Number(m?.[2] ?? 443) !== port) return false;
    return name.startsWith("*.") ? h.length > name.length - 1 && h.endsWith(name.slice(1)) : h === name;
  });
}

function parseV4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : undefined;
}

function blockedV4(n: number[]): boolean {
  const [a, b] = n as [number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Eight 16-bit groups of an IPv6 address, or undefined. */
function parseV6(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = parseV4(dotted[1]!);
    if (!v4) return undefined;
    s = s.slice(0, dotted.index) + ((v4[0]! << 8) | v4[1]!).toString(16) + ":" + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const side = (t: string) => (t === "" ? [] : t.split(":"));
  const head = side(halves[0]!);
  const tail = halves.length === 2 ? side(halves[1]!) : [];
  if (halves.length === 1 && head.length !== 8) return undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < (halves.length === 2 ? 1 : 0)) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** Is this address one a step must not reach: loopback, private, link-local, CGNAT, multicast, unspecified, or an IPv6 form of those? An address that cannot be read is blocked. */
export function blockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blockedV4(parseV4(ip)!);
  if (kind !== 6) return true;
  const g = parseV6(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 5).every((x) => x === 0)) {
    if (g[5] === 0xffff) return v4(g[6]!, g[7]!); // ::ffff:a.b.c.d
    if (g[5] === 0) return g[6] === 0 && g[7]! <= 1 ? true : v4(g[6]!, g[7]!); // ::, ::1 and ::a.b.c.d
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6]!, g[7]!); // NAT64
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!); // 6to4
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The hosts a model step may reach. `env` is the environment the CLI will really get (after the provider settings).
 * The base URL is `ANTHROPIC_BASE_URL` (Claude) or `OPENAI_BASE_URL` (Codex), else the provider's `base_url` only where the
 * CLI uses it (a local model for Codex), else the default. A local endpoint bypasses the proxy (`noProxy`) and gets its own port rule.
 */
export function modelHosts(t: Pick<Target, "agent" | "provider">, env: Record<string, string | undefined>): { hosts: string[]; noProxy: string[]; localPorts: number[] } | { refused: string } {
  const local = t.provider.kind === "ollama" || t.provider.kind === "lmstudio";
  const raw =
    t.agent === "claude"
      ? env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"
      : local
        ? t.provider.base_url || env.OPENAI_BASE_URL || "https://api.openai.com"
        : env.OPENAI_BASE_URL || "https://api.openai.com";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { refused: MODEL_HOST_REFUSED };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { refused: MODEL_HOST_REFUSED };
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (LOOPBACK.has(host)) return { hosts: [], noProxy: [...LOOPBACK], localPorts: [port] };
  if (u.protocol !== "https:") return { refused: MODEL_HOST_REFUSED };
  return { hosts: [`${host}:${port}`], noProxy: [], localPorts: [] };
}

export interface Egress {
  port: number;
  /** The `host:port` requests the proxy refused (without repeats, at most 50). */
  refused(): string[];
  close(): Promise<void>;
}

export interface EgressOptions {
  lookup?: (host: string) => Promise<string[]>;
  /** Opens the connection to an address the proxy has checked. */
  connect?: (port: number, address: string) => Socket;
  /** One deadline for the lookup and the connection. */
  connectTimeoutMs?: number;
  maxTunnels?: number;
  maxLookups?: number;
}

const defaultLookup = async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** Starts the proxy of one step on a random loopback port. Only CONNECT to listed hosts works; everything else gets 403. */
export function startEgress(allow: readonly string[], o: EgressOptions = {}): Promise<Egress> {
  const lookup = o.lookup ?? defaultLookup;
  const connect = o.connect ?? ((port: number, address: string) => netConnect({ port, host: address }));
  const deadline = o.connectTimeoutMs ?? 15_000;
  const maxTunnels = o.maxTunnels ?? 64;
  const maxLookups = o.maxLookups ?? 16;
  const refusedSet = new Set<string>();
  const refuse = (what: string) => {
    if (refusedSet.size < 50) refusedSet.add(what);
  };
  const sockets = new Set<Socket>();
  const jobs = new Set<{ dead: boolean; destroy(): void }>();
  let lookups = 0;
  let closed = false;

  const server: Server = createServer((_req, res) => {
    res.writeHead(403, { "content-type": "text/plain", connection: "close" });
    res.end("Only CONNECT to a listed host is allowed.\n");
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
  });
  server.on("clientError", (_e, s) => s.destroy());

  const reply = (s: Socket, line: string) => {
    if (s.destroyed) return;
    s.end(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
  };

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s/]+):(\d{1,5})$/.exec(req.url ?? "");
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) return reply(client, "400 Bad Request");
    const host = m[1]!.replace(/^\[|\]$/g, "").toLowerCase();
    if (closed || !hostAllowed(allow, host, port)) {
      refuse(`${host}:${port}`);
      return reply(client, "403 Forbidden");
    }
    if (jobs.size >= maxTunnels || lookups >= maxLookups) return reply(client, "503 Service Unavailable");

    let upstream: Socket | undefined;
    const job = {
      dead: false,
      destroy() {
        if (job.dead) return;
        job.dead = true;
        clearTimeout(timer);
        jobs.delete(job);
        client.destroy();
        upstream?.destroy();
      },
    };
    const timer = setTimeout(() => job.destroy(), deadline);
    timer.unref();
    jobs.add(job);
    client.on("close", () => job.destroy());
    client.on("error", () => job.destroy());

    lookups++;
    let counted = true;
    const uncount = () => {
      if (counted) {
        counted = false;
        lookups--;
      }
    };
    void (async () => {
      try {
        let addresses: string[];
        try {
          addresses = await lookup(host);
        } finally {
          uncount();
        }
        if (job.dead) return;
        if (!addresses.length) return fail("502 Bad Gateway");
        if (addresses.some(blockedAddress)) {
          refuse(`${host}:${port}`);
          return fail("403 Forbidden");
        }
        const up = connect(port, addresses[0]!);
        upstream = up;
        let open = false;
        up.on("error", () => (open ? job.destroy() : fail("502 Bad Gateway")));
        up.on("close", () => job.destroy());
        up.once("connect", () => {
          if (job.dead) return up.destroy();
          open = true;
          clearTimeout(timer);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) up.write(head);
          pipeline(client, up).catch(() => job.destroy());
          pipeline(up, client).catch(() => job.destroy());
        });
      } catch {
        if (!job.dead) fail("502 Bad Gateway");
      }
    })();

    function fail(line: string): void {
      if (job.dead) return;
      reply(client, line);
      job.destroy();
    }
  });

  return new Promise<Egress>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", () => {});
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        refused: () => [...refusedSet],
        close: () =>
          new Promise<void>((done) => {
            closed = true;
            for (const j of [...jobs]) j.destroy();
            for (const s of sockets) s.destroy();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** The proxy variables of a step: the usual names for every tool, and the JVM's own settings. `noProxy` is the list of hosts that bypass it (a local model). */
export function proxyEnv(port: number, env: Record<string, string | undefined>, noProxy: readonly string[] = []): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  const np = noProxy.join(",");
  const java = [`-Dhttps.proxyHost=127.0.0.1`, `-Dhttps.proxyPort=${port}`, `-Dhttp.proxyHost=127.0.0.1`, `-Dhttp.proxyPort=${port}`, ...(noProxy.length ? [`-Dhttp.nonProxyHosts=${noProxy.join("|")}`] : [])].join(" ");
  return {
    HTTPS_PROXY: url,
    https_proxy: url,
    HTTP_PROXY: url,
    http_proxy: url,
    ALL_PROXY: url,
    npm_config_proxy: url,
    npm_config_https_proxy: url,
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: np,
    no_proxy: np,
    JAVA_TOOL_OPTIONS: env.JAVA_TOOL_OPTIONS ? `${env.JAVA_TOOL_OPTIONS} ${java}` : java,
  };
}

/** `ProxyCommand=…` as one single-quoted shell word, for `GIT_SSH_COMMAND` (a shell string): `ssh … -o 'ProxyCommand=…'`. Built from the port only. */
export function sshProxyOption(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("not a port");
  return `'ProxyCommand=/usr/bin/nc -X connect -x 127.0.0.1:${port} %h %p'`;
}
