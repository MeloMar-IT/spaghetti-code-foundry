import { h, mount } from "./dom.js";
import { moveNameProblem, suggestName } from "./repo-move.js";
import { GITHUB, WORDS } from "./simple-words.js";

// "Put this project on GitHub" on the Simple project page: name → check → put it on GitHub → done. All text comes from the word list;
// the server's answer is never shown. There is no field for a secret: without a GitHub sign-in the page only says how to connect one.

/** Does the list have a GitHub record with a token that can make a new place on GitHub? */
export const hasGithubSignIn = (repos) =>
  Array.isArray(repos) && repos.some((r) => r?.method === "github-token" && typeof r.github === "string" && r.github);

/** "token" (can make a new place), "app" (only the GitHub App: an existing place can be chosen in the Advanced view), or "none". */
export function githubSignInKind(repos) {
  if (hasGithubSignIn(repos)) return "token";
  const app = Array.isArray(repos) && repos.some((r) => r?.method === "github-app" && typeof r.github === "string" && r.github);
  return app ? "app" : "none";
}

/** What the dry run says, in numbers. */
export function simplePlan(r) {
  const plan = Array.isArray(r?.stories?.plan) ? r.stories.plan : [];
  const n = (...st) => plan.filter((p) => st.includes(p.status)).length;
  return {
    create: r?.repository === "create",
    github: typeof r?.github === "string" ? r.github : "",
    changes: n("create"),
    already: n("already-moved"),
    blocked: n("unreadable", "too-large"),
  };
}

export const GITHUB_URL = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const bigLink = (href, label, focus, external) => (external
  ? h("a", { class: "btn simple-big", href, target: "_blank", rel: "noopener noreferrer", "data-focus": focus }, label, h("span", { class: "sr-only" }, WORDS.newTab))
  : h("a", { class: "btn primary simple-big", href, "data-focus": focus }, label));

/**
 * The parts, as nodes. `s`: { phase: "idle" | "connect" | "name" | "checking" | "confirm" | "moving" | "done" | "failed" | "stopped",
 * kind, name, private, withDone, problem, plan, repoId, github }.
 */
export function githubMoveView(s, { onStart, onInput, onPrivate, onWithDone, onCheck, onMove, onBack, onNotNow } = {}) {
  const off = s.phase === "checking" || s.phase === "moving" ? true : undefined;
  const btn = (label, focus, onClick, cls = "") => h("button", { type: "button", class: `simple-big ${cls}`.trim(), "data-focus": focus, disabled: off, onClick }, label);
  const notNow = () => btn(GITHUB.notNow, "simple-move-notnow", () => onNotNow?.());
  const box = (...kids) => [h("div", { role: "group", "aria-label": WORDS.actions.github }, ...kids)];
  switch (s.phase) {
    case "connect":
      return box(h("p", { "aria-live": "polite" }, s.kind === "app" ? GITHUB.connectApp : GITHUB.connect), notNow());
    case "name":
    case "checking":
      const nameIn = h("input", { type: "text", "aria-label": GITHUB.nameLabel, "data-focus": "simple-move-name", value: s.name, disabled: off, onInput: () => onInput?.(String(nameIn.value ?? "")) });
      const privIn = h("input", { type: "checkbox", checked: s.private, disabled: off, onChange: () => onPrivate?.(privIn.checked === true) });
      const doneIn = h("input", { type: "checkbox", checked: s.withDone, disabled: off, onChange: () => onWithDone?.(doneIn.checked === true) });
      return box(
        h("h3", {}, GITHUB.step1),
        h("label", { class: "row" }, h("span", {}, GITHUB.nameLabel), nameIn),
        h("label", { class: "row" }, privIn, h("span", {}, GITHUB.private)),
        h("label", { class: "row" }, doneIn, h("span", {}, GITHUB.withDone)),
        h("p", { "aria-live": "polite" }, s.phase === "checking" ? GITHUB.checking : s.problem ? GITHUB.nameProblem : ""),
        btn(GITHUB.next, "simple-move-next", () => onCheck?.(), "primary"), notNow());
    case "confirm":
    case "moving": {
      const p = s.plan ?? simplePlan({});
      return box(
        h("h3", {}, GITHUB.step2),
        h("p", {}, p.create ? GITHUB.willCreate(p.github) : GITHUB.willUse(p.github)),
        p.create ? null : h("p", {}, GITHUB.keepsSeeing),
        h("p", {}, GITHUB.history),
        h("p", {}, GITHUB.changes(p.changes), p.already > 0 ? ` ${GITHUB.already(p.already)}` : ""),
        p.blocked > 0 ? h("p", {}, GITHUB.blocked(p.blocked)) : null,
        h("p", { "aria-live": "polite" }, s.phase === "moving" ? GITHUB.moving : ""),
        p.blocked === 0 ? btn(GITHUB.go, "simple-move-go", () => onMove?.(), "primary") : null,
        btn(GITHUB.back, "simple-move-back", () => onBack?.()), notNow());
    }
    case "done":
      return box(
        h("p", { "aria-live": "polite" }, GITHUB.done),
        bigLink(`#/repos/${encodeURIComponent(s.repoId ?? "")}`, GITHUB.openProject, "simple-move-open", false),
        GITHUB_URL.test(String(s.github ?? "")) ? bigLink(`https://github.com/${s.github}`, GITHUB.openGithub, "simple-move-github", true) : null);
    case "failed":
      return box(h("p", { "aria-live": "polite" }, GITHUB.failed), btn(GITHUB.again, "simple-move-again", () => onBack?.(), "primary"), notNow());
    case "stopped":
      return box(h("p", { "aria-live": "polite" }, GITHUB.stopped));
    default:
      return [h("button", { type: "button", class: "simple-big", "data-focus": "simple-action-github", onClick: () => onStart?.() }, WORDS.actions.github)];
  }
}

const CONNECT_FIRST = /^connect GitHub first/i;

/**
 * Runs the steps for project `id`; `a.moveToGithub(id, body)` makes the calls. `node` draws itself again. One call at a time.
 * `keepsPage()` is true while the move runs and after it worked: the project page keeps `node` even when the project is gone from
 * the list (the move removes the local record).
 */
export function moveController({ id, a }) {
  const node = h("div", { class: "simple-move" });
  const s = { phase: "idle", kind: "none", name: "", private: true, withDone: false, problem: false, plan: null, repoId: "", github: "" };
  let ctx = { kind: "none", name: "" };
  let body = null; // the body of the dry run that was shown
  let busy = false;
  let dead = false;
  const draw = () => mount(node, ...githubMoveView(s, handlers));
  const fail = (e) => (CONNECT_FIRST.test(String(e?.message ?? "")) ? "connect" : null);
  const call = (b) => Promise.resolve().then(() => a.moveToGithub(id, b));

  const handlers = {
    onStart() {
      if (busy) return;
      s.kind = ctx.kind;
      if (ctx.kind !== "token") s.phase = "connect";
      else Object.assign(s, { phase: "name", name: suggestName(ctx.name), problem: false });
      draw();
    },
    onInput(v) { s.name = v; s.problem = false; },
    onPrivate(v) { s.private = v; },
    onWithDone(v) { s.withDone = v; },
    async onCheck() {
      if (busy || dead) return;
      const name = s.name.trim();
      if (moveNameProblem(name, { owner: false })) {
        s.problem = true;
        return draw();
      }
      s.problem = false;
      busy = true;
      s.phase = "checking";
      draw();
      let next = "failed";
      try {
        const r = await call({ target: { create: { name, private: s.private } }, includeClosed: s.withDone, dryRun: true });
        if (dead) return;
        s.plan = simplePlan(r);
        body = { target: { create: { name, private: s.private } }, includeClosed: s.withDone, dryRun: false };
        next = "confirm";
      } catch (e) {
        if (dead) return;
        next = fail(e) ?? "failed";
      }
      busy = false;
      s.phase = next;
      draw();
    },
    async onMove() {
      if (busy || dead || !body || !s.plan || s.plan.blocked > 0) return;
      busy = true;
      s.phase = "moving";
      draw();
      let next = "stopped";
      try {
        const r = await call(body);
        if (dead) return;
        s.repoId = String(r?.repoId ?? "");
        s.github = typeof r?.github === "string" ? r.github : "";
        next = "done";
      } catch (e) {
        if (dead) return;
        // a refusal before anything ran leaves the project as it was; any other failure may have stopped half way
        next = fail(e) ?? "stopped";
      }
      busy = false;
      s.phase = next;
      draw();
    },
    onBack() {
      if (busy) return;
      s.phase = "name";
      draw();
    },
    onNotNow() {
      if (busy) return;
      s.phase = "idle";
      draw();
    },
  };
  draw();
  return {
    node,
    /** The page tells whether a sign-in exists (`kind`: "token" | "app" | "none") and the project's name. */
    setContext(c) {
      ctx = { kind: c?.kind ?? "none", name: String(c?.name ?? "") };
      if (s.phase === "idle") draw();
    },
    isDone: () => s.phase === "done",
    keepsPage: () => s.phase === "moving" || s.phase === "done" || s.phase === "stopped",
    stop() { dead = true; },
  };
}
