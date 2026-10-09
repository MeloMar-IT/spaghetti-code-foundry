import { api } from "./api.js";
import { h, mount, toast } from "./dom.js";
import { dialogOpen, keepScroll, liveStates, poller } from "./live.js";
import { ISSUE_UNCHECKED, whereTarget } from "./next.js";
import { ownerLabel } from "./runs.js";
import { setCount } from "./shell.js";
import { actButtons } from "./turn-act.js";

// The "Your turn" page: only what waits for the owner, from GET /api/your-turn. No wording of
// its own except labels; the text of each item comes from its next-step record.

export const TITLE = "Spaghetti Code Foundry";
export const tabTitle = (count) => (count > 0 ? `(${count}) Foundry` : TITLE);

/** The page to open at start: Your turn, when something waits and the URL names no page. */
export const startHash = (hash, count) => (!hash && count > 0 ? "#/your-turn" : null);

/** The count in the navigation badge and the tab title. */
export function showCount(count) {
  const badge = document.getElementById("turn-badge");
  if (badge) {
    badge.textContent = count > 0 ? String(count) : "";
    badge.hidden = !(count > 0);
  }
  setCount(count);
}

let gen = 0; // the newest request wins
let openOnWaiting = false; // the app opened with nothing waiting and no page chosen: open Your turn when the first item shows

/** Watchers check GitHub after the server starts, so the first answer can be empty. */
function openWhenWaiting(count) {
  if (!openOnWaiting || count <= 0) return;
  openOnWaiting = false;
  if (!globalThis.location?.hash) globalThis.location.hash = "#/your-turn";
}
let page = null; // set while the Your turn page is open: (data) => draws it

/**
 * Asks the server (or runs `call`, which returns the same data), then updates the badge. → the data, or undefined when a
 * newer request won. Does not draw. The failure of an older read (poll, badge) is dropped; a failed action always throws,
 * so its handler can show the error.
 */
async function ask(call = api.yourTurn) {
  const g = ++gen;
  const read = call === api.yourTurn;
  let data;
  try {
    data = await call();
  } catch (e) {
    if (read && g !== gen) return undefined;
    throw e;
  }
  if (g !== gen) return undefined; // a newer request was started; its answer is the one to show
  showCount(data.count);
  openWhenWaiting(data.count);
  return data;
}

/** `ask`, then the open page gets the answer (once, through its poller's `show`). */
export async function refresh(call = api.yourTurn) {
  const data = await ask(call);
  page?.(data); // `show` ignores undefined
  return data;
}

/** Shows the badge now and every 30 seconds; returns the first count (0 when the server does not answer). */
export async function startBadge() {
  const first = await refresh().then((d) => d?.count ?? 0, () => 0);
  openOnWaiting = first === 0 && !!globalThis.location && !globalThis.location.hash;
  // Not the page's poller: this keeps asking every 30 s in a hidden tab too, so the tab title shows the count.
  setInterval(() => refresh().catch(() => {}), 30_000);
  return first;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

/** "14:05" today, "28 Sep, 14:05" on another day, "" for no valid time. */
export function timeText(iso, now = new Date()) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hm}`;
}

/** "since 14:05" today, "since 28 Sep, 14:05" on another day, "" for no valid time. */
export function sinceText(iso, now = new Date()) {
  const t = timeText(iso, now);
  return t ? `since ${t}` : "";
}

const stories = (n) => `${n} ${n === 1 ? "story" : "stories"}`;

/** A bug story as a link (only for an https address), else "#12" as text. */
function storyLink(s, focus) {
  return typeof s.url === "string" && s.url.startsWith("https://")
    ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer", "data-focus": focus }, `#${s.issue}`)
    : h("span", {}, `#${s.issue}`);
}

const turnHead = (embedded, count = 0) =>
  embedded ? h("h2", {}, count > 0 ? `Needs you (${count})` : "Needs you") : h("div", { class: "toolbar" }, h("h1", {}, "Your turn"));

function itemView(item, { onDismiss, onLeave, onAct }) {
  const n = item.next;
  const k = item.key;
  // The buttons of an item are named by what they say, so a button that appears or goes does not change the others' names.
  const slug = (el) => el.textContent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const named = (btn) => {
    btn.setAttribute("data-focus", `turn-act-${slug(btn)}-${k}`);
    return btn;
  };
  const issueOk = n.issue && /^[\w.-]+\/[\w.-]+$/.test(n.repo ?? "");
  const target = whereTarget(n.where);
  const acts = item.acts?.length > 0 && onAct;
  const cls = acts ? "btn" : "btn primary"; // the in-app buttons are the main action; the link stays beside them
  const action = !target
    ? h("span", { class: "muted" }, n.where?.label ?? "")
    : target.external
      ? h("a", { class: cls, href: target.href, target: "_blank", rel: "noopener", "data-focus": `turn-open-${k}`, onClick: () => onLeave(item) }, `${n.where.label} ↗`)
      : h("a", { class: cls, href: target.href, "data-focus": `turn-open-${k}` }, n.where.label);
  const since = sinceText(item.since);
  return h("div", { class: "turn-item" },
    h("div", { class: "turn-main" },
      h("div", {},
        issueOk ? h("a", { href: `https://github.com/${n.repo}/issues/${n.issue}`, target: "_blank", rel: "noopener", class: "mono", "data-focus": `turn-issue-${k}`, onClick: () => onLeave(item) }, `#${n.issue}`) : null,
        issueOk ? " " : null,
        h("b", {}, item.what)),
      h("div", {}, h("span", { class: "hold-action" }, n.action)),
      h("div", { class: "muted" }, n.why),
      n.issueUnchecked ? h("div", { class: "muted" }, ISSUE_UNCHECKED) : null,
      n.evidence?.length ? h("div", { class: "muted" }, n.evidence.map((l) => h("div", {}, l))) : null,
      n.stories?.length ? h("div", {}, "Bug stories: ", n.stories.flatMap((s, i) => [i ? ", " : null, storyLink(s, `turn-story-${k}-${s.issue}`)])) : null,
      item.unblocks > 0 ? h("div", { class: "muted" }, `${stories(item.unblocks)} ${item.unblocks === 1 ? "waits" : "wait"} for this`) : null,
      since ? h("div", { class: "muted", title: new Date(item.since).toLocaleString() }, since) : null,
      ownerLabel(item.ownerName) ? h("div", { class: "muted" }, `Owner: ${ownerLabel(item.ownerName)}`) : null),
    h("div", { class: "turn-side" },
      ...(acts ? actButtons(item, onAct).map(named) : []),
      action,
      item.dismissable ? h("button", { class: "ghost small", "data-focus": `turn-dismiss-${k}`, onClick: () => onDismiss(item.key) }, "Dismiss") : null));
}

/** An item the user acted on: no buttons, the Foundry carries on by itself. */
function continuingView(item) {
  const n = item.next;
  const issueOk = n.issue && /^[\w.-]+\/[\w.-]+$/.test(n.repo ?? "");
  return h("div", { class: "turn-item" },
    h("div", { class: "turn-main" },
      h("div", {},
        issueOk ? h("a", { href: `https://github.com/${n.repo}/issues/${n.issue}`, target: "_blank", rel: "noopener", class: "mono", "data-focus": `turn-done-issue-${item.key}` }, `#${n.issue}`) : null,
        issueOk ? " " : null,
        h("b", {}, item.what)),
      ownerLabel(item.ownerName) ? h("div", { class: "muted" }, `Owner: ${ownerLabel(item.ownerName)}`) : null,
      h("div", { class: "muted" }, "done — continuing")));
}

/** The page for one answer of the server. */
export function turnView(data, { onDismiss, onRestore, onLeave, onAct }, { embedded = false } = {}) {
  return [
    turnHead(embedded, data.count),
    data.count === 0 ? h("div", { class: embedded ? "home-clear" : "empty" }, data.empty) : null,
    ...(data.groups ?? []).map((g) =>
      h("div", { class: "card turn-group" }, h("h3", {}, g.repo), ...g.items.map((i) => itemView(i, { onDismiss, onLeave, onAct })))),
    data.continuing?.length
      ? h("div", { class: "card turn-group" }, h("h3", {}, "Done — continuing"), ...data.continuing.map(continuingView))
      : null,
    data.dismissed > 0
      ? h("p", { class: "muted" }, `${data.dismissed} dismissed `, h("button", { class: "small", "data-focus": "turn-restore", onClick: () => onRestore() }, "Show again"))
      : null,
  ];
}

/** Opens the page; returns a function that closes it. `embedded`: a section of Home; `onData` gets every answer drawn;
 * `focus` is a prefix for the names of the Retry buttons. Never rejects. */
export async function renderYourTurn(main, { embedded = false, onData, focus } = {}) {
  let left; // an item with a watcher whose link was opened: check GitHub again when the user comes back
  const fail = (e) => toast(e.message, "error");
  const handlers = {
    onDismiss: async (key) => {
      try {
        await refresh(() => api.dismissTurn(key));
        // Undo brings back only this item. It stays until used or replaced, so the keyboard can reach it.
        toast("Item dismissed", "info", { sticky: true, action: { label: "Undo", run: () => refresh(() => api.restoreTurn(key)).catch(fail) } });
      } catch (e) {
        fail(e);
      }
    },
    onRestore: () => refresh(() => api.restoreTurn()).catch(fail),
    onLeave: (item) => { if (item.watcher) left = item.watcher; },
    // Wait for the action first: a poll that started meanwhile is older than its answer and must not win.
    onAct: async (body) => {
      const data = await api.actTurn(body);
      await refresh(async () => data);
    },
  };
  let poll;
  const states = liveStates({
    body: main,
    heading: () => turnHead(embedded),
    label: "Loading what needs you",
    what: "Could not load what needs you.",
    quiet: embedded, // Home has its own note; the section shows none
    retry: () => poll.refresh(),
    focus,
  });
  const draw = (data) => {
    const [head, ...rest] = turnView(data, handlers, { embedded });
    keepScroll(main, () => mount(main, head, states.alert, ...rest, states.note));
    onData?.(data);
  };
  const mine = (data) => poll.show(data);
  page = mine;
  poll = poller({
    load: () => ask(),
    draw,
    every: 5000,
    onState: states.onState,
    hold: dialogOpen, // a dialog opened from an item remembers its button: no redraw while it is open
    wake: async () => { // back from a GitHub link: the watcher checks GitHub first
      if (!left) return;
      const id = left;
      left = undefined;
      await api.tickWatcher(id).catch(() => {});
    },
  });
  await poll.ready;
  // Only clear the hook if it is still ours: a newer page may have taken it over.
  return () => {
    poll.stop();
    if (page === mine) page = null;
  };
}
