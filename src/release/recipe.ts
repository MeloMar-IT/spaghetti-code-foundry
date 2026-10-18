import { parse } from "yaml";
import { z } from "zod";

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

/** Parse and check the text of `.factory/release-build.yaml`. */
export function parseRecipe(text: string): Recipe {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new RecipeError(`the release-build recipe is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (raw === null || raw === undefined) throw new RecipeError("the release-build recipe is empty");
  const res = RecipeSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new RecipeError(`the release-build recipe is not valid\n${issues}`);
  }
  return res.data;
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
