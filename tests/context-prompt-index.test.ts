import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/evidence/identity.js";
import { parseContextBundle } from "../src/context/bundle.js";
import { CONTEXT_LEFT_OUT_SENTENCE, ContextIndexError, contextIndex, renderContextIndex } from "../src/context/prompt-index.js";
import { contextSourceId, issueCommentUri, repositoryFileUri } from "../src/context/uri.js";

const C1 = "a".repeat(40);
const T0 = "2026-01-31T11:59:00.000Z";
const T = "2026-01-31T12:00:00.000Z";
const RUN = "/runs/r1";
const MARKER = "UNIQUE-SOURCE-TEXT-MARKER";

type Raw = Record<string, any>;

function src(kind: string, uri: string, more: Raw = {}): Raw {
  const id = contextSourceId(uri);
  const text = `${MARKER} ${uri}`;
  return {
    id,
    kind,
    uri,
    revision: kind === "repository-file" ? { commit: C1 } : { version: "2026-01-31T10:00:00Z" },
    content: { path: `context/${id}`, sha256: sha256Hex(text), bytes: Buffer.byteLength(text) },
    owners: [],
    classification: "internal",
    retrievedAt: T0,
    freshness: { maxAgeSeconds: null },
    selection: { reason: kind === "repository-file" ? "instructions" : "task" },
    consumers: ["planner", "coder"],
    ...more,
  };
}

const bundleOf = (sources: Raw[], omitted: Raw[] = []) =>
  parseContextBundle({
    version: 1,
    runId: "20260131-120000-abc",
    createdAt: T,
    repository: { repository: "acme/shop", commit: C1 },
    budget: { maxSources: 20, maxSourceBytes: 1000, maxTotalBytes: 10_000 },
    policies: [],
    sources,
    omitted,
  });

const opts = (more: Partial<Parameters<typeof contextIndex>[1]> = {}) => ({ role: "coder" as const, now: T, runDir: RUN, present: () => true, ...more });

describe("contextIndex", () => {
  it("lists id, kind, address, absolute file, bytes and reason, and the rule of a discovery", () => {
    const issue = src("issue", "issue:12");
    const found = src("repository-file", "repo:docs/API.md", { selection: { reason: "discovery", rule: "docs-api" } });
    const text = renderContextIndex(contextIndex(bundleOf([found, issue]), opts()));
    expect(text).toContain(`- ${issue.id} | issue | issue:12 | ${RUN}/context/${issue.id} | ${issue.content.bytes} bytes | picked: task`);
    expect(text).toContain(`- ${found.id} | repository-file | repo:docs/API.md | ${RUN}/context/${found.id} | ${found.content.bytes} bytes | picked: discovery, rule docs-api`);
    expect(text.startsWith("=== CONTEXT (role: coder) ===")).toBe(true);
    expect(text.endsWith("=== END CONTEXT ===")).toBe(true);
  });

  it("never holds source text", () => {
    const text = renderContextIndex(contextIndex(bundleOf([src("issue", "issue:12")]), opts()));
    expect(text).not.toContain(MARKER);
  });

  it("leaves out a source the role may not consume, with the fixed sentence", () => {
    const only = src("issue", "issue:12", { consumers: ["reviewer"] });
    const idx = contextIndex(bundleOf([only]), opts());
    expect(idx.entries).toEqual([]);
    expect(idx.leftOut).toEqual([{ kind: "issue", uri: "issue:12", reason: "role" }]);
    expect(renderContextIndex(idx)).toContain(`- issue:12 | issue | role: ${CONTEXT_LEFT_OUT_SENTENCE}`);
    expect(contextIndex(bundleOf([only]), opts({ role: "reviewer" })).entries).toHaveLength(1);
  });

  it("leaves out a stale source: fresh at the limit, stale one second later, never when null", () => {
    const s = src("issue", "issue:12", { freshness: { maxAgeSeconds: 60 } }); // retrieved T0, stale after T0 + 60s
    const at = (now: string) => contextIndex(bundleOf([s, src("repository-file", "repo:a.md")]), opts({ now }));
    expect(at("2026-01-31T12:00:00.000Z").entries.map((e) => e.uri)).toContain("issue:12");
    expect(at("2026-01-31T12:00:01.000Z").leftOut).toEqual([{ kind: "issue", uri: "issue:12", reason: "stale" }]);
    expect(at("2036-01-31T12:00:00.000Z").entries.map((e) => e.uri)).toEqual(["repo:a.md"]);
    expect(at("not a time").leftOut.map((l) => l.reason)).toEqual(["stale"]);
  });

  it("gives role before stale when both apply", () => {
    const s = src("issue", "issue:12", { consumers: ["reviewer"], freshness: { maxAgeSeconds: 1 } });
    expect(contextIndex(bundleOf([s]), opts({ now: "2030-01-01T00:00:00.000Z" })).leftOut[0]!.reason).toBe("role");
  });

  it("lists a source whose file is gone as missing, not as available", () => {
    const a = src("issue", "issue:12");
    const b = src("repository-file", "repo:a.md");
    const idx = contextIndex(bundleOf([a, b]), opts({ present: (s) => s.id !== a.id }));
    expect(idx.entries.map((e) => e.id)).toEqual([b.id]);
    expect(idx.leftOut).toEqual([{ kind: "issue", uri: "issue:12", reason: "missing" }]);
    expect(renderContextIndex(idx)).not.toContain(`${RUN}/context/${a.id}`);
  });

  it("prints every omitted entry with its own reason and the sentence", () => {
    const reasons = ["missing", "stale", "ambiguous", "over-budget", "classification", "generated", "unsupported"];
    const omitted = reasons.map((reason, i) => ({ kind: "repository-file", uri: `repo:f${i}.md`, selection: { reason: "instructions" }, reason }));
    const text = renderContextIndex(contextIndex(bundleOf([], omitted), opts()));
    for (const [i, r] of reasons.entries()) expect(text).toContain(`- repo:f${i}.md | repository-file | ${r}: ${CONTEXT_LEFT_OUT_SENTENCE}`);
  });

  it("orders the task first, comments by number, then notes and files by address", () => {
    const uris = [repositoryFileUri("z.md"), issueCommentUri(12, 100), repositoryFileUri("a.md"), issueCommentUri(12, 99), "issue:12"];
    const sources = uris.map((u) => src(u.startsWith("repo:") ? "repository-file" : u.includes("comment") ? "issue-comment" : "issue", u));
    expect(contextIndex(bundleOf(sources), opts()).entries.map((e) => e.uri)).toEqual(["issue:12", "issue:12/comment/99", "issue:12/comment/100", "repo:a.md", "repo:z.md"]);
  });

  it("prints none for empty lists", () => {
    const text = renderContextIndex(contextIndex(bundleOf([]), opts()));
    expect(text.match(/^- none$/gm)).toHaveLength(2);
  });

  it("refuses a bundle whose file is not context/<id>, whatever the schema allows", () => {
    for (const path of ["context/a b<x>|y.md", "context/s-0123456789abcdef/sub"]) {
      const s = src("issue", "issue:12");
      s.content.path = path;
      expect(() => contextIndex(bundleOf([s]), opts())).toThrow(ContextIndexError);
    }
  });

  it("renders an address with markup percent-encoded, on one line", () => {
    const s = src("repository-file", repositoryFileUri("a b<x>|.md"));
    const text = renderContextIndex(contextIndex(bundleOf([s]), opts()));
    const line = text.split("\n").find((l) => l.startsWith(`- ${s.id}`))!;
    expect(line).not.toMatch(/[<>]/);
    expect(line.split(" | ")).toHaveLength(6);
    expect(line).toContain(`${RUN}/context/${s.id}`);
  });
});
