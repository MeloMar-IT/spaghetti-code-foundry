import { api } from "./api.js";
import { h, mount, toast } from "./dom.js";
import { statusPill } from "./icons.js";
import { errorState, explainError, loadingState } from "./states.js";

// Not imported from users.js: that is an admin module, and the user display must not reach it.
async function copyText(clipboard, value) {
  if (!clipboard || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
export const pageClipboard = () => (typeof navigator === "undefined" ? undefined : navigator.clipboard);

/** One row of the report (from `setupRows`) as a list item. `again(id, label)` makes a Check again button; without it the row has none. `text` maps the server's words. */
export function setupRowNode(r, { clipboard, notify = toast, alive = () => true, again = null, text = (s) => s } = {}) {
  const explain = r.explain ? text(r.explain) : "";
  return h("li", { class: `setup-row ${r.tone}` },
    h("div", { class: "setup-name" }, statusPill(r.semantic, r.word), " ", h("strong", {}, r.name), r.optional ? " (optional)" : ""),
    explain && h("p", {}, explain),
    r.command && h("p", {},
      h("code", {}, r.command), " ",
      h("button", { type: "button", onClick: async () => {
        const ok = await copyText(clipboard, r.command);
        if (alive()) notify(ok ? "Copied" : "Select the command and copy it", ok ? "info" : "error");
      } }, "Copy")),
    r.link && h("p", {}, h("a", { href: r.link.url, target: "_blank", rel: "noopener noreferrer" }, r.link.label)),
    r.tone !== "ok" && again && h("p", {}, again(r.id, "Check again")));
}

// Setup check: is what the Foundry needs on this computer, in plain words. The words come from the server (src/setup-check.ts).
// The page has no input: it never asks for a password, key or token. Sign-in happens in the agent's own window.

export const ASK_ADMIN = "The setup check looks at the computer that runs the Foundry. Ask the person who runs it (an admin) to open it.";

/** → [{ id, name, mark, tone, optional, explain, command, link }] for each item of the report. */
export function setupRows(report) {
  return (Array.isArray(report?.items) ? report.items : []).map((i) => ({
    id: i.id,
    name: i.name,
    mark: i.state === "ok" ? "✔" : i.state === "unknown" ? "?" : "✘",
    tone: i.state === "ok" ? "ok" : i.state === "unknown" ? "unknown" : "bad",
    semantic: i.state === "ok" ? "success" : i.state === "unknown" ? "neutral" : i.needed ? "danger" : "warning",
    word: i.state === "ok" ? "Ready" : i.state === "unknown" ? "Not checked" : "Needs fixing",
    optional: !i.needed && i.state !== "ok",
    explain: i.state === "ok" ? "" : i.explain,
    command: i.state === "ok" ? undefined : i.command,
    link: i.state === "ok" ? undefined : i.link,
    version: i.version,
  }));
}

export function summaryText(r) {
  if (r?.ready) return "Everything is ready.";
  const plural = (n) => (n === 1 ? "thing" : "things");
  const parts = [];
  if (r?.problems) parts.push(`${r.problems} ${plural(r.problems)} to fix.`);
  if (r?.unchecked) parts.push(`${r.unchecked} ${plural(r.unchecked)} could not be checked. Check again.`);
  return parts.join(" ");
}

/** Draws the page into `box`. Returns a cleanup: an answer that arrives after it neither redraws, toasts nor moves focus. */
export async function renderSetupCheck(box, { a = api, admin = false, readOnly = false, needs = [], clipboard = pageClipboard(), notify = toast } = {}) {
  if (!admin || readOnly) {
    mount(box, h("div", { class: "card" }, h("h1", {}, "Setup check"), h("p", {}, ASK_ADMIN)));
    return () => {};
  }
  let gone = false;
  let busy = false;
  let report = null;
  const body = h("div", { class: "setup-check" });
  mount(box, body);

  const draw = (focusId) => {
    const buttons = new Map();
    const again = (id, label) => {
      const b = h("button", { type: "button", disabled: busy, onClick: () => check(id) }, label);
      buttons.set(id, b);
      return b;
    };
    const rows = setupRows(report).map((r) => setupRowNode(r, { clipboard, notify, alive: () => !gone, again }));
    mount(body,
      h("h1", {}, "Setup check"),
      h("p", { role: "status" }, summaryText(report)),
      h("p", {}, again("top", "Check again")),
      h("ul", { class: "setup-rows" }, rows),
      h("p", {}, h("a", { href: "#/agents", class: "btn primary" }, "Next: Claude and Codex")));
    if (focusId) buttons.get(focusId)?.focus?.();
  };

  const check = async (focusId) => {
    if (busy || gone) return;
    busy = true;
    if (report) draw(focusId);
    else mount(body, h("h1", {}, "Setup check"), loadingState("Checking this computer", { rows: 4 }));
    try {
      const answer = await a.setupCheck(needs);
      if (gone) return;
      report = answer;
      busy = false;
      draw(focusId);
    } catch (e) {
      if (gone) return;
      busy = false;
      mount(body, h("h1", {}, "Setup check"), errorState(explainError(e, { what: "The setup check could not run." }), { onRetry: () => check("top") }));
    }
  };

  await check();
  return () => {
    gone = true;
  };
}

const KNOWN_NEEDS = ["node"];

/** The extra tools a page address asks for (`#/setup?need=node`); anything not on the list is dropped. */
export function needsOf(query) {
  const raw = typeof query === "string" ? query.replace(/^\?/, "") : "";
  const out = [];
  for (const v of new URLSearchParams(raw).getAll("need").flatMap((s) => s.split(","))) {
    if (KNOWN_NEEDS.includes(v.trim()) && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
}
