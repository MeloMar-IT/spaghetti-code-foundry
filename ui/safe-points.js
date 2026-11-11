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

/** The nodes of the list. `answer` undefined: the read failed (a quiet note). All text is drawn as text. */
export function safePointsView(answer, { simple = false, now = Date.now() } = {}) {
  if (!answer || !Array.isArray(answer.points)) return [h("p", { class: "muted" }, SAFE.failed)];
  if (!answer.points.length) return [h("p", { class: "muted" }, answer.complete === false ? SAFE.partial : SAFE.none)];
  return [
    h("p", { class: "muted" }, SAFE.intro),
    h("ul", { class: "safe-points" }, answer.points.map((p) => {
      const l = pointLines(p, { simple, now });
      return h("li", {},
        h("strong", {}, l.when), l.what ? ` — ${l.what}` : "", " ",
        h("span", { class: "muted" }, l.commit ? `${l.who} · ${l.commit}` : l.who));
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
      (answer) => { if (my === loads) mount(el, ...safePointsView(answer), reread); },
      () => { if (my === loads) mount(el, ...safePointsView(undefined), reread); });
  }
  reload();
  return { el };
}
