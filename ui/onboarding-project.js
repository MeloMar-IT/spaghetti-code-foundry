import { h, mount } from "./dom.js";
import {
  GUIDE_LIMITS, aboutOf, canContinue, guideReturnView, isId, nameProblem, returnToGuide, starterChoices,
} from "./onboarding-guide-model.js";
import { githubSignInKind } from "./simple-move.js";
import { GUIDE, forbiddenIn } from "./simple-words.js";
import { errorState, explainError, loadingState } from "./states.js";
import { chooseView } from "./view-mode.js";

// Steps 3 to 5 of the Get started guide: what to make, tell us about it, where to keep it. Each step is a controller:
// `{ start(), canContinue(), onContinue?(), leave?(), stop() }`. The guide (onboarding-guide.js) owns the progress and the buttons.
//
// env = { a, admin, box, answers(), setAnswer(key, value, save = true), saveNow(), redrawNav(), live(), goTo(id), making(), make(), connectGithub() }
// `admin` is true only for an admin who is not in a read-only preview: anyone else makes no starter or project call.

const text = (s) => (forbiddenIn(s).length ? "" : s);
const heading = (title) => [h("h1", {}, GUIDE.title), h("h2", {}, title)];

// ---- step 3: what to make ----------------------------------------------------------------------------------------

export function makeStep(env) {
  const { a, admin, box, answers, setAnswer, redrawNav, live } = env;
  const W = GUIDE.make;
  let choices = [];
  let stopped = false;
  const ok = () => !stopped && live();

  const pick = (id) => {
    if (isId(answers().repoId) || answers().starter === id) return;
    setAnswer("starter", id);
    drawChoices();
    redrawNav();
  };

  function drawChoices() {
    const made = isId(answers().repoId);
    const items = choices.map((c) => {
      const on = answers().starter === c.id;
      return h("li", {},
        h("button", { type: "button", class: on ? "primary" : "", "aria-pressed": on ? "true" : "false", disabled: made, "data-focus": `guide-starter-${c.id}`, onClick: () => pick(c.id) }, text(c.title) || c.id),
        h("p", {}, text(c.description)),
        W.examples[c.id] ? h("p", { class: "muted" }, W.examples[c.id]) : null);
    });
    mount(box, ...heading(W.title), h("p", {}, W.intro), made ? h("p", { role: "status" }, W.made) : null,
      items.length ? h("ul", { class: "choices" }, items) : h("p", {}, W.none));
  }

  async function load() {
    mount(box, ...heading(W.title), loadingState(GUIDE.loading, { rows: 3 }));
    try {
      const reply = await a.starters();
      if (!ok()) return;
      choices = starterChoices(reply);
    } catch (e) {
      if (ok()) mount(box, ...heading(W.title), errorState(explainError(e, { what: W.loadFailed }), { onRetry: load }));
      return;
    }
    drawChoices();
    redrawNav();
  }

  return {
    start() {
      if (!admin) {
        mount(box, ...heading(W.title), h("p", {}, W.askAdmin));
        return undefined;
      }
      return load();
    },
    canContinue: () => canContinue("step-3", { admin, answers: answers(), starterIds: choices.map((c) => c.id) }),
    stop() { stopped = true; },
  };
}

// ---- step 4: tell us about it ------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const NOT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const NOT_LINE = /[\u0000-\u001f\u007f-\u009f]/g;

export function aboutStep(env) {
  const { box, answers, setAnswer, redrawNav, saveNow } = env;
  const W = GUIDE.about;
  let dirty = false;
  let problemBox = null;

  // The typed text goes into the progress at once (so Continue and leaving see it); it is saved on change and when the step is left.
  const put = (field, value, save) => {
    const cur = answers();
    if (field === "name") {
      if (problemBox) problemBox.nameRaw = value;
      if (nameProblem(value) === "control") {
        problems();
        redrawNav();
        return; // never saved: the server would refuse it
      }
      setAnswer("name", value === "" ? null : value, save);
    } else if (field === "style") setAnswer("style", value === "" ? null : value.replace(NOT_LINE, ""), save);
    else {
      const about = { ...(cur.about && typeof cur.about === "object" && !Array.isArray(cur.about) ? cur.about : {}) };
      const clean = field === "what" ? value.replace(NOT_TEXT, "") : value.replace(NOT_LINE, "");
      if (clean === "") delete about[field];
      else about[field] = clean;
      setAnswer("about", Object.keys(about).length ? about : null, save);
    }
    dirty = !save;
    problems();
    redrawNav();
  };

  const problems = () => {
    if (!problemBox) return;
    const a = aboutOf(answers());
    const raw = (problemBox.nameRaw ?? a.name);
    const p = nameProblem(raw);
    mount(problemBox.name, p && raw !== "" ? W.nameProblems[p] : "");
  };

  const field = (id, label, value, { area = false, max }) => {
    const props = { id, name: id, value, maxlength: max, "data-focus": id, disabled: isId(answers().repoId) };
    const input = h(area ? "textarea" : "input", area ? { ...props, rows: 4 } : { ...props, type: "text" });
    input.value = value;
    input.addEventListener("input", (e) => put(id.replace("guide-", ""), String(e.target?.value ?? input.value), false));
    input.addEventListener("change", (e) => put(id.replace("guide-", ""), String(e.target?.value ?? input.value), true));
    return [h("label", { for: id }, label), input];
  };

  return {
    start() {
      const a = aboutOf(answers());
      const made = isId(answers().repoId);
      const nameProblemBox = h("p", { role: "status", class: "muted" });
      problemBox = { name: nameProblemBox, nameRaw: undefined };
      mount(box, ...heading(W.title),
        made ? h("p", { role: "status" }, W.locked) : null,
        h("div", {},
          field("guide-who", W.who, a.who, { max: GUIDE_LIMITS.who }),
          field("guide-what", W.what, a.what, { area: true, max: GUIDE_LIMITS.what }),
          field("guide-name", W.name, a.name, { max: GUIDE_LIMITS.name }),
          nameProblemBox,
          answers().starter === "website" ? field("guide-style", W.style, a.style, { max: GUIDE_LIMITS.style }) : null));
      problems();
      return undefined;
    },
    canContinue: () => canContinue("step-4", { answers: answers() }) && !(problemBox?.nameRaw !== undefined && nameProblem(problemBox.nameRaw) === "control"),
    leave() { if (dirty) saveNow(); },
    stop() {},
  };
}

// ---- step 5: where to keep it ------------------------------------------------------------------------------------

export function whereStep(env) {
  const { a, admin, box, answers, setAnswer, redrawNav, live, goTo } = env;
  const W = GUIDE.where;
  let github = false; // GitHub is connected
  let problem = null; // the kind of the last failed make
  let stopped = false;
  const ok = () => !stopped && live();
  const where = () => (answers().where === "github" ? "github" : "local");

  const choose = (v) => {
    if (where() === v && answers().where !== undefined) return;
    setAnswer("where", v);
    if (v === "github") void readGithub();
    draw();
    redrawNav();
  };

  async function readGithub() {
    try {
      const repos = await a.repos();
      github = githubSignInKind(repos) !== "none";
    } catch {
      github = false; // a failed read counts as not connected
    }
    if (!ok()) return;
    draw();
    redrawNav();
  }

  const message = () => {
    if (!problem) return null;
    const row = (t, ...buttons) => h("div", { role: "alert" }, h("p", {}, t), h("p", { class: "row" }, ...buttons));
    const btn = (label, focus, fn) => h("button", { type: "button", "data-focus": focus, onClick: fn }, label);
    if (problem === "exists") return row(W.exists, btn(W.rename, "guide-rename", () => goTo("step-4")));
    if (problem === "gone") return row(W.gone, btn(W.chooseAgain, "guide-choose", () => goTo("step-3")));
    if (problem === "name") return row(W.nameBad, btn(W.rename, "guide-rename", () => goTo("step-4")));
    if (problem === "lost") return row(W.lost, btn(W.retry, "guide-retry", retry));
    if (problem === "denied") return row(W.askAdmin);
    return row(W.other);
  };

  function draw() {
    if (!ok()) return;
    const id = answers().repoId;
    if (!admin) return mount(box, ...heading(W.title), h("p", {}, W.askAdmin));
    if (isId(id)) {
      return mount(box, ...heading(W.title), h("p", { role: "status" }, W.made),
        h("p", {}, h("a", { href: `#/repos/${id}`, "data-focus": "guide-open" }, W.open)));
    }
    const on = where();
    const option = (v, label, body, focus) => h("li", {},
      h("button", { type: "button", class: on === v ? "primary" : "", "aria-pressed": on === v ? "true" : "false", disabled: env.making(), "data-focus": focus, onClick: () => choose(v) }, label),
      h("p", {}, body));
    mount(box, ...heading(W.title),
      h("ul", { class: "choices" }, option("local", W.local, W.localText, "guide-where-local"), option("github", W.github, W.githubText, "guide-where-github")),
      on === "github" ? (github
        ? h("p", { role: "status" }, W.connected)
        : h("p", {}, h("button", { type: "button", "data-focus": "guide-github", disabled: env.making(), onClick: () => env.connectGithub() }, W.connect))) : null,
      env.making() ? h("p", { role: "status" }, W.making) : null,
      message());
  }

  // Makes the project (once: the guide and the server both see to that). True when it is made.
  async function onContinue() {
    if (!admin || isId(answers().repoId)) return true;
    problem = null;
    draw();
    const r = await env.make();
    if (stopped) return r.ok;
    if (r.ok) {
      draw();
      return true;
    }
    problem = r.kind;
    draw();
    redrawNav();
    return false;
  }

  async function retry() {
    const mine = live;
    if (await onContinue() && mine()) goTo("step-6");
  }

  return {
    start() {
      draw();
      if (admin && where() === "github" && !isId(answers().repoId)) return readGithub();
      return undefined;
    },
    canContinue: () => canContinue("step-5", { admin, answers: answers(), github }),
    onContinue,
    stop() { stopped = true; },
  };
}

// ---- the way back from the page to connect GitHub ---------------------------------------------------------------

export const backToGuide = (store, choose = chooseView, go = (x) => { location.hash = x; }) => returnToGuide({ store, choose, go });

/** The "Back to Get started" button for the repositories page; null when there is no marker. A problem text goes to `notify`. */
export function guideReturnNode({ store, toGuide, notify }) {
  if (!guideReturnView(store)) return null;
  return h("button", { type: "button", "data-focus": "guide-return", onClick: async () => {
    const r = await toGuide();
    if (r) notify(r);
  } }, GUIDE.backToGuide);
}
