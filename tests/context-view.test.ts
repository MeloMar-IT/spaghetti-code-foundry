import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashContextBundle, hashContextSources, parseContextBundle, serializeContextBundle } from "../src/context/bundle.js";
import { CONTEXT_CLASSIFICATIONS, CONTEXT_OMISSION_REASONS } from "../src/context/schema.js";
import { contextSourceId, issueCommentUri, refinementUri, repositoryFileUri } from "../src/context/uri.js";
import { sha256Hex } from "../src/evidence/identity.js";
import { readPlainBytes } from "../src/evidence/stream.js";
import {
  CONTEXT_NEXT_ACTIONS, CONTEXT_STATUS_LABELS, CONTEXT_VIEW_MAX_BYTES, contextNextAction, contextSourceLabel, runContextView,
} from "../src/server/context-view.js";

const C1 = "a".repeat(40);
const T0 = "2026-01-31T11:59:00.000Z";
const T = "2026-01-31T12:00:00.000Z";
const LATER = "2026-01-31T14:00:00.000Z";
const SESSION = "0b8f6a0e-5a52-4a4e-9a57-0f2f3f1f7c11";
const RUN = "20260131-120000-abc";
const MARKER = "SOURCE-TEXT-MARKER";

type Raw = Record<string, any>;

function src(kind: string, uri: string, text: string, more: Raw = {}): Raw {
  const id = contextSourceId(uri);
  return {
    id,
    kind,
    uri,
    revision: kind === "repository-file" ? { commit: C1 } : { version: "2026-01-31T10:00:00Z" },
    content: { path: `context/${id}`, sha256: sha256Hex(text), bytes: Buffer.byteLength(text) },
    owners: ["@acme/platform"],
    classification: "internal",
    retrievedAt: T0,
    freshness: { maxAgeSeconds: kind === "repository-file" ? null : 3600 },
    selection: { reason: kind === "repository-file" ? "instructions" : kind === "refinement-notes" ? "refinement" : "task" },
    consumers: ["planner", "coder"],
    ...more,
  };
}

const FILE = () => src("repository-file", repositoryFileUri("docs/API.md"), MARKER);
const ISSUE = () => src("issue", "issue:12", MARKER);
const COMMENT = () => src("issue-comment", issueCommentUri(12, 34), MARKER, { classification: "public" });
const NOTES = () => src("refinement-notes", refinementUri(SESSION), MARKER, { classification: "confidential" });

const omission = (reason: string, path = "CODEOWNERS"): Raw => ({ kind: "repository-file", uri: repositoryFileUri(path), selection: { reason: "ownership" }, reason });

const bundle = (more: Raw = {}): Raw => ({
  version: 1,
  runId: RUN,
  createdAt: T,
  repository: { repository: "acme/shop", commit: C1 },
  budget: { maxSources: 10, maxSourceBytes: 1000, maxTotalBytes: 4000 },
  policies: [{ id: "baseline", version: "2026.1" }],
  sources: [FILE(), ISSUE(), COMMENT(), NOTES()],
  omitted: [omission("missing")],
  ...more,
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A fake run folder; `raw` is written as the bundle (undefined: no file). */
function run(raw?: Raw | string) {
  const runDir = mkdtempSync(join(tmpdir(), "ctxview-"));
  dirs.push(runDir);
  if (raw !== undefined) writeFileSync(join(runDir, "context.json"), typeof raw === "string" ? raw : serializeContextBundle(parseContextBundle(raw)));
  return { runId: RUN, runDir, workdir: join(runDir, "work"), repo: join(runDir, "repo") };
}

describe("readPlainBytes limit", () => {
  it("refuses a file above the limit and reads one at it", () => {
    const s = run("x".repeat(11));
    expect(() => readPlainBytes(join(s.runDir, "context.json"), 10)).toThrow("too large");
    expect(readPlainBytes(join(s.runDir, "context.json"), 11)?.length).toBe(11);
  });
});

describe("runContextView: absent and unreadable", () => {
  it("is absent without a file or without a run folder", () => {
    for (const s of [run(), { ...run(), runDir: "" }]) {
      const v = runContextView(s, true, T);
      expect(v).toEqual({ runId: RUN, state: "absent", sources: [], omitted: [] });
    }
  });
  it.each([
    ["bad JSON", "{nope", "invalid"],
    ["a newer version", JSON.stringify({ version: 99 }), "unsupported-version"],
  ])("is unreadable for %s, with detail for an administrator only", (_n, text, code) => {
    const s = run(text);
    const admin = runContextView(s, true, T);
    const user = runContextView(s, false, T);
    expect(admin.state).toBe("unreadable");
    expect(admin.problem?.code).toBe(code);
    expect(admin.problem?.detail).toBeTruthy();
    expect(user.problem?.code).toBe(code);
    expect(user.problem?.detail).toBeUndefined();
    expect(JSON.stringify(user)).not.toContain(s.runDir);
    if (code === "unsupported-version") expect(user.problem?.reason).toContain("newer version");
  });
  it("gives an administrator no machine path, even when the file cannot be opened", () => {
    const s = run(bundle());
    const target = join(s.runDir, "elsewhere.json");
    writeFileSync(target, serializeContextBundle(parseContextBundle(bundle())));
    rmSync(join(s.runDir, "context.json"));
    symlinkSync(target, join(s.runDir, "context.json"));
    const admin = runContextView(s, true, T);
    expect(admin.state).toBe("unreadable");
    expect(admin.problem?.code).toBe("not-a-file");
    expect(admin.problem?.detail).toBe("the file cannot be opened (ELOOP)");
    const text = JSON.stringify(admin);
    expect(text).not.toContain(s.runDir);
    expect(text).not.toContain(target);
    expect(text).not.toContain(tmpdir());
  });
  it("is unreadable when context.json is a folder", () => {
    const s = run();
    mkdirSync(join(s.runDir, "context.json"));
    expect(runContextView(s, false, T).problem?.code).toBe("not-a-file");
  });
  it("is unreadable for the bundle of another run", () => {
    const s = run(bundle({ runId: "20260131-120000-zzz" }));
    const v = runContextView(s, true, T);
    expect(v.state).toBe("unreadable");
    expect(v.problem?.code).toBe("other-run");
  });
  it("is unreadable above the size limit, without reading the file", () => {
    const s = run("");
    truncateSync(join(s.runDir, "context.json"), CONTEXT_VIEW_MAX_BYTES + 1);
    const v = runContextView(s, false, T);
    expect(v.problem?.code).toBe("too-large");
    expect(v.problem?.reason).toContain("too large");
  });
});

describe("runContextView: available", () => {
  it("gives an administrator the hashes, the metadata and every address", () => {
    const raw = bundle();
    const s = run(raw);
    const b = parseContextBundle(raw);
    const v = runContextView(s, true, T);
    expect(v.state).toBe("available");
    expect(v.sha256).toBe(hashContextBundle(b));
    expect(v.sourcesSha256).toBe(hashContextSources(b));
    expect(v.createdAt).toBe(T);
    expect(v.repository).toEqual({ repository: "acme/shop", commit: C1 });
    expect(v.budget).toEqual(raw.budget);
    expect(v.sources.map((x) => x.label).sort()).toEqual(["Comment 34 on issue #12", "Issue #12", "Refinement notes", "Repository file docs/API.md"]);
    for (const x of v.sources) {
      expect(x.uri).toBeTruthy();
      expect(x.id).toBe(contextSourceId(x.uri!));
      expect(x.owners).toBeDefined();
      expect(x.sha256).toHaveLength(64);
      expect(x.bytes).toBe(MARKER.length);
    }
    expect(v.omitted[0]).toMatchObject({ uri: "repo:CODEOWNERS", id: contextSourceId("repo:CODEOWNERS"), label: "Repository file CODEOWNERS" });
  });
  it("labels from the address", () => {
    expect(contextSourceLabel("repository-file", "repo:src/a%20b.ts")).toBe("Repository file src/a b.ts");
    expect(contextSourceLabel("issue", "issue:12")).toBe("Issue #12");
    expect(contextSourceLabel("issue-comment", "issue:12/comment/34")).toBe("Comment 34 on issue #12");
    expect(contextSourceLabel("refinement-notes", `refinement:${SESSION}`)).toBe("Refinement notes");
    expect(contextSourceLabel("repository-file", "repo:a", "restricted")).toBe("Restricted repository file");
    expect(contextSourceLabel("issue", "issue:1", "address")).toBe("Issue");
  });

  it.each(CONTEXT_CLASSIFICATIONS)("shows a user a %s source in its own shape", (classification) => {
    const raw = bundle({ sources: [src("repository-file", repositoryFileUri("secret/plan.md"), MARKER, { classification })], omitted: [] });
    const v = runContextView(run(raw), false, T);
    const x = v.sources[0]!;
    if (classification === "confidential" || classification === "restricted") {
      expect(Object.keys(x).sort()).toEqual(["classification", "freshness", "kind", "label", "retrievedAt", "selection"]);
      expect(x.label).toBe(`${classification === "restricted" ? "Restricted" : "Confidential"} repository file`);
      const text = JSON.stringify(v);
      for (const secret of ["secret/plan.md", "secret%2Fplan", "repo:", contextSourceId("repo:secret/plan.md"), "@acme/platform", sha256Hex(MARKER)]) expect(text).not.toContain(secret);
    } else {
      expect(x.label).toBe("Repository file secret/plan.md");
      expect(x.owners).toEqual(["@acme/platform"]);
      expect(x.sha256).toBe(sha256Hex(MARKER));
      expect(x.revision).toEqual({ commit: C1 });
      expect(x.uri).toBeUndefined();
      expect(x.id).toBeUndefined();
    }
    // the bundle-level hashes stay
    expect(v.sha256).toHaveLength(64);
    expect(v.sourcesSha256).toHaveLength(64);
  });

  it("gives every omission reason its own label, and the right next action for each role", () => {
    const raw = bundle({ sources: [FILE()], omitted: CONTEXT_OMISSION_REASONS.map((r) => omission(r, `f-${r}.md`)) });
    const s = run(raw);
    const admin = runContextView(s, true, T);
    const user = runContextView(s, false, T);
    expect(new Set(admin.omitted.map((o) => o.statusLabel)).size).toBe(CONTEXT_OMISSION_REASONS.length);
    for (const [view, isAdmin] of [[admin, true], [user, false]] as const) {
      const byStatus = new Map(view.omitted.map((o) => [o.status, o]));
      for (const r of CONTEXT_OMISSION_REASONS) {
        const o = byStatus.get(r)!;
        expect(o.statusLabel).toBe(CONTEXT_STATUS_LABELS[r]);
        expect(o.nextCode).toBe(contextNextAction(r, isAdmin));
        expect(o.next).toBe(CONTEXT_NEXT_ACTIONS[o.nextCode]);
      }
      const codes = ["missing", "stale", "ambiguous", "over-budget"].map((r) => byStatus.get(r as never)!.nextCode);
      expect(new Set(codes).size).toBe(4);
    }
    for (const r of ["over-budget", "classification", "stale"] as const) expect(contextNextAction(r, true)).not.toBe(contextNextAction(r, false));
    for (const r of ["missing", "ambiguous", "generated", "unsupported"] as const) expect(contextNextAction(r, true)).toBe(contextNextAction(r, false));
    for (const t of Object.values(CONTEXT_NEXT_ACTIONS)) expect(t.length).toBeGreaterThan(10);
    // a user sees no address for an entry, and the kind only when it was left out for its classification
    for (const o of user.omitted) {
      expect(o.uri).toBeUndefined();
      expect(o.id).toBeUndefined();
    }
    const cls = user.omitted.find((o) => o.status === "classification")!;
    expect(cls.label).toBe("Repository file");
    expect(JSON.stringify(cls)).not.toContain("f-classification");
    expect(admin.omitted.every((o) => o.id === contextSourceId(o.uri!))).toBe(true);
  });

  it("tells fresh from stale at the time of the request", () => {
    const s = run(bundle({ sources: [FILE(), ISSUE()], omitted: [] }));
    const fresh = runContextView(s, false, T);
    expect(fresh.sources.every((x) => x.freshness === "fresh" && x.nextCode === undefined)).toBe(true);
    const later = runContextView(s, false, LATER);
    const issue = later.sources.find((x) => x.kind === "issue")!;
    const file = later.sources.find((x) => x.kind === "repository-file")!;
    expect(issue.freshness).toBe("stale");
    expect(issue.nextCode).toBe("rerun-for-fresh");
    expect(issue.next).toBe(CONTEXT_NEXT_ACTIONS["rerun-for-fresh"]);
    expect(["reread", "reread-or-raise-age"]).not.toContain(issue.nextCode);
    expect(file.freshness).toBe("fresh");
    expect(runContextView(s, false, "not a time").sources.find((x) => x.kind === "issue")!.freshness).toBe("stale");
  });

  it("never holds source text, a stored path or a folder of this machine", () => {
    const s = run(bundle());
    for (const admin of [true, false]) {
      const text = JSON.stringify(runContextView(s, admin, T));
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain('"content"');
      expect(text).not.toContain("context/");
      if (!admin) for (const p of [s.runDir, s.workdir, s.repo]) expect(text).not.toContain(p);
    }
  });
});
