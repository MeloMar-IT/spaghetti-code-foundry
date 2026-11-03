import { createServer as httpServer, type Server } from "node:http";
import { connect } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRedactor } from "../src/credentials/redact.js";
import { type PreviewConfig } from "../src/preview/config.js";
import { freePort, MAX_OUTPUT, PreviewRunner, type PreviewInfo } from "../src/preview/runner.js";
import { priorityMachine } from "../src/steps/process.js";

const fixture = resolve("tests/fixtures/fake-preview-server.mjs");
const command = `exec "${process.execPath}" "${fixture}"`;
const cfg = (env: Record<string, string> = {}, extra: Partial<PreviewConfig> = {}): PreviewConfig =>
  ({ command, port: "auto", ready: "/", env, version: "develop", ...extra });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const dir = process.cwd();

let clock = { t: 1_000 };
let runner: PreviewRunner;
const make = (over: ConstructorParameters<typeof PreviewRunner>[0] = {}) => {
  clock = { t: 1_000 };
  runner = new PreviewRunner({
    now: () => clock.t,
    probeEveryMs: 20,
    probeTimeoutMs: 100,
    redactor: () => makeRedactor(["s3cret-value"]),
    providers: () => ({ providers: {} }),
    ...over,
  });
  return runner;
};
const once = <T>(source: PreviewRunner, event: string, pred: (x: T) => boolean = () => true) =>
  new Promise<T>((res) => {
    const on = (x: T) => {
      if (!pred(x)) return;
      source.off(event, on);
      res(x);
    };
    source.on(event, on);
  });
const servers: Server[] = [];
const saved: Record<string, string | undefined> = {};

afterEach(async () => {
  await runner?.stopAll();
  for (const s of servers.splice(0)) s.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("PreviewRunner", () => {
  it("starts and is ready; the url answers through the pass-through", async () => {
    make();
    const states: string[] = [];
    runner.on("state", (i: PreviewInfo) => states.push(i.state));
    const info = await runner.start("p", dir, cfg());
    expect(info.state).toBe("ready");
    expect((await fetch(info.url!)).status).toBe(200);
    expect(states).toEqual(["starting", "ready"]);
    expect(runner.get("p")).toMatchObject({ url: info.url, appPort: info.appPort, pid: info.pid });
  });

  it("gives the child a short, clean environment at low priority", async () => {
    make();
    for (const [k, v] of Object.entries({ FACTORY_LEAK: "1", GH_TOKEN: "t", OTHER_LEAK: "1" })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const info = await runner.start("p", dir, cfg({ APP_FLAG: "on" }));
    const body = (await (await fetch(`${info.url}env`)).json()) as { env: Record<string, string>; nice: number };
    for (const k of Object.keys(body.env)) expect(k).not.toMatch(/^(FACTORY_|SCF_|GH_|GITHUB_|ANTHROPIC_|OPENAI_)/);
    expect(body.env.OTHER_LEAK).toBeUndefined();
    expect(body.env.APP_FLAG).toBe("on");
    expect(body.env.HOST).toBe("127.0.0.1");
    expect(body.env.PORT).toBe(String(info.appPort));
    const machine = await priorityMachine();
    if (machine.nice) expect(body.nice).toBeGreaterThanOrEqual(Math.max(5, machine.current));
  });

  it("stops after 30 minutes without use", async () => {
    make();
    const info = await runner.start("p", dir, cfg());
    await fetch(info.url!);
    clock.t += 29 * 60_000;
    await runner.checkIdle();
    expect(runner.get("p")?.state).toBe("ready");
    await fetch(info.url!);
    clock.t += 29 * 60_000;
    await runner.checkIdle();
    expect(runner.get("p")?.state).toBe("ready");
    clock.t += 31 * 60_000;
    await runner.checkIdle();
    expect(runner.get("p")).toMatchObject({ state: "stopped", reason: "idle" });
    expect(alive(info.pid!)).toBe(false);
    await expect(
      new Promise((res, rej) => {
        const s = connect(Number(new URL(info.url!).port), "127.0.0.1");
        s.on("connect", () => rej(new Error("connected")));
        s.on("error", res);
      }),
    ).resolves.toBeDefined();
  });

  it("replaces a running preview and kills its whole group first", async () => {
    make();
    const port = await freePort();
    const a = await runner.start("p", dir, cfg({ FAKE_PREVIEW_MODE: "child" }, { port }));
    const grand = Number(await (await fetch(`${a.url}child`)).text());
    expect(alive(grand)).toBe(true);
    const events: string[] = [];
    runner.on("state", (i: PreviewInfo) => events.push(`${i.state}/${i.reason ?? ""}`));
    const startingB = once<PreviewInfo>(runner, "state", (i) => i.state === "starting");
    const b = await runner.start("p", dir, cfg({}, { port }));
    await startingB;
    expect(events[0]).toBe("stopped/replaced");
    expect(events[1]).toBe("starting/");
    expect(alive(a.pid!)).toBe(false);
    expect(alive(grand)).toBe(false);
    expect(b.state).toBe("ready");
    expect(b.appPort).toBe(port);
  });

  it("two concurrent starts leave one live child", async () => {
    make();
    const [first, second] = await Promise.all([runner.start("p", dir, cfg()), runner.start("p", dir, cfg())]);
    expect(first).toMatchObject({ state: "stopped", reason: "replaced" });
    expect(second.state).toBe("ready");
    expect(alive(second.pid!)).toBe(true);
    expect(first.pid === undefined || !alive(first.pid)).toBe(true);
  });

  it("a replacing start works while the first is still starting, with a frozen clock", async () => {
    make();
    const first = runner.start("p", dir, cfg({ FAKE_PREVIEW_MODE: "503" }));
    await once(runner, "probe", (p: { status?: number }) => p.status === 503);
    const second = runner.start("p", dir, cfg());
    expect(await first).toMatchObject({ state: "stopped", reason: "replaced" });
    expect((await second).state).toBe("ready");
  });

  it("a command that exits at once fails with its code and output", async () => {
    make();
    const info = await runner.start("p", dir, cfg({ FAKE_PREVIEW_MODE: "exit" }));
    expect(info).toMatchObject({ state: "failed", reason: "exited", exitCode: 3 });
    expect(runner.output("p")).toContain("boom");
  });

  it("fails as not-ready once the deadline passes, and kills the group", async () => {
    make();
    const started = runner.start("p", dir, cfg({ FAKE_PREVIEW_MODE: "503" }));
    await once(runner, "probe", (p: { status?: number }) => p.status === 503);
    clock.t += 121_000;
    const info = await started;
    expect(info).toMatchObject({ state: "failed", reason: "not-ready" });
    expect(alive(info.pid!)).toBe(false);
  });

  it("drops a probe whose response body never ends", async () => {
    make();
    const started = runner.start("p", dir, cfg({ FAKE_PREVIEW_MODE: "partial" }));
    for (let n = 0; n < 3; n++) await once(runner, "probe", (p: { status?: number }) => p.status === 503);
    const appPort = runner.get("p")!.appPort!;
    const open = async () => Number(await (await fetch(`http://127.0.0.1:${appPort}/open`)).text());
    let count = await open();
    for (let i = 0; i < 50 && count > 1; i++) {
      await new Promise((r) => setTimeout(r, 20));
      count = await open();
    }
    expect(count).toBeLessThanOrEqual(1);
    await runner.stop("p");
    expect(await started).toMatchObject({ state: "stopped", reason: "stopped" });
  });

  it("a server that never answers stalls neither the deadline nor stop", async () => {
    make();
    const started = runner.start("p", dir, cfg({ FAKE_PREVIEW_MODE: "hang" }));
    await once(runner, "probe", (p: { error?: string }) => p.error !== undefined);
    clock.t += 121_000;
    expect(await started).toMatchObject({ state: "failed", reason: "not-ready" });

    const again = runner.start("p", dir, cfg({ FAKE_PREVIEW_MODE: "hang" }));
    await once(runner, "probe", (p: { error?: string }) => p.error !== undefined);
    expect(await runner.stop("p")).toMatchObject({ state: "stopped", reason: "stopped" });
    expect(await again).toMatchObject({ state: "stopped", reason: "stopped" });
  });

  it("a fixed port held by another server ends as port-busy without a child", async () => {
    make();
    const other = httpServer((_req, res) => res.end("other"));
    servers.push(other);
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const port = (other.address() as { port: number }).port;
    const states: string[] = [];
    runner.on("state", (i: PreviewInfo) => states.push(i.state));
    const info = await runner.start("p", dir, cfg({}, { port }));
    expect(info).toMatchObject({ state: "failed", reason: "port-busy" });
    expect(info.pid).toBeUndefined();
    expect(states).not.toContain("ready");
  });

  it("a bad config ends as bad-config and starts nothing", async () => {
    make();
    const text = await runner.start("p", dir, "command: [");
    expect(text).toMatchObject({ state: "failed", reason: "bad-config" });
    expect(text.detail).toContain("YAML");
    expect(text.pid).toBeUndefined();
    const obj = await runner.start("q", dir, { ...cfg(), port: 80 });
    expect(obj).toMatchObject({ state: "failed", reason: "bad-config" });
  });

  it("stop, stopAll and an unknown id", async () => {
    make();
    await runner.start("a", dir, cfg());
    await runner.start("b", dir, cfg());
    expect(await runner.stop("a")).toMatchObject({ state: "stopped", reason: "stopped" });
    await runner.stopAll();
    expect(runner.get("b")).toMatchObject({ state: "stopped", reason: "stopped" });
    expect(await runner.stop("unknown")).toBeUndefined();
  });

  it("stop right after start cancels the start before it launches", async () => {
    make();
    const started = runner.start("p", dir, cfg());
    expect(await runner.stop("p")).toBeUndefined();
    expect(await started).toMatchObject({ state: "stopped", reason: "stopped" });
    expect(await started).not.toHaveProperty("pid");
    expect(runner.get("p")).toBeUndefined();
  });

  it("stopAll cancels a start that is still waiting", async () => {
    make();
    const started = runner.start("p", dir, cfg());
    await runner.stopAll();
    expect(await started).toMatchObject({ state: "stopped", reason: "stopped" });
    expect(runner.list()).toEqual([]);
  });

  it("stop cancels a queued replacement and the running start", async () => {
    make();
    const first = runner.start("p", dir, cfg());
    const queued = runner.start("p", dir, cfg()); // waits for the first one's launch
    await runner.stop("p");
    expect(await queued).toMatchObject({ state: "stopped", reason: "stopped" });
    expect(await first).toMatchObject({ state: "stopped", reason: "stopped" });
    expect(runner.list().filter((i) => i.state === "ready")).toEqual([]);
  });

  it("stop while starting resolves the start", async () => {
    make();
    const started = runner.start("p", dir, cfg({ FAKE_PREVIEW_MODE: "503" }));
    await once(runner, "probe", (p: { status?: number }) => p.status === 503);
    await runner.stop("p");
    expect(await started).toMatchObject({ state: "stopped", reason: "stopped" });
  });
});

describe("PreviewRunner output", () => {
  const untilOutput = async (text: string) => {
    for (let i = 0; i < 500 && !runner.output("p").includes(text); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it("redacts secrets", async () => {
    make();
    await runner.start("p", dir, cfg({ FAKE_PREVIEW_PRINT: "token s3cret-value" }));
    await untilOutput("[redacted]");
    expect(runner.output("p")).toContain("[redacted]");
    expect(runner.output("p")).not.toContain("s3cret-value");
  });

  it("redacts a secret split on stdout around a stderr line", async () => {
    make();
    await runner.start("p", dir, cfg({ FAKE_PREVIEW_INTERLEAVE: "1" }));
    await untilOutput("END");
    expect(runner.output("p")).toContain("[redacted]");
    expect(runner.output("p")).not.toContain("s3cret");
  });

  it("keeps the last 64 KB", async () => {
    make();
    await runner.start("p", dir, cfg({ FAKE_PREVIEW_BULK: "1" }));
    await untilOutput("END");
    expect(runner.output("p").length).toBeLessThanOrEqual(MAX_OUTPUT);
    expect(runner.output("p")).toContain("END");
  });

  it("caps multibyte text by bytes, at whole characters", async () => {
    make();
    await runner.start("p", dir, cfg({ FAKE_PREVIEW_BULK: "multi" }));
    await untilOutput("END");
    const out = runner.output("p");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT);
    expect(out).not.toContain("�");
  });

  it("keeps output without a final newline", async () => {
    make();
    const info = await runner.start("p", dir, cfg({ FAKE_PREVIEW_PRINT: "no newline", FAKE_PREVIEW_NONL: "1" }));
    expect(info.state).toBe("failed");
    expect(runner.output("p")).toBe("no newline");
  });

  it("keeps a character split across chunks", async () => {
    make();
    const info = await runner.start("p", dir, cfg({ FAKE_PREVIEW_PRINT: "caf", FAKE_PREVIEW_SPLIT: "1" }));
    expect(info.state).toBe("failed");
    expect(runner.output("p")).toBe("café");
  });
});
