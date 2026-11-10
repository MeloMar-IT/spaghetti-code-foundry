// The shared "change" words of every view. Pure functions, no imports (the UI has no build step).
// ui/simple-words.js stays the source of the Simple word list; a test keeps CHANGE_WORD in step with it.

export const CHANGE_WORD = Object.freeze({ one: "change", many: "changes", One: "Change", Many: "Changes" });

/** "1 change", "0 changes", "3 changes". */
export function changesText(n) {
  return `${n} ${n === 1 ? CHANGE_WORD.one : CHANGE_WORD.many}`;
}

/** The text shown for a `next.who` value from the server ("Another story" is shown as "Another change"). */
export function whoText(who) {
  if (who === null || who === undefined) return "";
  return String(who) === "Another story" ? "Another change" : String(who);
}

/** A token that is a value, not wording: a path, branch, file name, url, id, number or code span. Left as it is. */
const isValueToken = (tok) => /[/\\_=#:@`]|https?:|\.[A-Za-z0-9]/.test(tok);

/**
 * Words of a server-made sentence ("Fix story #4", "Switch bug stories on again") shown with the "change" words.
 * Values stay as they are: a token that is a path, branch, file name, url or id is never changed ("feature/story",
 * ".scf/stories/4.md"). Only plain words are replaced.
 */
export function plainServerText(text) {
  if (text === null || text === undefined) return "";
  const phrased = String(text)
    .replace(/\bbug stories\b/g, "bug-fix changes").replace(/\bBug stories\b/g, "Bug-fix changes")
    .replace(/\bbug story\b/g, "bug-fix change").replace(/\bBug story\b/g, "Bug-fix change");
  return phrased.split(/(\s+)/).map((tok) => {
    if (!tok || /^\s+$/.test(tok) || isValueToken(tok)) return tok;
    return tok.replace(/\bstories\b/g, "changes").replace(/\bStories\b/g, "Changes")
      .replace(/\bstory\b/g, "change").replace(/\bStory\b/g, "Change");
  }).join("");
}

/**
 * The old words left in a label: [] when it is clean. GitHub's own name for its object ("GitHub issue",
 * "issue #12", "issue number") and technical tokens (ids, paths, urls) are left out. "story" is never a GitHub name.
 */
export function oldWordsIn(text) {
  if (!text) return [];
  let t = String(text);
  if (/\bGitHub\b/.test(t)) t = t.replace(/\bissues?\b/gi, " ");
  t = t.replace(/\bissues?(?=\s+#)/gi, " ").replace(/\bissues?\s+number\b/gi, " ").replace(/\bissues? and pull requests?\b/gi, " ");
  const kept = t.split(/\s+/).filter((raw) => {
    const tok = raw.replace(/^[("'“‘]+/, "").replace(/[)"'”’.,;:!?…]+$/, "");
    if (tok.startsWith("http") || tok === "{}") return false;
    if (/^issue-gitflow$/.test(tok) || /^\.?[\w-]*\/?\.scf\/stories\/?$/.test(tok)) return false;
    if (/[_#=]/.test(tok)) return false;
    if (/^\.?\w+[\w-]*\.(json|md|ya?ml|js)$/.test(tok) || tok.startsWith(".scf/")) return false;
    // A slash joins words in a path or an API route (a/b/c), not in a label such as "story/issue".
    return !(tok.includes("/") && /^[\w.-]*\/[\w./-]+$/.test(tok) && !/^(stor(y|ies)|issues?)\/(stor(y|ies)|issues?)$/i.test(tok));
  });
  return kept.join(" ").match(/\b(stor(?:y|ies)|issues?)\b/gi) || [];
}
