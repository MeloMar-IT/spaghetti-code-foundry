import { lstatSync, readFileSync } from "node:fs";
import { CatalogueError, requestReviewer, type CatalogueContext, type CatalogueErrorCode } from "./catalogue-git.js";
import type { LsRemoteError } from "./ls-remote.js";

// Shared by `scf skills update <id>` (update-cli.ts) and `scf skills update --due` (update-due.ts): the fixed sentences, the
// interrupt check and the reviewer helpers of an unattended run.

export const NOTHING = "nothing was proposed";
export const INTERRUPTED = `PROBLEM the update was interrupted; ${NOTHING}`;

export class Interrupted extends Error {}

/** A signal that came in while a synchronous call ran is delivered by the next event-loop turns. */
export const tickFor =
  (signal: AbortSignal) =>
  async (): Promise<void> => {
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    if (signal.aborted) throw new Interrupted();
  };

/** Runs `fn` with a signal that SIGINT and SIGTERM abort. */
export async function withSignal(fn: (signal: AbortSignal) => Promise<number>): Promise<number> {
  const aborter = new AbortController();
  const onSignal = () => aborter.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await fn(aborter.signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export const sameBytes = (a: Buffer | undefined, b: Buffer | undefined) => (a === undefined || b === undefined ? a === b : a.equals(b));

/** The bytes of the file in the working copy, undefined when there is none; a link or another kind of file is "unreadable". */
export function workingFile(path: string): Buffer | undefined | "unreadable" {
  try {
    const st = lstatSync(path);
    return st.isFile() ? readFileSync(path) : "unreadable";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
  }
}

export function resolverSentence(code: LsRemoteError["code"], key: string): string {
  switch (code) {
    case "no-git":
      return "git was not found; install git and try again";
    case "unreachable":
      return `the upstream repository ${key} could not be reached; ${NOTHING}`;
    case "timeout":
      return `git did not answer in 20 seconds; ${NOTHING}`;
    case "interrupted":
      return `the update was interrupted; ${NOTHING}`;
    case "bad-answer":
      return `the answer of the upstream repository could not be read; ${NOTHING}`;
  }
}

export function catalogueSentence(code: CatalogueErrorCode, gh: "list" | "create" = "list"): string {
  switch (code) {
    case "no-git":
      return "git was not found; install git and try again";
    case "not-a-repository":
      return "this folder is not in a git work tree; run the command in a clone of the catalogue repository";
    case "no-origin":
      return "this clone has no remote named origin";
    case "no-default-branch":
      return "the default branch of origin is not known; run: git remote set-head origin --auto";
    case "fetch-failed":
      return `the default branch could not be fetched from origin; ${NOTHING}`;
    case "read-failed":
      return `skill-sources.yaml could not be read from origin; ${NOTHING}`;
    case "commit-failed":
      return `the commit of the proposal could not be made; ${NOTHING}`;
    case "push-failed":
      return "the branch could not be pushed to origin; no pull request was opened";
    case "delete-failed":
      return "the branch on origin could not be checked";
    case "no-gh":
      return "gh was not found; install the GitHub CLI and try again";
    case "gh-failed":
      return gh === "list" ? `the open pull requests could not be listed with gh; ${NOTHING}` : "gh could not open the pull request";
    case "timeout":
      return "git or gh did not finish in 120 seconds";
  }
}

/** Asks `handle` to review the pull request. False when gh could not do it. */
export function askReviewer(ctx: CatalogueContext, repo: string, url: string, handle: string): boolean {
  try {
    requestReviewer(ctx, { repo, url, reviewer: handle });
    return true;
  } catch (e) {
    if (e instanceof CatalogueError) return false;
    throw e;
  }
}

/**
 * Whether `handle` (a user, or a team like `org/team`, with or without the `@`) was asked or, for a user, has reviewed. A review
 * by someone else is no evidence for a team (membership is not known here), so a team counts only while its request is open;
 * a repeated request is harmless.
 */
export function reviewerConfirmed(state: { requested: readonly string[]; reviewed: readonly string[] }, handle: string): boolean {
  const h = handle.replace(/^@/, "").toLowerCase();
  const requested = state.requested.map((x) => x.toLowerCase());
  if (h.includes("/")) return requested.includes(h) || requested.includes(h.slice(h.indexOf("/") + 1));
  return requested.includes(h) || state.reviewed.some((x) => x.toLowerCase() === h);
}
