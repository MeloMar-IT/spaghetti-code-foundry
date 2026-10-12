import { isSafeRelativePath, sha256Hex } from "../evidence/identity.js";

/**
 * The address (URI) of a context source. Pure helpers.
 *
 * There are four forms, one per kind of source, and nothing else is an address:
 *
 *   repo:<path>                       a file of the repository of the bundle, e.g. "repo:src/a%20b.ts"
 *   issue:<number>                    the text of an issue of that repository
 *   issue:<number>/comment/<id>       one comment on that issue
 *   refinement:<session id>           the accepted notes of a refinement session
 *
 * An address never names a host, a folder of this machine, a user, a query or a fragment, so it cannot carry a
 * token or a private path. Which repository it is about is said once, by the bundle.
 */

export const CONTEXT_URI_MAX = 4096;

const REPO = "repo:";
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** The address of a file of the repository. `path` is relative to the repository root, with `/` between parts. Throws when it is not. */
export function repositoryFileUri(path: string): string {
  let uri: string | undefined;
  try {
    uri = isSafeRelativePath(path) ? REPO + encodePath(path) : undefined;
  } catch {
    uri = undefined; // text that cannot be encoded (half a surrogate pair)
  }
  if (uri === undefined || uri.length > CONTEXT_URI_MAX) throw new Error("not a path inside the repository: it must be relative, with / between parts, and without . or .. parts");
  return uri;
}

/**
 * The path a `repo:` address names, relative to the repository root; undefined when the text is not such an address
 * in its one canonical spelling (so two different texts never name the same file).
 */
export function repositoryFilePath(uri: string): string | undefined {
  if (!uri.startsWith(REPO) || uri.length > CONTEXT_URI_MAX) return undefined;
  const rest = uri.slice(REPO.length);
  try {
    const path = decodeURIComponent(rest);
    return isSafeRelativePath(path) && encodePath(path) === rest ? path : undefined;
  } catch {
    return undefined;
  }
}

const NUMBER = "[1-9][0-9]{0,15}";
const ISSUE = new RegExp(`^issue:${NUMBER}$`);
const ISSUE_COMMENT = new RegExp(`^issue:${NUMBER}/comment/${NUMBER}$`);
const REFINEMENT = /^refinement:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isIssueUri = (uri: string): boolean => ISSUE.test(uri);
export const isIssueCommentUri = (uri: string): boolean => ISSUE_COMMENT.test(uri);
export const isRefinementUri = (uri: string): boolean => REFINEMENT.test(uri);

const whole = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n < 1 || n > 9_999_999_999_999_999) throw new Error(`${what} must be a whole number above 0`);
  return n;
};

/** The address of the text of issue `number`. */
export const issueUri = (number: number): string => `issue:${whole(number, "the issue number")}`;
/** The address of one comment on issue `number`. `commentId` is the id the host gives the comment. */
export const issueCommentUri = (number: number, commentId: number): string => `${issueUri(number)}/comment/${whole(commentId, "the comment id")}`;
/** The address of the accepted notes of a refinement session, by the id of the session (a lower-case UUID). */
export function refinementUri(sessionId: string): string {
  const uri = `refinement:${sessionId}`;
  if (!REFINEMENT.test(uri)) throw new Error("the refinement session id must be a lower-case UUID");
  return uri;
}

/**
 * The id of the entry for an address: "s-" and the first 16 hex characters of the SHA-256 of the address.
 * It follows from the address alone, so the same source has the same id in every bundle and can be cited.
 */
export const contextSourceId = (uri: string): string => `s-${sha256Hex(uri).slice(0, 16)}`;
