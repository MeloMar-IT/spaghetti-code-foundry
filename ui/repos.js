import { api } from "./api.js";
import { defaultGo, filterBar, filterGone, matchesRepo, splitHash, withQuery } from "./filters.js";
import { confirmDialog, fieldFor, h, modal, mount, showError, timeAgo, toast } from "./dom.js";
import { banner, errorState, explainError, loadingState, permissionState, staleNote } from "./states.js";

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
      "Then save here, and press Test connection.",
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

const appAvailable = (options) => options?.githubApp?.available === true;

const installLink = (options) => {
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
 * the checks that were skipped (they say why something was not checked).
 */
export function connectionLines(repo) {
  const c = repo?.connection;
  if (!c) return [];
  return c.checks
    .filter((x) => !c.ok || x.skipped)
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

const methodOf = (methods, id) => methods.find((m) => m.id === id) ?? { id, fields: [] };

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

// Which control a server sentence is about (src/auth/repo-url.ts, src/server/api-repos.ts). The URL entry covers address errors and a duplicate, not quota ("at most N repositories").
const REPO_PAIRS = [
  [/GitHub App|may choose|authentication|method/i, "method"],
  [/address|host name|\bport\b|\bpath\b|transport|ssh form|you have that repository|^the repository (?:must|is empty)|repository is written/i, "url"],
  [/user name/i, "username"],
  [/token/i, "token"],
];

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

/**
 * Asks for the URL (when adding) and the method. Resolves once the dialog is closed and any request that
 * was started has finished; the caller then loads the list again. Resolves with the record the server made
 * when a repository was added (undefined otherwise).
 */
export function repoDialog({ admin = false, options, methods = methodsFor(admin, options), repo } = {}) {
  let pending = null;
  let created;
  let closed = false;
  const shown = modal(repo ? "Change authentication" : "Add repository", (close) => {
    const HTTPS_EXAMPLE = "https://github.com/owner/name";
    const SSH_EXAMPLE = "git@github.com:owner/name.git";
    const urlInput = repo ? null : h("input", { name: "url", class: "mono", placeholder: HTTPS_EXAMPLE, autocomplete: "off" });
    const initial = methods.some((m) => m.id === repo?.method) ? repo.method : methods[0].id;
    const select = h("select", { name: "method" }, methods.map((m) => h("option", { value: m.id }, m.label)));
    select.value = initial;
    const values = repo ? { ...repo } : {};
    delete values.token;
    // the address of the record is not a field value; the SSH address input starts empty
    delete values.url;
    let els = {};
    const area = h("div", { class: "stack" });
    const err = h("p", { class: "status bad flush", role: "alert" });
    const controls = () => ({ ...(urlInput ? { url: urlInput } : {}), ...els, method: select });
    const fail = (m, key) => showError(err, m, { fields: Object.values(controls()), field: controls()[key ?? fieldFor(m, REPO_PAIRS)] });
    const draw = () => {
      const m = methodOf(methods, select.value);
      els = {};
      if (urlInput) urlInput.setAttribute("placeholder", m.ssh ? SSH_EXAMPLE : HTTPS_EXAMPLE);
      // a method whose address form differs from the stored one needs the other form of the address
      const toSsh = repo && m.ssh && !isSshUrl(repo.url);
      const toHttps = repo && m.https && isSshUrl(repo.url);
      if (toSsh || toHttps) {
        els.url = h("input", { name: "url", class: "mono", placeholder: toSsh ? SSH_EXAMPLE : HTTPS_EXAMPLE, autocomplete: "off", value: values.url ?? "" });
      }
      mount(area,
        h("div", { class: "field" }, (m.help ?? []).map((t) => h("small", {}, t)), m.app ? installLink(options) : null),
        els.url ? h("label", { class: "field" }, h("span", {}, toSsh ? "SSH address" : "HTTPS address"), els.url) : null,
        m.fields.map((f) => {
          const attrs = { name: f.key, autocomplete: f.secret ? "new-password" : "off" };
          els[f.key] = f.multiline
            ? h("textarea", { ...attrs, rows: 5, class: "mono" })
            : h("input", { ...attrs, type: f.secret ? "password" : "text", value: f.secret ? "" : values[f.key] ?? "" });
          return h("label", { class: "field" }, h("span", {}, f.label), els[f.key]);
        }));
    };
    const read = () => Object.fromEntries(Object.entries(els).map(([k, el]) => [k, el.value]));
    select.addEventListener("change", () => {
      // keep what was typed in plain fields; a secret is not carried over to another method
      for (const [k, v] of Object.entries(read())) if (!methods.some((m) => m.fields.some((f) => f.key === k && f.secret))) values[k] = v;
      draw();
      fail("");
    });
    draw();

    let busy = false;
    const run = () => {
      if (busy) return;
      const method = select.value;
      const v = read();
      const withUrl = !repo || !!els.url;
      const input = { url: els.url ? v.url : urlInput?.value, method, values: v, methods };
      const needSecret = !repo || method !== repo.method;
      const problem = repoProblemAt({ ...input, needUrl: withUrl, needSecret });
      if (problem.text) return void fail(problem.text, problem.field);
      const body = repoBody({ ...input, withUrl });
      if (repo) {
        const same = method === repo.method && Object.entries(body).every(([k, x]) => k === "method" || (k !== "token" && x === repo[k]));
        if (same) return close(true);
      }
      busy = true;
      save.disabled = true;
      fail("");
      pending = (async () => {
        try {
          if (repo) await api.setRepoAuth(repo.id, body);
          else created = await api.addRepo(body);
        } catch (e) {
          busy = false;
          if (closed) return toast(plainError(e), "error");
          fail(plainError(e));
          save.disabled = false;
          return;
        }
        toast(repo ? "Authentication changed" : "Repository added");
        if (!closed) close(true);
      })();
    };
    const save = h("button", { class: "primary", onClick: run }, repo ? "Save" : "Add repository");
    return h("div", { class: "stack" },
      repo ? h("p", { class: "mono" }, repo.url) : h("label", { class: "field" }, h("span", {}, "Repository URL"), urlInput),
      h("label", { class: "field" }, h("span", {}, "Authentication"), select),
      options && !appAvailable(options) ? h("small", {}, "GitHub App is not available: the administrator has not set up the app (Settings → GitHub App).") : null,
      area, err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
  shown.then(() => { closed = true; });
  return shown.then(() => pending).then(() => created);
}

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

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent(splitHash(location.hash).path.split("/")[1] ?? "") === "repos";
  } catch {
    return false;
  }
};

/** The My repositories page. `notice` ({ text, retryId }) is a message kept from the last removal. Returns a cleanup. */
export async function renderRepos(main, { admin = false, notice, readOnly = false, query = {}, go = defaultGo } = {}) {
  const mine = ++generation;
  let seq = 0; // only the newest fetch of this page draws
  // the filters live in the state, so a reload keeps them and a removed filter stays removed
  const state = { repos: [], options: undefined, methodsFailed: false, at: null, stale: false, notice, testErrors: new Map(), filters: query.repo ? { repo: query.repo } : {} };
  const live = () => mine === generation && onPage();
  const fetchAll = async (n) => {
    const [repos, methods] = await Promise.all([api.repos(), api.repoMethods().then((options) => ({ options }), () => ({ failed: true }))]);
    if (n !== seq) return;
    Object.assign(state, { repos, options: methods.options, methodsFailed: !!methods.failed, at: new Date(), stale: false });
  };
  const reload = async (next) => {
    state.notice = next;
    const n = ++seq;
    try {
      await fetchAll(n);
    } catch {
      if (n === seq) state.stale = true; // the list on screen stays
    }
    if (n === seq && live()) draw();
  };
  const load = async () => {
    mount(main, head(false), loadingState("Loading your repositories", { rows: 3, shape: "table" }));
    const n = ++seq;
    try {
      await fetchAll(n);
    } catch (e) {
      if (n !== seq || !live()) return;
      return mount(main, head(false), loadFailed(e, { what: "Your repositories could not be loaded.", denied: "You are not allowed to see these repositories.", onRetry: load }));
    }
    if (n === seq && live()) draw();
  };
  const head = (canAdd) => h("div", { class: "toolbar" }, h("h1", {}, "My repositories"),
    h("span", { class: "muted" }, "The repositories you work in, and how the Foundry signs in to them"),
    h("span", { class: "spacer" }), canAdd ? h("button", { class: "primary", "data-focus": "add-toolbar", onClick: add }, "+ Add repository") : null);
  const remove = async (id, again = false) => {
    try {
      await api.removeRepo(id);
    } catch (e) {
      // a repeat that finds no repository: the first try removed it, and the old key is gone now
      if (!(again && e.status === 404)) return reload({ text: plainError(e), retryId: e.status === 500 ? id : undefined });
    }
    state.repos = state.repos.filter((r) => r.id !== id);
    toast("Repository removed");
    return reload();
  };
  const add = async () => {
    const created = await repoDialog({ admin, options: state.options });
    if (created?.id && !state.repos.some((r) => r.id === created.id)) state.repos = [...state.repos, created];
    return reload();
  };
  const copy = async (value) => {
    if (await copyText(value)) toast("Public key copied");
    else toast("Could not copy. Select the key and copy it yourself.", "error");
  };
  const newKey = async (e, repo) => {
    const btn = e.currentTarget;
    if (!(await confirmDialog({
      title: "Generate a new key",
      text: `Generate a new key for ${repo.url}? The old key stops working. Add the new public key as a deploy key and remove the old one.`,
      confirm: "Generate a new key",
    }))) return;
    return whileBusy(btn, async () => {
      try {
        const made = await api.setRepoAuth(repo.id, { newKey: true });
        if (made?.id === repo.id) state.repos = state.repos.map((r) => (r.id === repo.id ? made : r));
      } catch (err) {
        // the client cannot tell whether a key was made, so there is no retry button
        return reload({ text: plainError(err) });
      }
      toast("New key generated");
      return reload();
    });
  };
  const test = (e, repo) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.textContent = "Testing…";
    state.testErrors.delete(repo.id);
    return whileBusy(btn, async () => {
      try {
        const r = await api.testRepo(repo.id);
        if (Array.isArray(r?.checks)) state.repos = state.repos.map((x) => (x.id === repo.id ? { ...x, connection: r } : x));
        if (r.ok) toast("Connection works");
        else toast("Connection failed", "error");
      } catch (err) {
        state.testErrors.set(repo.id, explainRepoError(err, "The test could not run.").what);
        toast(plainError(err), "error");
      } finally {
        btn.textContent = label;
      }
      return reload(state.notice);
    });
  };
  const keyBlock = (repo) => h("div", { class: "field mt-6 maxw-520" },
    h("span", {}, "Public key"),
    h("code", { class: "mono break-all select-all" }, repo.publicKey),
    h("button", { class: "small", onClick: () => copy(repo.publicKey) }, "Copy"),
    h("small", {}, DEPLOY_KEY_HINT));
  const appBlock = () => appAvailable(state.options) || !state.options
    ? h("div", { class: "field mt-6 maxw-520" },
      installLink(state.options),
      h("small", {}, "Install the app on this repository, or change which repositories it may use. Then press Test connection."))
    : h("div", { class: "status bad" }, "The administrator removed the GitHub App. Choose another authentication.");
  const row = (repo) => {
    const testError = state.testErrors.get(repo.id);
    const failed = !!testError || (repo.connection && !repo.connection.ok);
    return h("tr", {},
      h("td", { class: "mono" }, repo.url),
      h("td", {}, methodLabel(repo, admin),
        repo.method === "ssh-deploy-key" && repo.publicKey ? keyBlock(repo) : null,
        repo.method === "github-app" ? appBlock() : null),
      connectionCell(repo, { error: testError }),
      readOnly ? h("td", {}) : h("td", {},
        h("button", { class: "small", onClick: (e) => test(e, repo) }, failed ? "Test again" : "Test connection"), " ",
        h("button", { class: "small", "data-focus": `auth-${repo.id}`, onClick: async () => {
          await repoDialog({ admin, options: state.options, repo });
          reload();
        } }, "Change authentication"), " ",
        h("button", { class: "small", onClick: (e) => whileBusy(e.currentTarget, () => readyView(repo)) }, "Definition of Ready"), " ",
        repo.method === "ssh-deploy-key" ? [h("button", { class: "small", onClick: (e) => newKey(e, repo) }, "Generate a new key"), " "] : null,
        h("button", { class: "small danger", onClick: async (e) => {
          const btn = e.currentTarget;
          if (!(await confirmDialog({
            title: "Remove repository",
            text: `Remove ${repo.url}? ${repo.method === "ssh-deploy-key" ? "Its stored key is deleted too." : repo.method === "github-app" ? "The app stays installed on GitHub." : "Its stored token is deleted too."}`,
            confirm: "Remove",
          }))) return;
          return whileBusy(btn, () => remove(repo.id));
        } }, "Remove")));
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
    const shown = state.filters.repo ? state.repos.filter((r) => matchesRepo(r, state.filters.repo)) : state.repos;
    mount(main,
      head(canAdd),
      filterBar(state.filters, { onRemove: clear, onClear: clear }),
      state.stale ? staleNote(state.at, { failed: true, onRetry: () => reload(state.notice) }) : null,
      state.methodsFailed && !readOnly
        ? banner("warn", "The sign-in methods could not be loaded. You cannot add a repository now.", [{ label: "Retry", onClick: () => reload(state.notice) }])
        : null,
      pending.length
        ? banner("warn", `Add the public key as a deploy key with write access${readOnly ? "" : ", then press Test connection"}: ${pending.map((r) => r.url).join(", ")}`)
        : null,
      state.notice ? h("p", { class: "status bad", role: "alert" }, state.notice.text,
        state.notice.retryId ? [" ", h("button", { class: "small", onClick: (e) => {
          const btn = e.currentTarget;
          return whileBusy(btn, () => remove(state.notice.retryId, true));
        } }, "Try again")] : null) : null,
      shown.length
        ? h("div", { class: "table-box" }, h("table", { class: "table" },
          h("caption", { class: "sr-only" }, "My repositories"),
          h("thead", {}, h("tr", {}, ["Repository", "Authentication", "Connection", h("span", { class: "sr-only" }, "Actions")].map((t) => h("th", { scope: "col" }, t)))),
          h("tbody", {}, shown.map(row))))
        : state.filters.repo ? filterGone({ onClear: clear })
        : h("div", { class: "empty" }, "No repositories yet. Add the repository you work in.", canAdd ? h("div", {}, h("button", { class: "primary", "data-focus": "add-empty", onClick: add }, "+ Add repository")) : null));
  };
  await load();
  return () => {
    if (generation === mine) generation++;
  };
}
