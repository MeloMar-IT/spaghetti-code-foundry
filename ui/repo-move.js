import { api } from "./api.js";
import { h, modal, toast } from "./dom.js";

// "Move to GitHub" on My repositories: pick or create the target, check it with a dry run, then move. The server does the work
// (POST /api/repos/:id/move-to-github); this file only builds the request and tells the answer.

export const MOVE_TITLE = "Move to GitHub";
const PART = /^[A-Za-z0-9._-]{1,100}$/;

/** The person's own GitHub records a move can use, by name. */
export function moveTargets(repos) {
  return (Array.isArray(repos) ? repos : [])
    .filter((r) => (r?.method === "github-token" || r?.method === "github-app") && typeof r.github === "string" && r.github)
    .map((r) => ({ id: r.id, github: r.github }))
    .sort((a, b) => a.github.localeCompare(b.github));
}

/** A repository name from the last part of a folder or address. */
export function suggestName(url) {
  const last = String(url ?? "").replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? "";
  const n = last.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/^-+|-+$/g, "");
  return !n || n === "." || n === ".." ? "project" : n;
}

/** "" when the name is fine for the server ("name" or "owner/name"); else a sentence. */
export function moveNameProblem(name, { owner = true } = {}) {
  const parts = String(name ?? "").trim().split("/");
  const fine = parts.length <= (owner ? 2 : 1) && parts.every((p) => PART.test(p) && p !== "." && p !== ".." && !/\.git$/i.test(p));
  if (fine) return "";
  return owner ? 'Use "name" or "owner/name": letters, digits, "-", "_" and ".".' : 'Use only letters, digits, "-", "_" and "." in the name.';
}

export function moveInputProblem({ mode, repoId, name }) {
  if (mode === "pick") return repoId ? "" : "Choose one of your GitHub repositories.";
  return moveNameProblem(name);
}

/** The body of the call. */
export function moveBody({ mode, repoId, name, private: priv, includeClosed }, dryRun) {
  return {
    target: mode === "pick" ? { repoId } : { create: { name: String(name ?? "").trim(), private: priv !== false } },
    includeClosed: !!includeClosed,
    dryRun: !!dryRun,
  };
}

export function refGroups(refs) {
  const out = { branches: [], tags: [] };
  for (const r of Array.isArray(refs) ? refs : []) {
    const ref = String(r?.ref ?? r);
    if (ref.startsWith("refs/heads/")) out.branches.push(ref.slice(11));
    else if (ref.startsWith("refs/tags/")) out.tags.push(ref.slice(10));
  }
  return out;
}

export function repositoryLine(r, { private: priv = true } = {}) {
  const g = r?.github;
  if (r?.repository === "create") return `${g} will be created (${priv === false ? "public" : "private"})`;
  if (r?.repository === "exists") return `${g} exists on GitHub and will be used`;
  if (r?.repository === "picked") return `${g} (one of your repositories)`;
  return `${g} was created`;
}

export function storyLine(p) {
  if (p.status === "already-moved") return `#${p.number} ${p.title}: already moved (#${p.githubIssue} on GitHub)`;
  if (p.status === "unreadable") return `#${p.number}: cannot be read (${p.reason ?? "unknown reason"})`;
  if (p.status === "too-large") return `#${p.number} ${p.title}: its comments are too large for one GitHub comment`;
  return `#${p.number} ${p.title}: will be created`;
}

export const blockedStories = (r) => (r?.stories?.plan ?? []).filter((p) => p.status === "unreadable" || p.status === "too-large");

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function doneLine(r) {
  const refs = r.refs ?? [];
  const same = refs.filter((x) => x.status === "up-to-date").length;
  const pushed = refs.length - same;
  const made = r.stories?.created?.length ?? 0;
  let first = `${count(pushed, "branch or tag", "branches and tags")} pushed`;
  if (same) first += `, ${same} already up to date`;
  const parts = [first, `${count(made, "story", "stories")} created on GitHub`];
  const w = r.switched?.watchers?.length ?? 0;
  if (w) parts.push(`${count(w, "watcher")} moved`);
  return `Moved to ${r.github}: ${parts.join("; ")}. The local record is removed; the folder and its .scf/stories files stay.`;
}

const MOVING = "Moving… This pushes every branch and tag and moves the stories. It can take a few minutes; keep this page open.";

/**
 * The dialog. Resolves `{ called, result }` however it is closed (Escape, ✕, the backdrop, Cancel): `called` is true once a real
 * move was sent (worked or not), `result` is the answer of one that worked.
 */
export async function moveDialog(repo, { repos = [], a = api, errorText = (e) => e?.message || "Something went wrong." } = {}) {
  const targets = moveTargets(repos);
  const out = { called: false };
  let busy = false;
  let checked = null; // { body, blocked } of the last dry run that worked
  let finished = false;
  let close;
  const f = { mode: targets.length ? "pick" : "create", repoId: targets[0]?.id ?? "", name: suggestName(repo.url), private: true, includeClosed: false };

  const alertLine = h("p", { class: "error", role: "alert" });
  const status = h("p", { class: "muted", role: "status", "aria-live": "polite" });
  const area = h("div", { class: "stack" });
  const note = h("p", { class: "muted" });
  const pickRadio = h("input", { type: "radio", name: "move-target", value: "pick", checked: f.mode === "pick", onChange: () => input({ mode: "pick" }) });
  const createRadio = h("input", { type: "radio", name: "move-target", value: "create", checked: f.mode === "create", onChange: () => input({ mode: "create" }) });
  const select = h("select", { "aria-label": "Your GitHub repository", onChange: (e) => input({ repoId: e?.target?.value ?? select.value }) },
    targets.map((t) => h("option", { value: t.id }, t.github)));
  if (targets.length) select.value = f.repoId;
  const nameField = h("input", { type: "text", "aria-label": "Name of the new repository", value: f.name, onInput: (e) => input({ name: e?.target?.value ?? nameField.value }) });
  const priv = h("input", { type: "checkbox", checked: true, onChange: (e) => input({ private: e?.target?.checked ?? priv.checked }) });
  const closed = h("input", { type: "checkbox", checked: false, onChange: (e) => input({ includeClosed: e?.target?.checked ?? closed.checked }) });
  const checkBtn = h("button", { type: "button", "data-focus": "move-check", onClick: () => check() }, "Check");
  const moveBtn = h("button", { type: "button", class: "primary", "data-focus": "move-go", disabled: true, onClick: () => move() }, "Move");
  const cancelBtn = h("button", { type: "button", onClick: () => close?.(undefined) }, "Cancel");

  const sync = () => {
    const off = busy || finished;
    const pick = f.mode === "pick";
    pickRadio.disabled = off || !targets.length ? true : undefined;
    createRadio.disabled = off ? true : undefined;
    select.disabled = off || !pick ? true : undefined;
    nameField.disabled = off || pick ? true : undefined;
    priv.disabled = off || pick ? true : undefined;
    closed.disabled = off ? true : undefined;
    checkBtn.disabled = off ? true : undefined;
    moveBtn.disabled = off || !checked || checked.blocked ? true : undefined;
    cancelBtn.disabled = busy ? true : undefined;
    cancelBtn.textContent = finished ? "Close" : "Cancel";
  };
  const reset = () => {
    checked = null;
    area.replaceChildren();
    note.textContent = "";
  };
  function input(change) {
    if (busy || finished) return;
    Object.assign(f, change);
    reset();
    alertLine.textContent = "";
    status.textContent = "";
    sync();
  }

  const showCheck = (r) => {
    const g = refGroups(r.refs);
    const list = (title, items) => (items.length ? h("div", {}, h("strong", {}, `${title} (${items.length})`), h("ul", {}, items.map((i) => h("li", {}, i)))) : null);
    const plan = r.stories?.plan ?? [];
    // native replaceChildren() would draw a null child as the text "null": only real nodes go in
    area.replaceChildren(...[
      h("p", {}, repositoryLine(r, { private: f.private })),
      list("Branches", g.branches), list("Tags", g.tags),
      h("div", {}, h("strong", {}, `Stories (${plan.length})`), plan.length ? h("ul", {}, plan.map((p) => h("li", {}, storyLine(p)))) : h("p", { class: "muted" }, "No stories to move.")),
    ].filter(Boolean));
  };

  async function check() {
    if (busy || finished) return;
    const problem = moveInputProblem(f);
    reset();
    alertLine.textContent = problem;
    status.textContent = "";
    if (problem) return sync();
    const body = moveBody(f, true);
    busy = true;
    status.textContent = "Checking…";
    sync();
    try {
      const r = await a.moveToGithub(repo.id, body);
      const blocked = blockedStories(r).length > 0;
      checked = { body: moveBody(f, false), blocked };
      showCheck(r);
      note.textContent = blocked ? "Some stories cannot be moved. Fix or remove them, then check again." : "";
    } catch (e) {
      alertLine.textContent = errorText(e);
    }
    busy = false;
    status.textContent = "";
    sync();
  }

  async function move() {
    if (busy || finished || !checked) return;
    const body = checked.body; // exactly what was checked
    busy = true;
    out.called = true;
    alertLine.textContent = "";
    status.textContent = MOVING;
    sync();
    try {
      const r = await a.moveToGithub(repo.id, body);
      out.result = r;
      finished = true;
      status.textContent = doneLine(r);
      toast("Moved to GitHub");
    } catch (e) {
      status.textContent = "";
      alertLine.textContent = errorText(e);
    }
    busy = false;
    sync();
  }

  const label = (cb, text) => h("label", { class: "row" }, cb, h("span", {}, text));
  await modal(MOVE_TITLE, (c) => {
    close = c;
    sync();
    return h("div", { class: "stack" },
      h("p", { class: "muted" }, `Moves ${repo.url} to GitHub: every branch, tag and story. Check first; nothing changes until you press Move.`),
      h("fieldset", { class: "stack" }, h("legend", {}, "Where to?"),
        label(pickRadio, "Use one of my GitHub repositories"), select,
        label(createRadio, "Create a new repository"), nameField, label(priv, "Private")),
      label(closed, "Also move closed stories"),
      alertLine, status, area, note,
      h("div", { class: "row" }, h("span", { class: "spacer" }), cancelBtn, checkBtn, moveBtn));
  }, { busy: () => busy });
  return out;
}
