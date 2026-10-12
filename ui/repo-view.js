import { api } from "./api.js";
import { h, mount, timeAgo } from "./dom.js";
import { splitHash } from "./filters.js";
import { card } from "./kit/display.js";
import { pageHeader, statusSummary } from "./kit/product.js";
import { repoAttention, repoName } from "./repo-status.js";
import {
  appBlock, connectionLines, connectionStatus, fillRuns, installLink, keyBlock, loadActiveRuns, loadFailed, methodLabel,
  newKey, readyView, remove, repoDialog, repoWebUrl, test,
} from "./repos.js";
import { loadingState, staleNote } from "./states.js";

export const NO_REPO = "No such repository.";

const BACK = { label: "My repositories", href: "#/repos" };

// Each render gets a number; an answer for an older render, or that arrives after the person left the page, is dropped.
let generation = 0;

const onRepo = (id) => {
  if (typeof location === "undefined") return true;
  try {
    const parts = splitHash(location.hash).path.split("/");
    return parts.length === 3 && parts[1] === "repos" && decodeURIComponent(parts[2] ?? "") === id;
  } catch {
    return false;
  }
};

const failedTest = (ctx) => !!ctx.testError || (ctx.repo.connection && !ctx.repo.connection.ok);

const pill = (att) => h("span", { class: att.level === "ok" ? "pill ok" : att.level === "warn" ? "pill locked" : "pill fail" }, att.text);

const testButton = (ctx, focus) =>
  h("button", { "data-action": "test", "data-focus": focus, onClick: ctx.act.test }, failedTest(ctx) ? "Test again" : "Test connection");

const authButton = (ctx, focus) =>
  h("button", { "data-action": "auth", "data-focus": focus, onClick: ctx.act.auth }, "Change authentication");

function nextAction(ctx) {
  const { att, readOnly, options, repo } = ctx;
  if (!att.action) return att.level === "ok" ? "Nothing to do" : (att.detail ?? att.text);
  if (readOnly) return att.text;
  if (att.action === "auth") return ctx.foreign ? att.text : authButton(ctx, `next-${repo.id}`);
  if (att.action === "install") return installLink(options) ?? testButton(ctx, `next-${repo.id}`);
  return testButton(ctx, `next-${repo.id}`);
}

function overview(ctx) {
  const { repo, att, readOnly, runs } = ctx;
  const webUrl = repoWebUrl(repo.url);
  const name = repoName(repo);
  const count = h("span", { "data-runs": repo.id });
  fillRuns(count, runs, repo);
  const added = repo.added ? new Date(repo.added) : null;
  const items = [
    { label: "Name", value: webUrl ? h("a", { class: "repo-link", href: webUrl, target: "_blank", rel: "noopener noreferrer" }, name) : name },
    { label: "Address", value: h("span", { class: "mono" }, repo.url) },
    { label: "State", value: h("span", {}, pill(att), att.detail ? [" ", h("span", { class: "muted" }, att.detail)] : null) },
    { label: "Next action", value: nextAction(ctx) },
    { label: "Active runs", value: count },
    { label: "Added", value: added && !Number.isNaN(added.getTime()) ? added.toLocaleDateString() : "—" },
  ];
  return [
    statusSummary({ label: "Overview", items }),
    readOnly ? null : h("div", { class: "row" }, h("button", { "data-action": "ready", onClick: ctx.act.ready }, "Definition of Ready")),
  ];
}

function connection(ctx) {
  const { repo, admin, readOnly, options } = ctx;
  const c = repo.connection;
  const items = [{ label: "Method", value: methodLabel(repo, admin) }];
  if (repo.username) items.push({ label: "User name", value: repo.username });
  const appGone = options && options.githubApp?.available !== true;
  return [
    statusSummary({ label: "Connection", items }),
    repo.method === "ssh-deploy-key" && repo.publicKey ? keyBlock(repo, { copy: !readOnly }) : null,
    repo.method === "github-app" && (!readOnly || appGone) ? appBlock(options) : null,
    h("div", { class: "field mt-6" },
      h("strong", {}, "Last test"),
      h("div", {},
        h("span", { class: c ? (c.ok ? "pill ok" : "pill fail") : "pill" }, connectionStatus(repo)),
        c ? [" ", h("span", { class: "muted", title: new Date(c.at).toLocaleString() }, `tested ${timeAgo(c.at)}`)] : null),
      connectionLines(repo, { all: true }).map((l) => h("div", { class: l.ok ? "status ok" : "status bad" }, l.text)),
      ctx.testError ? h("div", { class: "status bad" }, ctx.testError) : null),
    readOnly ? null : h("div", { class: "row" }, testButton(ctx), ctx.foreign ? null : authButton(ctx, `auth-${repo.id}`)),
  ];
}

function danger(ctx) {
  const { repo, readOnly } = ctx;
  const deployKey = repo.method === "ssh-deploy-key";
  if (readOnly) {
    return h("p", { class: "muted" }, deployKey ? "Generate a new key and Remove are not available in a read-only view." : "Remove is not available in a read-only view.");
  }
  if (ctx.foreign) return h("p", { class: "muted" }, "Only the owner can remove this repository or generate a new key.");
  return h("div", { class: "row" },
    deployKey ? h("button", { class: "danger", "data-action": "newKey", onClick: ctx.act.newKey }, "Generate a new key") : null,
    h("button", { class: "danger", "data-action": "remove", onClick: ctx.act.remove }, "Remove"));
}

/** The sections of the view, in order: { id, title, tone?, show(ctx), draw(ctx) }. "danger" stays last; new sections go before it. */
export const SECTIONS = [
  { id: "overview", title: "Overview", show: () => true, draw: overview },
  { id: "connection", title: "Connection", show: () => true, draw: connection },
  { id: "danger", title: "Dangerous actions", tone: "fail", show: () => true, draw: danger },
];

/** Where the record comes from: the signed-in account's own repositories. */
const OWN = { load: async (id) => ({ repo: (await api.repos()).find((r) => r.id === id) ?? null }) };

/**
 * The view of one repository (`#/repos/:id`). `onName` gets the name once loaded; `nav` changes the address.
 * `source.load(id)` resolves { repo, foreign?, extra?, back? } (`foreign`: another account's repository, so only what an
 * admin may do there is offered; `back`: { label, href }); the source may also have `foreign(repo)`, `back(repo)` and `keep` (record keys that the answer of the
 * authentication call, which lacks them, must not drop). `attention` says what needs attention. Returns a cleanup.
 */
export async function renderRepo(main, { id, admin = false, readOnly = false, onName, nav = (hash) => { location.hash = hash; }, sections = SECTIONS, source = OWN, attention = repoAttention } = {}) {
  const mine = ++generation;
  let seq = 0; // only the newest fetch draws
  const state = { repo: null, extra: undefined, options: undefined, at: null, stale: false, notice: null, testError: undefined, runs: undefined, pending: null };
  const live = () => mine === generation && onRepo(id);

  const fetchAll = async (n) => {
    const [loaded, methods] = await Promise.all([source.load(id), api.repoMethods().then((options) => ({ options }), () => ({}))]);
    if (n !== seq) return;
    Object.assign(state, { repo: loaded.repo ?? null, extra: loaded.extra, foreign: loaded.foreign, back: loaded.back, options: methods.options, at: new Date(), stale: false });
  };
  const loadRuns = (n) => {
    loadActiveRuns().then((runs) => {
      if (n !== seq || !live()) return;
      state.runs = runs;
      const el = main.querySelector("span[data-runs]");
      if (el && state.repo) fillRuns(el, runs, state.repo);
    });
  };
  const lock = () => {
    for (const b of main.querySelectorAll("button[data-action]")) b.disabled = !!state.pending;
  };
  // Only one action runs at a time: every action button is disabled while one is pending, also after a redraw.
  const once = (name, fn) => async (e) => {
    if (state.pending) return;
    state.pending = name;
    lock();
    try {
      await fn(e);
    } finally {
      state.pending = null;
      if (live()) lock();
    }
  };
  const reload = async () => {
    const n = ++seq;
    try {
      await fetchAll(n);
    } catch {
      if (n === seq) state.stale = true; // the page on screen stays
    }
    if (n === seq && live()) settle(n);
  };
  const settle = (n) => {
    if (state.repo) onName?.(repoName(state.repo));
    draw();
    if (state.repo) loadRuns(n);
  };

  const act = {
    test: once("test", (e) => {
      const btn = e.currentTarget;
      state.testError = undefined;
      return test(btn, state.repo, ({ connection: c, error }) => {
        if (c) state.repo = { ...state.repo, connection: c };
        if (error) state.testError = error;
        return reload();
      });
    }),
    auth: once("auth", async () => {
      await repoDialog({ admin, options: state.options, repo: state.repo });
      return reload();
    }),
    ready: once("ready", () => readyView(state.repo)),
    newKey: once("newKey", (e) => newKey(e.currentTarget, state.repo, ({ repo, error }) => {
      state.notice = error ? { text: error } : null;
      // the answer is the public record: keep the admin fields it lacks
      if (repo) state.repo = { ...Object.fromEntries((source.keep ?? []).filter((k) => k in state.repo).map((k) => [k, state.repo[k]])), ...repo };
      return reload();
    })),
    remove: once("remove", (e) => doRemove(e.currentTarget, false)),
  };
  const doRemove = (btn, again) => remove(btn, state.repo, ({ removed, error, retry }) => {
    if (removed) return live() ? nav("#/repos") : undefined;
    state.notice = { text: error, retry };
    if (live()) draw();
  }, { again });
  const retry = once("remove", (e) => doRemove(e.currentTarget, true));

  const notFound = () => h("div", { class: "empty" }, h("p", {}, NO_REPO), h("a", { href: "#/repos" }, "Back to My repositories"));
  const draw = () => {
    const repo = state.repo;
    if (!repo) return mount(main, notFound());
    const foreign = !!(state.foreign ?? source.foreign?.(repo));
    const asAdmin = foreign ? repo.account?.role === "admin" : admin;
    const att = attention(repo, { admin: asAdmin, options: state.options });
    const setRepo = (row) => { if (row?.id === state.repo?.id) state.repo = row; };
    const ctx = { repo, admin: asAdmin, readOnly, options: state.options, runs: state.runs, testError: state.testError, att, act, foreign, extra: state.extra, reload, once, setRepo };
    mount(main,
      pageHeader({ title: repoName(repo), back: state.back ?? source.back?.(repo) ?? BACK, meta: [pill(att)] }),
      state.stale ? staleNote(state.at, { failed: true, onRetry: reload }) : null,
      state.notice ? h("p", { class: "status bad", role: "alert" }, state.notice.text,
        state.notice.retry && !readOnly ? [" ", h("button", { class: "small", "data-action": "remove", onClick: retry }, "Try again")] : null) : null,
      sections.filter((s) => s.show(ctx)).map((s) => card({ title: s.title, tone: s.tone ?? "neutral", id: `repo-section-${s.id}` }, s.draw(ctx))));
    lock();
  };
  const load = async () => {
    if (live()) mount(main, loadingState("Loading the repository", { rows: 4, shape: "detail" }));
    const n = ++seq;
    try {
      await fetchAll(n);
    } catch (e) {
      if (n !== seq || !live()) return;
      return mount(main, loadFailed(e, { what: "The repository could not be loaded.", denied: "You are not allowed to see this repository.", onRetry: load, back: { href: "#/repos", label: "Back to My repositories" } }));
    }
    if (n === seq && live()) settle(n);
  };
  await load();
  return () => {
    if (generation === mine) generation++;
  };
}
