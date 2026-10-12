/** The rules for `help.sensitive_patterns`. No imports: the config schema reads this file. */

/** The most patterns, and the longest one. */
export const PATTERN_LIMIT = 20;
export const PATTERN_MAX = 200;

/** Whether a text of `help.sensitive_patterns` can be used: a regular expression that does not match the empty text. */
export function usablePattern(p: string): boolean {
  try {
    return p.length > 0 && p.length <= PATTERN_MAX && !new RegExp(p, "gi").test("");
  } catch {
    return false;
  }
}
