import { api } from "./api.js";
import { h, mount, toast } from "./dom.js";
import { nextParts } from "./next.js";
import { lastOkText } from "./admin.js";

export const REFRESH_MS = 30_000;
const NO_ANSWER = "The Foundry server does not answer. Check that it is still running.";

const findingsLink = ({ open, unreadable }) => (unreadable ? "Findings of the monitor (the file cannot be read)" : open > 0 ? `${open} open finding${open === 1 ? "" : "s"} of the monitor` : "Findings of the monitor (none open)");

/** A name for a problem that stays the same between answers: what it is, where, and which text it carries. */
const problemKey = (n) => [n.kind, n.runId, n.repo, n.issue, n.title, n.action].filter((x) => x != null && x !== "").join("|");

/** Draws the line for one answer of GET /api/health; `health` null: the server did not answer. */
export function renderHealth(el, health, { onCancel } = {}) {
  el.hidden = false;
  if (!health) {
    el.setAttribute("class", "health bad");
    mount(el, h("b", {}, NO_ANSWER));
    return;
  }
  el.setAttribute("class", health.ok ? "health ok" : "health bad");
  const problems = health.problems ?? [];
  const repos = health.repos ?? [];
  const skills = health.skillProblems ?? [];
  mount(el,
    h("b", {}, health.summary),
    problems.length ? h("ul", { class: "holds" }, problems.map((n) => h("li", {},
      nextParts(n, { status: false, focus: `health-${problemKey(n)}` }),
      n.kind === "closed_elsewhere" && n.runId ? h("button", { class: "small danger", "data-focus": `health-cancel-${n.runId}`, onClick: () => onCancel?.(n.runId) }, "Cancel run") : null))) : null,
    skills.length ? h("ul", { class: "holds" }, [
      ...skills.map((p) => h("li", {}, `Skills (${p.root}${p.package ? " / " + p.package : ""}): ${p.reason}`)),
      health.skillProblemsMore > 0 ? h("li", {}, `and ${health.skillProblemsMore} more skill problem${health.skillProblemsMore === 1 ? "" : "s"}: run "scf skills" to see all`) : null,
    ]) : null,
    health.monitorFindings ? h("a", { class: "health-findings", "data-focus": "health-findings", href: "#/problems" }, findingsLink(health.monitorFindings)) : null,
    repos.length ? h("span", { class: "health-repos muted" }, repos.map((r) => h("span", {}, h("span", { class: "mono" }, r.repo), lastOkText({ lastOk: r.lastOk })))) : null,
    health.version || health.update ? h("span", { class: "health-version muted" },
      health.version ? `Version ${String(health.version.commit).slice(0, 7)} · ${new Date(health.version.date).toLocaleString()}` : "",
      health.version && health.update ? " · " : "",
      health.update?.text ?? "") : null);
}

let gen = 0; // the newest request wins

/** Asks the server and draws the line; the newest request wins. Never rejects. */
export async function loadHealth(el) {
  const g = ++gen;
  const health = await api.health().catch(() => null);
  if (g !== gen) return;
  renderHealth(el, health, {
    onCancel: async (runId) => {
      if (!confirm("Cancel this run? You can resume it later.")) return;
      await api.cancelRun(runId).catch((e) => toast(e.message, "error"));
      loadHealth(el);
    },
  });
  last = { health };
  showHealth(el, document.getElementById("health-btn"), health);
}

/** Loads the line now, on every page change and every 30 seconds; returns a stop function. */
export function startHealth(el, { every = REFRESH_MS } = {}) {
  const load = () => loadHealth(el);
  load();
  const timer = setInterval(load, every);
  globalThis.addEventListener?.("hashchange", load);
  const chip = document.getElementById("health-btn");
  const toggle = () => {
    open = !open;
    if (last) showHealth(el, chip, last.health);
  };
  chip?.addEventListener?.("click", toggle);
  return () => {
    clearInterval(timer);
    globalThis.removeEventListener?.("hashchange", load);
    chip?.removeEventListener?.("click", toggle);
    open = false;
  };
}

let open = false; // the person pressed the chip
let last = null; // { health } of the newest answer

/** Sets the chip in the top bar and hides the line when all is good and it was not asked for. */
export function showHealth(el, chip, health, isOpen = open) {
  // The line opens by itself only when the server does not answer; a problem turns the chip red and Home lists it.
  el.hidden = health !== null && !isOpen;
  if (!chip) return;
  chip.hidden = false;
  chip.textContent = health ? health.summary : "No answer";
  chip.setAttribute("class", health?.ok ? "health-chip ok" : "health-chip bad");
  chip.setAttribute("aria-expanded", String(!el.hidden));
}
