// The "New refinement session" form: an idea or an existing issue. What was typed is kept in page memory
// (never on disk) until the session is made. Must not import refinement.js.
import { api } from "./api.js";
import { errorText } from "./auth.js";
import { h, modal, mount } from "./dom.js";
import { sameRepo } from "./filters.js";
import { issueNumber } from "./refinement-import.js";

export const NEED_ISSUE = "Give the issue number.";

const text = (s) => String(s ?? "").trim();

/** What is missing in the input, or "" when it can be sent. kind: "idea" (default) or "issue". */
export function sessionProblem({ repo, idea, issue, kind } = {}) {
  if (!text(repo)) return "Choose a repository.";
  if (kind === "issue") return issueNumber(issue) === undefined ? NEED_ISSUE : "";
  if (!text(idea)) return "Describe your idea.";
  return "";
}

/** The request body. An idea: { repo, idea, title? }. An issue: { repo, issue } and nothing else. */
export function sessionBody({ repo, idea, title, issue, kind }) {
  if (kind === "issue") return { repo: text(repo), issue: issueNumber(issue) };
  const body = { repo: text(repo), idea: String(idea ?? "") };
  if (text(title)) body.title = text(title);
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

/** Asks for the repository and an idea or an issue. Resolves with the new session, or undefined when closed. `kind` wins over the kept kind; `preferred` is the filtered repository. */
export function newSessionDialog(repos, onMade, { kind, preferred } = {}) {
  return modal("New refinement session", (close) => {
    if (!repos.length) {
      return h("div", { class: "stack" },
        h("p", { class: "muted" }, "You need a GitHub repository first. Add one under My repositories."),
        h("a", { href: "#/repos", onClick: () => close(undefined) }, "Go to My repositories"));
    }
    const was = kept ?? {};
    let current = kind === "issue" || kind === "idea" ? kind : was.kind === "issue" ? "issue" : "idea";
    const select = h("select", { name: "repo" }, repos.map((r) => h("option", { value: r }, r)));
    select.value = repos.find((r) => sameRepo(r, was.repo)) ?? repos.find((r) => sameRepo(r, preferred)) ?? repos[0];
    const title = h("input", { name: "title", placeholder: "The first line of the idea is used when empty.", autocomplete: "off" });
    const idea = h("textarea", { name: "idea", rows: 8, placeholder: "Describe your idea in your own words" });
    const issue = h("input", { name: "issue", inputmode: "numeric", autocomplete: "off", placeholder: "For example 12" });
    title.value = was.title ?? "";
    idea.value = was.idea ?? "";
    issue.value = was.issue ?? "";
    const radio = (value) => h("input", { type: "radio", name: "kind", value, checked: current === value });
    const ideaRadio = radio("idea");
    const issueRadio = radio("issue");
    const err = h("p", { class: "status bad flush" });
    const fields = h("div", { class: "stack" });
    const values = () => ({ repo: select.value, kind: current, title: title.value, idea: idea.value, issue: issue.value });
    const remember = () => keep(values());
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
      remember();
    };
    ideaRadio.addEventListener("change", pick("idea"));
    issueRadio.addEventListener("change", pick("issue"));
    select.addEventListener("change", remember);
    for (const el of [title, idea, issue]) el.addEventListener("input", remember);
    draw();
    let busy = false;
    const run = async () => {
      if (busy) return;
      remember();
      const input = values();
      const problem = sessionProblem(input);
      if (problem) return void (err.textContent = problem);
      busy = true;
      start.disabled = true;
      err.textContent = "";
      const sent = revision;
      try {
        const made = await api.createRefinement(sessionBody(input));
        // only the text this request was made from; newer text, here or in another dialog, stays
        if (revision === sent) clearKeptSession();
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
      h("label", { class: "field" }, h("span", {}, "Repository"), select),
      h("fieldset", {}, h("legend", {}, "What do you want to refine?"),
        h("label", { class: "choice" }, ideaRadio, h("b", {}, "An idea")),
        h("label", { class: "choice" }, issueRadio, h("b", {}, "An existing issue"))),
      fields, err, h("div", { class: "row" }, h("span", { class: "spacer" }), start));
  });
}
