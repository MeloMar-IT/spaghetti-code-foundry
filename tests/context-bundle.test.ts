import { describe, expect, it } from "vitest";
import { ArtifactRefSchema, sha256Hex } from "../src/evidence/identity.js";
import { RunEvidenceSchema } from "../src/evidence/schema.js";
import {
  classificationAtMost, contextBundleRef, contextSourceRef, contextTotalBytes, findSource, hashContextBundle, hashContextSources, isSourceText, isStale,
  mayConsume, parseContextBundle, readContextBundle, serializeContextBundle, staleAt,
} from "../src/context/bundle.js";
import {
  CONTEXT_CLASSIFICATIONS, CONTEXT_CONSUMERS, CONTEXT_MAX_ENTRIES, CONTEXT_OMISSION_REASONS, CONTEXT_SELECTION_REASONS, CONTEXT_SOURCE_KINDS,
  ContextBundleSchema, type ContextBundle, type ContextSource,
} from "../src/context/schema.js";
import { contextSourceId, issueCommentUri, issueUri, refinementUri, repositoryFilePath, repositoryFileUri } from "../src/context/uri.js";
import { CONTEXT_BUNDLE_FILE, CONTEXT_BUNDLE_VERSION, CONTEXT_SOURCES_DIR, ContextSchemaError, upgradeContextBundle } from "../src/context/version.js";

const C1 = "a".repeat(40);
const C2 = "b".repeat(40);
const T0 = "2026-01-31T11:59:00.000Z";
const T = "2026-01-31T12:00:00.000Z";
const SESSION = "0b8f6a0e-5a52-4a4e-9a57-0f2f3f1f7c11";

type Raw = Record<string, any>;

/** A valid source for an address; `more` replaces fields. */
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

const FILE = () => src("repository-file", "repo:CLAUDE.md", "# rules\n");
const FOUND = () => src("repository-file", "repo:src/a%20b.ts", "export {};\n", { selection: { reason: "discovery", rule: "named-in-task" }, owners: [] });
const ISSUE = () => src("issue", "issue:12", "Add a button");
const COMMENT = () => src("issue-comment", "issue:12/comment/34", "Make it blue", { classification: "public" });
const NOTES = () => src("refinement-notes", `refinement:${SESSION}`, "Accepted: one button", { classification: "confidential", consumers: ["planner"] });

const bundle = (more: Raw = {}): Raw => ({
  version: 1,
  runId: "20260131-120000-abc",
  createdAt: T,
  repository: { repository: "acme/shop", commit: C1 },
  budget: { maxSources: 10, maxSourceBytes: 1000, maxTotalBytes: 4000 },
  policies: [{ id: "baseline", version: "2026.1" }],
  sources: [FILE(), FOUND(), ISSUE(), COMMENT(), NOTES()],
  omitted: [{ kind: "repository-file", uri: "repo:CODEOWNERS", selection: { reason: "ownership" }, reason: "missing" }],
  ...more,
});

/** The bundle with its first source changed. */
const withFirst = (change: (s: Raw) => void, more: Raw = {}): Raw => {
  const b = bundle(more);
  change(b.sources[0]);
  return b;
};

function problems(raw: unknown): ContextSchemaError {
  try {
    parseContextBundle(raw);
  } catch (e) {
    if (e instanceof ContextSchemaError) return e;
    throw e;
  }
  throw new Error("expected a ContextSchemaError");
}
const paths = (raw: unknown): string[] => problems(raw).issues.map((i) => i.path);

describe("context bundle: shape", () => {
  it("reads a bundle with a source of every kind back unchanged", () => {
    const raw = bundle();
    expect([...new Set(raw.sources.map((s: Raw) => s.kind))].sort()).toEqual([...new Set(CONTEXT_SOURCE_KINDS)].sort());
    expect(parseContextBundle(raw)).toEqual(raw);
    expect(CONTEXT_BUNDLE_VERSION).toBe(1);
  });

  it("accepts an empty bundle and a repository without a name", () => {
    expect(parseContextBundle(bundle({ sources: [], omitted: [], policies: [], repository: { commit: "c".repeat(64) } })).sources).toEqual([]);
  });

  it("needs every field of a source", () => {
    for (const field of ["id", "kind", "uri", "revision", "content", "owners", "classification", "retrievedAt", "freshness", "selection", "consumers"]) {
      const raw = withFirst((s) => delete s[field]);
      expect(paths(raw), field).toContain(`sources.0.${field}`);
    }
    for (const field of ["path", "sha256", "bytes"]) expect(paths(withFirst((s) => delete s.content[field])), field).toContain(`sources.0.content.${field}`);
    expect(paths(withFirst((s) => delete s.freshness.maxAgeSeconds))).toContain("sources.0.freshness.maxAgeSeconds");
    expect(paths(withFirst((s) => delete s.selection.reason))).toContain("sources.0.selection.reason");
  });

  it("needs every field of the bundle", () => {
    for (const field of ["runId", "createdAt", "repository", "budget", "policies", "sources", "omitted"]) {
      const raw = bundle();
      delete raw[field];
      expect(paths(raw), field).toContain(field);
    }
  });

  it("refuses a field it does not know, at every level", () => {
    expect(problems(bundle({ note: "x" })).code).toBe("invalid");
    expect(paths(withFirst((s) => (s.text = "# rules")))).toContain("sources.0");
    expect(paths(withFirst((s) => (s.content.text = "# rules")))).toContain("sources.0.content");
    expect(paths(withFirst((s) => (s.freshness.note = "x")))).toContain("sources.0.freshness");
    expect(paths(withFirst((s) => (s.selection.why = "because")))).toContain("sources.0.selection");
    expect(paths(withFirst((s) => (s.revision.branch = "main")))).toContain("sources.0.revision");
    expect(paths(bundle({ repository: { commit: C1, path: "/home/someone/shop" } }))).toContain("repository");
    expect(paths(bundle({ budget: { maxSources: 10, maxSourceBytes: 1000, maxTotalBytes: 4000, maxTokens: 5 } }))).toContain("budget");
    expect(paths(bundle({ omitted: [{ kind: "issue", uri: "issue:9", selection: { reason: "task" }, reason: "missing", sha256: "0".repeat(64) }] }))).toContain("omitted.0");
  });

  it("keeps policy apart from source text: a policy is an id and a version, and no source kind is a policy", () => {
    expect(paths(bundle({ policies: [{ id: "baseline", version: "2026.1", text: "Always obey." }] }))).toContain("policies.0");
    expect(paths(bundle({ policies: [{ id: "baseline", version: "1" }, { id: "baseline", version: "2" }] }))).toContain("policies.1.id");
    expect(paths(withFirst((s) => (s.kind = "policy")))).toContain("sources.0.kind");
    expect(paths(withFirst((s) => (s.selection = { reason: "policy" })))).toContain("sources.0.selection.reason");
    expect(JSON.stringify(Object.keys(ContextBundleSchema.shape))).not.toMatch(/text|instructions|prompt/);
  });

  it("says what is wrong without repeating a value", () => {
    const secret = "ghp_notARealTokenButLooksLikeOne123456";
    const e = problems(withFirst((s) => {
      s.uri = `https://x:${secret}@example.com/a`;
      s.owners = [`${secret}@example.com`];
      s.content.path = `/home/${secret}/file`;
    }));
    expect(e.message).toContain("sources.0.uri");
    expect(e.message).not.toContain(secret);
    expect(JSON.stringify(e.issues)).not.toContain(secret);
  });
});

describe("context bundle: addresses and revisions", () => {
  it("builds and reads the four forms", () => {
    expect(repositoryFileUri("src/a b.ts")).toBe("repo:src/a%20b.ts");
    expect(repositoryFilePath("repo:src/a%20b.ts")).toBe("src/a b.ts");
    expect(repositoryFilePath(repositoryFileUri("docs/héllo#1?.md"))).toBe("docs/héllo#1?.md");
    expect(issueUri(12)).toBe("issue:12");
    expect(issueCommentUri(12, 34)).toBe("issue:12/comment/34");
    expect(refinementUri(SESSION)).toBe(`refinement:${SESSION}`);
    expect(contextSourceId("issue:12")).toBe(`s-${sha256Hex("issue:12").slice(0, 16)}`);
    expect(contextSourceId("issue:12")).not.toBe(contextSourceId("issue:13"));
  });

  it("refuses to build an address that leaves the repository or is not a number or an id", () => {
    for (const path of ["/etc/passwd", "../other/a.ts", "a/../b", "a//b", "./a", "C:/a", "a\\b", "", "a\nb", "a/\ud800"]) expect(() => repositoryFileUri(path), JSON.stringify(path)).toThrow(/inside the repository/);
    for (const n of [0, -1, 1.5, Number.NaN, 2 ** 60]) expect(() => issueUri(n), String(n)).toThrow(/whole number/);
    expect(() => issueCommentUri(1, 0)).toThrow(/comment id/);
    expect(() => refinementUri("../x")).toThrow(/UUID/);
    expect(() => refinementUri(SESSION.toUpperCase())).toThrow(/UUID/);
  });

  it("refuses an address that is not one of the four forms in its one spelling", () => {
    const bad = [
      "/home/someone/shop/CLAUDE.md", "file:///home/someone/shop/CLAUDE.md", "https://github.com/acme/shop/blob/main/CLAUDE.md", "https://user:token@example.com/a",
      "repo:/CLAUDE.md", "repo:../CLAUDE.md", "repo:a/../b", "repo:a/%2e%2e/b", "repo:a%2Fb", "repo:a b.ts", "repo:a%2fb", "repo:a%zz", "repo:", "repo:a?token=1", "repo:a#x",
      "REPO:CLAUDE.md", "issue:12", "CLAUDE.md", "", `repo:${"a".repeat(5000)}`,
    ];
    for (const uri of bad) expect(paths(withFirst((s) => (s.uri = uri))), uri).toContain("sources.0.uri");
    for (const uri of ["issue:0", "issue:012", "issue:12/", "issue:12?x=1", "issue:acme/shop#12", "issue:12/comment/34", "repo:a"]) {
      expect(paths(bundle({ sources: [src("issue", "issue:12", "x", { uri })] })), uri).toContain("sources.0.uri");
    }
    for (const uri of ["issue:12", "issue:12/comment/0", "issue:12/comment/x", "issue:12/comments/3"]) {
      expect(paths(bundle({ sources: [src("issue-comment", "issue:12/comment/3", "x", { uri })] })), uri).toContain("sources.0.uri");
    }
    for (const uri of ["refinement:abc", `refinement:${SESSION}/x`, `refinement:${SESSION.toUpperCase()}`]) {
      expect(paths(bundle({ sources: [src("refinement-notes", `refinement:${SESSION}`, "x", { uri })] })), uri).toContain("sources.0.uri");
    }
  });

  it("ties the id to the address, and has each address and each file once", () => {
    expect(paths(withFirst((s) => (s.id = contextSourceId("repo:other.md"))))).toEqual(["sources.0.id"]);
    expect(paths(withFirst((s) => (s.id = "CLAUDE")))).toContain("sources.0.id");
    const twice = bundle();
    twice.sources.push(FILE());
    expect(paths(twice)).toEqual(expect.arrayContaining(["sources.5.uri", "sources.5.content.path"]));
    const shared = bundle();
    shared.sources[1].content.path = shared.sources[0].content.path;
    expect(paths(shared)).toEqual(["sources.1.content.path"]);
  });

  it("wants a full commit for a repository file, the commit of the bundle, and a version for the rest", () => {
    expect(paths(withFirst((s) => (s.revision = { commit: C2 })))).toEqual(["sources.0.revision.commit"]);
    expect(paths(withFirst((s) => (s.revision = { commit: "abc1234" })))).toContain("sources.0.revision.commit");
    expect(paths(withFirst((s) => (s.revision = { version: "1" })))).toContain("sources.0.revision.commit");
    expect(paths(withFirst((s) => (s.revision = {})))).toContain("sources.0.revision.commit");
    expect(paths(bundle({ sources: [src("issue", "issue:12", "x", { revision: { commit: C1 } })] }))).toContain("sources.0.revision.version");
    for (const version of ["", "two words", "a/b", "x".repeat(101), "v1\n"]) {
      expect(paths(bundle({ sources: [src("issue", "issue:12", "x", { revision: { version } })] })), version).toContain("sources.0.revision.version");
    }
    expect(paths(bundle({ repository: { repository: "acme/shop", commit: "main" } }))).toContain("repository.commit");
    expect(paths(bundle({ repository: { repository: "/home/someone/shop", commit: C1 } }))).toContain("repository.repository");
  });

  it("stores the text under context/ in the run folder, by hash and size", () => {
    expect(CONTEXT_SOURCES_DIR).toBe("context");
    for (const path of ["CLAUDE.md", "/tmp/context/a", "context/../run.json", "context", "context/", "contexts/a", "steps/context/a", "context\\a"]) {
      expect(paths(withFirst((s) => (s.content.path = path))), path).toContain("sources.0.content.path");
    }
    expect(paths(withFirst((s) => (s.content.sha256 = "ABC")))).toContain("sources.0.content.sha256");
    for (const bytes of [-1, 1.5, "8", null]) expect(paths(withFirst((s) => (s.content.bytes = bytes))), String(bytes)).toContain("sources.0.content.bytes");
  });
});

describe("context bundle: who, how private, how fresh, why, for whom", () => {
  it("takes owners as host handles only, each once", () => {
    expect(parseContextBundle(withFirst((s) => (s.owners = ["@alice", "@acme/platform-team"]))).sources[0]!.owners).toHaveLength(2);
    for (const owner of ["alice", "alice@example.com", "@", "@acme/", "Alice Example", "@a b", ""]) expect(paths(withFirst((s) => (s.owners = [owner]))), owner).toContain("sources.0.owners.0");
    expect(paths(withFirst((s) => (s.owners = ["@alice", "@alice"])))).toEqual(["sources.0.owners.1"]);
  });

  it("has a closed, ordered list of classifications", () => {
    expect(CONTEXT_CLASSIFICATIONS).toEqual(["public", "internal", "confidential", "restricted"]);
    for (const c of ["secret", "Public", "", null]) expect(paths(withFirst((s) => (s.classification = c))), String(c)).toContain("sources.0.classification");
    expect(classificationAtMost("public", "internal")).toBe(true);
    expect(classificationAtMost("internal", "internal")).toBe(true);
    expect(classificationAtMost("confidential", "internal")).toBe(false);
    expect(classificationAtMost("restricted", "confidential")).toBe(false);
    expect(classificationAtMost("restricted", "restricted")).toBe(true);
  });

  it("wants a UTC retrieval time that is not after the bundle", () => {
    for (const t of ["2026-01-31", "2026-01-31T12:00:00+01:00", "yesterday", 1769860800]) expect(paths(withFirst((s) => (s.retrievedAt = t))), String(t)).toContain("sources.0.retrievedAt");
    expect(paths(withFirst((s) => (s.retrievedAt = "2026-01-31T12:00:00.001Z")))).toEqual(["sources.0.retrievedAt"]);
    expect(parseContextBundle(withFirst((s) => (s.retrievedAt = T))).sources[0]!.retrievedAt).toBe(T);
  });

  it("gives freshness in whole seconds or null, and says when a copy is stale", () => {
    for (const age of [0, -5, 1.5, "3600", 315_360_001]) expect(paths(withFirst((s) => (s.freshness = { maxAgeSeconds: age }))), String(age)).toContain("sources.0.freshness.maxAgeSeconds");
    const b = parseContextBundle(bundle());
    const file = findSource(b, contextSourceId("repo:CLAUDE.md"))!;
    const issue = findSource(b, contextSourceId("issue:12"))!;
    expect(staleAt(file)).toBeNull();
    expect(isStale(file, "2099-01-01T00:00:00Z")).toBe(false);
    expect(staleAt(issue)).toBe("2026-01-31T12:59:00.000Z");
    expect(isStale(issue, "2026-01-31T12:59:00.000Z")).toBe(false);
    expect(isStale(issue, "2026-01-31T12:59:00.001Z")).toBe(true);
    expect(isStale(issue, "not a time")).toBe(true);
    expect(findSource(b, "s-0000000000000000")).toBeUndefined();
  });

  it("takes only the reasons that fit the kind, and a rule for discovery", () => {
    expect(CONTEXT_SELECTION_REASONS).toEqual(["task", "instructions", "ownership", "api-schema", "discovery", "refinement"]);
    for (const reason of ["task", "refinement", "because it matters", ""]) expect(paths(withFirst((s) => (s.selection = { reason }))), reason).toContain("sources.0.selection.reason");
    for (const reason of ["instructions", "discovery", "refinement"]) expect(paths(bundle({ sources: [src("issue", "issue:12", "x", { selection: { reason } })] })), reason).toContain("sources.0.selection.reason");
    expect(paths(bundle({ sources: [src("refinement-notes", `refinement:${SESSION}`, "x", { selection: { reason: "task" } })] }))).toContain("sources.0.selection.reason");
    expect(paths(withFirst((s) => (s.selection = { reason: "discovery" })))).toEqual(["sources.0.selection.rule"]);
    expect(paths(withFirst((s) => (s.selection = { reason: "discovery", rule: "Named in the task!" })))).toContain("sources.0.selection.rule");
    expect(parseContextBundle(withFirst((s) => (s.selection = { reason: "api-schema", rule: "openapi" }))).sources[0]!.selection).toEqual({ reason: "api-schema", rule: "openapi" });
  });

  it("names at least one consumer from the closed list, each once", () => {
    expect(CONTEXT_CONSUMERS).toEqual(["planner", "coder", "reviewer", "tester"]);
    expect(paths(withFirst((s) => (s.consumers = [])))).toContain("sources.0.consumers");
    expect(paths(withFirst((s) => (s.consumers = ["everyone"])))).toContain("sources.0.consumers.0");
    expect(paths(withFirst((s) => (s.consumers = ["coder", "coder"])))).toEqual(["sources.0.consumers.1"]);
    const notes = parseContextBundle(bundle()).sources.find((s) => s.kind === "refinement-notes")!;
    expect(mayConsume(notes, "planner")).toBe(true);
    expect(mayConsume(notes, "coder")).toBe(false);
  });
});

describe("context bundle: budget and omissions", () => {
  it("is not valid over its own budget", () => {
    expect(contextTotalBytes(parseContextBundle(bundle()))).toBe(8 + 11 + 12 + 12 + 20);
    expect(paths(bundle({ budget: { maxSources: 4, maxSourceBytes: 1000, maxTotalBytes: 4000 } }))).toEqual(["sources"]);
    expect(paths(bundle({ budget: { maxSources: 10, maxSourceBytes: 19, maxTotalBytes: 4000 } }))).toEqual(["sources.4.content.bytes"]);
    expect(problems(bundle({ budget: { maxSources: 10, maxSourceBytes: 20, maxTotalBytes: 62 } })).issues).toEqual([{ path: "sources", message: "has more bytes of text than budget.maxTotalBytes" }]);
    expect(parseContextBundle(bundle({ budget: { maxSources: 5, maxSourceBytes: 20, maxTotalBytes: 63 } })).sources).toHaveLength(5);
    expect(paths(bundle({ budget: { maxSources: 10, maxSourceBytes: 5000, maxTotalBytes: 4000 } }))).toEqual(["budget.maxSourceBytes"]);
  });

  it("wants whole budgets above zero, in sources and bytes", () => {
    const ok = { maxSources: 10, maxSourceBytes: 1000, maxTotalBytes: 4000 };
    for (const field of Object.keys(ok)) {
      for (const value of [0, -1, 1.5, "10", null, undefined]) expect(paths(bundle({ budget: { ...ok, [field]: value } })), `${field}=${String(value)}`).toContain(`budget.${field}`);
    }
    expect(paths(bundle({ budget: { ...ok, maxSources: CONTEXT_MAX_ENTRIES + 1 } }))).toContain("budget.maxSources");
  });

  it("records a source that was left out with its reason, once, and never together with the source itself", () => {
    expect(CONTEXT_OMISSION_REASONS).toEqual(["missing", "stale", "ambiguous", "over-budget", "classification", "generated", "unsupported"]);
    for (const reason of CONTEXT_OMISSION_REASONS) {
      expect(parseContextBundle(bundle({ omitted: [{ kind: "issue-comment", uri: "issue:12/comment/99", selection: { reason: "task" }, reason }] })).omitted[0]!.reason).toBe(reason);
    }
    const o = { kind: "repository-file", uri: "repo:docs/API.md", selection: { reason: "api-schema" }, reason: "over-budget" };
    expect(paths(bundle({ omitted: [{ ...o, reason: "too long" }] }))).toContain("omitted.0.reason");
    expect(paths(bundle({ omitted: [{ ...o, uri: "/abs/API.md" }] }))).toContain("omitted.0.uri");
    expect(paths(bundle({ omitted: [{ ...o, selection: { reason: "task" } }] }))).toContain("omitted.0.selection.reason");
    expect(paths(bundle({ omitted: [{ ...o, selection: { reason: "discovery" } }] }))).toEqual(["omitted.0.selection.rule"]);
    expect(paths(bundle({ omitted: [o, o] }))).toEqual(["omitted.1.uri"]);
    expect(paths(bundle({ omitted: [{ ...o, uri: "repo:CLAUDE.md" }] }))).toEqual(["omitted.0.uri"]);
  });
});

describe("context bundle: text and hash", () => {
  const shuffled = (): Raw => {
    const b = bundle({ policies: [{ id: "repo", version: "3" }, { id: "baseline", version: "2026.1" }] });
    const again = bundle({ policies: [{ id: "baseline", version: "2026.1" }, { id: "repo", version: "3" }] });
    again.sources.reverse();
    again.sources.forEach((s: Raw) => {
      s.consumers.reverse();
      Object.assign(s, Object.fromEntries(Object.entries(s).reverse()));
    });
    return { b, again: Object.fromEntries(Object.entries(again).reverse()) };
  };

  it("writes the same text for the same bundle, whatever the order of its lists and fields", () => {
    const { b, again } = shuffled();
    const text = serializeContextBundle(b as ContextBundle);
    expect(serializeContextBundle(again as ContextBundle)).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    const back = parseContextBundle(JSON.parse(text));
    expect(back.sources.map((s) => s.uri)).toEqual([...back.sources.map((s) => s.uri)].sort());
    expect(serializeContextBundle(back)).toBe(text);
    expect(hashContextBundle(again as ContextBundle)).toBe(sha256Hex(text));
  });

  it("changes the hash when anything in the bundle changes", () => {
    const base = hashContextBundle(bundle() as ContextBundle);
    const changes: ((b: Raw) => void)[] = [
      (b) => (b.runId = "20260131-120000-abd"),
      (b) => (b.createdAt = "2026-01-31T12:00:00.001Z"),
      (b) => (b.budget.maxTotalBytes = 4001),
      (b) => (b.policies[0].version = "2026.2"),
      (b) => (b.sources[0].content.sha256 = "0".repeat(64)),
      (b) => (b.sources[0].classification = "public"),
      (b) => (b.sources[0].consumers = ["planner"]),
      (b) => (b.sources[2].revision.version = "2026-01-31T10:00:01Z"),
      (b) => (b.sources[2].freshness.maxAgeSeconds = 3601),
      (b) => (b.omitted[0].reason = "stale"),
      (b) => b.sources.pop(),
    ];
    const hashes = changes.map((change) => {
      const b = bundle();
      change(b);
      return hashContextBundle(b as ContextBundle);
    });
    expect(new Set([base, ...hashes]).size).toBe(changes.length + 1);
  });

  it("does not write a bundle that is not valid", () => {
    expect(() => serializeContextBundle(withFirst((s) => (s.uri = "/abs")) as ContextBundle)).toThrow(ContextSchemaError);
    expect(() => hashContextBundle(bundle({ extra: 1 }) as ContextBundle)).toThrow(ContextSchemaError);
  });

  it("gives evidence a reference to context.json by hash, which a manifest accepts", () => {
    const b = bundle() as ContextBundle;
    const ref = contextBundleRef(b);
    const text = serializeContextBundle(b);
    expect(CONTEXT_BUNDLE_FILE).toBe("context.json");
    expect(ref).toEqual({ kind: "other", path: "context.json", sha256: hashContextBundle(b), bytes: Buffer.byteLength(text), required: true });
    const sourceRef = contextSourceRef(b.sources[0]!);
    expect(ArtifactRefSchema.parse(sourceRef)).toEqual({ kind: "other", path: b.sources[0]!.content.path, sha256: sha256Hex("# rules\n"), bytes: 8, required: false });
    const manifest = RunEvidenceSchema.parse({
      version: 1, runId: b.runId, status: "succeeded", startedAt: T, finishedAt: T, finalizedAt: T,
      flow: { name: "issue-gitflow", sha256: "2".repeat(64) }, events: { path: "evidence.jsonl", count: 3, terminalHash: "1".repeat(64) },
      git: {}, models: [], policies: [], approvals: [], tests: [], artifacts: [ref, sourceRef],
    });
    expect(manifest.artifacts[0]!.sha256).toBe(sha256Hex(text));
  });

  it("has one hash for the sources that does not depend on the run, the time or the reasons", () => {
    const base = hashContextSources(bundle() as ContextBundle);
    const other = bundle({ runId: "another-run", createdAt: "2026-02-01T00:00:00Z", budget: { maxSources: 50, maxSourceBytes: 9000, maxTotalBytes: 9000 }, policies: [], omitted: [] });
    other.sources.reverse();
    other.sources.forEach((s: Raw) => (s.consumers = ["tester"]));
    expect(hashContextSources(other as ContextBundle)).toBe(base);
    expect(hashContextSources(withFirst((s) => (s.content.sha256 = "0".repeat(64))) as ContextBundle)).not.toBe(base);
    const moved = bundle({ repository: { commit: C2 } });
    moved.sources.forEach((s: Raw) => s.kind === "repository-file" && (s.revision = { commit: C2 }));
    expect(hashContextSources(moved as ContextBundle)).not.toBe(base);
  });

  it("checks a text against the hash and size of its source", () => {
    const s = parseContextBundle(bundle()).sources[0] as ContextSource;
    expect(isSourceText(s, "# rules\n")).toBe(true);
    expect(isSourceText(s, new TextEncoder().encode("# rules\n"))).toBe(true);
    expect(isSourceText(s, "# rules")).toBe(false);
    expect(isSourceText(s, "# rulez\n")).toBe(false);
  });
});

describe("context bundle: versions and old runs", () => {
  /** A version 1 `context.json` exactly as this Foundry wrote it. Never change this text: it is what old runs have. */
  const V1 = `{
  "budget": {
    "maxSourceBytes": 1000,
    "maxSources": 10,
    "maxTotalBytes": 4000
  },
  "createdAt": "2026-01-31T12:00:00.000Z",
  "omitted": [
    {
      "kind": "repository-file",
      "reason": "missing",
      "selection": {
        "reason": "ownership"
      },
      "uri": "repo:CODEOWNERS"
    }
  ],
  "policies": [
    {
      "id": "baseline",
      "version": "2026.1"
    }
  ],
  "repository": {
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "repository": "acme/shop"
  },
  "runId": "20260131-120000-abc",
  "sources": [
    {
      "classification": "internal",
      "consumers": [
        "planner",
        "coder"
      ],
      "content": {
        "bytes": 8,
        "path": "context/s-a39b1fb8f39bff11",
        "sha256": "b063d404f1417cfe60efad23a84eb7a9539b123ebc87f401aa0b7c3b86067df1"
      },
      "freshness": {
        "maxAgeSeconds": null
      },
      "id": "s-a39b1fb8f39bff11",
      "kind": "repository-file",
      "owners": [
        "@acme/platform"
      ],
      "retrievedAt": "2026-01-31T11:59:00.000Z",
      "revision": {
        "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "selection": {
        "reason": "instructions"
      },
      "uri": "repo:CLAUDE.md"
    }
  ],
  "version": 1
}
`;
  const V1_SHA256 = "ede66dbc3d949f4027ae7d398a51237f32bcbbbca59c548bfd192349d1e86cbf";

  it("still reads a version 1 file as it was written, and writes it back byte for byte", () => {
    const read = readContextBundle(V1);
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.bundle).toEqual(parseContextBundle(bundle({ sources: [FILE()] })));
    expect(serializeContextBundle(read.bundle)).toBe(V1);
    expect(hashContextBundle(read.bundle)).toBe(V1_SHA256);
    expect(sha256Hex(V1)).toBe(V1_SHA256);
  });

  it("says absent for a run without a bundle, and never throws on a broken one", () => {
    expect(readContextBundle(undefined)).toEqual({ state: "absent" });
    expect(readContextBundle("")).toMatchObject({ state: "unreadable", code: "invalid", reason: "context bundle: not valid JSON" });
    expect(readContextBundle("{ nope")).toMatchObject({ state: "unreadable", code: "invalid" });
    expect(readContextBundle("[]")).toMatchObject({ state: "unreadable", code: "not-an-object" });
    expect(readContextBundle("null")).toMatchObject({ state: "unreadable", code: "not-an-object" });
    expect(readContextBundle('{"sources":[]}')).toMatchObject({ state: "unreadable", code: "no-version" });
    expect(readContextBundle(JSON.stringify(bundle({ version: "1" })))).toMatchObject({ state: "unreadable", code: "no-version" });
    expect(readContextBundle(JSON.stringify(bundle({ version: 0 })))).toMatchObject({ state: "unreadable", code: "no-version" });
    expect(readContextBundle(JSON.stringify(bundle({ runId: "../x" })))).toMatchObject({ state: "unreadable", code: "invalid" });
  });

  it("refuses a bundle of a newer Foundry with a sentence that says so", () => {
    const read = readContextBundle(JSON.stringify(bundle({ version: 2 })));
    expect(read).toMatchObject({ state: "unreadable", code: "unsupported-version" });
    expect(read.state === "unreadable" && read.reason).toMatch(/version 2 is not supported; this Foundry reads version 1\. It was written by a newer Foundry/);
  });

  it("brings an older bundle to the current version step by step, without changing the input", () => {
    const old = Object.freeze({ version: 1, a: 1 });
    const steps = { 1: (r: Record<string, unknown>) => ({ ...r, version: 2, b: 2 }), 2: (r: Record<string, unknown>) => ({ ...r, version: 3, c: 3 }) };
    expect(upgradeContextBundle(old, 3, steps)).toEqual({ version: 3, a: 1, b: 2, c: 3 });
    expect(upgradeContextBundle({ version: 3, z: 0 }, 3, steps)).toEqual({ version: 3, z: 0 });
    expect(old).toEqual({ version: 1, a: 1 });
    expect(() => upgradeContextBundle(old, 3, { 1: steps[1] })).toThrow(/version 2 can no longer be read/);
    expect(() => upgradeContextBundle(old, 2, { 1: (r) => ({ ...r }) })).toThrow(/did not give a version 2 record/);
    expect(() => upgradeContextBundle({ version: 4 }, 3, steps)).toThrow(/reads versions 1 to 3/);
    expect(() => upgradeContextBundle({ version: 1 }, 2, { toString: () => ({}) } as never)).toThrow(/can no longer be read/);
  });
});

describe("the foundry mark on an issue comment", () => {
  const withComment = (more: Raw) => bundle({ sources: [src("issue-comment", "issue:12/comment/34", "x", more)] });
  it("accepts foundry: true and still reads a comment without it", () => {
    expect(parseContextBundle(withComment({ foundry: true })).sources[0]).toHaveProperty("foundry", true);
    expect(parseContextBundle(withComment({})).sources[0]).not.toHaveProperty("foundry");
  });
  it("refuses false, other values, other kinds and unknown fields", () => {
    for (const v of [false, "yes", 1, null]) expect(() => parseContextBundle(withComment({ foundry: v })), String(v)).toThrow();
    for (const s of [ISSUE(), FILE(), NOTES()]) expect(() => parseContextBundle(bundle({ sources: [{ ...s, foundry: true }] })), s.kind).toThrow();
    expect(() => parseContextBundle(withComment({ other: true }))).toThrow();
  });
});
