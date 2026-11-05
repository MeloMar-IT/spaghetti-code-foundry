import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRedactor } from "../src/credentials/redact.js";
import type { CheckoutResult, checkoutPreview } from "../src/preview/checkout.js";
import { PreviewRunner } from "../src/preview/runner.js";
import { PreviewService, previewDir, type PreviewJob, type SourceFactory } from "../src/preview/service.js";

const fixture = resolve("tests/fixtures/fake-preview-server.mjs");
const yaml = (env: Record<string, string> = {}) =>
  `command: ${JSON.stringify(`exec "${process.execPath}" "${fixture}"`)}\nenv:\n${Object.entries({ FAKE_PREVIEW_PRINT: "fake-preview-value", ...env })
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const okSource: SourceFactory = async () => ({ kind: "path", path: "/unused" });

let data: string;
let runner: PreviewRunner;
let service: PreviewService;
let seq = 0;

type Check = typeof checkoutPreview;
/** A checkout that makes the folder and answers with this config. */
const writing = (config: string | undefined, over: Partial<CheckoutResult> = {}): Check => async (o) => {
  mkdirSync(o.dir, { recursive: true });
  writeFileSync(join(o.dir, "marker"), "x");
  return { ok: true, ...(config === undefined ? {} : { config }), ...over } as CheckoutResult;
};
const make = (checkout: Check) => {
  runner = new PreviewRunner({ probeEveryMs: 20, probeTimeoutMs: 100, redactor: () => makeRedactor(["fake-preview-value"]), providers: () => ({ providers: {} }) });
  service = new PreviewService({ runner, dataDir: () => data, checkout });
  return service;
};
const job = (repoId: string, over: Partial<PreviewJob> = {}): PreviewJob => ({ repoId, version: "develop", branch: "develop", sources: [okSource], ...over });
const deferred = () => {
  let resolveIt!: () => void;
  const promise = new Promise<void>((r) => (resolveIt = r));
  return { promise, resolve: resolveIt };
};
const pidOf = (id: string) => runner.get(id)!.pid!;
const id = () => `repo-${seq++}`;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "preview-service-"));
});
afterEach(async () => {
  await service?.stopAll();
  rmSync(data, { recursive: true, force: true });
});

describe("PreviewService", () => {
  it("is stopped before anything starts, then starts and is ready; output only on request, redacted", async () => {
    make(writing(yaml()));
    const r = id();
    expect(service.view(r)).toEqual({ state: "stopped" });
    const first = service.start(job(r, { version: "checking", runId: "run-1" }));
    expect(first).toMatchObject({ state: "starting", version: "checking", runId: "run-1" });
    const view = await service.settled(r);
    expect(view).toMatchObject({ state: "ready", version: "checking", runId: "run-1" });
    expect((await fetch(view.url!)).status).toBe(200);
    expect(view).not.toHaveProperty("pid");
    expect(view).not.toHaveProperty("output");
    const out = service.view(r, true).output!;
    expect(out).toContain("listening");
    expect(out).not.toContain("fake-preview-value");
    expect(existsSync(previewDir(data, r))).toBe(true);
  });

  it("fails with no-config, bad-config and no-access", async () => {
    const r = id();
    make(writing(undefined));
    service.start(job(r));
    expect(await service.settled(r)).toMatchObject({ state: "failed", reason: "no-config" });
    make(writing(undefined, { configProblem: ".factory/preview.yaml is not a regular file" }));
    service.start(job(r));
    expect(await service.settled(r)).toMatchObject({ state: "failed", reason: "bad-config", detail: ".factory/preview.yaml is not a regular file" });
    make(writing("command: [1]\n"));
    service.start(job(r));
    expect(await service.settled(r)).toMatchObject({ state: "failed", reason: "bad-config" });
    make(writing(yaml()));
    service.start(job(r, { sources: [async () => ({ refused: "set a token" })] }));
    expect(await service.settled(r)).toMatchObject({ state: "failed", reason: "no-access", detail: "set a token" });
  });

  it("goes on to the next source only when the earlier gave no branch or no source", async () => {
    const r = id();
    const seen: string[] = [];
    const sources = (...names: string[]): SourceFactory[] => names.map((n) => async () => (seen.push(n), { kind: "path" as const, path: n }));
    make(async (o) => {
      if (o.source.kind === "path" && o.source.path === "a") return { ok: false, reason: "no-branch", detail: "" };
      return writing(yaml())(o);
    });
    service.start(job(r, { sources: sources("a", "b", "c") }));
    expect(await service.settled(r)).toMatchObject({ state: "ready" });
    expect(seen).toEqual(["a", "b"]);
    seen.length = 0;
    service.start(job(r, { sources: sources("b", "c") }));
    expect(await service.settled(r)).toMatchObject({ state: "ready" });
    expect(seen).toEqual(["b"]);
  });

  it("a failed workspace checkout is final: the remote source is never asked", async () => {
    const r = id();
    const remote = vi.fn(async () => ({ kind: "path" as const, path: "/remote" }));
    make(async (o) => {
      if (o.source.kind === "path" && o.source.path === "/workspace") return { ok: false, reason: "checkout-failed", detail: "the project could not be checked out" };
      return writing(yaml())(o);
    });
    service.start(job(r, { version: "checking", runId: "run-x", sources: [async () => ({ kind: "path", path: "/workspace" }), remote] }));
    expect(await service.settled(r)).toMatchObject({ state: "failed", reason: "checkout-failed" });
    expect(remote).not.toHaveBeenCalled();
  });

  it("reports no-branch when every source has no such branch, and checkout-failed otherwise", async () => {
    const r = id();
    make(async () => ({ ok: false, reason: "no-branch", detail: "" }));
    service.start(job(r, { sources: [okSource, okSource] }));
    expect(await service.settled(r)).toMatchObject({ state: "failed", reason: "no-branch" });
    make(async () => ({ ok: false, reason: "no-source", detail: "" }));
    service.start(job(r));
    expect(await service.settled(r)).toMatchObject({ state: "failed", reason: "checkout-failed", detail: "the project could not be checked out" });
  });

  it("a second start during a blocked checkout aborts the first at once and keeps its own folder", async () => {
    const r = id();
    const began = deferred();
    let calls = 0;
    make(async (o) => {
      if (++calls > 1) return writing(yaml())(o);
      began.resolve();
      await new Promise<void>((res) => o.signal!.addEventListener("abort", () => res()));
      mkdirSync(o.dir, { recursive: true });
      return { ok: true, config: yaml() };
    });
    const startSpy = vi.spyOn(runner, "start");
    service.start(job(r, { branch: "first" }));
    await began.promise;
    service.start(job(r, { branch: "second" }));
    expect(await service.settled(r)).toMatchObject({ state: "ready" });
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(join(previewDir(data, r), "marker"))).toBe(true);
  });

  it("a second start during a readiness probe does not wait for the probe limit", async () => {
    const r = id();
    let n = 0;
    make(async (o) => writing(yaml(n++ === 0 ? { FAKE_PREVIEW_MODE: "503" } : {}))(o));
    service.start(job(r));
    await vi.waitFor(() => expect(runner.get(r)?.pid).toBeDefined());
    const old = pidOf(r);
    service.start(job(r));
    expect(await service.settled(r)).toMatchObject({ state: "ready" });
    expect(alive(old)).toBe(false);
  });

  it("a start while ready replaces the running preview", async () => {
    const r = id();
    make(writing(yaml()));
    service.start(job(r));
    await service.settled(r);
    const old = pidOf(r);
    service.start(job(r, { version: "checking", runId: "r" }));
    const now = await service.settled(r);
    expect(now).toMatchObject({ state: "ready", version: "checking" });
    expect(alive(old)).toBe(false);
    expect(pidOf(r)).not.toBe(old);
  });

  it("removes the folder only after a slow process has exited, on stop and on replace", async () => {
    const r = id();
    const log = join(data, "exit.log");
    make(writing(yaml({ FAKE_PREVIEW_EXIT_DELAY: "300", FAKE_PREVIEW_EXIT_LOG: log })));
    service.start(job(r));
    await service.settled(r);
    const pid = pidOf(r);
    const view = await service.stop(r);
    expect(view).toMatchObject({ state: "stopped", reason: "stopped" });
    expect(alive(pid)).toBe(false);
    expect(existsSync(previewDir(data, r))).toBe(false);
    expect(readFileSync(log, "utf8")).toBe("dir-present");
    rmSync(log);
    service.start(job(r));
    await service.settled(r);
    service.start(job(r));
    await service.settled(r);
    expect(readFileSync(log, "utf8")).toBe("dir-present");
  });

  it("a stop followed at once by a start leaves the new folder; a stop alone removes it", async () => {
    const r = id();
    make(writing(yaml()));
    service.start(job(r));
    await service.settled(r);
    const stopping = service.stop(r);
    service.start(job(r));
    await stopping;
    expect(await service.settled(r)).toMatchObject({ state: "ready" });
    expect(existsSync(join(previewDir(data, r), "marker"))).toBe(true);
    await service.stop(r);
    expect(existsSync(previewDir(data, r))).toBe(false);
    expect(service.view(r)).toMatchObject({ state: "stopped" });
  });

  it("stopAll stops every preview, cancels a checkout in progress and resolves", async () => {
    const [a, b] = [id(), id()];
    const began = deferred();
    let aborted = false;
    make(async (o) => {
      if (o.branch !== "slow") return writing(yaml())(o);
      began.resolve();
      await new Promise<void>((res) => o.signal!.addEventListener("abort", () => ((aborted = true), res())));
      return { ok: false, reason: "checkout-failed", detail: "" };
    });
    service.start(job(a));
    await service.settled(a);
    const pid = pidOf(a);
    service.start(job(b, { branch: "slow" }));
    await began.promise;
    await service.stopAll();
    expect(aborted).toBe(true);
    expect(alive(pid)).toBe(false);
    expect(service.view(a).state).toBe("stopped");
    expect(service.view(b).state).toBe("stopped");
    expect(existsSync(previewDir(data, a))).toBe(false);
  });

  it("answers a failed start of the runner with a fixed sentence", async () => {
    const r = id();
    make(writing(yaml()));
    vi.spyOn(runner, "start").mockRejectedValue(new Error("secret path /x"));
    service.start(job(r));
    expect(await service.settled(r)).toMatchObject({ state: "failed", detail: "the preview could not be started; see the server log" });
  });
});
