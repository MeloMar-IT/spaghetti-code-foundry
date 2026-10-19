import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { z } from "zod";
import { listAllRepos } from "../auth/repos.js";
import { githubKey, tryParseRepoUrl, validGithubName } from "../auth/repo-url.js";

export const PLATFORMS = ["macos", "linux", "windows"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const ARCHES = ["arm64", "x64"] as const;
export type Arch = (typeof ARCHES)[number];

const COMMIT_PLACEHOLDERS = ["commit_datetime", "commit_date", "sha"];
const placeholders = (names: string[]) => names.map((n) => `{${n}}`).join(", ");

const VERSION_RE = new RegExp(`^(?:[0-9A-Za-z._+-]|\\{(?:${COMMIT_PLACEHOLDERS.join("|")})\\})+$`);
const TAG_RE = new RegExp(`^(?:[0-9A-Za-z._+/-]|\\{(?:${[...COMMIT_PLACEHOLDERS, "version"].join("|")})\\})+$`);

export const BuildSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "a build name uses a-z, 0-9 and - only (1–64 characters, not starting with -)"),
  on: z.array(z.enum(PLATFORMS)).min(1, "on: list at least one of macos, linux, windows").default([...PLATFORMS]),
  arch: z.enum(ARCHES).optional(),
  requires: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "a command name has letters, digits and . _ + - only")).default([]),
  run: z.string().trim().min(1, "run: the command is empty"),
  artifacts: z
    .array(
      z.string().min(1).refine((g) => !g.startsWith("/") && !g.startsWith("~") && !g.includes("\\") && !g.split("/").includes(".."), {
        message: "an artifact glob is a relative path with / and no .. (inside the build folder)",
      }),
    )
    .min(1, "artifacts: list at least one glob"),
});

export const RecipeSchema = z
  .strictObject({
    version: z
      .string()
      .trim()
      .min(1)
      .refine((s) => VERSION_RE.test(s), {
        message: `version may hold only letters, digits and "._+-" plus the placeholders ${placeholders(COMMIT_PLACEHOLDERS)}`,
      })
      .default("{commit_datetime}"),
    tag: z
      .string()
      .trim()
      .min(1)
      .max(128, "tag: at most 128 characters")
      .refine((s) => TAG_RE.test(s), {
        message: `tag may hold only letters, digits and "._+/-" plus the placeholders ${placeholders(["version", ...COMMIT_PLACEHOLDERS])}`,
      })
      .refine((s) => !s.includes("..") && !s.startsWith("-") && !s.startsWith("/") && !s.endsWith("/") && !s.endsWith(".lock"), {
        message: "tag is not a valid git tag name",
      })
      .default("v{version}"),
    prerelease: z.boolean().default(true),
    keep: z.number().int("keep: a whole number from 1 to 50").min(1, "keep: at least 1").max(50, "keep: at most 50").default(5),
    timeout_minutes: z.number().int("timeout_minutes: a whole number from 1 to 480").min(1, "timeout_minutes: at least 1").max(480, "timeout_minutes: at most 480").default(60),
    builds: z.array(BuildSchema).min(1, "builds: list at least one build"),
    assemble: z.string().trim().min(1, "assemble: the command is empty").optional(),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.builds.forEach((b, i) => {
      if (seen.has(b.name)) ctx.addIssue({ code: "custom", path: ["builds", i, "name"], message: `"${b.name}" is used twice` });
      seen.add(b.name);
    });
  });

export type Recipe = z.output<typeof RecipeSchema>;
export type Build = Recipe["builds"][number];

export class RecipeError extends Error {}

/** Parse and check the text of a recipe (`.factory/release-build.yaml` or the one stored in the settings). */
export function parseRecipe(text: string, what = "the release-build recipe"): Recipe {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new RecipeError(`${what} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (raw === null || raw === undefined) throw new RecipeError(`${what} is empty`);
  const res = RecipeSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new RecipeError(`${what} is not valid\n${issues}`);
  }
  return res.data;
}

// ---- finding the recipe: the file at the commit, else the one stored in the settings -----------------
// This module imports auth/repos.ts, so nothing under auth/ may import it (a cycle).

export const RECIPE_PATH = ".factory/release-build.yaml";
export const MAX_RECIPE_BYTES = 64 * 1024;
const STORED_WHAT = "the release-build recipe stored in the Foundry settings";

export type RecipeSource = "file" | "stored";
export interface FoundRecipe {
  source: RecipeSource;
  text: string;
}
export const RECIPE_SOURCE_TEXT: Record<RecipeSource, string> = { file: RECIPE_PATH, stored: "stored in the Foundry settings" };

const firstLine = (e: unknown): string => {
  const err = e as { stderr?: Buffer | string; message?: string };
  const text = (err.stderr ? String(err.stderr) : "").trim() || err.message || String(e);
  return text.split("\n")[0]!;
};

/** The recipes stored for a GitHub repository (any case, with or without ".git"), one per different text, and whether a record exists. */
export function storedReleaseRecipes(githubRepo: string): { registered: boolean; texts: string[] } {
  if (!validGithubName(githubRepo)) return { registered: false, texts: [] };
  const key = githubKey(githubRepo);
  const texts = new Set<string>();
  let registered = false;
  for (const r of listAllRepos()) {
    const p = tryParseRepoUrl(r.url);
    if (p?.github === undefined || p.key !== key) continue;
    registered = true;
    if (r.settings?.releaseRecipe) texts.add(r.settings.releaseRecipe);
  }
  return { registered, texts: [...texts] };
}

const gitOut = (cwd: string, args: string[], maxBuffer = 1024 * 1024): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"] });

/** The text of the file at the commit; undefined only when git shows the commit is valid and the path is not in it. Anything else throws. */
function readRecipeFile(commitDir: string, sha: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (!sha || sha.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(sha)) throw new RecipeError(`"${sha}" is not a usable commit`);
  const short = sha.slice(0, 7);
  try {
    gitOut(commitDir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  } catch {
    throw new RecipeError(`cannot find commit ${short} in this repository`);
  }
  let entry: string;
  try {
    entry = gitOut(commitDir, ["ls-tree", sha, "--", RECIPE_PATH]).trim();
  } catch (e) {
    throw new RecipeError(`cannot read ${RECIPE_PATH} at ${short}: ${firstLine(e)}`);
  }
  if (!entry) return undefined;
  const m = /^(100644|100755) blob ([0-9a-f]{40,64})\t/.exec(entry);
  if (!m) throw new RecipeError(`${RECIPE_PATH} at ${short} is not a file`);
  const oid = m[2]!;
  try {
    const size = Number(gitOut(commitDir, ["cat-file", "-s", oid]).trim());
    if (size > MAX_RECIPE_BYTES) throw new RecipeError(`the release-build recipe is too big (over ${MAX_RECIPE_BYTES / 1024} KB)`);
    return gitOut(commitDir, ["cat-file", "blob", oid]);
  } catch (e) {
    if (e instanceof RecipeError) throw e;
    throw new RecipeError(`cannot read ${RECIPE_PATH} at ${short}: ${firstLine(e)}`);
  }
}

function lookup(githubRepo: string, commitDir: string, sha: string): { found: FoundRecipe | null; registered: boolean } {
  const file = readRecipeFile(commitDir, sha);
  if (file !== undefined) return { found: { source: "file", text: file }, registered: true };
  let stored: { registered: boolean; texts: string[] };
  try {
    stored = storedReleaseRecipes(githubRepo);
  } catch (e) {
    throw new RecipeError(`${STORED_WHAT} cannot be read: ${firstLine(e)}`);
  }
  if (stored.texts.length > 1) {
    throw new RecipeError(`${stored.texts.length} accounts store different release-build recipes for ${githubRepo}; an admin should keep only one (Repositories → All)`);
  }
  const text = stored.texts[0];
  return { found: text === undefined ? null : { source: "stored", text }, registered: stored.registered };
}

/** The one check for "this repository has a recipe": the file at the commit wins, else the stored one, else null. */
export const findReleaseRecipe = (githubRepo: string, commitDir: string, sha = "HEAD"): FoundRecipe | null => lookup(githubRepo, commitDir, sha).found;

export const hasReleaseRecipe = (githubRepo: string, commitDir: string, sha = "HEAD"): boolean => findReleaseRecipe(githubRepo, commitDir, sha) !== null;

/** Find and parse the recipe, or throw a RecipeError that says what is missing. */
export function loadReleaseRecipe(githubRepo: string, commitDir: string, sha: string): { recipe: Recipe; source: RecipeSource } {
  const { found, registered } = lookup(githubRepo, commitDir, sha);
  if (!found) {
    const short = sha.slice(0, 7);
    throw new RecipeError(
      registered
        ? `this repository has no release-build recipe (no ${RECIPE_PATH} at ${short}, and none stored in the Foundry settings for ${githubRepo})`
        : `this repository has no release-build recipe (no ${RECIPE_PATH} at ${short}; ${githubRepo || "this repository"} is not a repository in the Foundry, so no recipe can be stored for it)`,
    );
  }
  return { recipe: parseRecipe(found.text, found.source === "stored" ? STORED_WHAT : undefined), source: found.source };
}

export interface CommitInfo {
  sha: string;
  /** Committer time, seconds since 1970 (git's %ct). */
  committerTime: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function fill(text: string, commit: CommitInfo): string {
  const d = new Date(commit.committerTime * 1000);
  const date = `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const values: Record<string, string> = {
    commit_datetime: `${date}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`,
    commit_date: date,
    sha: commit.sha.slice(0, 7),
  };
  return text.replace(/\{(commit_datetime|commit_date|sha)\}/g, (_m, k: string) => values[k]!);
}

/** The version of a release: the same commit always gives the same text (UTC, never the local time zone). */
export function expandVersion(recipe: Pick<Recipe, "version">, commit: CommitInfo): string {
  return fill(recipe.version, commit);
}

/** The tag of a release; `{version}` is the expanded version. */
export function expandTag(recipe: Pick<Recipe, "version" | "tag">, commit: CommitInfo): string {
  return fill(recipe.tag.replaceAll("{version}", expandVersion(recipe, commit)), commit);
}
