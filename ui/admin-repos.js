import { api } from "./api.js";
import { fieldFor, h, modal, mount, showError, toast } from "./dom.js";
import { onWish, takeWish } from "./palette-data.js";
import { connectionStatus, focusRepoRow, methodLabel, plainError } from "./repos.js";

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
      await send();
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

/** Edits the settings of one repository. Resolves once the dialog is closed and any request has finished. */
export function settingsDialog(repo) {
  const s = repo.settings ?? {};
  const state = { busy: false, closed: false, pending: null };
  const shown = modal("Repository settings", (close) => {
    const els = {
      testCommand: h("input", { name: "testCommand", class: "mono", value: s.testCommand ?? "", autocomplete: "off", placeholder: "npm test" }),
      docs: h("textarea", { name: "docs", rows: 3, class: "mono", placeholder: "docs/CHANGELOG.md" }),
      protectedBranches: h("textarea", { name: "protectedBranches", rows: 3, class: "mono", placeholder: "release/*" }),
      mainBranch: h("input", { name: "mainBranch", class: "mono", value: s.mainBranch ?? "", placeholder: "main", autocomplete: "off" }),
      developBranch: h("input", { name: "developBranch", class: "mono", value: s.developBranch ?? "", placeholder: "develop", autocomplete: "off" }),
    };
    els.docs.value = (s.docs ?? []).join("\n");
    els.protectedBranches.value = (s.protectedBranches ?? []).join("\n");
    const err = h("p", { class: "status bad flush", role: "alert" });
    const pairs = [
      [/^testCommand/, "testCommand"],
      [/^docs|path inside the repository/, "docs"],
      [/^protectedBranches|branch pattern/, "protectedBranches"],
      [/^mainBranch/, "mainBranch"],
      [/^developBranch/, "developBranch"],
    ];
    const mark = (m) => showError(err, m, { fields: Object.values(els), field: els[fieldFor(m, pairs)] });
    const save = h("button", { class: "primary", onClick: () =>
      sendFrom({
        button: save, err, mark, close, state, done: "Settings saved",
        send: () => api.setRepoSettings(repo.id, settingsBody(Object.fromEntries(Object.entries(els).map(([k, el]) => [k, el.value])))),
      }) }, "Save");
    return h("div", { class: "stack" },
      h("p", { class: "mono" }, repo.url),
      field("Test command", els.testCommand),
      field("Docs to update (one path per line)", els.docs),
      field("Protected branches (one pattern per line)", els.protectedBranches, PATTERN_HINT),
      field("Main branch", els.mainBranch),
      field("Develop branch", els.developBranch),
      h("small", {}, "Stored with the repository. Runs do not use these settings yet."),
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
  shown.then(() => { state.closed = true; });
  return shown.then(() => state.pending);
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

/** Edits the Definition of Ready of one repository. Resolves once the dialog is closed and any request has finished. */
export function readyDialog(repo) {
  const state = { busy: false, closed: false, pending: null };
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
  return shown.then(() => state.pending);
}

/** Asks for the e-mail of the new owner. Resolves once the dialog is closed and any request has finished. */
export function transferDialog(repo) {
  const state = { busy: false, closed: false, pending: null };
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
  return shown.then(() => state.pending);
}

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
// The wish handler of the newest load of this page: a reload replaces it, leaving the page removes it.
let unwish = () => {};
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent(location.hash.split("/")[1] ?? "") === "all-repos";
  } catch {
    return false;
  }
};

/** The admin page with the repositories of all accounts. Returns a cleanup. */
export async function renderAllRepos(main) {
  const mine = ++generation;
  const repos = await api.allRepos();
  if (mine !== generation || !onPage()) return () => {};
  const reload = () => renderAllRepos(main).catch((e) => toast(plainError(e), "error"));
  const row = (repo) => h("tr", { "data-repo": repo.id },
    h("td", { class: "mono" }, repo.url),
    h("td", {}, ownerText(repo), repo.account?.status === "blocked" ? [" ", h("span", { class: "pill" }, "blocked")] : null),
    h("td", {}, methodLabel(repo, repo.account?.role === "admin"), repo.offAppList ? [" ", h("span", { class: "pill" }, "not on the app list")] : null),
    h("td", {}, h("span", { class: "pill" }, connectionStatus(repo))),
    h("td", {},
      h("button", { class: "small", onClick: async () => {
        await settingsDialog(repo);
        reload();
      } }, "Settings"), " ",
      h("button", { class: "small", onClick: async () => {
        await readyDialog(repo);
        reload();
      } }, "Definition of Ready"), " ",
      h("button", { class: "small", onClick: async () => {
        await transferDialog(repo);
        reload();
      } }, "Transfer")));
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Repositories"), h("span", { class: "muted" }, "The repositories of all accounts")),
    repos.length
      ? h("table", { class: "table" },
        h("caption", { class: "sr-only" }, "Repositories of all accounts"),
        h("thead", {}, h("tr", {}, ["Repository", "Owner", "Authentication", "Connection", h("span", { class: "sr-only" }, "Actions")].map((t) => h("th", { scope: "col" }, t)))),
        h("tbody", {}, sortRepos(repos).map(row)))
      : h("div", { class: "empty" }, "No repositories yet."));
  focusRepoRow(main, takeWish("all-repos")?.repo);
  unwish();
  unwish = onWish("all-repos", (w) => focusRepoRow(main, w?.repo));
  return () => {
    generation++;
    unwish();
  };
}
