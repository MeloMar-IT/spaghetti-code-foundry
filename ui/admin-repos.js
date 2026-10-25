import { api } from "./api.js";
import { fieldFor, h, modal, mount, showError, toast } from "./dom.js";
import { defaultGo } from "./filters.js";
import { plainError, renderRepos } from "./repos.js";
import { repoAttention } from "./repo-status.js";

const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const PATTERN_HINT = '"*" matches any text, ? one character.';

/** The request body for the settings: every setting is sent, trimmed; an empty one clears it. */
export function settingsBody(values = {}) {
  return {
    testCommand: String(values.testCommand ?? "").trim(),
    docs: lines(values.docs),
    protectedBranches: lines(values.protectedBranches),
    mainBranch: String(values.mainBranch ?? "").trim(),
    developBranch: String(values.developBranch ?? "").trim(),
    // not trimmed here: the server tidies the text, and an empty text clears it
    releaseRecipe: String(values.releaseRecipe ?? ""),
    // a missing value means on
    questions: { decide_technical: values.decideTechnical !== false },
  };
}

/** The owner as "Name (e-mail)", or "Unknown account" when the account is gone. */
export const ownerText = (repo) => (repo.account ? `${repo.account.name} (${repo.account.email})` : "Unknown account");

/** The list for the page: by owner e-mail, then by address. */
export const sortRepos = (repos) =>
  [...repos].sort((a, b) => (a.account?.email ?? "").localeCompare(b.account?.email ?? "") || String(a.url).localeCompare(String(b.url)));

const field = (label, el, hint) => h("label", { class: "field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);

/** Runs `send` for a dialog: shows the error in the dialog and enables the button again, or toasts and closes. Resolves when the dialog is closed. */
function sendFrom({ button, err, send, done, close, state, mark }) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  mark("");
  state.pending = (async () => {
    try {
      state.result = await send();
    } catch (e) {
      state.busy = false;
      if (state.closed) return toast(plainError(e), "error");
      mark(plainError(e));
      button.disabled = false;
      return;
    }
    toast(done);
    if (!state.closed) close(true);
  })();
}

const formShape = (s = {}) => ({
  ...s, docs: (s.docs ?? []).join("\n"), protectedBranches: (s.protectedBranches ?? []).join("\n"), decideTechnical: s.questions?.decide_technical !== false,
});
const CHECKS = new Set(["decideTechnical"]);

/**
 * Edits the settings of one repository. Resolves with the server's row once the dialog is closed after a save (else undefined).
 * `only` (setting keys) draws just those fields; Save then reads the other settings with `current()` (default: the repository's
 * own) so they are sent back unchanged, because the server replaces the whole object.
 */
export function settingsDialog(repo, { only, title = "Repository settings", current } = {}) {
  const s = repo.settings ?? {};
  const state = { busy: false, closed: false, pending: null, result: undefined };
  const shown = modal(title, (close) => {
    const all = {
      testCommand: h("input", { name: "testCommand", class: "mono", value: s.testCommand ?? "", autocomplete: "off", placeholder: "npm test" }),
      docs: h("textarea", { name: "docs", rows: 3, class: "mono", placeholder: "docs/CHANGELOG.md" }),
      protectedBranches: h("textarea", { name: "protectedBranches", rows: 3, class: "mono", placeholder: "release/*" }),
      mainBranch: h("input", { name: "mainBranch", class: "mono", value: s.mainBranch ?? "", placeholder: "main", autocomplete: "off" }),
      developBranch: h("input", { name: "developBranch", class: "mono", value: s.developBranch ?? "", placeholder: "develop", autocomplete: "off" }),
      releaseRecipe: h("textarea", { name: "releaseRecipe", rows: 12, class: "mono", spellcheck: "false", placeholder: "builds:\n  - name: …" }),
      decideTechnical: h("input", { type: "checkbox", name: "decideTechnical" }),
    };
    all.decideTechnical.checked = s.questions?.decide_technical !== false;
    all.releaseRecipe.value = s.releaseRecipe ?? "";
    all.docs.value = (s.docs ?? []).join("\n");
    all.protectedBranches.value = (s.protectedBranches ?? []).join("\n");
    const els = only ? Object.fromEntries(Object.entries(all).filter(([k]) => only.includes(k))) : all;
    const labels = {
      testCommand: ["Test command"], docs: ["Docs to update (one path per line)"], protectedBranches: ["Protected branches (one pattern per line)", PATTERN_HINT],
      mainBranch: ["Main branch"], developBranch: ["Develop branch"],
      releaseRecipe: ["Release-build recipe (YAML)", "Used by release-build when the commit has no .factory/release-build.yaml. A file in the repository wins."],
      decideTechnical: ["Decide technical questions itself", "The Foundry takes its own recommendation on technical questions and says so on the issue. Off: you are asked every question."],
    };
    const err = h("p", { class: "status bad flush", role: "alert" });
    const pairs = [
      [/^testCommand/, "testCommand"],
      [/^docs|path inside the repository/, "docs"],
      [/^protectedBranches|branch pattern/, "protectedBranches"],
      [/^mainBranch/, "mainBranch"],
      [/^developBranch/, "developBranch"],
      [/^releaseRecipe/, "releaseRecipe"],
      [/^questions/, "decideTechnical"],
    ];
    const mark = (m) => showError(err, m, { fields: Object.values(els), field: els[fieldFor(m, pairs)] });
    const typed = () => Object.fromEntries(Object.entries(els).map(([k, el]) => [k, CHECKS.has(k) ? el.checked === true : el.value]));
    const send = async () => {
      if (!only) return api.setRepoSettings(repo.id, settingsBody(typed()));
      const base = formShape(current ? await current() : s);
      return api.setRepoSettings(repo.id, settingsBody({ ...base, ...typed() }));
    };
    const save = h("button", { class: "primary", onClick: () => sendFrom({ button: save, err, mark, close, state, done: "Settings saved", send }) }, "Save");
    return h("div", { class: "stack" },
      h("p", { class: "mono" }, repo.url),
      Object.entries(els).map(([k, el]) => field(labels[k][0], el, labels[k][1])),
      only ? null : h("small", {}, 'Stored with the repository. Runs use the release-build recipe and "Decide technical questions itself"; the other settings not yet.'),
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
  shown.then(() => { state.closed = true; });
  return shown.then(() => state.pending).then(() => state.result);
}

/** The default Definition of Ready (the same ids and texts as the server's). */
export const READY_DEFAULTS = [
  { id: "value", text: "the value is clear (who and why)" },
  { id: "standalone", text: "it stands on its own or its dependencies are named" },
  { id: "checkable", text: "every acceptance criterion can be checked" },
  { id: "small", text: "it is small enough to build in one go" },
  { id: "no-open-questions", text: "there are no open questions" },
  { id: "out-of-scope", text: "it says what is out of scope" },
  { id: "no-plan", text: "it contains no implementation plan" },
];
const READY_MAX = 20;

/** The request body for the Definition of Ready: an item with an id keeps it, one without is new. */
export function readyBody(rows) {
  return { items: rows.map((r) => (r.id ? { id: r.id, text: String(r.text ?? "").trim() } : { text: String(r.text ?? "").trim() })) };
}

/** Edits the Definition of Ready of one repository. Resolves with the server's row once the dialog is closed after a save (else undefined). */
export function readyDialog(repo) {
  const state = { busy: false, closed: false, pending: null, result: undefined };
  const shown = modal("Definition of Ready", (close) => {
    let rows = (repo.ready?.items ?? READY_DEFAULTS).map((i) => ({ id: i.id, text: i.text }));
    let inputs = [];
    const list = h("div", { class: "stack tight" });
    const extra = h("div", { class: "row" });
    const err = h("p", { class: "status bad flush", role: "alert" });
    const mark = (m, field) => showError(err, m, { fields: inputs, field });
    const take = () => rows.forEach((r, i) => { r.text = inputs[i].value; });
    // every button: copy what was typed, change the rows, draw again
    const change = (fn) => () => {
      if (state.busy) return;
      take();
      fn();
      draw();
      mark("");
    };
    const move = (i, by) => change(() => rows.splice(i + by, 0, rows.splice(i, 1)[0]));
    const draw = () => {
      inputs = rows.map((r, i) => h("input", { name: "item", maxlength: 200, autocomplete: "off", "aria-label": `Item ${i + 1}`, value: r.text }));
      mount(list, rows.map((r, i) => h("div", { class: "row" },
        h("span", { class: "muted" }, `${i + 1}.`),
        inputs[i],
        h("button", { class: "small", disabled: i === 0, "aria-label": `Move item ${i + 1} up`, onClick: move(i, -1) }, "Up"),
        h("button", { class: "small", disabled: i === rows.length - 1, "aria-label": `Move item ${i + 1} down`, onClick: move(i, 1) }, "Down"),
        h("button", { class: "small danger", disabled: rows.length <= 1, "aria-label": `Remove item ${i + 1}`, onClick: change(() => rows.splice(i, 1)) }, "Remove"))));
      mount(extra,
        h("button", { class: "small", disabled: rows.length >= READY_MAX, onClick: change(() => rows.push({ text: "" })) }, "+ Add item"),
        READY_DEFAULTS.filter((d) => !rows.some((r) => r.id === d.id)).map((d) =>
          h("button", { class: "small", disabled: rows.length >= READY_MAX, onClick: change(() => rows.push({ id: d.id, text: d.text })) }, `Add back: ${d.text}`)));
    };
    draw();
    const back = h("button", { class: "small", onClick: () => {
      if (state.busy) return;
      rows = READY_DEFAULTS.map((d) => ({ ...d }));
      draw();
      mark("");
    } }, "Back to the default");
    const save = h("button", { class: "primary", onClick: () => {
      if (state.busy) return;
      take();
      const empty = rows.findIndex((r) => !String(r.text).trim());
      if (empty >= 0) return void mark("Fill in every item, or remove it.", inputs[empty]);
      sendFrom({ button: save, err, mark, close, state, done: "Definition of Ready saved", send: () => api.setRepoReady(repo.id, readyBody(rows)) });
    } }, "Save");
    return h("div", { class: "stack" },
      h("p", { class: "mono" }, repo.url),
      list, extra,
      h("div", { class: "row" }, back, h("small", {}, "Back to the default drops the items you added and your wording.")),
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
  shown.then(() => { state.closed = true; });
  return shown.then(() => state.pending).then(() => state.result);
}

/** Asks for the e-mail of the new owner. Resolves with the server's row once the dialog is closed after a transfer (else undefined). */
export function transferDialog(repo) {
  const state = { busy: false, closed: false, pending: null, result: undefined };
  const shown = modal("Transfer repository", (close) => {
    const email = h("input", { name: "email", type: "text", placeholder: "name@example.com", autocomplete: "off" });
    const err = h("p", { class: "status bad flush", role: "alert" });
    const mark = (m) => showError(err, m, { fields: [email], field: fieldFor(m, [[/e-mail/i, "email"]]) ? email : undefined });
    const note = repo.method === "github-token" || repo.method === "https-token"
      ? "The stored token is deleted. The new owner must set the authentication again. If the new owner is an admin, the repository uses the server's own access until then."
      : repo.method !== "none" ? "The sign-in of this repository stays with it." : null;
    const go = h("button", { class: "primary", onClick: () => {
      if (state.busy) return;
      const to = email.value.trim();
      if (!to) return void mark("Fill in the e-mail of the new owner.");
      sendFrom({ button: go, err, mark, close, state, done: "Repository transferred", send: () => api.transferRepo(repo.id, to) });
    } }, "Transfer");
    return h("div", { class: "stack" },
      h("p", { class: "mono" }, repo.url),
      h("p", {}, `Owner now: ${ownerText(repo)}`),
      field("E-mail of the new owner", email),
      note ? h("small", {}, note) : null,
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), go));
  });
  shown.then(() => { state.closed = true; });
  return shown.then(() => state.pending).then(() => state.result);
}

/** The owner cell of a row on the All list: the owner, and a pill when the account is blocked. */
const ownerCell = (repo) => [ownerText(repo), repo.account?.status === "blocked" ? [" ", h("span", { class: "pill" }, "blocked")] : null];

/**
 * What needs attention on a row of the All list: the usual states for the owner's role, then (when those are fine) a repository
 * missing from the owner's app list, then a watcher problem. A failed test or a missing sign-in comes first.
 */
export function allAttention(repo, { options } = {}) {
  const base = repoAttention(repo, { admin: repo.account?.role === "admin", options });
  if (base.level === "bad") return base;
  if (repo.offAppList) return { level: "bad", text: "Not on the app list", detail: "The owner may not use the GitHub App for this repository.", action: null };
  if (repo.watcherProblem) return { level: "warn", text: "Watcher problem", detail: repo.watcherProblem, action: null };
  return base;
}

/** The scope of the Repositories list for all accounts (an admin only). */
export const ALL_SCOPE = {
  id: "all", page: "all-repos", title: "Repositories", hint: "The repositories of all accounts", caption: "Repositories of all accounts",
  loading: "Loading the repositories", failed: "The repositories could not be loaded.", denied: "Only an admin can see the repositories of all accounts.",
  empty: "No repositories yet.", back: { href: "#/repos", label: "My repositories" }, own: false, load: () => api.allRepos(), ownerCell,
  attention: allAttention, asAdmin: (r) => r.account?.role === "admin", sort: sortRepos,
};

/** The admin page with the repositories of all accounts: the Repositories list with the All scope. Returns a cleanup. */
export function renderAllRepos(main, { query = {}, go = defaultGo } = {}) {
  return renderRepos(main, { admin: true, switcher: true, scope: ALL_SCOPE, query, go });
}

