import { api } from "./api.js";
import { errorText, linkHash } from "./auth.js";
import { h, modal, mount, timeAgo, toast } from "./dom.js";
import { rememberView } from "./view-as.js";

const text = (s) => String(s ?? "").trim();
const ROLES = ["user", "admin"];

const browserPage = {
  origin: () => location.origin,
  clipboard: () => (typeof navigator === "undefined" ? undefined : navigator.clipboard),
  reload: () => location.reload(),
  go: (to) => location.assign(to),
};

/** True while the account is locked after too many wrong tries (`lockedUntil` is a time in the future). */
export const isLocked = (u, now = Date.now()) => !!u.lockedUntil && Date.parse(u.lockedUntil) > now;

/** The account's status in words: blocked wins over "no password yet", and that wins over "locked". */
export const statusText = (u, now = Date.now()) =>
  u.status === "blocked" ? "blocked" : !u.hasPassword ? "no password yet" : isLocked(u, now) ? "locked" : "active";

/** The classes of the status pill. */
export const pillClass = (u, now = Date.now()) =>
  `pill${u.status === "blocked" ? " fail" : !u.hasPassword ? "" : isLocked(u, now) ? " locked" : " ok"}`;

/** When the account last signed in, or "never". */
export const lastSignInText = (u) => (u.lastSignIn ? timeAgo(u.lastSignIn) : "never");

/**
 * The buttons of a row, in order. A link is offered exactly when the account has no password, a reset exactly when it
 * has one. Unlock is offered for a locked account that has a password (also when it is blocked).
 */
export const actionsFor = (u, now = Date.now()) => [
  "edit",
  "limits",
  u.hasPassword ? "reset" : "link",
  ...(u.hasPassword && isLocked(u, now) ? ["unlock"] : []),
  u.status === "blocked" ? "unblock" : "block",
  ...(u.role === "user" ? ["view"] : []),
  "delete",
];

/** For a blocked account: why its link does not work yet. Empty for any other account. */
export const blockedLinkText = (u) => (u?.status === "blocked" ? `${u.name} is blocked, so the link works only after you unblock the account.` : "");

/** The set-password link for a token, built from the address the admin uses (the server does not know its public address). */
export const passwordLink = (origin, token) => `${origin}/${linkHash(token)}`;

/** What is missing in the form, or "" when it can be sent. */
export function userProblem({ name, email }) {
  if (!text(name)) return "Fill in the name.";
  if (!text(email)) return "Fill in the e-mail.";
  return "";
}

/** The body for a new account: trimmed; an unknown role becomes user. */
export const newUserBody = ({ name, email, role }) => ({ name: text(name), email: text(email), role: role === "admin" ? "admin" : "user" });

/** Only the fields that differ from the account; {} when nothing changed. An e-mail that differs only in case is not a change. */
export function userChanges(u, { name, email, role }) {
  const changes = {};
  if (text(name) !== u.name) changes.name = text(name);
  if (text(email).toLowerCase() !== String(u.email).toLowerCase()) changes.email = text(email);
  if (ROLES.includes(role) && role !== u.role) changes.role = role;
  return changes;
}

/** The number of runs the server cancelled: it answers `{ queued, running, waiting }`. */
export const cancelledTotal = (c) => (typeof c === "number" ? c : (c?.queued ?? 0) + (c?.running ?? 0) + (c?.waiting ?? 0));

/** The line shown after a block. */
export const cancelledText = (name, n) => `${name} is blocked. ${n === 0 ? "No runs were cancelled." : n === 1 ? "1 run was cancelled." : `${n} runs were cancelled.`}`;

/** Copies text; false when there is no clipboard (it needs HTTPS or localhost) or the copy is refused. */
export async function copyText(clipboard, value) {
  if (!clipboard || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

const f = (label, el) => h("label", { class: "field" }, h("span", {}, label), el);
const stack = (...nodes) => h("div", { style: { display: "grid", gap: "12px" } }, ...nodes);
const para = (t) => h("p", { style: { margin: 0 } }, t);

/** The one-time link: a read-only field to select, a Copy button, and what the admin has to do with it. */
function linkView(link, user, page, onDone) {
  const field = h("input", { name: "link", class: "mono", readonly: true, value: link, onFocus: (e) => e.currentTarget.select?.() });
  const note = h("p", { class: "status", style: { margin: 0 } });
  return stack(
    para("This link works once, for 24 hours. Send it to the user yourself: the Foundry does not send it."),
    blockedLinkText(user) ? para(blockedLinkText(user)) : null,
    field,
    note,
    h("div", { class: "row" },
      h("button", { onClick: async () => {
        note.textContent = (await copyText(page.clipboard(), link)) ? "Copied." : "Could not copy. Select the link and copy it yourself.";
      } }, "Copy"),
      h("span", { class: "spacer" }),
      h("button", { class: "primary", onClick: onDone }, "Done")));
}

/**
 * A dialog that makes one call. `prepare()` returns a problem (text), null (close, nothing to send) or the call.
 * An error shows in the dialog and the button works again. `done(answer, { close, closed, mountIn })` may keep the dialog open.
 * Resolves with the answer once the dialog is closed and a started call has finished.
 */
function callDialog({ title, body, label, danger = false, prepare, done }) {
  let pending = null;
  let closed = false;
  const shown = modal(title, (close) => {
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    const content = stack();
    const btn = h("button", { class: danger ? "danger" : "primary", onClick: () => go() }, label);
    let busy = false;
    const go = () => {
      if (busy) return;
      const call = prepare();
      if (typeof call === "string") return void (err.textContent = call);
      if (call === null) return close(undefined);
      busy = true;
      btn.disabled = true;
      err.textContent = "";
      pending = (async () => {
        let answer;
        try {
          answer = await call();
        } catch (e) {
          busy = false;
          if (closed) return void toast(errorText(e), "error");
          err.textContent = errorText(e);
          btn.disabled = false;
          return undefined;
        }
        if (done) return void done(answer, { close, closed, mountIn: (...n) => mount(content, ...n) });
        if (!closed) close(answer);
        return answer;
      })();
    };
    mount(content, ...body, err, h("div", { class: "row" }, h("span", { class: "spacer" }), btn));
    return content;
  });
  shown.then(() => { closed = true; });
  return shown.then(() => pending);
}

function userForm(u) {
  const name = h("input", { name: "name", value: u?.name ?? "", autocomplete: "off" });
  const email = h("input", { name: "email", value: u?.email ?? "", autocomplete: "off" });
  const role = h("select", { name: "role" }, ROLES.map((r) => h("option", { value: r }, r)));
  role.value = u?.role ?? "user";
  const read = () => ({ name: name.value, email: email.value, role: role.value });
  return { read, nodes: [f("Name", name), f("E-mail", email), f("Role", role)] };
}

const own = (u, me) => (u.id === me ? [para("This is your own account: you are signed out at once.")] : []);

/** Shows the one-time link in the dialog; when the dialog is already closed the token is dropped. */
const showLink = (user, page, lateText) => (answer, { close, closed, mountIn }) => {
  if (closed) return toast(lateText, "error");
  mountIn(linkView(passwordLink(page.origin(), answer.token), answer.user ?? user, page, () => close(undefined)));
};

const addDialog = (_u, { page }) => {
  const form = userForm();
  return callDialog({
    title: "Add user",
    body: form.nodes,
    label: "Add user",
    prepare: () => userProblem(form.read()) || (() => api.addUser(newUserBody(form.read()))),
    done: showLink(null, page, "The link was not shown. Use New link on the account to make one."),
  });
};

const linkDialog = (u, { page }) => callDialog({
  title: `New link for ${u.name}`,
  body: [para(`Make a new set-password link for ${u.name} (${u.email}). The earlier link stops working.`), blockedLinkText(u) ? para(blockedLinkText(u)) : null],
  label: "New link",
  prepare: () => () => api.userLink(u.id),
  done: showLink(u, page, "The link was not shown. Use New link again to make one."),
});

const resetDialog = (u, { me, page }) => callDialog({
  title: `Reset password of ${u.name}?`,
  body: [
    para(`${u.name} (${u.email}) loses the password and is signed out everywhere. The dialog then shows a link to set a new one. Until it is used, ${u.name} cannot sign in.`),
    ...own(u, me)],
  label: "Reset password",
  danger: true,
  prepare: () => () => api.resetUser(u.id),
  done: showLink(u, page, "The password was reset, but the link was not shown. Use New link on the account to make one."),
});

const unlockDialog = (u) => callDialog({
  title: `Unlock ${u.name}?`,
  body: [para(`Remove the lock of ${u.name} (${u.email}) and its wrong tries. A short wait for the address the tries came from can remain.`)],
  label: "Unlock",
  prepare: () => () => api.unlockUser(u.id),
});

const editDialog = (u) => {
  const form = userForm(u);
  return callDialog({
    title: `Edit ${u.name}`,
    body: form.nodes,
    label: "Save",
    prepare: () => {
      const input = form.read();
      const problem = userProblem(input);
      if (problem) return problem;
      const changes = userChanges(u, input);
      return Object.keys(changes).length ? () => api.saveUser(u.id, changes) : null;
    },
  });
};

const blockDialog = (u, { me }) => {
  const stop = h("input", { type: "checkbox", name: "stopWork", style: { width: "auto" } });
  return callDialog({
    title: `Block ${u.name}?`,
    body: [
      para(`${u.name} (${u.email}) is signed out and cannot sign in. Their queued runs are cancelled. Running runs finish, and runs that wait for approval stay.`),
      h("label", { class: "row", style: { gap: "6px" } }, stop, h("span", {}, "Also stop all their work now")),
      h("small", {}, "Also cancels their running runs and their runs that wait for approval. Workspaces are kept."),
      ...own(u, me)],
    label: "Block",
    danger: true,
    prepare: () => () => api.blockUser(u.id, stop.checked),
  });
};

const unblockDialog = (u) => callDialog({
  title: `Unblock ${u.name}?`,
  body: [para(`${u.name} can sign in again. Runs that were cancelled are not restarted.`)],
  label: "Unblock",
  prepare: () => () => api.unblockUser(u.id),
});

const deleteDialog = (u, { me }) => callDialog({
  title: `Delete ${u.name}?`,
  body: [
    para(`Delete the account ${u.name} (${u.email})? It is signed out and its queued runs are cancelled. Its stored credentials and repositories are wiped. Its runs are kept and show "deleted user". This cannot be undone.`),
    ...own(u, me)],
  label: "Delete",
  danger: true,
  prepare: () => () => api.deleteUser(u.id),
});

// ---- limits (stored and shown only; the server does not enforce them yet) ----------------------------

export const LIMIT_FIELDS = [
  { key: "maxConcurrent", label: "Runs at the same time" },
  { key: "maxRunsPerDay", label: "Runs per day" },
  { key: "dailyBudgetUsd", label: "Daily budget (USD)" },
];
const LIMIT_TEXT = {
  maxConcurrent: (v) => `${v} at a time`,
  maxRunsPerDay: (v) => `${v} runs a day`,
  dailyBudgetUsd: (v) => `$${v} a day`,
};

/** The limits that apply to an account: `[{ key, text, override }]`, an own value wins over the default. Empty means no limits. */
export function limitParts(limits, id) {
  const own = limits?.users?.[id] ?? {};
  const defaults = limits?.defaults ?? {};
  return LIMIT_FIELDS.flatMap(({ key }) => {
    const override = own[key] !== undefined;
    const v = override ? own[key] : defaults[key];
    return v === undefined ? [] : [{ key, text: LIMIT_TEXT[key](v), override }];
  });
}

/** Reads the three input texts: `{ problem }` or `{ values }` (a missing key is empty = no limit). */
export function readLimits(input) {
  const values = {};
  for (const { key, label } of LIMIT_FIELDS) {
    const t = text(input[key]);
    if (!t) continue;
    if (key === "dailyBudgetUsd") {
      const n = Number(t);
      if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t) || !Number.isFinite(n) || n <= 0) return { problem: "Daily budget must be a number above 0, or empty." };
      values[key] = n;
    } else {
      const n = Number(t);
      if (!/^\d+$/.test(t) || !Number.isSafeInteger(n) || n < 1) return { problem: `${label} must be a whole number of 1 or more, or empty.` };
      values[key] = n;
    }
  }
  return { values };
}

/** Only the keys that differ: a number to set, null to clear. {} means no change. */
export function limitsPatch(current, values) {
  const patch = {};
  for (const { key } of LIMIT_FIELDS) {
    if (values[key] !== undefined) {
      if (values[key] !== current?.[key]) patch[key] = values[key];
    } else if (current?.[key] !== undefined) patch[key] = null;
  }
  return patch;
}

function limitsForm(current, hintOf) {
  const inputs = Object.fromEntries(LIMIT_FIELDS.map(({ key }) => [key, h("input", { name: key, inputmode: "decimal", autocomplete: "off", value: current?.[key] === undefined ? "" : String(current[key]), placeholder: hintOf(key) })]));
  return {
    nodes: LIMIT_FIELDS.map(({ key, label }) => f(label, inputs[key])),
    read: () => readLimits(Object.fromEntries(LIMIT_FIELDS.map(({ key }) => [key, inputs[key].value]))),
  };
}

const limitsPrepare = (form, current, save) => () => {
  const r = form.read();
  if (r.problem) return r.problem;
  const patch = limitsPatch(current, r.values);
  return Object.keys(patch).length ? () => save(patch) : null;
};

const limitsDialog = (u, { limits }) => {
  const current = limits?.users?.[u.id] ?? {};
  const defaults = limits?.defaults ?? {};
  const form = limitsForm(current, (k) => (defaults[k] === undefined ? "default: no limit" : `default: ${defaults[k]}`));
  return callDialog({
    title: `Limits of ${u.name}`,
    body: [para("Leave a field empty to use the default."), ...form.nodes],
    label: "Save",
    prepare: limitsPrepare(form, current, (patch) => api.saveUserLimits(u.id, patch)),
  });
};

const defaultLimitsDialog = (_u, { limits }) => {
  const current = limits?.defaults ?? {};
  const form = limitsForm(current, () => "no limit");
  return callDialog({
    title: "Default limits",
    body: [para("These apply to every account, admins too, unless the account has its own. Empty means no limit. Limits are stored only; they are not enforced yet."), ...form.nodes],
    label: "Save",
    prepare: limitsPrepare(form, current, (patch) => api.saveDefaultLimits(patch)),
  });
};

const DIALOGS = { edit: editDialog, limits: limitsDialog, link: linkDialog, reset: resetDialog, unlock: unlockDialog, block: blockDialog, unblock: unblockDialog, delete: deleteDialog };
const LABELS = { edit: "Edit", limits: "Limits", link: "New link", reset: "Reset password", unlock: "Unlock", block: "Block", unblock: "Unblock", view: "View as user", delete: "Delete" };

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent(location.hash.split("/")[1] ?? "") === "users";
  } catch {
    return false;
  }
};

/** The Users page. `me` is the signed-in account's id; `notice` ({ text }) is a line kept from the last block. Returns a cleanup. */
export async function renderUsers(main, { me = "", notice, page = browserPage } = {}) {
  const mine = ++generation;
  // A broken limits store must not take the page down: the column then says "not available".
  const [users, limits] = await Promise.all([api.users(), api.limits().catch(() => null)]);
  if (mine !== generation || !onPage()) return () => {};
  const reload = (next) => renderUsers(main, { me, notice: next, page }).catch((e) => toast(errorText(e), "error"));

  const act = async (u, kind) => {
    const answer = await DIALOGS[kind](u, { me, page, limits });
    if (answer && u.id === me && ["edit", "block", "delete"].includes(kind)) return page.reload();
    let next;
    if (answer && kind === "block") next = { text: cancelledText(u.name, cancelledTotal(answer.cancelled)) };
    else if (answer && (kind === "edit" || kind === "limits")) toast("Saved");
    else if (answer && kind === "unlock") toast(`${u.name} is unlocked`);
    else if (answer && kind === "unblock") toast(`${u.name} is unblocked`);
    else if (answer && kind === "delete") toast(`${u.name} was deleted`);
    return reload(next);
  };
  // Starts the read-only preview (an audit line on the server) and opens it in this tab; the name is kept for the bar.
  const view = async (u) => {
    try {
      const v = await api.startViewAs(u.id);
      rememberView(v);
      page.go(`/user/?as=${encodeURIComponent(v.id)}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const add = async () => {
    await addDialog(null, { page });
    reload();
  };
  const defaultLimits = async () => {
    const answer = await defaultLimitsDialog(null, { limits });
    if (answer) toast("Saved");
    reload();
  };
  const limitsCell = (u) => {
    if (limits === null) return h("span", { class: "muted" }, "not available");
    const parts = limitParts(limits, u.id);
    if (!parts.length) return h("span", { class: "muted" }, "no limits");
    return parts.map((p, i) => [
      i ? " · " : null,
      p.override ? h("strong", { title: "Set for this account" }, `${p.text} (own)`) : h("span", { class: "muted", title: "Default" }, p.text)]);
  };
  const row = (u) => h("tr", {},
    h("td", {}, u.name, u.id === me ? h("span", { class: "muted" }, " (you)") : null),
    h("td", { class: "mono" }, u.email),
    h("td", {}, u.role),
    h("td", {}, h("span", { class: pillClass(u) }, statusText(u))),
    h("td", { class: "muted" }, lastSignInText(u)),
    h("td", { class: "mono" }, u.runs),
    h("td", {}, limitsCell(u)),
    h("td", {}, actionsFor(u).map((k) => [h("button", { class: k === "delete" ? "small danger" : "small", disabled: k === "limits" && limits === null, onClick: () => (k === "view" ? view(u) : act(u, k)) }, LABELS[k]), " "])));
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Users"), h("span", { class: "muted" }, "Who can sign in"),
      h("span", { class: "spacer" }), h("button", { disabled: limits === null, onClick: defaultLimits }, "Default limits"), " ",
      h("button", { class: "primary", onClick: add }, "+ Add user")),
    notice ? h("p", { class: "status ok" }, notice.text) : null,
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ["Name", "E-mail", "Role", "Status", "Last sign-in", "Runs", "Limits", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, users.map(row))));
  return () => {
    generation++;
  };
}
