// The "New refinement session" form: an idea or an existing issue. What was typed is kept in page memory
// (never on disk) until the session is made. Must not import refinement.js.
import { api } from "./api.js";
import { errorText } from "./auth.js";
import { h, modal, mount } from "./dom.js";
import { sameRepo } from "./filters.js";
import { openAskConversation } from "./ask-handoff.js";
import { issueNumber } from "./refinement-import.js";

export const NEED_ISSUE = "Give the issue number.";
const FILL_NOTE = "Filled in from Ask SCF. Check the text and change it as you like. Nothing is saved until you press Start session.";
// the limits of POST /api/refinement for an idea (IDEA_MAX and TITLE_MAX of src/refinement/store.ts)
const IDEA_MAX = 10000;
const TITLE_MAX = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (s) => String(s ?? "").trim();

/** A fill from Ask SCF that can be used: a title and a text within the limits, an optional repository and the id of the conversation. */
function validFill(f) {
  return !!f && typeof f === "object" && typeof f.title === "string" && !!text(f.title) && typeof f.text === "string" && !!text(f.text) && (f.repo === undefined || typeof f.repo === "string") && typeof f.fromHelp === "string" && UUID.test(f.fromHelp);
}

/** What is missing in the input, or "" when it can be sent. kind: "idea" (default) or "issue". */
export function sessionProblem({ repo, idea, issue, kind } = {}) {
  if (!text(repo)) return "Choose a repository.";
  if (kind === "issue") return issueNumber(issue) === undefined ? NEED_ISSUE : "";
  if (!text(idea)) return "Describe your idea.";
  return "";
}

/** The request body. An idea: { repo, idea, title?, fromHelp? }. An issue: { repo, issue } and nothing else. */
export function sessionBody({ repo, idea, title, issue, kind, fromHelp }) {
  if (kind === "issue") return { repo: text(repo), issue: issueNumber(issue) };
  const body = { repo: text(repo), idea: String(idea ?? "") };
  if (text(title)) body.title = text(title);
  if (typeof fromHelp === "string" && UUID.test(fromHelp)) body.fromHelp = fromHelp;
  return body;
}

let kept = null;
let revision = 0;

/** The typed text { repo, kind, title, idea, issue }, or null. A copy. */
export function keptSession() {
  return kept ? { ...kept } : null;
}

export function clearKeptSession() {
  kept = null;
  revision += 1;
}

function keep(next) {
  if (kept && JSON.stringify(kept) === JSON.stringify(next)) return;
  kept = next;
  revision += 1;
}

/**
 * Asks for the repository and an idea or an issue. Resolves with the new session, or undefined when closed. `kind` wins over the kept kind; `preferred` is the filtered repository.
 * `fill` (from Ask SCF): the title and idea come from it, its repository wins over the kept one, and the session keeps a link back.
 * The kept text is written only by what the person types or picks, and cleared only by the dialog that wrote it.
 */
export function newSessionDialog(repos, onMade, { kind, preferred, fill: given } = {}) {
  const fill = validFill(given) ? given : null;
  return modal("New refinement session", (close) => {
    if (!repos.length) {
      return h("div", { class: "stack" },
        h("p", { class: "muted" }, "You need a GitHub repository first. Add one under My repositories."),
        h("a", { href: "#/repos", onClick: () => close(undefined) }, "Go to My repositories"));
    }
    const was = kept ?? {};
    let current = fill || kind === "idea" ? "idea" : kind === "issue" ? "issue" : was.kind === "issue" ? "issue" : "idea";
    // a repository of the fill that is not in the list is never replaced by another one: the person must choose
    const missing = !!fill?.repo && !repos.some((r) => sameRepo(r, fill.repo));
    const select = h("select", { name: "repo" }, [...(missing ? [h("option", { value: "" }, "Choose a repository")] : []), ...repos.map((r) => h("option", { value: r }, r))]);
    select.value = missing ? "" : (fill?.repo ? repos.find((r) => sameRepo(r, fill.repo)) : undefined) ?? repos.find((r) => sameRepo(r, was.repo)) ?? repos.find((r) => sameRepo(r, preferred)) ?? repos[0];
    const title = h("input", { name: "title", placeholder: "The first line of the idea is used when empty.", autocomplete: "off" });
    const idea = h("textarea", { name: "idea", rows: 8, placeholder: "Describe your idea in your own words" });
    const issue = h("input", { name: "issue", inputmode: "numeric", autocomplete: "off", placeholder: "For example 12" });
    title.value = fill ? fill.title.slice(0, TITLE_MAX) : (was.title ?? "");
    idea.value = fill ? fill.text.slice(0, IDEA_MAX) : (was.idea ?? "");
    issue.value = was.issue ?? "";
    const radio = (value) => h("input", { type: "radio", name: "kind", value, checked: current === value });
    const ideaRadio = radio("idea");
    const issueRadio = radio("issue");
    const err = h("p", { class: "status bad flush" });
    const fields = h("div", { class: "stack" });
    const values = () => ({ repo: select.value, kind: current, title: title.value, idea: idea.value, issue: issue.value });
    // `wrote`: the revision of the kept text this dialog wrote. A dialog that wrote nothing clears nothing.
    let wrote = -1;
    let touched = false;
    const remember = () => {
      keep(values());
      wrote = revision;
    };
    const touch = () => {
      touched = true;
      remember();
    };
    const draw = () => {
      mount(fields, current === "issue"
        ? [h("label", { class: "field" }, h("span", {}, "Issue number"), issue),
          h("p", { class: "muted flush" }, "The issue is read from GitHub. Nothing on GitHub changes.")]
        : [h("label", { class: "field" }, h("span", {}, "Title (optional)"), title),
          h("label", { class: "field" }, h("span", {}, "Your idea"), idea)]);
    };
    const pick = (value) => () => {
      current = value;
      err.textContent = "";
      draw();
      touch();
    };
    ideaRadio.addEventListener("change", pick("idea"));
    issueRadio.addEventListener("change", pick("issue"));
    select.addEventListener("change", touch);
    for (const el of [title, idea, issue]) el.addEventListener("input", touch);
    draw();
    let busy = false;
    const run = async () => {
      if (busy) return;
      if (!fill || touched) remember();
      const input = values();
      const problem = sessionProblem(input);
      if (problem) return void (err.textContent = problem);
      busy = true;
      start.disabled = true;
      err.textContent = "";
      const sent = revision;
      try {
        const made = await api.createRefinement(sessionBody({ ...input, ...(fill ? { fromHelp: fill.fromHelp } : {}) }));
        // only the text this request was made from; newer text, here or in another dialog, stays
        if (revision === sent && wrote === sent) clearKeptSession();
        onMade?.(made); // also when the dialog was closed while the request ran
        close(made);
      } catch (e) {
        busy = false;
        err.textContent = errorText(e);
        start.disabled = false;
      }
    };
    const start = h("button", { class: "primary", onClick: run }, "Start session");
    queueMicrotask(() => (current === "issue" ? issue : idea).focus());
    return h("div", { class: "stack" },
      fill ? h("p", { class: "muted flush" }, FILL_NOTE) : null,
      h("label", { class: "field" }, h("span", {}, "Repository"), select),
      h("fieldset", {}, h("legend", {}, "What do you want to refine?"),
        h("label", { class: "choice" }, ideaRadio, h("b", {}, "An idea")),
        h("label", { class: "choice" }, issueRadio, h("b", {}, "An existing issue"))),
      fields, err, h("div", { class: "row" }, h("span", { class: "spacer" }), start));
  });
}

/** What the refinement page does with a wish: nothing without one; the palette's wish (`{}`) opens the empty dialog; Ask SCF's wish carries a fill. */
export function wishedSession(repos, onMade, wish) {
  if (!wish) return undefined;
  return newSessionDialog(repos, onMade, validFill(wish.fill) ? { fill: wish.fill } : {});
}

/** The line of a session that was started from the owner's Ask SCF conversation (the server sends `fromHelp` to the owner only). */
export function helpOrigin(s) {
  if (typeof s?.fromHelp !== "string" || !UUID.test(s.fromHelp)) return [];
  const open = document.getElementById("ask-btn");
  return [h("p", { class: "muted" }, "Started from one of your Ask SCF conversations. ",
    open ? h("button", { type: "button", class: "small", onClick: () => openAskConversation(s.fromHelp) }, "Open the conversation") : null)];
}
