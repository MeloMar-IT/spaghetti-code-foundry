import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_PROVIDERS, claudeProviderEnv, type Target } from "../src/agents/targets.js";
import { blockedAddress, hostAllowed, modelHosts, MODEL_HOST_REFUSED, proxyEnv, sshProxyOption, startEgress, type Egress } from "../src/engine/egress.js";

// The proxy of a team's step (#785). Nothing here touches the network: the lookup and the connection are injected, and a local server stands in as the target.

const open: (Egress | Server)[] = [];
afterEach(async () => {
  for (const x of open.splice(0)) {
    if ("refused" in x) await x.close();
    else await new Promise<void>((r) => x.close(() => r()));
  }
});

/** Sends one request line and collects what comes back until the socket closes or the first line is complete. */
function talk(port: number, req: string): Promise<{ head: string; socket: Socket; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ port, host: "127.0.0.1" });
    let data = "";
    let done = false;
    const closed = new Promise<void>((r) => s.once("close", () => r()));
    s.on("error", () => {});
    s.on("data", (d) => {
      data += d.toString();
      if (!done && data.includes("\r\n\r\n")) {
        done = true;
        resolve({ head: data, socket: s, closed });
      }
    });
    s.once("close", () => {
      if (!done) {
        done = true;
        resolve({ head: data, socket: s, closed });
      }
    });
    s.once("connect", () => s.write(req));
    setTimeout(() => !done && reject(new Error("no answer")), 5000).unref();
  });
}
const connectReq = (hostPort: string) => `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`;

/** A local echo server that the injected connect reaches. */
async function echo(): Promise<number> {
  const srv = createServer((s) => {
    s.on("error", () => {});
    s.on("data", (d) => s.write(d));
  });
  open.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return (srv.address() as { port: number }).port;
}

describe("the proxy", () => {
  it("lets an allowed CONNECT through to the address it checked, not the name", async () => {
    const target = await echo();
    const seen: string[] = [];
    const eg = await startEgress(["api.example.com"], {
      lookup: async () => ["93.184.216.34"],
      connect: (_port, address) => {
        seen.push(address);
        return netConnect({ port: target, host: "127.0.0.1" });
      },
    });
    open.push(eg);
    const { head, socket } = await talk(eg.port, connectReq("api.example.com:443"));
    expect(head).toContain("200 Connection Established");
    const back = new Promise<string>((r) => socket.once("data", (d) => r(d.toString())));
    socket.write("ping");
    expect(await back).toBe("ping");
    expect(seen).toEqual(["93.184.216.34"]);
    socket.destroy();
  });

  it("answers 403 for an unlisted host and records it, for another port, and for a plain GET", async () => {
    const eg = await startEgress(["api.example.com"], { lookup: async () => ["93.184.216.34"] });
    open.push(eg);
    expect((await talk(eg.port, connectReq("evil.example.net:443"))).head).toContain("403");
    expect((await talk(eg.port, connectReq("api.example.com:8443"))).head).toContain("403");
    expect((await talk(eg.port, "GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n")).head).toContain("403");
    expect(eg.refused()).toEqual(["evil.example.net:443", "api.example.com:8443"]);
  });

  it("refuses a listed name that resolves to a loopback, private or mapped address", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "::ffff:10.0.0.1", "169.254.169.254", "::1"]) {
      let connected = false;
      const eg = await startEgress(["rebind.example.com"], { lookup: async () => [ip], connect: () => ((connected = true), netConnect({ port: 1 })) });
      open.push(eg);
      expect((await talk(eg.port, connectReq("rebind.example.com:443"))).head, ip).toContain("403");
      expect(connected, ip).toBe(false);
    }
  });

  it("answers 502 when the lookup or the connection fails", async () => {
    const dnsFail = await startEgress(["a.example.com"], { lookup: async () => Promise.reject(new Error("ENOTFOUND")) });
    const noConnect = await startEgress(["a.example.com"], { lookup: async () => ["93.184.216.34"], connect: () => netConnect({ port: 1, host: "127.0.0.1" }) });
    const empty = await startEgress(["a.example.com"], { lookup: async () => [] });
    open.push(dnsFail, noConnect, empty);
    for (const eg of [dnsFail, noConnect, empty]) expect((await talk(eg.port, connectReq("a.example.com:443"))).head).toContain("502");
  });

  it("closes the connection at the deadline when the lookup stalls", async () => {
    const eg = await startEgress(["a.example.com"], { lookup: () => new Promise(() => {}), connectTimeoutMs: 20 });
    open.push(eg);
    const { head, closed } = await talk(eg.port, connectReq("a.example.com:443"));
    expect(head).toBe("");
    await closed;
  });

  it("answers 503 over the limits of tunnels and lookups", async () => {
    let inLookup: () => void = () => {};
    const started = new Promise<void>((r) => (inLookup = r));
    const stalled = await startEgress(["a.example.com"], { lookup: () => (inLookup(), new Promise(() => {})), maxLookups: 1, connectTimeoutMs: 5000 });
    open.push(stalled);
    const first = await new Promise<Socket>((r) => {
      const s = netConnect({ port: stalled.port, host: "127.0.0.1" }, () => (s.write(connectReq("a.example.com:443")), r(s)));
      s.on("error", () => {});
    });
    await started; // the first request is in its lookup
    expect((await talk(stalled.port, connectReq("a.example.com:443"))).head).toContain("503");
    first.destroy();

    const target = await echo();
    const one = await startEgress(["a.example.com"], { lookup: async () => ["93.184.216.34"], connect: () => netConnect({ port: target, host: "127.0.0.1" }), maxTunnels: 1 });
    open.push(one);
    const t1 = await talk(one.port, connectReq("a.example.com:443"));
    expect(t1.head).toContain("200");
    expect((await talk(one.port, connectReq("a.example.com:443"))).head).toContain("503");
    t1.socket.destroy();
  });

  it("drops a pending request when the client leaves, and ignores a lookup that ends after close()", async () => {
    let release: (a: string[]) => void = () => {};
    let inLookup: () => void = () => {};
    const started = new Promise<void>((r) => (inLookup = r));
    let connected = false;
    let lateDone: Promise<void> = Promise.resolve();
    const eg = await startEgress(["a.example.com"], {
      lookup: () => {
        inLookup();
        const p = new Promise<string[]>((r) => (release = r));
        lateDone = p.then(() => new Promise<void>((r) => setImmediate(r)));
        return p;
      },
      connect: () => ((connected = true), netConnect({ port: 1, host: "127.0.0.1" })),
    });
    const s = netConnect({ port: eg.port, host: "127.0.0.1" });
    s.on("error", () => {});
    await new Promise<void>((r) => s.once("connect", () => (s.write(connectReq("a.example.com:443")), r())));
    await started;
    await eg.close();
    release(["93.184.216.34"]);
    await lateDone;
    expect(connected).toBe(false);
    s.destroy();
  });

  it("ends an open tunnel on close()", async () => {
    const target = await echo();
    const eg = await startEgress(["a.example.com"], { lookup: async () => ["93.184.216.34"], connect: () => netConnect({ port: target, host: "127.0.0.1" }) });
    const { head, closed } = await talk(eg.port, connectReq("a.example.com:443"));
    expect(head).toContain("200");
    await eg.close();
    await closed;
  });

  it("refuses a bad request line", async () => {
    const eg = await startEgress(["a.example.com"]);
    open.push(eg);
    expect((await talk(eg.port, connectReq("nonsense"))).head).toContain("400");
  });
});

describe("the host list", () => {
  it("matches names in lower case, wildcards for subdomains only, and a missing port as 443", () => {
    expect(hostAllowed(["*.x.org"], "a.x.org", 443)).toBe(true);
    expect(hostAllowed(["*.x.org"], "x.org", 443)).toBe(false);
    expect(hostAllowed(["*.x.org"], "evilx.org", 443)).toBe(false);
    expect(hostAllowed(["Repo.Example.com"], "REPO.example.com", 443)).toBe(true);
    expect(hostAllowed(["repo.example.com"], "repo.example.com", 8443)).toBe(false);
    expect(hostAllowed(["repo.example.com:8443"], "repo.example.com", 8443)).toBe(true);
    expect(hostAllowed(["repo.example.com:8443"], "repo.example.com", 443)).toBe(false);
  });

  it("blocks every address that is not public", () => {
    const blocked = ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:a00:1::", "not an address"];
    for (const ip of blocked) expect(blockedAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(blockedAddress(ip), ip).toBe(false);
  });
});

const target = (agent: "claude" | "codex", kind: Target["provider"]["kind"], base_url?: string, name = kind as string): Target => ({
  agent,
  providerName: name,
  provider: { kind, ...(base_url ? { base_url } : {}) } as Target["provider"],
  free: false,
  label: `${agent}:${name}`,
});

describe("the model hosts", () => {
  it("allows the default host of each agent", () => {
    expect(modelHosts(target("claude", "anthropic"), {})).toEqual({ hosts: ["api.anthropic.com:443"], noProxy: [], localPorts: [] });
    expect(modelHosts(target("codex", "openai"), {})).toEqual({ hosts: ["api.openai.com:443"], noProxy: [], localPorts: [] });
  });

  it("uses the endpoint the CLI really gets: the environment, not the provider's base_url, for a native provider", () => {
    expect(modelHosts(target("claude", "anthropic", "https://other.example.com"), {})).toMatchObject({ hosts: ["api.anthropic.com:443"] });
    expect(modelHosts(target("claude", "anthropic"), { ANTHROPIC_BASE_URL: "https://gw.example.com:8443" })).toMatchObject({ hosts: ["gw.example.com:8443"] });
    expect(modelHosts(target("codex", "openai", "https://other.example.com"), { OPENAI_BASE_URL: "https://gw.example.com/v1" })).toMatchObject({ hosts: ["gw.example.com:443"] });
  });

  it("agrees with the provider environment of Claude for a compatible provider", () => {
    const t = target("claude", "anthropic-compatible", "https://compat.example.com/v1", "compat");
    const env = claudeProviderEnv(t) as Record<string, string | undefined>;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://compat.example.com/v1");
    expect(modelHosts(t, env)).toEqual({ hosts: ["compat.example.com:443"], noProxy: [], localPorts: [] });
  });

  it("lets a local model bypass the proxy and opens its port", () => {
    for (const name of ["ollama", "lmstudio"] as const) {
      const t = target("claude", name, BUILTIN_PROVIDERS[name]!.base_url);
      const env = claudeProviderEnv(t) as Record<string, string | undefined>;
      const port = Number(new URL(BUILTIN_PROVIDERS[name]!.base_url!).port);
      const r = modelHosts(t, env);
      expect(r, name).toMatchObject({ hosts: [], localPorts: [port] });
      expect((r as { noProxy: string[] }).noProxy).toContain("localhost");
      const x = modelHosts(target("codex", name, BUILTIN_PROVIDERS[name]!.base_url), {});
      expect(x, name).toMatchObject({ hosts: [], localPorts: [port] });
    }
    expect(modelHosts(target("codex", "ollama", "http://127.0.0.1:9999"), {})).toMatchObject({ localPorts: [9999] });
  });

  it("refuses an http endpoint that is not local, and a URL that cannot be read", () => {
    expect(modelHosts(target("claude", "anthropic"), { ANTHROPIC_BASE_URL: "http://gw.example.com" })).toEqual({ refused: MODEL_HOST_REFUSED });
    expect(modelHosts(target("claude", "anthropic"), { ANTHROPIC_BASE_URL: "not a url" })).toEqual({ refused: MODEL_HOST_REFUSED });
    expect(modelHosts(target("claude", "anthropic"), { ANTHROPIC_BASE_URL: "ftp://gw.example.com" })).toEqual({ refused: MODEL_HOST_REFUSED });
  });
});

describe("the proxy variables", () => {
  it("point every tool at the port and set NO_PROXY from the list", () => {
    const env = proxyEnv(4321, {}, ["localhost", "127.0.0.1"]);
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "npm_config_proxy", "npm_config_https_proxy"]) expect(env[k], k).toBe("http://127.0.0.1:4321");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.no_proxy).toBe("localhost,127.0.0.1");
    expect(env.JAVA_TOOL_OPTIONS).toContain("-Dhttps.proxyPort=4321");
    expect(env.JAVA_TOOL_OPTIONS).toContain("-Dhttp.nonProxyHosts=localhost|127.0.0.1");
    expect(proxyEnv(1, {}).NO_PROXY).toBe("");
    expect(proxyEnv(1, {}).JAVA_TOOL_OPTIONS).not.toContain("nonProxyHosts");
  });

  it("appends to an existing JAVA_TOOL_OPTIONS", () => {
    expect(proxyEnv(7, { JAVA_TOOL_OPTIONS: "-Xmx1g" }).JAVA_TOOL_OPTIONS?.startsWith("-Xmx1g -Dhttps.proxyHost=127.0.0.1")).toBe(true);
  });

  it("makes the ssh option one single-quoted shell word, from a port only", () => {
    const o = sshProxyOption(4321);
    expect(o).toBe("'ProxyCommand=/usr/bin/nc -X connect -x 127.0.0.1:4321 %h %p'");
    expect(o.slice(1, -1)).not.toContain("'");
    expect(() => sshProxyOption(1.5)).toThrow();
    expect(() => sshProxyOption(0)).toThrow();
    expect(() => sshProxyOption("1; rm -rf /" as unknown as number)).toThrow();
  });
});
