import { api } from "./api.js";
import { reposChanged } from "./context.js";
import { defaultGo, filterBar, filterGone, matchesRepo, splitHash, withQuery } from "./filters.js";
import { confirmDialog, h, modal, mount, table, timeAgo, toast } from "./dom.js";
import { repoDialog } from "./repo-connect.js";
import { onWish, takeWish } from "./palette-data.js";
import { FILTER_FROM, activeRuns, attentionCount, attentionSummary, matchesText, readCompact, repoAttention, repoName, sortByAttention, writeCompact } from "./repo-status.js";
import { safeStore } from "./shell.js";
import { banner, errorState, explainError, loadingState, permissionState, staleNote } from "./states.js";

export { repoDialog };

/**
 * The ways to sign in to a repository. A later method (the GitHub App) is another entry:
 * `fields` are the inputs to show; a `secret` field is never shown again, a `multiline` one is a textarea.
 * An `ssh` method needs an SSH address of the repository, an `https` one an https address.
 */
export const METHODS = [
  {
    id: "github-token",
    https: true,
    label: "GitHub fine-grained personal access token",
    help: [
      "Create a fine-grained personal access token on GitHub, limited to this repository.",
      'Repository permissions: Contents, Issues and Pull requests, each "Read and write".',
    ],
    fields: [{ key: "token", label: "Token", secret: true }],
  },
  {
    id: "https-token",
    https: true,
    label: "HTTPS user name + token",
    help: [
      "For other git hosts. Use your user name on that host and an access token, not your password.",
      "The token must be allowed to read and write the repository.",
    ],
    fields: [
      { key: "username", label: "User name" },
      { key: "token", label: "Token", secret: true },
    ],
  },
  {
    id: "ssh-deploy-key",
    label: "SSH deploy key",
    ssh: true,
    fields: [],
    help: [
      "The Foundry makes a key pair for this repository and shows you the public key.",
      "Add the public key in the settings of the repository as a deploy key with write access.",
      "Needs the SSH address of the repository (git@host:path or ssh://…).",
    ],
  },
  {
    id: "github-app",
    https: true,
    app: true,
    label: "GitHub App",
    fields: [],
    help: [
      "The Foundry signs in as the GitHub App the administrator set up. You need no personal token.",
      "First install the app on this repository with the link below (choose Only select repositories and pick this one).",
      "Then save here. The connection is tested right after you save.",
    ],
  },
  {
    id: "none",
    label: "The server's own access",
    help: ["The server uses its own access to this repository. No token is stored."],
    fields: [],
  },
];

/**
 * The methods an account may choose: only an admin may use the server's own access. With `options` (the answer of
 * `GET /api/repos/methods`) the entries it lists; without, the GitHub App is left out because it may not be set up.
 */
export const methodsFor = (admin, options) =>
  METHODS.filter((m) => (admin || m.id !== "none") && (Array.isArray(options?.methods) ? options.methods.includes(m.id) : m.id !== "github-app"));

/** The link to install the app, only when it is a github.com/apps/<name>/installations/new address; else "". */
export const appInstallUrl = (options) => {
  const url = options?.githubApp?.installUrl;
  return typeof url === "string" && /^https:\/\/github\.com\/apps\/[A-Za-z0-9-]+\/installations\/new$/.test(url) ? url : "";
};

/**
 * The page of a repository on GitHub for its https, `git@github.com:owner/name` or `ssh://git@github.com/owner/name`
 * address (with or without `.git`); "" for any other host or shape, so no link is made from text we do not understand.
 */
export function repoWebUrl(url) {
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(text(url).trim());
  return m && m[1] !== "." && m[1] !== ".." && m[2] !== "." && m[2] !== ".." ? `https://github.com/${m[1]}/${m[2]}` : "";
}

export const appAvailable = (options) => options?.githubApp?.available === true;

/** The link to install the app, or null. */
export const installLink = (options) => {
  const href = appInstallUrl(options);
  return href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, "Install the app on GitHub") : null;
};

/** How the repository signs in, in words. */
export function methodLabel(repo, admin) {
  const m = METHODS.find((x) => x.id === repo.method);
  if (!m) return String(repo.method);
  // "legacy" is the word for the method none: repositories of watchers that moved out of config.yaml have it
  if (m.id === "none") return admin ? `${m.label} (legacy)` : "Needs authentication";
  return m.id === "https-token" && repo.username ? `${m.label} (${repo.username})` : m.label;
}

export const DEPLOY_KEY_HINT =
  'Add this public key in the settings of the repository as a deploy key with write access (on GitHub: Settings → Deploy keys → Add deploy key, with "Allow write access").';

const text = (s) => String(s ?? "").trim();

/** True for an SSH address: ssh://… or git@host:path. */
export const isSshUrl = (url) => /^(ssh:\/\/|git@)/i.test(text(url));

/** Copies text to the clipboard. False when the browser has none (plain http) or refuses. */
export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** The connection status in a word: "Not tested yet", "Connected" or "Failed". */
export const connectionStatus = (repo) => (!repo?.connection ? "Not tested yet" : repo.connection.ok ? "Connected" : "Failed");

const CHECK_LABELS = { clone: "Read", push: "Write", "github-api": "GitHub API" };

/**
 * The lines of the last test as { ok, text } ("Read: the message"). A failed test shows every check; a good one only
 * the checks that were skipped (they say why something was not checked). With `all` every check is returned.
 */
export function connectionLines(repo, { all = false } = {}) {
  const c = repo?.connection;
  if (!c) return [];
  return c.checks
    .filter((x) => all || !c.ok || x.skipped)
    .map((x) => ({ ok: !!x.ok, text: `${CHECK_LABELS[x.check] ?? x.check}: ${x.message}` }));
}

/** What is wrong with the connection, for a row: null when nothing is. `error` is the text of a test that could not run. */
export function connectionProblem(repo, { error } = {}) {
  const failed = repo.connection && !repo.connection.ok;
  if (!failed && !error) return null;
  return h("div", { "data-state": "provider-failure" },
    failed ? h("strong", {}, "Connection failed") : null,
    failed ? connectionLines(repo).map((l) => h("div", { class: l.ok ? "status ok" : "status bad" }, l.text)) : null,
    error ? h("div", { class: "status bad" }, error) : null);
}

const connectionCell = (repo, extra = {}) => {
  const c = repo.connection;
  return h("td", {},
    h("span", { class: c ? (c.ok ? "pill ok" : "pill fail") : "pill" }, connectionStatus(repo)),
    c ? [" ", h("span", { class: "muted", title: new Date(c.at).toLocaleString() }, `tested ${timeAgo(c.at)}`)] : null,
    c?.ok ? connectionLines(repo).map((l) => h("div", { class: l.ok ? "status ok" : "status bad" }, l.text)) : null,
    connectionProblem(repo, extra));
};

export const methodOf = (methods, id) => methods.find((m) => m.id === id) ?? { id, fields: [] };

/** What is missing in the input, or "" when it can be sent. */
export const repoProblem = (x) => repoProblemAt(x).text;

/** Like repoProblem, with the control at fault: `{ text, field }`, `field` being "url" or the key of a method field. */
export function repoProblemAt({ url, method, values = {}, needUrl = true, needSecret = true, methods = METHODS }) {
  if (needUrl && !text(url)) return { text: "Fill in the repository URL.", field: "url" };
  for (const f of methodOf(methods, method).fields) {
    if (f.secret && !needSecret) continue;
    if (!text(values[f.key])) return { text: `Fill in the ${f.label.toLowerCase()}.`, field: f.key };
  }
  return { text: "", field: undefined };
}

/** The request body: only the fields of the chosen method, trimmed; an empty secret is left out. */
export function repoBody({ url, method, values = {}, withUrl = true, methods = METHODS }) {
  const body = withUrl ? { url: text(url), method } : { method };
  for (const f of methodOf(methods, method).fields) {
    const v = text(values[f.key]);
    if (v || !f.secret) body[f.key] = v;
  }
  return body;
}

/** The server's sentence for a failed call, with method ids written as their names. */
export function plainError(e) {
  if (e instanceof TypeError) return "Could not reach the server.";
  const message = e?.message || "Something went wrong.";
  return message.replace(/"([\w-]+)"/g, (all, id) => {
    const m = METHODS.find((x) => x.id === id);
    return m && id !== "none" ? m.label : all;
  });
}

/** plainError's sentence in the three parts errorState needs. */
export function explainRepoError(e, what) {
  return explainError({ status: e?.status, message: e instanceof TypeError || e?.message ? plainError(e) : "" }, { what });
}

/** The box for a list that could not be loaded: permissionState for a 403, else errorState with Retry. */
export function loadFailed(e, { what, denied, back, onRetry }) {
  return e?.status === 403 ? permissionState(denied, back) : errorState(explainRepoError(e, what), { onRetry, back });
}

/** The deploy-key repositories whose connection does not work yet (the follow-up after adding one). */
export const needsDeployKey = (repos) => repos.filter((r) => r.method === "ssh-deploy-key" && r.publicKey && !r.connection?.ok);

async function whileBusy(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}

/** Shows the Definition of Ready of a repository, read-only. An error is toasted and no dialog opens. */
export async function readyView(repo) {
  let ready;
  try {
    ready = await api.repoReady(repo.id);
  } catch (e) {
    return toast(plainError(e), "error");
  }
  return modal("Definition of Ready", () => h("div", { class: "stack" },
    h("p", { class: "mono" }, repo.url),
    h("ol", {}, (ready.items ?? []).map((i) => h("li", {}, i.text))),
    h("small", {}, ready.isDefault ? "The default list." : "Set by your administrator.")));
}

/** The address of the view of one repository. */
export const repoHref = (repo) => `#/repos/${encodeURIComponent(repo.id)}`;

/** The public key with Copy and the deploy-key hint. `copy: false` leaves the button out. */
export function keyBlock(repo, { copy = true } = {}) {
  const copyKey = async () => {
    if (await copyText(repo.publicKey)) toast("Public key copied");
    else toast("Could not copy. Select the key and copy it yourself.", "error");
  };
  return h("div", { class: "field mt-6 maxw-520" },
    h("span", {}, "Public key"),
    h("code", { class: "mono break-all select-all" }, repo.publicKey),
    copy ? h("button", { class: "small", onClick: copyKey }, "Copy") : null,
    h("small", {}, DEPLOY_KEY_HINT));
}

/** The install link with its hint, or the "administrator removed the GitHub App" line. `options` undefined: unknown, the hint is shown. */
export const appBlock = (options) => appAvailable(options) || !options
  ? h("div", { class: "field mt-6 maxw-520" },
    installLink(options),
    h("small", {}, "Install the app on this repository, or change which repositories it may use. Then press Test connection."))
  : h("div", { class: "status bad" }, "The administrator removed the GitHub App. Choose another authentication.");

/** What the Remove confirmation asks: { title, text, confirm } for confirmDialog. Names what the server deletes. */
export function removeQuestion(repo) {
  const byMethod = { "ssh-deploy-key": "Its stored key is deleted too.", "github-token": "Its stored token is deleted too.",
    "https-token": "Its stored token is deleted too.", "github-app": "The app stays installed on GitHub." };
  return {
    title: "Remove repository",
    text: [`Remove ${repo.url} from the Foundry? Its settings and its watchers are deleted.`, byMethod[repo.method], "The repository itself is not changed."].filter(Boolean).join(" "),
    confirm: "Remove",
  };
}

/** What the Generate a new key confirmation asks. */
export const newKeyQuestion = (repo) => ({
  title: "Generate a new key",
  text: `Generate a new key for ${repo.url}? The old key is deleted and stops working. Add the new public key as a deploy key and remove the old one.`,
  confirm: "Generate a new key",
});

/**
 * Runs the connection test with the button busy and "Testing…". Toasts the outcome, then awaits
 * apply({ connection }) (the answer has checks), apply({ error }) (the test could not run) or apply({}).
 */
export function test(btn, repo, apply) {
  const label = btn.textContent;
  btn.textContent = "Testing…";
  return whileBusy(btn, async () => {
    let result = {};
    try {
      const r = await api.testRepo(repo.id);
      if (Array.isArray(r?.checks)) result = { connection: r };
      if (r.ok) toast("Connection works");
      else toast("Connection failed", "error");
    } catch (err) {
      result = { error: explainRepoError(err, "The test could not run.").what };
      toast(plainError(err), "error");
    } finally {
      btn.textContent = label;
    }
    return apply(result);
  });
}

/** Asks, then makes a new key with the button busy. Cancelled: resolves without calling apply. apply({ repo }) or apply({ error }). */
export async function newKey(btn, repo, apply) {
  if (!(await confirmDialog(newKeyQuestion(repo)))) return;
  return whileBusy(btn, async () => {
    let made;
    try {
      made = await api.setRepoAuth(repo.id, { newKey: true });
    } catch (err) {
      // the client cannot tell whether a key was made, so there is no retry
      return apply({ error: plainError(err) });
    }
    toast("New key generated");
    return apply({ repo: made?.id === repo.id ? made : undefined });
  });
}

/**
 * Asks (not when `again`), then removes with the button busy. apply({ removed: true }) after the toast;
 * apply({ error, retry }) otherwise (`retry` is true for a 500). Cancelled: resolves without calling apply.
 */
export async function remove(btn, repo, apply, { again = false } = {}) {
  if (!again && !(await confirmDialog(removeQuestion(repo)))) return;
  return whileBusy(btn, async () => {
    try {
      await api.removeRepo(repo.id);
    } catch (e) {
      // a repeat that finds no repository: the first try removed it, and the old key is gone now
      if (!(again && e.status === 404)) {
        // a 500 comes from the cleanup after the record is gone: the switcher must not keep the repository
        if (e.status === 500) void reposChanged();
        return apply({ error: plainError(e), retry: e.status === 500 });
      }
    }
    void reposChanged();
    toast("Repository removed");
    return apply({ removed: true });
  });
}

const RUNS_CAP = 200; // GET /api/runs returns at most this many runs

/** Running and waiting runs, or null when they cannot be known (a failed call, or an answer at the cap of 200). */
export const loadActiveRuns = () =>
  // asked for by status, so the server's cap of 200 runs does not hide an old active run; an answer at the cap may be cut
  Promise.all(["running", "waiting"].map((s) => api.runsWithStatus(s)))
    .then(([a, b]) => (Array.isArray(a) && Array.isArray(b) && a.length < RUNS_CAP && b.length < RUNS_CAP ? [...a, ...b] : null), () => null);

/** Writes the Active runs value into `el`: the count, "—" with a title for null, "…" for undefined. */
export function fillRuns(el, runs, repo) {
  el.textContent = runs ? String(activeRuns(runs, repo)) : runs === null ? "—" : "…";
  if (runs === null) el.setAttribute("title", "The runs could not be loaded.");
  else el.removeAttribute("title");
}

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
// The wish handler of the newest load of this page: a reload replaces it, leaving the page removes it.
let unwish = () => {};
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent(splitHash(location.hash).path.split("/")[1] ?? "") === "repos";
  } catch {
    return false;
  }
};

/** Gives the row of repository `id` the focus and scrolls it into view; nothing happens when it is not listed. */
export function focusRepoRow(main, id) {
  const row = id ? [...main.querySelectorAll("tr[data-repo]")].find((r) => r.getAttribute("data-repo") === id) : null;
  if (!row) return;
  row.setAttribute("tabindex", "-1");
  row.scrollIntoView?.({ block: "center" });
  row.focus();
}

/** The My repositories page. `notice` ({ text }) is a message kept from the last removal. Returns a cleanup. */
export async function renderRepos(main, { admin = false, notice, readOnly = false, query = {}, go = defaultGo, store = safeStore() } = {}) {
  const mine = ++generation;
  let seq = 0; // only the newest fetch of this page draws
  // the filters live in the state, so a reload keeps them and a removed filter stays removed
  const state = { repos: [], options: undefined, methodsFailed: false, at: null, stale: false, notice, testErrors: new Map(), filters: query.repo ? { repo: query.repo } : {},
    runs: undefined, text: "", compact: readCompact(store) }; // runs: undefined while loading, null when they could not be loaded
  const live = () => mine === generation && onPage();
  const fetchAll = async (n) => {
    const [repos, methods] = await Promise.all([api.repos(), api.repoMethods().then((options) => ({ options }), () => ({ failed: true }))]);
    if (n !== seq) return;
    Object.assign(state, { repos, options: methods.options, methodsFailed: !!methods.failed, at: new Date(), stale: false });
  };
  // The runs load on their own: the page never waits for them, and a failed call only shows "—".
  const loadRuns = (n) => {
    loadActiveRuns().then((runs) => {
      if (n !== seq || !live()) return;
      state.runs = runs;
      for (const td of main.querySelectorAll("td[data-runs]")) {
        const repo = state.repos.find((r) => r.id === td.getAttribute("data-runs"));
        if (repo) fillRuns(td, runs, repo);
      }
    });
  };
  const reload = async (next) => {
    state.notice = next;
    const n = ++seq;
    try {
      await fetchAll(n);
    } catch {
      if (n === seq) state.stale = true; // the list on screen stays
    }
    if (n === seq && live()) {
      draw();
      loadRuns(n);
    }
  };
  const load= async () => {
    mount(main, head(false), loadingState("Loading your repositories", { rows: 3, shape: "table" }));
    const n = ++seq;
    try {
      await fetchAll(n);
    } catch (e) {
      if (n !== seq || !live()) return;
      return mount(main, head(false), loadFailed(e, { what: "Your repositories could not be loaded.", denied: "You are not allowed to see these repositories.", onRetry: load }));
    }
    if (n === seq && live()) {
      draw();
      loadRuns(n);
    }
  };
  const head= (canAdd) => h("div", { class: "toolbar" }, h("h1", {}, "My repositories"),
    h("span", { class: "muted" }, "The repositories you work in, and how the Foundry signs in to them"),
    h("span", { class: "spacer" }), canAdd ? h("button", { class: "primary", "data-focus": "add-toolbar", onClick: add }, "+ Add repository") : null);
  const add = async () => {
    const created = await repoDialog({ admin, options: state.options });
    if (created?.id && !state.repos.some((r) => r.id === created.id)) state.repos = [...state.repos, created];
    return reload();
  };
  const row = (repo) => {
    const testError = state.testErrors.get(repo.id);
    const failed = !!testError || (repo.connection && !repo.connection.ok);
    const webUrl = repoWebUrl(repo.url);
    const att = repoAttention(repo, { admin, options: state.options });
    const name = repoName(repo);
    const testBtn = h("button", { class: "small", onClick: (e) => {
      state.testErrors.delete(repo.id);
      return test(e.currentTarget, repo, ({ connection, error }) => {
        if (connection) state.repos = state.repos.map((x) => (x.id === repo.id ? { ...x, connection } : x));
        if (error) state.testErrors.set(repo.id, error);
        return reload(state.notice);
      });
    } }, failed ? "Test again" : "Test connection");
    const authBtn = h("button", { class: "small", "data-focus": `auth-${repo.id}`, onClick: async () => {
      await repoDialog({ admin, options: state.options, repo });
      reload();
    } }, "Change authentication");
    const link = att.action === "install" ? installLink(state.options) : null;
    // the one next action sits in the Next step cell and is left out of the Actions cell
    const promoted = att.action === "auth" ? authBtn : att.action === "test" || att.action === "install" ? (link ?? testBtn) : null;
    const runs = h("td", { "data-runs": repo.id });
    fillRuns(runs, state.runs, repo);
    return h("tr", { "data-repo": repo.id },
      h("td", { class: "mono repo-name", title: repo.url }, webUrl ? h("a", { class: "repo-link", href: webUrl, target: "_blank", rel: "noopener noreferrer" }, name) : name),
      h("td", {}, methodLabel(repo, admin)),
      connectionCell(repo, { error: testError }),
      runs,
      h("td", { class: "next-step" },
        h("span", { class: att.level === "ok" ? "pill ok" : att.level === "warn" ? "pill locked" : "pill fail" }, att.text),
        att.detail ? h("div", { class: "muted", title: att.detail }, att.detail) : null,
        !readOnly && promoted ? h("div", {}, promoted) : null),
      h("td", {}, h("a", { class: "btn small", href: repoHref(repo) }, "Open")));
  };
  const setFilters = (next) => {
    state.filters = next;
    go(withQuery("#/repos", next));
    draw();
  };
  const clear = () => setFilters({});
  const draw = () => {
    const canAdd = !readOnly && !state.methodsFailed;
    const pending = needsDeployKey(state.repos);
    const inContext = state.filters.repo ? state.repos.filter((r) => matchesRepo(r, state.filters.repo)) : state.repos;
    const ctx = { admin, options: state.options };
    const showFilter = state.repos.length >= FILTER_FROM;
    if (!showFilter) state.text = "";
    // only this part is drawn again while typing, so the search box keeps its caret
    const results = h("div", {});
    const drawResults = () => {
      const shown = sortByAttention(inContext.filter((r) => matchesText(r, state.text)), ctx);
      mount(results,
        shown.length
          ? table(["Repository", "Authentication", "Connection", "Active runs", "Next step", h("span", { class: "sr-only" }, "Actions")], shown.map(row),
            { cards: true, caption: "My repositories", class: state.compact ? "compact" : undefined })
          : inContext.length ? h("div", { class: "empty" }, "No repository matches the filter.")
          : state.filters.repo ? filterGone({ onClear: clear })
          : h("div", { class: "empty" }, "No repositories yet. Add the repository you work in.", canAdd ? h("div", {}, h("button", { class: "primary", "data-focus": "add-empty", onClick: add }, "+ Add repository")) : null));
    };
    drawResults();
    const filterInput = showFilter
      ? h("input", { type: "search", "aria-label": "Filter repositories", placeholder: "Filter by address", "data-focus": "repos-filter", value: state.text,
        onInput: () => { state.text = filterInput.value; drawResults(); } })
      : null;
    mount(main,
      head(canAdd),
      filterBar(state.filters, { onRemove: clear, onClear: clear }),
      state.stale ? staleNote(state.at, { failed: true, onRetry: () => reload(state.notice) }) : null,
      state.methodsFailed && !readOnly
        ? banner("warn", "The sign-in methods could not be loaded. You cannot add a repository now.", [{ label: "Retry", onClick: () => reload(state.notice) }])
        : null,
      pending.length
        ? banner("warn", `Open the repository to find its public key, add it as a deploy key with write access${readOnly ? "" : ", then press Test connection"}: ${pending.map((r) => r.url).join(", ")}`)
        : null,
      state.notice ? h("p", { class: "status bad", role: "alert" }, state.notice.text) : null,
      inContext.length
        ? h("div", { class: "row" },
          h("p", { class: "muted flush", "data-attention": String(attentionCount(inContext, ctx)) }, attentionSummary(attentionCount(inContext, ctx))),
          h("span", { class: "spacer" }),
          filterInput,
          h("label", {}, h("input", { type: "checkbox", "data-focus": "repos-compact", checked: state.compact,
            onChange: (e) => { state.compact = e.currentTarget.checked; writeCompact(store, state.compact); drawResults(); } }), " Compact rows"))
        : null,
      results);
  };
  // The palette's repository result: a wish that came before this page, or one for the page as it is.
  unwish();
  unwish = onWish("repos", (w) => focusRepoRow(main, w?.repo));
  await load();
  if (live()) focusRepoRow(main, takeWish("repos")?.repo);
  return () => {
    if (generation === mine) generation++;
    unwish();
  };
}
