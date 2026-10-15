import type { SkillIntegrityFailure } from "./registry.js";

export type SkillSelectCode = "unknown" | "unapproved" | "unverified" | "unpinned" | "mismatch";
export class SkillSelectError extends Error {
  constructor(
    public code: SkillSelectCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillSelectError";
  }
}
export class SkillIntegrityError extends SkillSelectError {
  constructor(public failure: SkillIntegrityFailure) {
    super("mismatch", `${failure.id}@${failure.version} does not match its pin (pinned ${failure.expected}, actual ${failure.actual})`);
    this.name = "SkillIntegrityError";
  }
}

export type SkillPinErrorCode = "bad-key" | "bad-digest" | "unknown" | "unapproved" | "digest-mismatch" | "already-pinned";
export class SkillPinError extends Error {
  constructor(
    public code: SkillPinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillPinError";
  }
}
