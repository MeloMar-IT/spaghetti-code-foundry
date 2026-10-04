export type RefinementErrorCode =
  | "bad-idea"
  | "bad-title"
  | "bad-repo"
  | "bad-answer"
  | "bad-text"
  | "bad-round"
  | "no-owner"
  | "not-yours"
  | "limit"
  | "not-found"
  | "not-owner"
  | "bad-state"
  | "busy"
  | "no-repo";

/** A problem with what the caller asked for (not with the file). The message is safe to show. */
export class RefinementError extends Error {
  constructor(
    public code: RefinementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RefinementError";
  }
}
