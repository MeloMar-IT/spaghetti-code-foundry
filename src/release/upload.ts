import { execFile } from "node:child_process";
import { copyFileSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseMarker, tagPattern, type Recipe } from "./recipe.js";

/** Runs `gh` with these arguments and returns its output. Rejects when gh fails. */
export type GhRunner = (args: string[]) => Promise<string>;

const MAX_BUFFER = 64 * 1024 * 1024;
const GH_TIMEOUT_MS = 30 * 60 * 1000;

/** The default runner: `$FACTORY_GH_BIN` (else `gh`) through execFile, no shell. */
export function ghRunner(opts: { bin?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): GhRunner {
  const bin = opts.bin || process.env.FACTORY_GH_BIN || "gh";
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { env: opts.env ?? process.env, signal: opts.signal, maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS, encoding: "utf8" }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const why = (String(stderr ?? "").trim() || err.message).split("\n").slice(0, 3).join(" ");
        reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${why}`, { cause: err }));
      });
    });
}

export interface GhAsset { id: number; name: string; size: number }
export interface GhRelease {
  id: number;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  createdAt: string;
  url: string;
  uploadUrl: string;
  body: string;
  assets: GhAsset[];
}
export interface StagedFile { name: string; path: string; size: number }

/** A failure the owner can read and act on (not a bug). */
export class UploadError extends Error {}

const MAX_FILES = 1000;
const MAX_NAME = 200;

/** The name a file gets on the release: no folders, only `A-Za-z0-9._-`, not starting with `.` or `-`. */
export function assetName(rel: string): string {
  let n = rel.replaceAll("/", "-").replace(/[^A-Za-z0-9._-]/g, "_");
  if (/^[.-]/.test(n)) n = `_${n.slice(1)}`;
  return n.slice(0, MAX_NAME);
}

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/**
 * Puts the files of `outDir` under their asset names into a fresh `stageDir`. Files are hard-linked, except `SHA256SUMS`,
 * which is a new file (its lines follow the new names). `outDir` is never changed.
 */
export function stageFiles(outDir: string, stageDir: string): StagedFile[] {
  const files = walk(outDir);
  if (!files.length) throw new UploadError("there are no release files to upload (release/out is empty)");
  if (files.length > MAX_FILES) throw new UploadError(`${files.length} release files; a release takes at most ${MAX_FILES}`);
  const names = new Map<string, string>();
  for (const f of files) {
    const n = assetName(f);
    const clash = names.get(n.toLowerCase());
    if (clash !== undefined) throw new UploadError(`the files "${clash}" and "${f}" would both be called "${n}" on the release`);
    names.set(n.toLowerCase(), f);
  }
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const known = new Set(files);
  const out: StagedFile[] = [];
  for (const f of files) {
    const name = assetName(f);
    const dest = join(stageDir, name);
    const src = join(outDir, f);
    if (f === "SHA256SUMS") {
      const lines = readFileSync(src, "utf8").split("\n").filter((l) => l !== "");
      const parsed = lines.map((l) => /^([0-9a-f]{64}) {2}(.+)$/.exec(l));
      if (lines.length && parsed.every((m) => m && known.has(m[2]!))) {
        writeFileSync(dest, parsed.map((m) => `${m![1]}  ${assetName(m![2]!)}\n`).join(""));
      } else copyFileSync(src, dest);
    } else {
      try {
        linkSync(src, dest);
      } catch {
        copyFileSync(src, dest);
      }
    }
    out.push({ name, path: dest, size: statSync(dest).size });
  }
  return out;
}

/** 1024-based, one decimal from KB up: "512 B", "1.2 KB", "3.4 MB", "1.1 GB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

const LIST_JQ =
  ".[] | {id, tag_name, draft, prerelease, created_at, html_url, upload_url, body, assets: [.assets[] | {id, name, size}]} | tojson";

function toRelease(raw: unknown): GhRelease {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r.id !== "number" || typeof r.tag_name !== "string") throw new UploadError("GitHub answered with a release this tool does not understand");
  const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
  return {
    id: r.id,
    tag: r.tag_name,
    draft: r.draft === true,
    prerelease: r.prerelease === true,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    url: typeof r.html_url === "string" ? r.html_url : "",
    uploadUrl: typeof r.upload_url === "string" ? r.upload_url : "",
    body: typeof r.body === "string" ? r.body : "",
    assets: assets.map((a) => ({ id: Number(a.id), name: String(a.name), size: Number(a.size) || 0 })),
  };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UploadError(`GitHub's answer for ${what} is not JSON`);
  }
}

/** Every release of the repository (all pages), one JSON line each from `gh api --paginate --jq`. */
export async function listReleases(gh: GhRunner, repo: string): Promise<GhRelease[]> {
  const text = await gh(["api", "--paginate", `repos/${repo}/releases?per_page=100`, "--jq", LIST_JQ]);
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => toRelease(parseJson(l, "the release list")));
}

/** One release by its ID. */
export async function getRelease(gh: GhRunner, repo: string, id: number): Promise<GhRelease> {
  return toRelease(parseJson(await gh(["api", `repos/${repo}/releases/${id}`]), `release ${id}`));
}

export interface PrunePick { remove: GhRelease[]; kept: GhRelease[] }

const newestFirst = (a: GhRelease, b: GhRelease) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id;

/**
 * Which old drafts go. Only drafts whose tag matches the pattern and whose notes hold the marker are candidates (published releases,
 * hand-made drafts and drafts of other recipes never are). The run's own draft is not a candidate but takes one place of `keep`.
 */
export function pickPrune(releases: GhRelease[], o: { pattern: RegExp; marker: string; keep: number; ownId: number }): PrunePick {
  const candidates = releases.filter((r) => r.draft && r.id !== o.ownId && o.pattern.test(r.tag) && r.body.includes(o.marker)).sort(newestFirst);
  const room = Math.max(0, o.keep - 1);
  return { kept: candidates.slice(0, room), remove: candidates.slice(room) };
}

export interface UploadInput {
  repo: string;
  plan: { sha: string; tag: string; prerelease: boolean; keep: number; recipe: Pick<Recipe, "version" | "tag"> };
  outDir: string;
  stageDir: string;
  gh: GhRunner;
  log: (line: string) => void;
}
export interface UploadResult {
  url: string;
  tag: string;
  id: number;
  created: boolean;
  files: StagedFile[];
  deleted: string[];
  skipped: { tag: string; id: number; why: string }[];
  warnings: string[];
}

/** Upload the release files to the draft of the plan's tag (made if needed), then prune old drafts of this recipe. */
export async function uploadRelease(i: UploadInput): Promise<UploadResult> {
  const { gh, repo, plan } = i;
  const warnings: string[] = [];
  const warn = (w: string) => {
    warnings.push(w);
    i.log(`warning: ${w}`);
  };
  const files = stageFiles(i.outDir, i.stageDir);

  const all = await listReleases(gh, repo);
  const same = all.filter((r) => r.tag === plan.tag);
  const published = same.find((r) => !r.draft);
  if (published) throw new UploadError(`the release for tag ${plan.tag} is already published (${published.url}); the Foundry never changes a published release. Nothing was changed.`);

  let rel: GhRelease;
  let created = false;
  if (!same.length) {
    const notes = `Built from ${plan.sha.slice(0, 7)} by the Spaghetti Code Foundry.\n\n${releaseMarker(plan.recipe)}\n`;
    const answer = await gh([
      "api", "-X", "POST", `repos/${repo}/releases`,
      "-f", `tag_name=${plan.tag}`, "-f", `target_commitish=${plan.sha}`, "-f", `name=${plan.tag}`, "-f", `body=${notes}`,
      "-F", "draft=true", "-F", `prerelease=${plan.prerelease ? "true" : "false"}`,
    ]);
    rel = toRelease(parseJson(answer, "the new release"));
    created = true;
  } else {
    rel = [...same].sort(newestFirst)[0]!;
    if (same.length > 1) warn(`${same.length} drafts have tag ${plan.tag}; using the newest, id ${rel.id}`);
  }

  const fresh = await getRelease(gh, repo, rel.id);
  if (!fresh.draft || fresh.tag !== plan.tag) throw new UploadError(`release ${rel.id} is no longer a draft for tag ${plan.tag}; nothing was uploaded`);
  rel = { ...fresh, uploadUrl: fresh.uploadUrl || rel.uploadUrl };
  i.log(`RELEASE: ${rel.tag} (draft, ${created ? "new" : "existing"}, id ${rel.id})`);
  i.log(`URL: ${rel.url}`);

  const uploadBase = rel.uploadUrl.replace(/\{[^}]*\}$/, "");
  if (!uploadBase) throw new UploadError(`release ${rel.id} has no upload address`);
  for (const [n, f] of files.entries()) {
    if (n > 0) {
      // a long upload: someone may have published the release in between; then nothing more is changed
      const now = await getRelease(gh, repo, rel.id);
      if (!now.draft || now.tag !== plan.tag) throw new UploadError(`release ${rel.id} was published or changed during the upload; stopped after ${n} of ${files.length} files`);
      rel = { ...rel, assets: now.assets };
    }
    const old = rel.assets.find((a) => a.name.toLowerCase() === f.name.toLowerCase());
    if (old) await gh(["api", "-X", "DELETE", `repos/${repo}/releases/assets/${old.id}`]);
    const answer = parseJson(
      await gh(["api", "-X", "POST", `${uploadBase}?name=${encodeURIComponent(f.name)}`, "-H", "Content-Type: application/octet-stream", "--input", f.path]),
      `the upload of ${f.name}`,
    ) as { name?: unknown };
    if (answer.name !== f.name) throw new UploadError(`GitHub stored "${f.name}" as "${String(answer.name)}"; the upload is not complete`);
  }
  i.log(`UPLOADED: ${files.length} files`);
  for (const f of files) i.log(`  ${f.name}  ${formatSize(f.size)}`);

  const deleted: string[] = [];
  const skipped: UploadResult["skipped"] = [];
  const marker = releaseMarker(plan.recipe);
  const pick = pickPrune(await listReleases(gh, repo), { pattern: tagPattern(plan.recipe), marker, keep: plan.keep, ownId: rel.id });
  for (const r of pick.remove) {
    try {
      const now = await getRelease(gh, repo, r.id);
      if (!now.draft || now.tag !== r.tag || !now.body.includes(marker)) {
        skipped.push({ tag: r.tag, id: r.id, why: "changed since the list" });
        warn(`not deleting ${r.tag} (id ${r.id}): it changed since the list`);
        continue;
      }
      await gh(["api", "-X", "DELETE", `repos/${repo}/releases/${r.id}`]);
      deleted.push(`${r.tag} (${r.id})`);
    } catch (e) {
      skipped.push({ tag: r.tag, id: r.id, why: (e as Error).message });
      warn(`could not delete ${r.tag} (id ${r.id}): ${(e as Error).message}`);
    }
  }
  if (deleted.length) i.log(`PRUNED: ${deleted.join(", ")}`);
  if (pick.kept.length) i.log(`KEPT: ${pick.kept.map((r) => `${r.tag} (${r.id})`).join(", ")}`);
  return { url: rel.url, tag: rel.tag, id: rel.id, created, files, deleted, skipped, warnings };
}
