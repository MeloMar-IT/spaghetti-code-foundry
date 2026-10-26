import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/evidence/identity.js";
import { contextBundleRef, hashContextSources, readContextBundle, serializeContextBundle } from "../src/context/bundle.js";
import { ContextRepositoryError, openRepositoryAt } from "../src/context/repository.js";
import { selectContext } from "../src/context/select.js";
import { ContextStoreError, writeContextBundle } from "../src/context/store.js";
import { ContextSchemaError } from "../src/context/version.js";
import { EXPECTED_OMITTED, EXPECTED_SOURCES, FILES, input, memorySnapshot } from "./helpers/context-fixture.js";

// The selector against a real git repository, built once in a temporary folder, and the writer of a bundle.

const SECRET = "TOP SECRET: outside the repository";
let tmp: string;
let repo: string;
let first: string;
let second: string;

const git = (cwd: string, ...args: string[]) => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (path: string, data: string | Uint8Array) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), data);
};
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof ContextRepositoryError || e instanceof ContextStoreError ? e.code : `other: ${String(e)}`;
  }
  return "no error";
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "context-repo-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  writeFileSync(join(tmp, "outside-secret.txt"), SECRET);
  git(repo, "init", "-q", "-b", "main");
  for (const [path, f] of Object.entries(FILES)) {
    if (typeof f === "string" || f instanceof Uint8Array) put(path, f);
    else if ("link" in f) symlinkSync(f.link, join(repo, path));
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  first = git(repo, "rev-parse", "HEAD");
  // A later commit, and a working tree that is different again: none of it may be seen at the first commit.
  put("README.md", "# Added later\n");
  put("AGENTS.md", "# Rules of the second commit\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "second");
  second = git(repo, "rev-parse", "HEAD");
  put("AGENTS.md", "# Not committed\n");
  put("services/pay/src/new.ts", "// not committed\n");
  put("docs/CODEOWNERS", "* @not-committed\n");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the context selector on a git repository", () => {
  it("gives exactly what the same files give in memory, at the declared commit", () => {
    const sel = selectContext(input({ snapshot: openRepositoryAt(repo, first) }));
    expect(sel.bundle.sources.map((s) => [s.uri, s.selection.rule, s.selection.reason, s.owners])).toEqual(EXPECTED_SOURCES);
    expect(sel.bundle.omitted.map((o) => [o.uri, o.selection.rule, o.reason])).toEqual(EXPECTED_OMITTED);
    expect(sel.bundle.repository.commit).toBe(first);
    // the same text and hash per source as the snapshot in memory; only the commit differs
    const inMemory = selectContext(input({ snapshot: memorySnapshot(FILES, first) }));
    expect(serializeContextBundle(sel.bundle)).toBe(serializeContextBundle(inMemory.bundle));
    expect(hashContextSources(sel.bundle)).toBe(hashContextSources(inMemory.bundle));
    // and again, from a fresh look at the repository
    expect(hashContextSources(selectContext(input({ snapshot: openRepositoryAt(repo, first) })).bundle)).toBe(hashContextSources(sel.bundle));
  });

  it("does not see the working tree, a later commit, or what a link points at", () => {
    const sel = selectContext(input({ snapshot: openRepositoryAt(repo, first) }));
    const text = (uri: string) => Buffer.from(sel.texts.get(sel.bundle.sources.find((s) => s.uri === uri)!.content.path)!).toString("utf8");
    expect(text("repo:AGENTS.md")).toBe(FILES["AGENTS.md"]);
    expect(sel.bundle.omitted.find((o) => o.uri === "repo:README.md")?.reason).toBe("missing");
    expect(sel.bundle.omitted.find((o) => o.uri === "repo:services/pay/src/new.ts")?.reason).toBe("missing");
    expect(sel.bundle.omitted.find((o) => o.uri === "repo:CLAUDE.md")?.reason).toBe("unsupported");
    for (const data of sel.texts.values()) expect(Buffer.from(data).toString("utf8")).not.toContain("SECRET");
    // the second commit has its own files
    const later = selectContext(input({ snapshot: openRepositoryAt(repo, second) }));
    expect(later.bundle.sources.map((s) => s.uri)).toContain("repo:README.md");
    expect(Buffer.from(later.texts.get(later.bundle.sources.find((s) => s.uri === "repo:AGENTS.md")!.content.path)!).toString("utf8")).toBe("# Rules of the second commit\n");
  });

  it("lists links and files with their size, and reads only files of the commit", () => {
    const snap = openRepositoryAt(repo, first);
    expect(snap.unlisted).toBe(0);
    expect(snap.entries.find((e) => e.path === "CLAUDE.md")).toEqual({ path: "CLAUDE.md", kind: "symlink", bytes: "../outside-secret.txt".length });
    expect(snap.entries.find((e) => e.path === "assets/logo.png")).toEqual({ path: "assets/logo.png", kind: "file", bytes: 8 });
    expect([...snap.entries].map((e) => e.path).sort()).toEqual(Object.keys(FILES).sort());
    expect(Buffer.from(snap.read("assets/logo.png"))).toEqual(Buffer.from(FILES["assets/logo.png"] as Uint8Array));
    for (const path of ["CLAUDE.md", "README.md", "../outside-secret.txt", "services", ".git/config", ""]) expect(code(() => snap.read(path)), path).toBe("read-failed");
  });

  it("refuses anything but a full commit of this very repository", () => {
    for (const rev of ["HEAD", "main", first.slice(0, 12), `${first} `, "--help", "e".repeat(40), first.toUpperCase()]) expect(code(() => openRepositoryAt(repo, rev)), rev).toBe("no-commit");
    const tree = git(repo, "rev-parse", `${first}^{tree}`);
    expect(code(() => openRepositoryAt(repo, tree))).toBe("no-commit");
    // a folder inside the repository, a folder that is no repository, and a folder that does not exist
    expect(code(() => openRepositoryAt(join(repo, "services"), first))).toBe("not-a-repository");
    expect(code(() => openRepositoryAt(tmp, first))).toBe("not-a-repository");
    expect(code(() => openRepositoryAt(join(tmp, "nowhere"), first))).toBe("not-a-repository");
  });

  it("ignores git settings of the caller's environment, and reads a bare repository", () => {
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    git(elsewhere, "init", "-q");
    const snap = openRepositoryAt(repo, first, { env: { ...process.env, GIT_DIR: join(elsewhere, ".git"), GIT_WORK_TREE: elsewhere } });
    expect(snap.entries.length).toBe(Object.keys(FILES).length);
    const bare = join(tmp, "bare.git");
    git(tmp, "clone", "-q", "--bare", repo, bare);
    expect(openRepositoryAt(bare, first).entries.length).toBe(Object.keys(FILES).length);
    expect(code(() => openRepositoryAt(repo, first, { listBytes: 100 }))).toBe("too-large");
  });
});

describe("writing a context bundle into a folder", () => {
  const sel = selectContext(input());
  const folder = (name: string) => {
    const dir = join(tmp, name);
    mkdirSync(dir);
    return dir;
  };

  it("writes the text of every source under context/, and context.json with the hash evidence names", () => {
    const run = folder("run-ok");
    const ref = writeContextBundle(run, sel.bundle, sel.texts);
    expect(ref).toEqual(contextBundleRef(sel.bundle));
    const text = readFileSync(join(run, "context.json"), "utf8");
    expect(text).toBe(serializeContextBundle(sel.bundle));
    expect(sha256Hex(text)).toBe(ref.sha256);
    expect(readContextBundle(text)).toEqual({ state: "ok", bundle: sel.bundle });
    expect(readdirSync(join(run, "context")).sort()).toEqual(sel.bundle.sources.map((s) => s.id).sort());
    for (const s of sel.bundle.sources) expect(sha256Hex(readFileSync(join(run, s.content.path))), s.uri).toBe(s.content.sha256);
    expect(readdirSync(run).sort()).toEqual(["context", "context.json"]);
  });

  it("never replaces anything: a second write, or a folder that already has one of the two, is refused", () => {
    const run = folder("run-twice");
    writeContextBundle(run, sel.bundle, sel.texts);
    const before = readFileSync(join(run, "context.json"), "utf8");
    expect(code(() => writeContextBundle(run, sel.bundle, sel.texts))).toBe("exists");
    expect(readFileSync(join(run, "context.json"), "utf8")).toBe(before);
    const half = folder("run-half");
    writeFileSync(join(half, "context.json"), "{}");
    expect(code(() => writeContextBundle(half, sel.bundle, sel.texts))).toBe("exists");
    expect(existsSync(join(half, "context"))).toBe(false);
    const linked = folder("run-linked");
    symlinkSync(tmp, join(linked, "context"));
    expect(code(() => writeContextBundle(linked, sel.bundle, sel.texts))).toBe("exists");
    expect(existsSync(join(linked, "context.json"))).toBe(false);
  });

  it("writes nothing when a text is missing, extra or changed, or the bundle is not valid", () => {
    const run = folder("run-bad");
    const [firstPath] = [...sel.texts.keys()] as [string];
    const without = new Map(sel.texts);
    without.delete(firstPath);
    const changed = new Map(sel.texts).set(firstPath, Buffer.from("something else"));
    const extra = new Map(sel.texts).set("context/extra", Buffer.from("x"));
    for (const texts of [without, changed, extra, new Map()]) expect(code(() => writeContextBundle(run, sel.bundle, texts))).toBe("texts-do-not-match");
    expect(() => writeContextBundle(run, { ...sel.bundle, runId: "../x" }, sel.texts)).toThrow(ContextSchemaError);
    expect(readdirSync(run)).toEqual([]);
    expect(code(() => writeContextBundle(join(tmp, "no-such-run"), sel.bundle, sel.texts))).toBe("no-folder");
    const link = join(tmp, "run-link");
    symlinkSync(run, link);
    expect(code(() => writeContextBundle(link, sel.bundle, sel.texts))).toBe("no-folder");
    expect(readdirSync(run)).toEqual([]);
  });
});

describe("a deadline for the git calls", () => {
  it("throws timeout without starting git when no time is left", () => {
    const env = { ...process.env, PATH: join(tmp, "no-bin") };
    mkdirSync(join(tmp, "no-bin"), { recursive: true });
    // without the deadline git is missing; with it the deadline is seen first
    expect(code(() => openRepositoryAt(repo, first, { env }))).toBe("no-git");
    expect(code(() => openRepositoryAt(repo, first, { env, deadlineMs: 0 }))).toBe("timeout");
    expect(code(() => openRepositoryAt(repo, first, { env, deadlineMs: 1000, now: () => 1000 }))).toBe("timeout");
    expect(code(() => openRepositoryAt(repo, first, { env, deadlineMs: Number.NaN }))).toBe("timeout");
  });

  it("gives read() the time that is left, not the time of the open", () => {
    let t = 1_000;
    const snap = openRepositoryAt(repo, first, { deadlineMs: 61_000, now: () => t });
    t = 2_000;
    expect(Buffer.from(snap.read("assets/logo.png"))).toEqual(Buffer.from(FILES["assets/logo.png"] as Uint8Array));
    t = 61_000;
    expect(code(() => snap.read("assets/logo.png"))).toBe("timeout");
    t = 2_000;
    expect(snap.read("assets/logo.png").length).toBe(8);
  });

  it("keeps a deadline when the git timeout is 0 (no limit)", () => {
    expect(code(() => openRepositoryAt(repo, first, { timeoutMs: 0, deadlineMs: 5, now: () => 5 }))).toBe("timeout");
    expect(openRepositoryAt(repo, first, { timeoutMs: 0, deadlineMs: Date.now() + 60_000 }).entries.length).toBe(Object.keys(FILES).length);
  });

  it("changes nothing, and never reads the clock, without a deadline", () => {
    const now = () => {
      throw new Error("clock read");
    };
    const snap = openRepositoryAt(repo, first, { now });
    expect(snap.entries.length).toBe(Object.keys(FILES).length);
    expect(snap.read("assets/logo.png").length).toBe(8);
  });
});

describe("a failed write of a context bundle leaves nothing behind", () => {
  const sel = selectContext(input());
  const folder = (name: string) => {
    const dir = join(tmp, name);
    mkdirSync(dir);
    return dir;
  };
  const boom = () => {
    throw new Error("boom");
  };
  /** The bundle with its sources moved to the given paths (first source to paths[0], and so on). */
  const moved = (paths: string[]) => {
    const texts = new Map<string, Uint8Array>();
    const sources = sel.bundle.sources.map((s, i) => {
      const path = paths[i] ?? s.content.path;
      texts.set(path, sel.texts.get(s.content.path) as Uint8Array);
      return { ...s, content: { ...s.content, path } };
    });
    return { bundle: { ...sel.bundle, sources }, texts };
  };
  const tree = (dir: string, rel = ""): string[] =>
    readdirSync(join(dir, rel), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? [`${join(rel, e.name)}/`, ...tree(dir, join(rel, e.name))] : [join(rel, e.name)]))
      .sort();

  it("removes everything when a source or context.json fails after it was opened", () => {
    const firstPath = sel.bundle.sources[0]!.content.path;
    for (const [name, at] of [["src", firstPath], ["json", "context.json"]] as const) {
      const run = folder(`run-open-${name}`);
      expect(code(() => writeContextBundle(run, sel.bundle, sel.texts, { afterOpen: (p) => p.endsWith(at) && boom() })), name).toBe("write-failed");
      expect(readdirSync(run), name).toEqual([]);
    }
  });

  it("removes the folders of a nested source too", () => {
    const m = moved(["context/a/b.md"]);
    const run = folder("run-nested");
    expect(code(() => writeContextBundle(run, m.bundle, m.texts, { afterOpen: (p) => p.endsWith("context/a/b.md") && boom() }))).toBe("write-failed");
    expect(readdirSync(run)).toEqual([]);
  });

  it("leaves a planted context.json, or a planted context/ with a file in it, as it was", () => {
    const a = folder("run-plant-json");
    expect(code(() => writeContextBundle(a, sel.bundle, sel.texts, { afterCheck: () => writeFileSync(join(a, "context.json"), "planted") }))).toBe("write-failed");
    expect(readFileSync(join(a, "context.json"), "utf8")).toBe("planted");
    expect(readdirSync(a)).toEqual(["context.json"]);

    const b = folder("run-plant-dir");
    const plant = () => {
      mkdirSync(join(b, "context"));
      writeFileSync(join(b, "context", "x.txt"), "planted");
    };
    expect(code(() => writeContextBundle(b, sel.bundle, sel.texts, { afterCheck: plant }))).toBe("write-failed");
    expect(tree(b)).toEqual(["context/", "context/x.txt"]);
    expect(readFileSync(join(b, "context", "x.txt"), "utf8")).toBe("planted");
  });

  it("keeps a foreign file, and its folder, that appeared in a folder the store made", () => {
    const m = moved(["context/sub/a.md", "context/sub/b.md"]);
    const run = folder("run-foreign");
    const afterOpen = (p: string) => {
      if (!p.endsWith("context/sub/b.md")) return;
      writeFileSync(join(run, "context", "sub", "foreign.txt"), "foreign");
      boom();
    };
    expect(code(() => writeContextBundle(run, m.bundle, m.texts, { afterOpen }))).toBe("write-failed");
    expect(tree(run)).toEqual(["context/", "context/sub/", "context/sub/foreign.txt"]);
    expect(readFileSync(join(run, "context", "sub", "foreign.txt"), "utf8")).toBe("foreign");
  });
});
