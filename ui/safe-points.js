// Safe points (#863): the recent versions of a project that passed the checks. Words, one pure model and small views, used by the
// Advanced repository page, the Simple project page and the Simple home. Read only: nothing here changes anything.
import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { loadingState } from "./states.js";

export const SAFE = {
  title: "Safe points",
  simpleTitle: "Versions that worked",
  intro: "Recent versions of this project that passed the checks. Nothing is changed here.",
  none: "No version that worked is known yet.",
  partial: "Not all past work was checked, so no version that worked is shown yet.",
  failed: "Could not load the versions that worked.",
  lastGood: (when) => `Last good version: ${when}`,
  release: (tag) => (tag ? `Final version ${tag}` : "Final version"),
  more: (n) => `and ${n} more`,
  by: { you: "started by you", foundry: "started by the Foundry", person: (name) => (name ? `started by ${name}` : "started by someone else") },
  today: "today",
  yesterday: "yesterday",
  reread: "Read again",
  restore: "Restore",
  restoreChecking: "Checking what would be taken back…",
  takenBack: "These changes are taken back:",
  nothingKnown: "No change of the Foundry is known after this version.",
  atLeast: (n) => `and at least ${n} more`,
  yesOpen: "Yes, open the change",
  cancel: "Cancel",
  opening: "Opening the change…",
  opened: (n) => `Opened change #${n}`,
  retry: "Try again",
  restoreFailed: "Could not restore this version.",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "today 13:19", "yesterday 09:02", "3 Nov 13:19" (this year) or "3 Nov 2025"; local time, 24 h. "" for a time that is not one. */
export function whenText(iso, now = Date.now()) {
  const d = new Date(iso);
  if (typeof iso !== "string" || Number.isNaN(d.getTime())) return "";
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000);
  if (days === 0) return `${SAFE.today} ${clock}`;
  if (days === 1) return `${SAFE.yesterday} ${clock}`;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? `${date} ${clock}` : `${date} ${d.getFullYear()}`;
}

/** "Last good version: today 13:19" for the newest point of an answer; "" when there is no answer, no point or no usable time. */
export function lastGoodText(answer, now = Date.now()) {
  const when = whenText(answer?.points?.[0]?.at, now);
  return when ? SAFE.lastGood(when) : "";
}

/** The words of one point: { when, what, who, commit? }. The commit (short id and branch) is for the Advanced view only. */
export function pointLines(point, { simple = false, now = Date.now() } = {}) {
  const titles = (Array.isArray(point?.changes) ? point.changes : []).map((c) => String(c?.title ?? "")).filter(Boolean);
  const rest = Number(point?.moreChanges) > 0 ? ` ${SAFE.more(point.moreChanges)}` : "";
  const what = titles.length ? `${titles.join(", ")}${rest}` : point?.release ? SAFE.release(point.tag) : "";
  const kind = point?.by?.kind;
  const who = kind === "you" ? SAFE.by.you : kind === "foundry" ? SAFE.by.foundry : SAFE.by.person(typeof point?.by?.name === "string" ? point.by.name : "");
  const out = { when: whenText(point?.at, now), what, who };
  if (!simple) out.commit = `${String(point?.short ?? "")} (${String(point?.branch ?? "")})`;
  return out;
}

/** The preview of a restore: the titles that are taken back and the two fixed sentences of the server. All text is drawn as text. */
export function restorePreview(answer) {
  const titles = (Array.isArray(answer?.takenBack) ? answer.takenBack : []).map((t) => String(t ?? "")).filter(Boolean);
  const more = Number(answer?.more) > 0 ? [h("li", {}, SAFE.atLeast(answer.more))] : [];
  const any = titles.length > 0 || more.length > 0;
  return [
    any ? h("p", {}, SAFE.takenBack) : h("p", { class: "muted" }, SAFE.nothingKnown),
    any ? h("ul", {}, titles.map((t) => h("li", {}, t)), more) : null,
    h("p", { class: "muted" }, String(answer?.others ?? "")),
    h("p", { class: "muted" }, String(answer?.notUndone ?? "")),
  ].filter(Boolean);
}

const controls = new Map();
const MAX_CONTROLS = 40;

/** The Restore button of one point, with its preview. One element per project and commit, so a redraw of the page keeps an open preview. */
export function restoreControl(id, point, { a = api } = {}) {
  const key = `${id}:${point?.commit}`;
  const known = controls.get(key);
  if (known) return known;
  const el = h("div", { class: "safe-restore" });
  let preview;
  const show = (...nodes) => mount(el, ...nodes);
  const idle = () => show(h("button", { type: "button", onClick: () => look() }, SAFE.restore));
  const fail = (e, again) => show(h("p", { class: "error", role: "alert" }, e?.message || SAFE.restoreFailed), h("button", { type: "button", onClick: again }, SAFE.retry), h("button", { type: "button", onClick: idle }, SAFE.cancel));
  async function look() {
    show(h("p", { class: "muted" }, SAFE.restoreChecking));
    try {
      preview = await a.restoreSafePoint(id, { commit: point.commit, dryRun: true });
    } catch (e) {
      return fail(e, look);
    }
    show(...restorePreview(preview), h("button", { type: "button", onClick: () => open() }, SAFE.yesOpen), h("button", { type: "button", onClick: idle }, SAFE.cancel));
  }
  async function open() {
    show(h("p", { class: "muted" }, SAFE.opening));
    try {
      const made = await a.restoreSafePoint(id, { commit: point.commit, confirm: preview?.confirm?.token });
      const url = typeof made?.url === "string" && made.url.startsWith("https://") ? made.url : "";
      show(h("p", {}, url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, SAFE.opened(made.issue)) : SAFE.opened(made?.issue)));
    } catch (e) {
      fail(e, look);
    }
  }
  idle();
  controls.set(key, el);
  while (controls.size > MAX_CONTROLS) controls.delete(controls.keys().next().value);
  return el;
}

/** The nodes of the list. `answer` undefined: the read failed (a quiet note). All text is drawn as text. */
export function safePointsView(answer, { simple = false, now = Date.now(), restore } = {}) {
  if (!answer || !Array.isArray(answer.points)) return [h("p", { class: "muted" }, SAFE.failed)];
  if (!answer.points.length) return [h("p", { class: "muted" }, answer.complete === false ? SAFE.partial : SAFE.none)];
  return [
    h("p", { class: "muted" }, SAFE.intro),
    h("ul", { class: "safe-points" }, answer.points.map((p) => {
      const l = pointLines(p, { simple, now });
      return h("li", {},
        h("strong", {}, l.when), l.what ? ` — ${l.what}` : "", " ",
        h("span", { class: "muted" }, l.commit ? `${l.who} · ${l.commit}` : l.who),
        restore ? restoreControl(restore.id, p, restore.a ? { a: restore.a } : {}) : null);
    })),
  ];
}

/** The Advanced section: loads once, draws the list, "Read again" loads again. */
export function safePointsPart(id, { a = api } = {}) {
  const el = h("div", {});
  let loads = 0;
  const reread = h("button", { type: "button", onClick: () => reload() }, SAFE.reread);
  function reload() {
    const my = ++loads;
    mount(el, loadingState("Loading the safe points…", { rows: 2 }));
    Promise.resolve().then(() => a.safePoints(id)).then(
      (answer) => { if (my === loads) mount(el, ...safePointsView(answer, { restore: { id, a } }), reread); },
      () => { if (my === loads) mount(el, ...safePointsView(undefined), reread); });
  }
  reload();
  return { el };
}
