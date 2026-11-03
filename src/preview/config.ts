import { parse } from "yaml";
import { z } from "zod";
import { MAX_COMMAND } from "../auth/repo-settings.js";

// This follows the style of release/recipe.ts but does not import it (that pulls in auth/repos.ts).

export const PREVIEW_PATH = ".factory/preview.yaml";
export const PREVIEW_VERSIONS = ["develop", "checking"] as const;
export const REFUSED_ENV_PREFIX = /^(FACTORY_|SCF_|GH_|GITHUB_|ANTHROPIC_|OPENAI_)/;
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
export const MAX_READY_PATH = 300;
export const MAX_ENV_ENTRIES = 50;
export const MAX_ENV_VALUE = 4096;

// eslint-disable-next-line no-control-regex
const BAD_COMMAND_CHAR = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const READY_PATH = /^\/[\x21-\x7e]*$/;

/**
 * The file's `env` is set on the app after the short inherited environment. `PORT` and `HOST` may be named here,
 * but the runner's own values replace them.
 */
export const PreviewSchema = z
  .strictObject({
    command: z
      .string()
      .trim()
      .min(1, "command: the command is empty")
      .max(MAX_COMMAND, `command: at most ${MAX_COMMAND} characters`)
      .refine((c) => !BAD_COMMAND_CHAR.test(c), { message: "command: no control characters other than tab and newline" }),
    port: z
      .union([z.literal("auto"), z.number().int().min(1024).max(65535)], { error: 'port: "auto" or a whole number from 1024 to 65535' })
      .default("auto"),
    ready: z
      .string()
      .max(MAX_READY_PATH, `ready: at most ${MAX_READY_PATH} characters`)
      .refine((p) => READY_PATH.test(p), { message: "ready: a path that starts with / (printable characters, no spaces)" })
      .default("/"),
    env: z.record(z.string(), z.string(), { error: "env: names and values must be text" }).default({}),
    version: z.enum(PREVIEW_VERSIONS, { error: 'version: "develop" or "checking"' }).default("develop"),
  })
  .superRefine((p, ctx) => {
    const entries = Object.entries(p.env);
    if (entries.length > MAX_ENV_ENTRIES) ctx.addIssue({ code: "custom", path: ["env"], message: `env: at most ${MAX_ENV_ENTRIES} entries` });
    for (const [name, value] of entries) {
      const at = ["env", name];
      if (!ENV_NAME.test(name)) ctx.addIssue({ code: "custom", path: at, message: "a name uses A-Z, 0-9 and _ only, and does not start with a digit" });
      else if (REFUSED_ENV_PREFIX.test(name)) ctx.addIssue({ code: "custom", path: at, message: "this name is reserved (FACTORY_, SCF_, GH_, GITHUB_, ANTHROPIC_, OPENAI_)" });
      if (value.length > MAX_ENV_VALUE) ctx.addIssue({ code: "custom", path: at, message: `a value has at most ${MAX_ENV_VALUE} characters` });
      if (value.includes("\0")) ctx.addIssue({ code: "custom", path: at, message: "a value has no NUL character" });
    }
  });

export type PreviewConfig = z.output<typeof PreviewSchema>;

export class PreviewConfigError extends Error {}

/** Parse and check the text of `.factory/preview.yaml`. */
export function parsePreview(text: string, what = PREVIEW_PATH): PreviewConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new PreviewConfigError(`${what} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (raw === null || raw === undefined) throw new PreviewConfigError(`${what} is empty`);
  return checkPreview(raw, what);
}

/** Check an already parsed value (a config object given to the runner). */
export function checkPreview(raw: unknown, what = PREVIEW_PATH): PreviewConfig {
  const res = PreviewSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new PreviewConfigError(`${what} is not valid\n${issues}`);
  }
  return res.data;
}
