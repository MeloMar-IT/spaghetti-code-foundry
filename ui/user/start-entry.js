// Start work: where you start (a new idea, an existing change, a conversation) and what "Make a plan" sends for each.
// Pure helpers first, then the two widgets. Relative imports, so a test can load it.
import { h } from "../dom.js";
import { issueNumber } from "../refinement-import.js";
import { TEXT_MAX, changeRepoOf } from "../simple-change-model.js";
import { CHANGE } from "../simple-change-words.js";
import { errorState, explainError, loadingState } from "../states.js";

export const POINTS_TITLE = "Where do you start?";
export const START_POINTS = [
  { id: "idea", label: "A new idea" },
  { id: "issue", label: "An existing change" },
  { id: "conversation", label: "A conversation" },
];
export const ISSUE_LABEL = "Which change? Give its issue number, for example #12";
export const ISSUE_HINT = "The issue is read from GitHub. Nothing on GitHub changes.";
export const IDEA_HINT = "Write it in your own words. The Foundry may ask a few questions, then shows its plan.";
export const NEED_TEXT = "Write what you would like to change first.";
export const NEED_ISSUE_NUMBER = "Give the issue number, for example #12.";
export const NEEDS_GITHUB = "An existing change needs a GitHub repository. Choose one under Advanced.";
export const NO_PLAN_REPO = "Add the repository you work in.";
export const NO_PLAN_PROJECT = "Add a project first.";
export const PLAN_FAILED = "The plan could not be started.";
export const SESSION_EXISTS = "You already have a session for this change. It is open now.";
export const NO_CONVERSATIONS = "You have no open conversation. Start with a new idea.";
export const CONVERSATIONS_FAILED = "Your conversations could not be loaded.";
export const inRepo = (name) => `In ${name}`;

const KINDS = START_POINTS.map((p) => p.id);
export const isKind = (k) => KINDS.includes(k);

/** [{ id, name, github }]: the records a plan can be made for, in list order. `name` is what the change API takes. */
export function planRepos(repos) {
  return (Array.isArray(repos) ? repos : []).flatMap((r) => {
    const name = changeRepoOf(r);
    return name ? [{ id: r.id, name, github: typeof r.github === "string" ? r.github : "" }] : [];
  });
}

/** `wanted` (any case) when listed, else the first, else null. */
export function pickPlanRepo(list, wanted) {
  const w = String(wanted ?? "").toLowerCase();
  return list.find((r) => w && r.name.toLowerCase() === w) ?? list[0] ?? null;
}

/** "" when the plan can be sent, else the sentence to show. `repo` is a planRepos item or null. */
export function planProblem({ kind, text, repo }) {
  const t = String(text ?? "").trim();
  if (kind === "idea") {
    if (!t) return NEED_TEXT;
    const n = [...t].length;
    if (n > TEXT_MAX) return CHANGE.tooLongText(n);
  } else if (kind === "issue" && issueNumber(t) === undefined) return NEED_ISSUE_NUMBER;
  if (!repo) return NO_PLAN_REPO;
  if (kind === "issue" && !repo.github) return NEEDS_GITHUB;
  return "";
}

/** The API call and its body. Call `planProblem` first. */
export function planRequest({ kind, text, repo }) {
  if (kind === "issue") return { call: "createRefinement", body: { repo: repo.github, issue: issueNumber(text) } };
  return { call: "createChange", body: { repo: repo.name, text: String(text).trim() } };
}

/** The page a made plan opens. */
export const planTarget = (kind, repo, answer) =>
  kind === "issue" ? "#/refinement/" + encodeURIComponent(answer?.id) : "#/change/" + encodeURIComponent(repo.id);

/** The session id inside a 409 "you already have one" answer (the server sends `session` as the id), or "". */
export const existingSession = (e) => (e?.status === 409 && typeof e.data?.session === "string" ? e.data.session : "");

const time = (s) => Date.parse(s?.updated ?? "") || 0;
/** The person's open sessions from GET /api/refinement, newest first. */
export function openSessions(answer) {
  const list = Array.isArray(answer?.sessions) ? answer.sessions : [];
  return list.filter((s) => s && s.mine !== false && !["dropped", "published"].includes(s.state)).sort((x, y) => time(y) - time(x));
}

/** { node, radios }: the radio group. */
export function startPoints({ kind, disabled = false, onChange }) {
  const radios = START_POINTS.map((p) => {
    const radio = h("input", { type: "radio", name: "start-point", value: p.id, checked: p.id === kind, disabled: disabled ? true : undefined });
    radio.addEventListener("change", () => onChange?.(p.id));
    return radio;
  });
  const node = h("fieldset", { class: "start-points" }, h("legend", {}, POINTS_TITLE),
    START_POINTS.map((p, i) => h("label", { class: "choice" }, radios[i], p.label)));
  return { node, radios };
}

/** The open conversations as links. Reads them itself; `isGone()` stops late answers. */
export function conversationList({ a, isGone = () => false }) {
  const node = h("div", { class: "start-conversations" });
  const show = (...n) => { if (!isGone()) node.replaceChildren(...n.flat().filter(Boolean)); };
  async function load() {
    show(loadingState("Loading your conversations…", { rows: 2 }));
    try {
      const sessions = openSessions(await a.refinement(true));
      if (!sessions.length) return show(h("p", { class: "muted" }, NO_CONVERSATIONS), h("a", { href: "#/refinement" }, "All sessions"));
      show(h("ul", { class: "start-notes" }, sessions.map((s) => h("li", {},
        h("a", { href: "#/refinement/" + encodeURIComponent(s.id) }, s.title || "Untitled session"),
        s.repo ? h("small", { class: "muted" }, ` ${s.repo}`) : null))));
    } catch (e) {
      show(errorState(explainError(e, { what: CONVERSATIONS_FAILED }), { onRetry: load }));
    }
  }
  void load();
  return node;
}
