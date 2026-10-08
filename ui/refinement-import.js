import { api } from "./api.js";
import { h, modal, toast } from "./dom.js";

const MAX_ISSUE = 2147483647; // the server's limit

/** The issue number of what was typed ("12" or "#12"), or undefined. */
export function issueNumber(input) {
  const m = /^#?([1-9]\d{0,9})$/.exec(String(input ?? "").trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n <= MAX_ISSUE ? n : undefined;
}

/** What is missing in the input, or "" when it can be sent. */
export function importProblem({ repo, issue } = {}) {
  if (!String(repo ?? "").trim()) return "Choose a repository.";
  if (!String(issue ?? "").trim()) return "Give the issue number.";
  if (issueNumber(issue) === undefined) return "The issue number is a whole number from 1, for example 12.";
  return "";
}

/** The request body: { repo, issue: <number> }. */
export function importBody({ repo, issue }) {
  return { repo: String(repo ?? "").trim(), issue: issueNumber(issue) };
}

/** Asks for the repository and the issue number. Resolves with the new session, or undefined when closed. */
export function importDialog(repos, onMade, errorText) {
  return modal("Refine an existing issue", (close) => {
    if (!repos.length) {
      return h("div", { style: { display: "grid", gap: "12px" } },
        h("p", { class: "muted" }, "You need a GitHub repository first. Add one under My repositories."),
        h("a", { href: "#/repos", onClick: () => close(undefined) }, "Go to My repositories"));
    }
    const select = h("select", { name: "repo" }, repos.map((r) => h("option", { value: r }, r)));
    select.value = repos[0];
    const issue = h("input", { name: "issue", inputmode: "numeric", autocomplete: "off", placeholder: "For example 12" });
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    let busy = false;
    const run = async () => {
      if (busy) return;
      const input = { repo: select.value, issue: issue.value };
      const problem = importProblem(input);
      if (problem) return void (err.textContent = problem);
      busy = true;
      start.disabled = true;
      err.textContent = "";
      try {
        const made = await api.createRefinement(importBody(input));
        onMade?.(made); // also when the dialog was closed while the request ran
        close(made);
      } catch (e) {
        busy = false;
        err.textContent = errorText(e);
        start.disabled = false;
      }
    };
    const start = h("button", { class: "primary", onClick: run }, "Refine issue");
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("label", { class: "field" }, h("span", {}, "Repository"), select),
      h("label", { class: "field" }, h("span", {}, "Issue number"), issue),
      h("p", { class: "muted", style: { margin: 0 } }, "The issue is read from GitHub. Nothing on GitHub changes."),
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), start));
  });
}

/** "From issue #N" with its link, and the build-label warning. Returns nodes (an empty list without a source). */
export function sourceSection(s, { send }) {
  const src = s?.source;
  if (!src) return [];
  const label = `#${src.issue}`;
  const link = String(src.url ?? "").startsWith("https://")
    ? h("a", { href: src.url, target: "_blank", rel: "noopener noreferrer" }, label)
    : h("span", {}, label);
  const nodes = [h("p", { class: "muted" }, "From issue ", link)];
  if (src.buildLabel) {
    const canRemove = s.mine && s.state !== "dropped" && s.repoAvailable !== false;
    const button = canRemove
      ? h("button", { class: "small", onClick: async (e) => {
        const ok = await send(e.currentTarget, () => api.removeBuildLabel(s.id));
        if (ok) toast("Build label removed");
      } }, "Remove the build label")
      : null;
    nodes.push(h("p", { class: "status bad" }, `This issue has the build label "${src.buildLabel}". The Foundry may start building it while you refine it.`, " ", button));
  }
  return nodes;
}

/** The log lines of this part in words, or "". */
export function importLogText(entry) {
  const who = entry.who || "Someone";
  if (entry.what === "imported") return `${who} started the session from issue ${entry.detail ?? ""}`.trim();
  if (entry.what === "source-label-removed") return `${who} removed the build label${entry.detail ? ` "${entry.detail}"` : ""} from the issue`;
  return "";
}
