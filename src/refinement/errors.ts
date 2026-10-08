export type RefinementErrorCode =
  | "bad-idea"
  | "bad-title"
  | "bad-repo"
  | "bad-answer"
  | "bad-text"
  | "bad-round"
  | "bad-draft"
  | "bad-epic"
  | "no-owner"
  | "not-yours"
  | "limit"
  | "not-found"
  | "not-owner"
  | "bad-state"
  | "busy"
  | "no-repo"
  | "bad-issue"
  | "no-issue"
  | "issue-closed"
  | "building"
  | "duplicate";

/** A problem with what the caller asked for (not with the file). The message is safe to show. */
export class RefinementError extends Error {
  constructor(
    public code: RefinementErrorCode,
    message: string,
    /** The id of the session that is meant (code `duplicate`). */
    public session?: string,
  ) {
    super(message);
    this.name = "RefinementError";
  }
}
