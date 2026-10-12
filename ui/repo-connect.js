import { api } from "./api.js";
import { reposChanged } from "./context.js";
import { fieldFor, h, modal, mount, showError, toast } from "./dom.js";
import { METHODS, appAvailable, connectionLines, installLink, isSshUrl, keyBlock, methodLabel, methodOf, methodsFor, plainError, repoBody, repoProblemAt } from "./repos.js";

export const TOKEN_STORED = "A token is stored. It is never shown again.";
export const NONE_REASON = "The server's own access is not tested here. Use Test connection on the repository page.";

// Which control a server sentence is about (src/auth/repo-url.ts, src/server/api-repos.ts). The URL entry covers address errors and a duplicate, not quota ("at most N repositories").
const REPO_PAIRS = [
  [/GitHub App|may choose|authentication|method/i, "method"],
  [/address|host name|\bport\b|\bpath\b|transport|ssh form|you have that repository|^the repository (?:must|is empty)|repository is written/i, "url"],
  [/user name/i, "username"],
  [/token/i, "token"],
];

const HTTPS_EXAMPLE = "https://github.com/owner/name";
const SSH_EXAMPLE = "git@github.com:owner/name.git";

/** True when the method keeps a secret (a field with `secret`). */
export const storesToken = (method, methods = METHODS) => methodOf(methods, method).fields.some((f) => f.secret);

/** True when a failed save may have changed the record: no status (network) or status >= 500. */
export const saveUnknown = (e) => !e?.status || e.status >= 500;

/** The sentences of the confirm step for PUT body `body` on record `repo`. `unsure`: the last save may not have finished. `unread`: the record could not be read again. */
export function replaceLines(repo, body, { methods = METHODS, unsure = false, unread = false } = {}) {
  const changed = body.method !== repo.method;
  const lines = [`Change the sign-in of ${repo.url}?`];
  if (unsure) lines.push("The last change may not have finished.");
  if (unread) lines.push("What is stored now is not known. It is replaced by this sign-in.");
  else if (storesToken(repo.method, methods)) {
    lines.push(changed ? "The stored token is deleted." : body.token ? "The stored token is replaced by the new one." : "The stored token is kept.");
  } else if (!changed) lines.push("The method stays the same; the server repairs what is missing.");
  else if (repo.method === "ssh-deploy-key") lines.push("The stored deploy key is deleted and stops working. Remove it from the deploy keys of the repository.");
  else if (repo.method === "github-app") lines.push("The link to the app installation is removed. The app stays installed on GitHub.");
  else if (repo.method === "none") lines.push("No sign-in is stored for this repository now.");
  if (body.method === "ssh-deploy-key" && changed) lines.push("A new key is made. You add its public key to the repository as a deploy key.");
  if (body.url) lines.push(`The address changes to ${body.url}.`);
  lines.push("Watchers of this repository may stop until the new sign-in works.");
  return lines;
}

/** The verification in one shape: { state, title, lines, reason?, retry? }. */
export function verdict({ method, connection, error } = {}) {
  if (method === "none") return { state: "unverified", title: "Not verified", reason: NONE_REASON, lines: [], retry: false };
  if (connection) {
    return { state: connection.ok ? "ok" : "failed", title: connection.ok ? "Connected" : "Verification failed", lines: connectionLines({ connection }, { all: true }) };
  }
  return { state: "unverified", title: "Not verified", reason: error, lines: [] };
}

/** The read-back node: address, method, user name, key block, token sentence, checks. No secret. */
export function readBack(record, v, { admin = false, methods = METHODS } = {}) {
  return h("div", { class: "stack" },
    h("p", {}, h("span", { class: v.state === "ok" ? "pill ok" : v.state === "failed" ? "pill fail" : "pill" }, v.title)),
    v.reason ? h("p", { class: "status bad" }, v.reason) : null,
    h("p", { class: "mono" }, record.url),
    h("p", {}, methodLabel(record, admin)),
    record.publicKey ? keyBlock(record) : null,
    storesToken(record.method, methods) ? h("p", {}, TOKEN_STORED) : null,
    v.lines.length ? h("div", { class: "checks" }, v.lines.map((l) => h("div", { class: l.ok ? "status ok" : "status bad" }, l.text))) : null);
}

const withoutConnection = (record) => {
  const { connection, ...rest } = record ?? {};
  void connection;
  return rest;
};

/**
 * Guides the sign-in of a repository: address, then method and details, then save, an automatic connection test and a
 * read-back of what is stored. Change authentication asks to confirm before it replaces a sign-in. Resolves once the
 * dialog is closed and any request that was started has finished; the caller then loads the list again. Resolves with
 * the record (with `connection` when the last test of the sign-in answered) when the dialog started as an add, else undefined.
 */
export function repoDialog({ admin = false, options, methods = methodsFor(admin, options), repo } = {}) {
  const started = repo ? "change" : "add";
  let current = repo ? { ...repo } : null;
  let busy = false;
  let pending = Promise.resolve();
  let unsure = false;
  let unread = false;
  let resultShown = false;
  let shownVerdict = null;
  let firstNext = true;
  let drawnOther = "";
  let els = {};
  let closeDialog = () => {};
  const mode = () => (current?.id ? "change" : "add");
  const isSecret = (k) => methods.some((m) => m.fields.some((f) => f.key === k && f.secret));
  const fresh = (record) => {
    const v = { ...record };
    delete v.token;
    // the address of the record is not a field value; the SSH address input starts empty
    delete v.url;
    return v;
  };
  let values = fresh(current);

  const body = h("div", { class: "stack" });
  const urlInput = h("input", { name: "url", class: "mono", placeholder: HTTPS_EXAMPLE, autocomplete: "off" });
  const addrErr = h("p", { class: "status bad flush", role: "alert" });
  const select = h("select", { name: "method" }, methods.map((m) => h("option", { value: m.id }, m.label)));
  select.value = methods.some((m) => m.id === repo?.method) ? repo.method : methods[0].id;
  const area = h("div", { class: "stack" });
  const err = h("p", { class: "status bad flush", role: "alert" });
  const addrLine = h("p", { class: "mono" });
  const methodHeading = h("h3", {});
  const detailsHeading = h("h3", {});

  const controls = () => ({ ...els, method: select });
  const fail = (m, key) => showError(err, m, { fields: Object.values(controls()), field: controls()[key ?? fieldFor(m, REPO_PAIRS)] });
  const failAddress = (m) => showError(addrErr, m, { fields: [urlInput], field: urlInput });
  const baseUrl = () => (current?.url ?? urlInput.value).trim();
  // when the stored record could not be read, its address is not known: ask for the address of the chosen method
  const otherForm = (m) => (unread ? (m.ssh ? "ssh" : m.https ? "https" : "") : m.ssh && !isSshUrl(baseUrl()) ? "ssh" : m.https && isSshUrl(baseUrl()) ? "https" : "");

  const draw = () => {
    const m = methodOf(methods, select.value);
    els = {};
    urlInput.setAttribute("placeholder", m.ssh ? SSH_EXAMPLE : HTTPS_EXAMPLE);
    // a method whose address form differs from the stored one needs the other form of the address
    drawnOther = otherForm(m);
    if (drawnOther) {
      els.url = h("input", { name: "url", class: "mono", placeholder: drawnOther === "ssh" ? SSH_EXAMPLE : HTTPS_EXAMPLE, autocomplete: "off", value: values.url && isSshUrl(values.url) === (drawnOther === "ssh") ? values.url : "" });
    }
    mount(area,
      h("div", { class: "field" }, (m.help ?? []).map((t) => h("small", {}, t)), m.app ? installLink(options) : null),
      els.url ? h("label", { class: "field" }, h("span", {}, drawnOther === "ssh" ? "SSH address" : "HTTPS address"), els.url) : null,
      m.fields.map((f) => {
        const attrs = { name: f.key, autocomplete: f.secret ? "new-password" : "off" };
        els[f.key] = f.multiline
          ? h("textarea", { ...attrs, rows: 5, class: "mono" })
          : h("input", { ...attrs, type: f.secret ? "password" : "text", value: f.secret ? "" : values[f.key] ?? "" });
        return h("label", { class: "field" }, h("span", {}, f.label), els[f.key]);
      }));
  };
  const read = () => Object.fromEntries(Object.entries(els).map(([k, el]) => [k, el.value]));
  // keep what was typed in plain fields; a secret is not carried over
  const keep = () => {
    for (const [k, v] of Object.entries(read())) if (!isSecret(k)) values[k] = v;
  };
  select.addEventListener("change", () => {
    keep();
    draw();
    fail("");
  });
  draw();

  /** The content node left `#modal-root`: another dialog took it over. */
  const gone = () => !document.getElementById("modal-root").contains(body);
  const run = (fn) => {
    if (busy) return;
    busy = true;
    pending = (async () => {
      try {
        await fn();
      } catch (e) {
        toast(plainError(e), "error");
      } finally {
        busy = false;
      }
    })();
  };

  const row = (...buttons) => h("div", { class: "row" }, h("span", { class: "spacer" }), ...buttons);

  const addressView = (message = "") => {
    mount(body,
      h("h3", {}, "1. Address"),
      h("label", { class: "field" }, h("span", {}, "Repository URL"), urlInput),
      h("small", {}, "An https address, or an SSH address (git@host:path) for a deploy key."),
      addrErr,
      row(h("button", { class: "primary", onClick: next }, "Next")));
    failAddress(message);
    if (!message) urlInput.focus();
  };

  const signInView = (message = "") => {
    const adding = mode() === "add";
    addrLine.textContent = baseUrl();
    methodHeading.textContent = adding ? "2. Method" : "1. Method";
    detailsHeading.textContent = adding ? "3. Details" : "2. Details";
    mount(body,
      adding ? null : addrLine,
      methodHeading,
      h("label", { class: "field" }, h("span", {}, "Authentication"), select),
      options && !appAvailable(options) ? h("small", {}, "GitHub App is not available: the administrator has not set up the app (Settings → GitHub App).") : null,
      detailsHeading, area, err,
      row(adding ? h("button", { onClick: () => addressView() }, "Back") : null,
        h("button", { class: "primary", onClick: submit }, adding ? "Add repository" : "Continue")));
    fail(message);
  };

  const next = () => {
    const problem = repoProblemAt({ url: urlInput.value, method: "none", needUrl: true });
    if (problem.text) return failAddress(problem.text);
    failAddress("");
    keep();
    if (firstNext) {
      firstNext = false;
      const ssh = isSshUrl(urlInput.value) ? methods.find((m) => m.ssh) : null;
      if (ssh) select.value = ssh.id;
      draw();
    } else if (otherForm(methodOf(methods, select.value)) !== drawnOther) draw();
    signInView();
    (Object.values(els)[0] ?? select).focus();
  };

  const submit = () => {
    if (busy) return;
    const adding = mode() === "add";
    const method = select.value;
    const v = read();
    const withUrl = adding || !!els.url;
    const input = { url: els.url ? v.url : urlInput.value, method, values: v, methods };
    const needSecret = adding || method !== current.method || unsure;
    const problem = repoProblemAt({ ...input, needUrl: withUrl, needSecret });
    if (problem.text) return void fail(problem.text, problem.field);
    const request = repoBody({ ...input, withUrl });
    fail("");
    if (adding) return run(() => save(request));
    const same = !unsure && method === current.method && Object.entries(request).every(([k, x]) => k === "method" || (k !== "token" && x === current[k]));
    if (same) return resultShown ? showResult() : closeDialog(true);
    confirmView(request);
  };

  const confirmView = (request) => {
    const box = h("input", { type: "checkbox", name: "replace" });
    const go = h("button", { class: "danger", onClick: () => run(() => save(request)) }, "Replace the sign-in");
    go.disabled = true;
    box.addEventListener("change", () => { go.disabled = !box.checked; });
    mount(body,
      replaceLines(current, request, { methods, unsure, unread }).map((t) => h("p", {}, t)),
      h("label", { class: "check check-row" }, box, " Replace the current sign-in"),
      row(h("button", { onClick: () => signInView() }, "Back"), go));
    box.focus();
  };

  const showResult = () => {
    resultShown = true;
    const done = h("button", { class: "primary", onClick: () => closeDialog(true) }, "Done");
    mount(body,
      readBack(current, shownVerdict, { admin, methods }),
      row(h("button", { onClick: () => { signInView(); } }, "Change details"),
        shownVerdict.retry === false ? null : h("button", { onClick: () => run(verify) }, "Test again"),
        done));
    done.focus();
  };

  const verify = async () => {
    current = withoutConnection(current);
    if (current.method === "none") {
      shownVerdict = verdict({ method: "none" });
      return showResult();
    }
    mount(body, h("p", { role: "status" }, "Testing the connection…"));
    let result;
    let error;
    try {
      result = await api.testRepo(current.id);
    } catch (e) {
      error = e;
    }
    if (Array.isArray(result?.checks)) {
      current = { ...current, connection: result };
      shownVerdict = verdict({ connection: result });
    } else shownVerdict = verdict({ error: error ? plainError(error) : "The test gave no answer." });
    if (gone()) {
      if (error) toast(plainError(error), "error");
      else if (result?.ok) toast("Connection works");
      else toast("Connection failed", "error");
      return closeDialog();
    }
    showResult();
  };

  const reread = async () => {
    try {
      const found = (await api.repos()).find((r) => r.id === current.id);
      if (found) {
        current = found;
        unread = false;
        return;
      }
    } catch {
      // handled below
    }
    unread = true;
    current = withoutConnection(current);
  };

  const failed = async (e, adding) => {
    if (gone()) {
      toast(plainError(e), "error");
      return closeDialog();
    }
    if (!adding && saveUnknown(e)) {
      unsure = true;
      await reread();
      if (gone()) {
        toast(plainError(e), "error");
        return closeDialog();
      }
      // the attempted method and what was typed stay; only the address field may change with what is stored
      const secrets = Object.entries(els).filter(([k]) => isSecret(k)).map(([k, el]) => [k, el.value]);
      keep();
      draw();
      for (const [k, v] of secrets) if (els[k]) els[k].value = v;
      const stored = unread ? "What is stored now could not be read. Check the method and save again." : `Stored now: ${methodLabel(current, admin)}`;
      return signInView(`${plainError(e)} ${stored}`);
    }
    const message = plainError(e);
    const key = fieldFor(message, REPO_PAIRS);
    if (adding && key === "url" && !els.url) return addressView(message);
    signInView(message);
  };

  const save = async (request) => {
    const adding = mode() === "add";
    let answer;
    try {
      answer = adding ? await api.addRepo(request) : await api.setRepoAuth(current.id, request);
    } catch (e) {
      return failed(e, adding);
    }
    // never copy `token`; the public key comes only from the answer
    current = answer?.id ? answer : { ...withoutConnection(current), method: request.method, username: request.username, ...(request.url ? { url: request.url } : {}) };
    if (current.username === undefined) delete current.username;
    unsure = false;
    unread = false;
    for (const [k, el] of Object.entries(els)) if (isSecret(k)) el.value = "";
    values = fresh(current);
    if (methods.some((m) => m.id === current.method)) select.value = current.method;
    draw();
    if (adding) void reposChanged();
    toast(adding ? "Repository added" : "Authentication changed");
    if (gone()) return closeDialog();
    await verify();
  };

  const shown = modal(repo ? "Change authentication" : "Add repository", (close) => {
    closeDialog = close;
    if (started === "add") addressView();
    else signInView();
    return body;
  }, { busy: () => busy });
  return shown.then(() => pending).then(() => (started === "add" && current?.id ? current : undefined));
}
