import { api } from "./api.js";
import { errorText } from "./auth.js";
import { confirmDialog, h, modal, mount, showError, timeAgo, toast } from "./dom.js";
import { statusPill } from "./icons.js";
import { table } from "./kit/display.js";
import { emptyState } from "./states.js";

// Service accounts (#866): accounts for programs. The Users page shows them apart from people.

const text = (s) => String(s ?? "").trim();

/** The state of the token in words. */
export const TOKEN_TEXT = { live: "live", expired: "expired (not used for 30 days)", revoked: "revoked" };
const TOKEN_SEMANTIC = { live: "success", expired: "warning", revoked: "danger" };

/** The token state as a short phrase: "live", "expired…", "revoked". */
export const tokenText = (a) => TOKEN_TEXT[a?.token] ?? "unknown";

/** When the token was last used, or "never". */
export const lastUseText = (a) => (a?.lastUse ? timeAgo(a.lastUse) : "never");

/**
 * The body for a new account or a changed scope: the trimmed name, the `class:x` entries that are checked (in the order of `classes`),
 * then the rule keys that are checked, in the order of `grantable`.
 */
export const scopeBody = ({ name, checked }, grantable = [], classes = []) => ({
  name: text(name),
  scope: [...classes.map((c) => `class:${c}`).filter((k) => checked.has(k)), ...grantable.map((g) => g.key).filter((k) => checked.has(k))],
});

const stack = (...nodes) => h("div", { class: "stack" }, ...nodes);
const para = (t) => h("p", { class: "flush" }, t);

/** The scope as a list. */
const scopeCell = (a) =>
  a.scope.length === 0 ? h("span", { class: "muted" }, "none")
    : h("details", {}, h("summary", {}, `${a.scope.length} route${a.scope.length === 1 ? "" : "s"}`), h("ul", { class: "flush" }, a.scope.map((k) => h("li", {}, h("code", {}, k)))));

/** The token, shown once, with a Copy button. */
function tokenDialog(title, token, clipboard) {
  return modal(title, (close) => {
    const field = h("input", { name: "token", class: "mono", readonly: true, "aria-label": "Service token", value: token, onFocus: (e) => e.currentTarget.select?.() });
    const note = h("p", { class: "status flush", role: "status" });
    return stack(
      para("Shown once. Use it only on this computer. It works as a bearer token: Authorization: Bearer <token>."),
      field,
      note,
      h("div", { class: "row" },
        h("button", { onClick: async () => {
          let copied = false;
          try {
            await clipboard?.writeText(token);
            copied = !!clipboard;
          } catch {
            copied = false;
          }
          note.setAttribute("role", copied ? "status" : "alert");
          note.textContent = copied ? "Copied." : "Could not copy. Select the token and copy it yourself.";
        } }, "Copy"),
        h("span", { class: "spacer" }),
        h("button", { class: "primary", onClick: () => close(true) }, "Done")));
  });
}

/** The checkboxes of the routes a scope may hold; the admin-only ones are marked. Returns the nodes and the set of checked keys. */
function scopePicker(grantable, current, classes = []) {
  const checked = new Set(current);
  const toggle = (key) => (e) => (e.currentTarget.checked ? checked.add(key) : checked.delete(key));
  const boxes = grantable.map((g) => {
    const input = h("input", { type: "checkbox", name: "scope", value: g.key, checked: checked.has(g.key), onClick: toggle(g.key) });
    return h("label", { class: "field-inline" }, input, " ", h("code", {}, g.key), g.data ? h("span", { class: "muted" }, ` [${g.data}]`) : null, g.adminOnly ? h("span", { class: "muted" }, " (admin only)") : null);
  });
  const kinds = classes.map((c) => {
    const key = `class:${c}`;
    const input = h("input", { type: "checkbox", name: "scope", value: key, checked: checked.has(key), onClick: toggle(key) });
    return h("label", { class: "field-inline" }, input, " ", h("code", {}, key));
  });
  return {
    checked,
    nodes: [
      kinds.length ? h("div", { class: "stack", role: "group", "aria-label": "Kinds of data this account may read" }, h("strong", {}, "Kinds of data (reads only)"), kinds) : null,
      h("div", { class: "stack", role: "group", "aria-label": "Routes this account may call" }, boxes),
    ],
  };
}

/** Add or edit dialog. Resolves with the answer of the call (or undefined when closed). */
function formDialog({ account, grantable, classes = [], clipboard }) {
  let answer;
  return modal(account ? `Scope of ${account.name}` : "Add service account", (close) => {
    const name = h("input", { name: "name", value: account?.name ?? "", autocomplete: "off" });
    const picker = scopePicker(grantable, account?.scope ?? [], classes);
    const err = h("p", { class: "status bad flush", role: "alert" });
    const save = h("button", { class: "primary", onClick: async () => {
      const body = scopeBody({ name: name.value, checked: picker.checked }, grantable, classes);
      if (!body.name) return showError(err, "Fill in the name.", { fields: [name], field: name });
      save.disabled = true;
      showError(err, "", { fields: [name] });
      try {
        answer = account ? await api.saveServiceAccount(account.id, body) : await api.addServiceAccount(body);
      } catch (e) {
        save.disabled = false;
        return showError(err, errorText(e), { fields: [name], field: name });
      }
      close(answer);
    } }, account ? "Save" : "Add");
    return stack(
      para("A service account is for a program. It has no password. Choose the kinds of data it may read, and the routes it may call; it can call nothing else. A kind of data covers reads only; a change needs its own route. Routes for credentials, users, settings, autonomy, plugins and the audit export (the secret data) can never be chosen."),
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      ...picker.nodes, err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  }).then(async (r) => {
    if (r?.token) await tokenDialog("Service token", r.token, clipboard);
    return r;
  });
}

/**
 * The "Service accounts" section of the Users page. Loads its own list; a failure shows in the section and leaves the page alone.
 * Returns a cleanup. `clipboard` is a function that gives the clipboard (the page's own, in tests a fake).
 */
export async function renderServiceAccounts(box, { readOnly = false, clipboard = () => (typeof navigator === "undefined" ? undefined : navigator.clipboard) } = {}) {
  let live = true;
  const draw = (body) => live && mount(box, h("h2", { id: "service-accounts" }, "Service accounts"), h("p", { class: "muted" }, "Accounts for programs. They sign in with a token on this computer only."), body);
  const load = async () => {
    let data;
    try {
      data = await api.serviceAccounts();
    } catch (e) {
      return draw(h("p", { class: "status bad", role: "alert" }, `The service accounts could not be loaded. ${errorText(e)}`));
    }
    if (!live) return undefined;
    const { accounts, grantable } = data;
    const classes = data.classes ?? [];
    const run = async (fn, done) => {
      try {
        const r = await fn();
        if (r?.token) await tokenDialog(done, r.token, clipboard());
        else if (done) toast(done);
      } catch (e) {
        toast(errorText(e), "error");
      }
      return load();
    };
    const columns = [
      { key: "name", label: "Name" },
      { key: "status", label: "Status", cell: (a) => (a.status === "blocked" ? statusPill("danger", "blocked") : statusPill("success", "active")) },
      { key: "token", label: "Token", cell: (a) => statusPill(TOKEN_SEMANTIC[a.token] ?? "neutral", tokenText(a)) },
      { key: "lastUse", label: "Last use", cell: (a) => h("span", { class: "muted" }, lastUseText(a)) },
      { key: "scope", label: "Scope", cell: scopeCell },
      ...(readOnly ? [] : [{ key: "actions", label: "Actions", cell: (a) => h("div", { class: "row" },
        h("button", { onClick: async () => { await formDialog({ account: a, grantable, classes, clipboard: clipboard() }); load(); } }, "Edit scope"),
        h("button", { onClick: () => run(() => api.rotateServiceToken(a.id), "New service token") }, "Rotate"),
        h("button", { disabled: a.token === "revoked", onClick: async () => { if (await confirmDialog({ title: `Revoke the token of ${a.name}?`, text: "The token stops working at once. Rotate gives a new one.", confirm: "Revoke" })) run(() => api.revokeServiceToken(a.id), "Token revoked"); } }, "Revoke"),
        h("button", { class: "danger", onClick: async () => { if (await confirmDialog({ title: `Delete ${a.name}?`, text: "The account and its token are removed. Its runs are kept. This cannot be undone." })) run(() => api.deleteUser(a.id), `${a.name} was deleted`); } }, "Delete")) }]),
    ];
    return draw([
      readOnly ? null : h("div", { class: "row" }, h("button", { class: "primary", onClick: async () => { await formDialog({ grantable, classes, clipboard: clipboard() }); load(); } }, "+ Add service account")),
      accounts.length === 0 ? emptyState("No service accounts yet.") : table({ caption: "Service accounts", hideCaption: true, columns, rows: accounts, class: "table-box" }),
    ]);
  };
  await load();
  return () => {
    live = false;
  };
}
