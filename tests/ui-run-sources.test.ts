import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let mod: any;
beforeAll(async () => {
  restore = installFakeDom();
  mod = await import("../ui/run-sources.js" as string);
});
afterAll(() => restore());

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const SHA = "a".repeat(64);
const COMMIT = "1234567890abcdef1234567890abcdef12345678";

const view = (admin: boolean, over: any = {}): any => ({
  runId: "r1", state: "available", sha256: SHA, sourcesSha256: "b".repeat(64), createdAt: "2026-01-31T12:00:00.000Z",
  repository: { repository: "acme/shop", commit: COMMIT }, budget: { maxSources: 10, maxSourceBytes: 1000, maxTotalBytes: 4000 },
  sources: [
    { kind: "repository-file", label: "Repository file docs/API.md", classification: "internal", selection: { reason: "discovery", rule: "named-in-task" }, retrievedAt: "2026-01-31T11:59:00.000Z", freshness: "fresh", revision: { commit: COMMIT }, sha256: SHA, bytes: 12, owners: ["@acme/platform"], ...(admin ? { uri: "repo:docs/API.md", id: "s-0123456789abcdef" } : {}) },
    { kind: "issue", label: "Issue #12", classification: "public", selection: { reason: "task" }, retrievedAt: "2026-01-31T11:59:00.000Z", freshness: "stale", nextCode: "rerun-for-fresh", next: "Start a new run.", revision: { version: "v1" }, owners: [] },
    { kind: "repository-file", label: "Restricted repository file", classification: "restricted", selection: { reason: "ownership" }, retrievedAt: "2026-01-31T11:59:00.000Z", freshness: "fresh" },
  ],
  omitted: [{ kind: "repository-file", label: "Repository file CODEOWNERS", selection: { reason: "ownership" }, status: "missing", statusLabel: "Not found", nextCode: "add-source", next: "Add it.", ...(admin ? { uri: "repo:CODEOWNERS", id: "s-fedcba9876543210" } : {}) }],
  ...over,
});

describe("contextSourcesModel", () => {
  it("shows the bundle, the sources and the left-out entries, with addresses for an administrator", () => {
    const m = mod.contextSourcesModel(view(true), { admin: true });
    expect(m.state).toBe("available");
    expect(m.rows.map((r: any) => r.label)).toEqual(["Bundle", "Sources hash", "Made", "Commit", "Limits"]);
    expect(m.rows.find((r: any) => r.label === "Commit").value).toBe("acme/shop at 1234567");
    const first = m.sources[0];
    expect(first.head).toBe("Repository file docs/API.md");
    expect(first.lines).toContain("Picked for: a discovery rule (rule named-in-task)");
    expect(first.lines).toContain("Commit 1234567");
    expect(first.lines.some((l: string) => l.startsWith("Read ") && l.endsWith("Fresh"))).toBe(true);
    expect(first.lines).toContain("Classification: Internal");
    expect(first.lines).toContain("Owners: @acme/platform");
    expect(first.lines).toContain(`SHA-256 ${SHA}`);
    expect(first.lines).toContain("12 bytes");
    expect(first.lines).toContain("Address: repo:docs/API.md (s-0123456789abcdef)");
    expect(m.omitted[0]).toMatchObject({ head: "Repository file CODEOWNERS", status: "Not found", next: "What to do: Add it." });
    expect(m.omitted[0].lines).toContain("Address: repo:CODEOWNERS (s-fedcba9876543210)");
    expect(m.omitted[0].lines).toContain("Would have been picked for: ownership");
  });
  it("shows no address or detail with admin false, even if the view has them", () => {
    const text = JSON.stringify(mod.contextSourcesModel(view(true), { admin: false }));
    expect(text).not.toContain("repo:docs");
    expect(text).not.toContain("s-0123456789abcdef");
    expect(text).not.toContain("s-fedcba9876543210");
    const bad = { runId: "r1", state: "unreadable", problem: { code: "invalid", reason: "Cannot be read.", detail: "secret detail" }, sources: [], omitted: [] };
    expect(mod.contextSourcesModel(bad, { admin: false }).text).toBe("Cannot be read.");
    expect(mod.contextSourcesModel(bad, { admin: true }).text).toBe("Cannot be read. secret detail");
  });
  it("says what a stale source needs, and leaves out lines it does not have", () => {
    const m = mod.contextSourcesModel(view(false));
    expect(m.sources[1].next).toBe("What to do: Start a new run.");
    expect(m.sources[0].next).toBeUndefined();
    const hidden = m.sources[2].lines.join("\n");
    expect(hidden).not.toContain("SHA-256");
    expect(hidden).not.toContain("bytes");
    expect(hidden).not.toContain("Commit");
    expect(hidden).not.toContain("Owners");
    expect(m.sources[2].head).toBe("Restricted repository file");
  });
  it("handles absent, unreadable and an empty bundle", () => {
    expect(mod.contextSourcesModel({ state: "absent" }).text).toBe(mod.NO_BUNDLE);
    expect(mod.contextSourcesModel(undefined).state).toBe("absent");
    expect(mod.contextSourcesModel({ state: "unreadable" }).text).toContain("cannot be read");
    const m = mod.contextSourcesModel(view(false, { sources: [], omitted: [] }));
    expect(m.sources).toEqual([]);
    expect(m.omitted).toEqual([]);
  });
});

describe("contextExport", () => {
  it("is exactly the answer, named by the run", () => {
    const v = view(false);
    const f = mod.contextExport(v, "r1");
    expect(f.name).toBe("context-r1.json");
    expect(JSON.parse(f.text)).toEqual(v);
    expect(f.text.endsWith("\n")).toBe(true);
    expect(mod.contextExport(v, "../a b").name).toBe("context-___a_b.json");
  });
});

describe("contextSourcesSection", () => {
  const make = (views: any[], opts: any = {}) => {
    let n = 0;
    const load = vi.fn(async () => { const v = views[Math.min(n++, views.length - 1)]; if (v instanceof Error) throw v; return v; });
    const save = vi.fn();
    const s = mod.contextSourcesSection({ load, save, runId: "r1", admin: false, ...opts });
    const node: FakeElement = s.build();
    return { s, node, load, save };
  };
  const btn = (node: FakeElement, f: string) => node.all("button").find((b) => b.attrs["data-focus"] === f)!;
  const absent = { runId: "r1", state: "absent", sources: [], omitted: [] };

  it("loads on build and shows the sources and what was left out", async () => {
    const { node } = make([view(false)]);
    expect(node.textContent).toContain("Loading the context sources…");
    await flush();
    for (const t of ["Context sources", "Repository file docs/API.md", "Left out", "Not found", "What to do: Add it."]) expect(node.textContent).toContain(t);
  });
  it("says so when there is no bundle", async () => {
    const { node } = make([absent]);
    await flush();
    expect(node.textContent).toContain("This run has no context bundle.");
  });
  it("exports a fresh load", async () => {
    const { node, load, save } = make([absent, view(false)]);
    await flush();
    btn(node, "sources-export").click();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith("context-r1.json", mod.contextExport(view(false), "r1").text);
  });
  it("shows an error and reloads on retry", async () => {
    const { node, load } = make([new Error("down"), view(false)]);
    await flush();
    const retry = node.all("button").find((b) => b.attrs["data-focus"] === "sources-retry")!;
    expect(retry).toBeTruthy();
    retry.click();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(node.textContent).toContain("Repository file docs/API.md");
  });
  it("reloads when the run finishes, and on a new step only while absent", async () => {
    const a = make([absent]);
    await flush();
    a.s.update({ history: [] }, undefined);
    a.s.update({ history: [{}] }, { history: [] });
    expect(a.load).toHaveBeenCalledTimes(2);
    a.s.update({ finishedAt: "t" }, { history: [{}] });
    expect(a.load).toHaveBeenCalledTimes(3);
    a.s.update({ finishedAt: "t" }, { finishedAt: "t" });
    expect(a.load).toHaveBeenCalledTimes(3);
    const b = make([view(false)]);
    await flush();
    b.s.update({ history: [{}] }, { history: [] });
    expect(b.load).toHaveBeenCalledTimes(1);
  });
  it("drops a late answer", async () => {
    const resolvers: ((v: any) => void)[] = [];
    const load = vi.fn(() => new Promise<any>((r) => { resolvers.push(r); }));
    const s = mod.contextSourcesSection({ load, runId: "r1", admin: false });
    const node: FakeElement = s.build();
    btn(node, "sources-refresh").click();
    resolvers[1]!(view(false));
    await flush();
    resolvers[0]!(absent);
    await flush();
    expect(node.textContent).toContain("Repository file docs/API.md");
    expect(node.textContent).not.toContain("no context bundle");
  });
});
