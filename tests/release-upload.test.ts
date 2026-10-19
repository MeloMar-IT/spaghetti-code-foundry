import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseMarker, tagPattern } from "../src/release/recipe.js";
import { assetName, formatSize, pickPrune, stageFiles, uploadRelease, UploadError, type GhRelease, type GhRunner } from "../src/release/upload.js";

const RECIPE = { version: "{commit_datetime}", tag: "v{version}" };
const MARKER = releaseMarker(RECIPE);
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const TAG = "v202610182030";

describe("tagPattern", () => {
  it("matches the whole tag with the format of each placeholder", () => {
    const p = tagPattern(RECIPE);
    expect(p.test("v202610182030")).toBe(true);
    for (const bad of ["v2026101820301", "v20261018", "xv202610182030", "v202610182030-x", "v20261018203a", "nightly"]) expect(p.test(bad), bad).toBe(false);
  });
  it("gives {commit_date} 8 digits and {sha} 7 lower-case hex characters", () => {
    const p = tagPattern({ version: "{commit_date}", tag: "r-{version}-{sha}" });
    expect(p.test("r-20261018-abc1234")).toBe(true);
    expect(p.test("r-2026101-abc1234")).toBe(false);
    expect(p.test("r-20261018-ABC1234")).toBe(false);
    expect(p.test("r-20261018-abc123")).toBe(false);
    expect(p.test("r-20261018-abc12345")).toBe(false);
  });
  it("escapes literal text", () => {
    expect(tagPattern({ version: "1.0", tag: "v{version}" }).test("v1x0")).toBe(false);
    expect(tagPattern({ version: "1.0", tag: "v{version}" }).test("v1.0")).toBe(true);
    expect(tagPattern({ version: "1", tag: "rel+1/x" }).test("rel+1/x")).toBe(true);
  });
  it("matches only itself when there is no placeholder", () => {
    const p = tagPattern({ version: "1", tag: "nightly" });
    expect(p.test("nightly")).toBe(true);
    expect(p.test("nightly2")).toBe(false);
  });
});

/** A GitHub in memory: the REST calls the upload makes, and a record of every call. */
function fakeGh(initial: GhRelease[], hooks: { rename?: boolean; failDelete?: number; draftOnRecheck?: boolean; tagOnRecheck?: string; publishOnRecheck?: number; publishAfterUploads?: number } = {}) {
  const releases = initial.map((r) => ({ ...r, assets: r.assets.map((a) => ({ ...a })) }));
  const calls: string[] = [];
  const uploaded: { id: number; name: string; size: number }[] = [];
  let seq = 9000;
  const rest = (r: GhRelease) => ({
    id: r.id, tag_name: r.tag, draft: r.draft, prerelease: r.prerelease, created_at: r.createdAt, html_url: r.url, upload_url: r.uploadUrl, body: r.body, assets: r.assets,
  });
  const gh: GhRunner = async (args) => {
    calls.push(args.join(" "));
    const field = (flag: string, key: string) => {
      for (let i = 0; i < args.length - 1; i++) if (args[i] === flag && args[i + 1]!.startsWith(`${key}=`)) return args[i + 1]!.slice(key.length + 1);
      return undefined;
    };
    const path = args.find((a) => a.startsWith("repos/") || a.startsWith("https://"))!;
    const method = args[args.indexOf("-X") + 1];
    let m: RegExpExecArray | null;
    if (args.includes("--paginate")) return releases.map((r) => JSON.stringify(rest(r))).join("\n");
    if ((m = /^https:\/\/uploads\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets\?name=(.*)$/.exec(path))) {
      const r = releases.find((x) => x.id === Number(m![1]))!;
      const name = decodeURIComponent(m[2]!);
      if (r.assets.some((a) => a.name === name)) throw new Error("already_exists");
      const size = statSync(args[args.indexOf("--input") + 1]!).size;
      r.assets.push({ id: seq++, name, size });
      uploaded.push({ id: r.id, name, size });
      if (hooks.publishAfterUploads === uploaded.length) r.draft = false;
      return JSON.stringify({ name: hooks.rename ? `renamed-${name}` : name });
    }
    if (method === "POST" && /^repos\/[^/]+\/[^/]+\/releases$/.test(path)) {
      const r: GhRelease = {
        id: seq++, tag: field("-f", "tag_name")!, draft: field("-F", "draft") === "true", prerelease: field("-F", "prerelease") === "true",
        createdAt: "2026-10-18T20:31:00Z", url: "https://github.com/acme/app/releases/tag/untagged-new", uploadUrl: "https://uploads.github.com/repos/acme/app/releases/NEW/assets{?name,label}",
        body: field("-f", "body")!, assets: [],
      };
      r.uploadUrl = r.uploadUrl.replace("NEW", String(r.id));
      releases.push(r);
      return JSON.stringify(rest(r));
    }
    if (method === "DELETE" && (m = /releases\/assets\/(\d+)$/.exec(path))) {
      for (const r of releases) r.assets = r.assets.filter((a) => a.id !== Number(m![1]));
      return "";
    }
    if (method === "DELETE" && (m = /releases\/(\d+)$/.exec(path))) {
      if (hooks.failDelete === Number(m[1])) throw new Error("gh api failed: HTTP 500");
      const i = releases.findIndex((x) => x.id === Number(m![1]));
      releases.splice(i, 1);
      return "";
    }
    if ((m = /releases\/(\d+)$/.exec(path))) {
      const r = releases.find((x) => x.id === Number(m![1]));
      if (!r) throw new Error("HTTP 404");
      if (hooks.publishOnRecheck === r.id) r.draft = false;
      const out = rest(r);
      if (hooks.draftOnRecheck === false) out.draft = false;
      if (hooks.tagOnRecheck) out.tag_name = hooks.tagOnRecheck;
      return JSON.stringify(out);
    }
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return { gh, calls, releases, uploaded, writes: () => calls.filter((c) => /-X (POST|DELETE)/.test(c)) };
}

const rel = (id: number, tag: string, o: Partial<GhRelease> = {}): GhRelease => ({
  id, tag, draft: true, prerelease: true, createdAt: "2026-01-01T00:00:00Z", url: `https://github.com/acme/app/releases/tag/untagged-${id}`,
  uploadUrl: `https://uploads.github.com/repos/acme/app/releases/${id}/assets{?name,label}`, body: MARKER, assets: [], ...o,
});
const tagOf = (n: number) => `v2026010100${String(n).padStart(2, "0")}`;

describe("uploadRelease", () => {
  let dir: string;
  let out: string;
  let stage: string;
  const log: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rel-up-"));
    out = join(dir, "out");
    stage = join(dir, "upload");
    mkdirSync(join(out, "cli"), { recursive: true });
    writeFileSync(join(out, "cli", "app.tgz"), "tgz-bytes");
    writeFileSync(join(out, "notes.txt"), "hello");
    log.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (o: Partial<{ keep: number; prerelease: boolean }> = {}) => ({ sha: SHA, tag: TAG, prerelease: true, keep: 5, recipe: RECIPE, ...o });
  const run = (g: ReturnType<typeof fakeGh>, o: Partial<{ keep: number; prerelease: boolean }> = {}) =>
    uploadRelease({ repo: "acme/app", plan: plan(o), outDir: out, stageDir: stage, gh: g.gh, log: (l) => void log.push(l) });

  it("makes a draft at the commit when no release has the tag, then uploads to it", async () => {
    const g = fakeGh([rel(1, "nightly", { draft: false })]);
    const r = await run(g);
    const post = g.calls.find((c) => c.includes("-X POST repos/acme/app/releases"))!;
    expect(post).toContain(`tag_name=${TAG}`);
    expect(post).toContain(`target_commitish=${SHA}`);
    expect(post).toContain("draft=true");
    expect(post).toContain("prerelease=true");
    expect(post).toContain(MARKER);
    expect(r.created).toBe(true);
    expect(g.uploaded.map((u) => u.name)).toEqual(["cli-app.tgz", "notes.txt"]);
    expect(new Set(g.uploaded.map((u) => u.id))).toEqual(new Set([r.id]));
    // the recheck by id comes before the first upload
    const check = g.calls.findIndex((c) => c === `api repos/acme/app/releases/${r.id}`);
    expect(check).toBeGreaterThan(g.calls.findIndex((c) => c.includes("-X POST repos/acme/app/releases")));
    expect(check).toBeLessThan(g.calls.findIndex((c) => c.includes("uploads.github.com")));
    expect(log).toContain(`RELEASE: ${TAG} (draft, new, id ${r.id})`);
    expect(log).toContain("  cli-app.tgz  9 B");
  });

  it("sets prerelease=false when the recipe says so", async () => {
    const g = fakeGh([]);
    await run(g, { prerelease: false });
    expect(g.calls.find((c) => c.includes("-X POST repos/acme/app/releases"))).toContain("prerelease=false");
  });

  it("adds to an existing draft and replaces files that exist, by id", async () => {
    const g = fakeGh([rel(7, TAG, { assets: [{ id: 70, name: "cli-app.tgz", size: 1 }, { id: 71, name: "other.bin", size: 5 }] })]);
    const r = await run(g);
    expect(r.created).toBe(false);
    expect(g.calls.some((c) => c.includes("-X POST repos/acme/app/releases "))).toBe(false);
    const del = g.calls.findIndex((c) => c === "api -X DELETE repos/acme/app/releases/assets/70");
    const up = g.calls.findIndex((c) => c.includes("releases/7/assets?name=cli-app.tgz"));
    expect(del).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(del);
    expect(g.releases[0]!.assets.map((a) => [a.name, a.size])).toEqual([["other.bin", 5], ["cli-app.tgz", 9], ["notes.txt", 5]]);
  });

  it("fails on a published release with the tag, with only the list called", async () => {
    const g = fakeGh([rel(3, TAG, { draft: false }), rel(4, TAG)]);
    await expect(run(g)).rejects.toThrow(UploadError);
    await expect(run(g)).rejects.toThrow(/already published/);
    expect(g.calls.every((c) => c.includes("--paginate"))).toBe(true);
  });

  it("sees a published release on a late page of a long list", async () => {
    const many = Array.from({ length: 1205 }, (_, i) => rel(100 + i, `other-${i}`, { draft: false }));
    many[1100] = rel(5000, TAG, { draft: false });
    const g = fakeGh(many);
    await expect(run(g)).rejects.toThrow(/already published/);
    expect(g.writes()).toEqual([]);
  });

  it("uses the newest of several drafts with the tag, whatever the list order, and warns", async () => {
    const g = fakeGh([
      rel(1, TAG, { createdAt: "2026-10-18T10:00:00Z" }),
      rel(2, TAG, { createdAt: "2026-10-18T12:00:00Z" }),
      rel(3, TAG, { createdAt: "2026-10-18T11:00:00Z" }),
    ]);
    const r = await run(g, { keep: 9 });
    expect(r.id).toBe(2);
    expect(new Set(g.uploaded.map((u) => u.id))).toEqual(new Set([2]));
    expect(r.warnings.join("\n")).toContain("3 drafts have tag");
    expect(log.some((l) => l.startsWith("warning: 3 drafts"))).toBe(true);
  });

  it("fails before any upload when the draft was published or changed in between", async () => {
    for (const hooks of [{ draftOnRecheck: false as const }, { tagOnRecheck: "other" }]) {
      const g = fakeGh([rel(7, TAG)], hooks);
      await expect(run(g)).rejects.toThrow(/no longer a draft/);
      expect(g.uploaded).toEqual([]);
      expect(g.writes()).toEqual([]);
    }
  });

  it("stops when the release is published between two files, without touching it again", async () => {
    const g = fakeGh([rel(7, TAG, { assets: [{ id: 71, name: "notes.txt", size: 1 }] })], { publishAfterUploads: 1 });
    await expect(run(g)).rejects.toThrow(/published or changed during the upload; stopped after 1 of 2 files/);
    expect(g.uploaded.map((u) => u.name)).toEqual(["cli-app.tgz"]);
    // the old notes.txt of the now published release was not deleted, and nothing was pruned
    expect(g.calls.some((c) => c.includes("DELETE"))).toBe(false);
    expect(g.releases[0]!.assets.some((a) => a.id === 71)).toBe(true);
  });

  it("fails when GitHub stores a file under another name", async () => {
    const g = fakeGh([rel(7, TAG)], { rename: true });
    await expect(run(g)).rejects.toThrow(/stored "cli-app.tgz" as "renamed-cli-app.tgz"/);
    expect(g.calls.some((c) => c.includes("DELETE repos/acme/app/releases/7"))).toBe(false);
  });

  describe("pruning", () => {
    const drafts = () => Array.from({ length: 7 }, (_, i) => rel(100 + i, tagOf(i + 1), { createdAt: `2026-01-0${i + 1}T00:00:00Z` }));

    it("keeps `keep` drafts (the new one included) and leaves everything else alone", async () => {
      const others = [
        rel(200, tagOf(50), { draft: false, createdAt: "2025-01-01T00:00:00Z" }),
        rel(201, tagOf(51), { body: "made by hand", createdAt: "2025-01-02T00:00:00Z" }),
        rel(202, tagOf(52), { body: releaseMarker({ tag: "other-{sha}" }), createdAt: "2025-01-03T00:00:00Z" }),
        rel(203, "nightly", { createdAt: "2025-01-04T00:00:00Z" }),
      ];
      // listed in an order that is neither by date nor by tag
      const list = [...drafts().reverse().slice(0, 6), ...others, drafts()[0]!];
      const g = fakeGh(list);
      const r = await run(g, { keep: 3 });
      // the new draft + the 2 newest old ones stay; the 5 oldest (by creation date) go
      expect(r.deleted.map((d) => d.match(/\((\d+)\)/)![1]).sort()).toEqual(["100", "101", "102", "103", "104"]);
      expect(g.releases.map((x) => x.id).sort((a, b) => a - b)).toEqual([105, 106, 200, 201, 202, 203, r.id].sort((a, b) => a - b));
      expect(log.some((l) => l.startsWith("PRUNED:"))).toBe(true);
    });

    it("deletes by id and never touches a release that shares the tag with a published one", async () => {
      const g = fakeGh([
        rel(1, tagOf(1), { createdAt: "2026-01-01T00:00:00Z" }),
        rel(2, tagOf(1), { draft: false, createdAt: "2026-01-01T00:00:00Z" }),
        rel(3, tagOf(2), { createdAt: "2026-01-02T00:00:00Z" }),
      ]);
      await run(g, { keep: 2 });
      expect(g.releases.map((x) => x.id).sort((a, b) => a - b)).toEqual([2, 3, 9000]);
      expect(g.calls.filter((c) => c.includes("-X DELETE repos/acme/app/releases/"))).toEqual(["api -X DELETE repos/acme/app/releases/1"]);
    });

    it("keeps exactly `keep` marked drafts when the oldest existing draft is rebuilt", async () => {
      const list = [rel(1, TAG, { createdAt: "2025-01-01T00:00:00Z" }), rel(2, tagOf(2)), rel(3, tagOf(3), { createdAt: "2026-02-01T00:00:00Z" }), rel(4, tagOf(4), { createdAt: "2026-03-01T00:00:00Z" })];
      const g = fakeGh(list);
      const r = await run(g, { keep: 2 });
      expect(r.id).toBe(1);
      expect(g.releases.map((x) => x.id).sort()).toEqual([1, 4]);
    });

    it("deletes the older of two drafts with one tag across the retention boundary", async () => {
      const g = fakeGh([
        rel(1, tagOf(1), { createdAt: "2026-01-01T00:00:00Z" }),
        rel(2, tagOf(1), { createdAt: "2026-01-05T00:00:00Z" }),
        rel(3, tagOf(2), { createdAt: "2026-01-03T00:00:00Z" }),
      ]);
      await run(g, { keep: 3 });
      // own + the newest 2 candidates (ids 2 and 3) stay
      expect(g.releases.map((x) => x.id).sort((a, b) => a - b)).toEqual([2, 3, 9000]);
    });

    it("skips a draft that was published since the list", async () => {
      const g = fakeGh([rel(1, tagOf(1), { createdAt: "2026-01-01T00:00:00Z" }), rel(2, tagOf(2), { createdAt: "2026-01-02T00:00:00Z" })], { publishOnRecheck: 1 });
      const r = await run(g, { keep: 2 });
      expect(r.skipped.map((s) => s.id)).toEqual([1]);
      expect(r.warnings.join("\n")).toContain("changed since the list");
      expect(g.releases.some((x) => x.id === 1)).toBe(true);
    });

    it("turns a failed delete into a warning and still returns", async () => {
      const g = fakeGh([rel(1, tagOf(1), { createdAt: "2026-01-01T00:00:00Z" }), rel(2, tagOf(2), { createdAt: "2026-01-02T00:00:00Z" })], { failDelete: 1 });
      const r = await run(g, { keep: 2 });
      expect(r.warnings.join("\n")).toContain("could not delete");
      expect(r.url).toContain("github.com");
    });

    it("deletes nothing when the upload fails", async () => {
      const g = fakeGh([rel(1, tagOf(1)), rel(2, tagOf(2), { createdAt: "2026-01-02T00:00:00Z" })], { rename: true });
      await expect(run(g, { keep: 1 })).rejects.toThrow(UploadError);
      expect(g.calls.some((c) => c.includes("-X DELETE repos/acme/app/releases/"))).toBe(false);
    });
  });
});

describe("pickPrune", () => {
  it("never picks the own release, a published one or one without the marker", () => {
    const own = rel(1, tagOf(1));
    const list = [own, rel(2, tagOf(2), { draft: false }), rel(3, tagOf(3), { body: "" }), rel(4, tagOf(4)), rel(5, "x")];
    const pick = pickPrune(list, { pattern: tagPattern(RECIPE), marker: MARKER, keep: 1, ownId: 1 });
    expect(pick.remove.map((r) => r.id)).toEqual([4]);
    expect(pick.kept).toEqual([]);
  });
});

describe("assetName and stageFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rel-stage-"));
    mkdirSync(join(dir, "out", "cli"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const out = () => join(dir, "out");
  const stage = () => join(dir, "stage");
  const put = (rel: string, text: string) => {
    mkdirSync(join(out(), rel, ".."), { recursive: true });
    writeFileSync(join(out(), rel), text);
  };

  it("encodes names", () => {
    expect(assetName("cli/x.tgz")).toBe("cli-x.tgz");
    expect(assetName("a b#1.tgz")).toBe("a_b_1.tgz");
    expect(assetName(".hidden")).toBe("_hidden");
    expect(assetName("-x")).toBe("_x");
    expect(assetName("a".repeat(300))).toHaveLength(200);
  });

  it("stages files under their asset names and rewrites SHA256SUMS to follow them", () => {
    put("cli/x.tgz", "abc");
    put("a b#1.tgz", "def");
    const h = "0".repeat(64);
    put("SHA256SUMS", `${h}  a b#1.tgz\n${h}  cli/x.tgz\n`);
    const files = stageFiles(out(), stage());
    expect(files.map((f) => f.name)).toEqual(["SHA256SUMS", "a_b_1.tgz", "cli-x.tgz"]);
    expect(readFileSync(join(stage(), "SHA256SUMS"), "utf8")).toBe(`${h}  a_b_1.tgz\n${h}  cli-x.tgz\n`);
    expect(readFileSync(join(out(), "SHA256SUMS"), "utf8")).toBe(`${h}  a b#1.tgz\n${h}  cli/x.tgz\n`);
    expect(files.find((f) => f.name === "cli-x.tgz")!.size).toBe(3);
  });

  it("copies a SHA256SUMS in another format unchanged", () => {
    put("x.tgz", "abc");
    put("SHA256SUMS", "not a list\n");
    stageFiles(out(), stage());
    expect(readFileSync(join(stage(), "SHA256SUMS"), "utf8")).toBe("not a list\n");
  });

  it("leaves release/out byte for byte the same, however often it stages", () => {
    put("x.tgz", "abc");
    const h = "1".repeat(64);
    put("SHA256SUMS", `${h}  x.tgz\n`);
    put("sub dir/y.bin", "yy");
    const before = [readFileSync(join(out(), "x.tgz")), readFileSync(join(out(), "SHA256SUMS")), readFileSync(join(out(), "sub dir", "y.bin"))];
    stageFiles(out(), stage());
    // writing into a staged copy must not reach release/out (SHA256SUMS is never a link)
    writeFileSync(join(stage(), "SHA256SUMS"), "changed");
    stageFiles(out(), stage());
    expect(readFileSync(join(stage(), "SHA256SUMS"), "utf8")).toBe(`${h}  x.tgz\n`);
    const after = [readFileSync(join(out(), "x.tgz")), readFileSync(join(out(), "SHA256SUMS")), readFileSync(join(out(), "sub dir", "y.bin"))];
    expect(after.map(String)).toEqual(before.map(String));
  });

  it("refuses names that clash after encoding, ignoring case, and an empty folder", () => {
    put("a b", "1");
    put("A_B", "2");
    expect(() => stageFiles(out(), stage())).toThrow(/would both be called/);
    rmSync(out(), { recursive: true });
    mkdirSync(out());
    expect(() => stageFiles(out(), stage())).toThrow(/no release files/);
  });
});

describe("formatSize", () => {
  it("uses 1024-based units", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1229)).toBe("1.2 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatSize(1.1 * 1024 ** 3)).toBe("1.1 GB");
  });
});
