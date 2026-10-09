import { api } from "./api.js";
import { h, mount, toast } from "./dom.js";

/** The four quick checks, in the order of the columns. */
export const CHECKS = [
  ["criteria", "Acceptance criteria"],
  ["value", "Value sentence"],
  ["dependencies", "Depends on"],
  ["questions", "No open questions"],
];

/** One mark: ✓ or ✗, with the check in words for a screen reader and a tooltip. `missing` are the "Depends on" numbers that were not found. */
export function checkMark(ok, label, missing = []) {
  const said = `${label}: ${ok ? "yes" : "no"}${!ok && missing.length ? ` — not found: ${missing.map((n) => `#${n}`).join(", ")}` : ""}`;
  return h("span", { class: ok ? "status has-glyph" : "status bad has-glyph", title: said, "aria-label": said }, ok ? "✓" : "✗");
}

let chosen = ""; // the repository chosen last, kept while the person is on other pages
const SIGN_IN = "Check the repository's sign-in under My repositories.";

/** The "Backlog readiness" page: a repository chooser and the open issues of it with a mark per check. */
export async function renderBacklog(main, { repos, readOnly, errorText, current, goTo }) {
  const back = h("a", { href: "#/refinement" }, "← All sessions");
  const title = h("div", { class: "toolbar" }, h("h1", {}, "Backlog readiness"), h("span", { class: "muted" }, "Which open issues are not ready to be built"));
  if (readOnly) {
    mount(main, back, title, h("p", { class: "muted" }, "The backlog is read with the owner's GitHub sign-in, so it is not shown in a preview."));
    return () => {};
  }
  if (!repos.length) {
    mount(main, back, title,
      h("p", { class: "muted" }, "You need a GitHub repository first. Add one under My repositories."),
      h("a", { href: "#/repos" }, "Go to My repositories"));
    return () => {};
  }
  if (!repos.includes(chosen)) chosen = repos[0];
  const select = h("select", { name: "repo", "aria-label": "Repository" }, repos.map((r) => h("option", { value: r }, r)));
  select.value = chosen;
  const body = h("div");
  let loads = 0;
  let left = false;
  const live = (n) => !left && n === loads && current();

  const refine = async (btn, repo, issue) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const made = await api.createRefinement({ repo, issue });
      if (made?.id) {
        if (current()) goTo(`#/refinement/${encodeURIComponent(made.id)}`);
        else toast("Refinement session started");
        return;
      }
    } catch (e) {
      toast(errorText(e), "error");
    }
    btn.disabled = false;
    // A session that was started meanwhile shows "Open session" now.
    if (live(loads)) await load();
  };

  const row = (repo, i) => {
    const link = String(i.url ?? "").startsWith("https://")
      ? h("a", { href: i.url, target: "_blank", rel: "noopener noreferrer" }, `#${i.number}`)
      : h("span", {}, `#${i.number}`);
    const action = i.session
      ? h("a", { class: "button small", href: `#/refinement/${encodeURIComponent(i.session)}` }, "Open session")
      : h("button", { class: "small primary", onClick: (e) => refine(e.currentTarget, repo, i.number) }, "Refine");
    return h("tr", {},
      h("td", {}, link),
      h("td", {}, i.title),
      CHECKS.map(([key, label]) => h("td", {}, checkMark(i.checks?.[key] === true, label, key === "dependencies" ? [...(i.missing ?? []), ...(i.unmatched ?? [])] : []))),
      h("td", {}, action));
  };

  const draw = (answer) => {
    const list = answer.issues ?? [];
    mount(body,
      list.length
        ? h("div", { class: "table-box" }, h("table", { class: "table" },
          h("thead", {}, h("tr", {}, ["Issue", "Title", ...CHECKS.map(([, l]) => l), ""].map((t) => h("th", {}, t)))),
          h("tbody", {}, list.map((i) => row(answer.repo, i)))))
        : h("div", { class: "empty" }, "No open issues to refine here."),
      answer.cut ? h("p", { class: "muted" }, "GitHub returned a full page of 100 issues and pull requests, so older open issues may be missing.") : null);
  };

  const load = async () => {
    const n = ++loads;
    const repo = select.value;
    mount(body, h("div", { class: "row" }, h("span", { class: "spinner" }), h("span", { class: "muted" }, "Reading the issues on GitHub")));
    let answer;
    try {
      answer = await api.refinementBacklog(repo);
    } catch (e) {
      if (!live(n)) return;
      const said = errorText(e);
      mount(body, h("p", { class: "status bad" }, /sign-in/i.test(said) ? said : `${said} ${SIGN_IN}`), h("a", { href: "#/repos" }, "Go to My repositories"));
      return;
    }
    if (live(n)) draw(answer);
  };

  select.addEventListener("change", () => {
    chosen = select.value;
    load();
  });
  mount(main, back, title, h("label", { class: "field" }, h("span", {}, "Repository"), select), body);
  await load();
  return () => {
    left = true;
    loads++;
  };
}
