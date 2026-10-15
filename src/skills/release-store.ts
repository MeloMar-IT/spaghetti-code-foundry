import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataHome } from "../auth/store.js";
import { claimHomeWrite } from "../home.js";
import { ATTRIBUTION_DIR, verifyRelease } from "./release-verify.js";
import { MAX_RELEASE_V2_BYTES, RELEASE_FILE, ReleaseManifestSchema, releaseDigest, type ReleaseManifestV2 } from "./release.js";

// The published catalogue releases: <data folder>/skill-releases/<catalogue>/<version>/ (a schema-2 release folder, see release-verify.ts).
// A release is built in a private skill-releases/.tmp-<random> folder (0700 folders, 0600 files, written with "wx" and synced), checked with
// verifyRelease, and then moved into place with ONE rename. A version is written exactly once: an existing version is never replaced, it
// is reported as "unchanged" (same digest) or "refused". The temporary folder sits next to the catalogue folders, so it is on the same
// filesystem and the rename is atomic, and a crash never leaves junk beside the versions.
//
// Exclusivity: rename(folder, folder) fails with ENOTEMPTY/EEXIST when the target is a non-empty folder and with ENOTDIR when it is a
// file or a link. POSIX rename DOES replace an EMPTY folder. So only an empty folder that someone else made in the window between our
// check and the rename can be replaced, never a real release: a release always holds catalogue-release.json.
// Readers must ignore names that start with "." in skill-releases/.

export const RELEASES_DIR = "skill-releases";
export const releasesDir = (home = dataHome()): string => join(home, RELEASES_DIR);

const TMP_PREFIX = ".tmp-";

export class ReleaseStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseStoreError";
  }
}

export interface ReleaseFile {
  path: string;
  content: Uint8Array;
}
export interface ReleaseContent {
  manifest: ReleaseManifestV2;
  /** Skill id → package files. */
  packages: Map<string, ReleaseFile[]>;
  /** Skill id → attribution files (a missing id: none). */
  attribution: Map<string, ReleaseFile[]>;
}
export type PublishResult =
  | { state: "published" | "unchanged"; digest: string }
  | { state: "refused"; digest: string; why: "other-digest" | "not-a-release"; detail?: string };

/** Test hooks: the rename that publishes, and a call between writing and verifying. */
export const releaseStoreSettings: { rename: (from: string, to: string) => void; beforeVerify?: (tmp: string) => void } = { rename: renameSync };

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
const codeOf = (e: unknown): string => {
  const c = code(e);
  return typeof c === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(c) ? c : "error";
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A plain 0700 folder, made (mode 0700) when missing. A creation race (EEXIST) is re-checked, not an error. */
function plainDir(path: string, label: string): void {
  for (let i = 0; i < 2; i++) {
    let st;
    try {
      st = lstatSync(path);
    } catch (e) {
      if (code(e) !== "ENOENT") throw e;
      try {
        mkdirSync(path, { mode: 0o700 });
        return;
      } catch (e2) {
        if (code(e2) === "EEXIST") continue;
        throw e2;
      }
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ReleaseStoreError(`${label} is not a plain folder`);
    if ((st.mode & 0o777) !== 0o700) throw new ReleaseStoreError(`${label} must have mode 0700; nothing was changed`);
    return;
  }
  throw new ReleaseStoreError(`${label} is busy; try again`);
}

const pathsOf = (list: { path: string }[]): string => JSON.stringify(list.map((f) => f.path).sort(cmp));

/** The content is exactly what the manifest lists, before any path is built from it. */
function checkContent(c: ReleaseContent): string {
  const parsed = ReleaseManifestSchema.safeParse(c.manifest);
  if (!parsed.success || c.manifest.schema !== 2) throw new ReleaseStoreError("the release manifest has the wrong format");
  const text = manifestText(c.manifest);
  if (Buffer.byteLength(text) > MAX_RELEASE_V2_BYTES) throw new ReleaseStoreError("the release manifest is too large");
  const ids = new Set(c.manifest.skills.map((s) => s.id));
  for (const id of [...c.packages.keys(), ...c.attribution.keys()]) {
    // An unknown key never passed the id schema: it is not shown.
    if (!ids.has(id)) throw new ReleaseStoreError("the content names a skill that the release manifest does not list");
  }
  for (const s of c.manifest.skills) {
    const pkg = c.packages.get(s.id);
    const att = c.attribution.get(s.id) ?? [];
    if (!pkg || pathsOf(pkg) !== pathsOf(s.files) || pathsOf(att) !== pathsOf(s.attribution)) {
      throw new ReleaseStoreError(`skill ${s.id}: the content does not match the release manifest`);
    }
  }
  return text;
}

const manifestText = (m: ReleaseManifestV2): string => JSON.stringify({ ...m, skills: [...m.skills].sort((a, b) => cmp(a.id, b.id)) }, null, 2) + "\n";

const mkdirs = (dir: string): void => void mkdirSync(dir, { recursive: true, mode: 0o700 });

function writeFile(path: string, bytes: Uint8Array): void {
  mkdirs(dirname(path));
  const fd = openSync(path, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** What an existing version path means for a release with digest `want`. Never changes anything. Undefined: nothing is there. */
function existing(target: string, want: string): PublishResult | undefined {
  let st;
  try {
    st = lstatSync(target);
  } catch (e) {
    if (code(e) === "ENOENT") return undefined;
    throw e;
  }
  const refused = (why: "other-digest" | "not-a-release", detail: string): PublishResult => ({ state: "refused", digest: want, why, detail });
  if (st.isSymbolicLink()) return refused("not-a-release", "is a link");
  if (!st.isDirectory()) return refused("not-a-release", "is not a folder");
  const v = verifyRelease(target);
  if (!v.ok) return refused("not-a-release", v.reason);
  if (v.digest === want) return { state: "unchanged", digest: want };
  return refused("other-digest", `the published release has digest ${v.digest}`);
}

/** Writes a schema-2 release once. See the header comment. Throws ReleaseStoreError; the message never shows a path. */
export function publishRelease(content: ReleaseContent, opts: { home?: string } = {}): PublishResult {
  const text = checkContent(content);
  const m = content.manifest;
  const want = releaseDigest(m);
  const home = opts.home ?? dataHome();
  const target = join(releasesDir(home), m.catalogue, m.version);
  let result: PublishResult | undefined;

  const write = () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const realHome = realpathSync(home);
    const root = join(realHome, RELEASES_DIR);
    const cat = join(root, m.catalogue);
    const dest = join(cat, m.version);
    plainDir(root, RELEASES_DIR);
    plainDir(cat, `${RELEASES_DIR}/${m.catalogue}`);
    if (realpathSync(cat) !== cat) throw new ReleaseStoreError("the release folder is not inside the data folder");
    const pre = existing(dest, want);
    if (pre) {
      result = pre;
      return;
    }
    const tmp = join(root, TMP_PREFIX + randomBytes(8).toString("hex"));
    mkdirSync(tmp, { mode: 0o700 });
    try {
      writeFile(join(tmp, RELEASE_FILE), Buffer.from(text));
      for (const s of m.skills) {
        for (const f of content.packages.get(s.id)!) writeFile(join(tmp, s.id, ...f.path.split("/")), f.content);
        for (const f of content.attribution.get(s.id) ?? []) writeFile(join(tmp, ATTRIBUTION_DIR, s.id, ...f.path.split("/")), f.content);
      }
      releaseStoreSettings.beforeVerify?.(tmp);
      const v = verifyRelease(tmp);
      if (!v.ok) throw new ReleaseStoreError(`the written release does not verify: ${v.reason}`);
      if (v.digest !== want) throw new ReleaseStoreError("the written release has another digest");
      const again = existing(dest, want);
      if (again) {
        result = again;
        return;
      }
      try {
        releaseStoreSettings.rename(tmp, dest);
      } catch (e) {
        // Another publish may have won the race: look at what is there now.
        const won = existing(dest, want);
        if (!won) throw e;
        result = won;
        return;
      }
      try {
        const fd = openSync(cat, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        // best effort
      }
      result = { state: "published", digest: want };
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // left for a later look: readers ignore .tmp- folders
      }
    }
  };

  try {
    claimHomeWrite(
      target,
      write,
      10_000,
      (kind) => new ReleaseStoreError(kind === "busy" ? "the data folder is locked by another scf process; try again in a moment" : "the data folder moved; restart scf"),
    );
  } catch (e) {
    if (e instanceof ReleaseStoreError) throw e;
    throw new ReleaseStoreError(`the release cannot be written (${codeOf(e)})`);
  }
  return result!;
}
