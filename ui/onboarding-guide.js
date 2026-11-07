import { api } from "./api.js";
import { confirmDialog, h, mount, toast } from "./dom.js";
import { allGreen, canContinue, cleanAgentsDraft, clearGuideReturn, isId, knownStep, makeOutcome, markGuideReturn, nextStep, prevStep, progressFrom, requestOf, stepInfo, stepLabel, withAnswer } from "./onboarding-guide-model.js";
import { renderOnboardingAgents } from "./onboarding-agents.js";
import { aboutStep, makeStep, whereStep } from "./onboarding-project.js";
import { safeStore } from "./shell.js";
import { chooseView } from "./view-mode.js";
import { pageClipboard, setupRowNode, setupRows } from "./setup-check.js";
import { GUIDE, forbiddenIn } from "./simple-words.js";
import { errorState, explainError, loadingState } from "./states.js";

// Get started (#/start-guide): one step at a time. The step reached and the answers so far are saved per account on the server.

// Every save and clear of every guide on this page goes through one queue, in the order it was asked. So an older save never lands after
// a newer one or after Start again, and a guide opened again reads only after the saves of the one before it are done.
let tail = Promise.resolve();
const enqueue = (job) => {
  const p = tail.then(job);
  tail = p.catch(() => {});
  return p;
};

const text = (s) => (forbiddenIn(s).length ? "" : s);

export async function renderOnboardingGuide(box, {
  a = api, admin = false, readOnly = false, credentialsHref = "#/credentials", clipboard = pageClipboard(), notify = toast, ask = confirmDialog,
  go = (hash) => { location.hash = hash; }, agents = renderOnboardingAgents, simple = false, store = safeStore(), choose = chooseView,
} = {}) {
  let gone = false;
  let epoch = 0; // changes with every step and every restart: an answer that arrives for an older one is dropped
  let progress = { step: "welcome", answers: {} };
  let report = null; // the setup check of the computer step
  let failed = false; // the setup check could not be made
  let stopStep = () => {};
  let current = null; // the controller of step 3, 4 or 5 (onboarding-project.js)
  let makePromise = null; // a project is being made
  let status = "";
  const stepBox = h("div", {});
  const statusBox = h("p", { role: "status" });
  const navBox = h("div", {});
  const label = h("p", { class: "muted" });
  const root = h("div", { class: "simple onboarding-guide" }, label, stepBox, statusBox, navBox);
  mount(box, root);

  const setStatus = (s) => {
    status = s;
    if (!gone) mount(statusBox, status);
  };
  const live = (mine) => !gone && mine === epoch;

  // Saves the progress now. A failed save only shows a quiet line: the person goes on.
  const save = () => {
    const body = requestOf(progress);
    const mine = epoch;
    enqueue(() => a.saveOnboardingProgress(body)).then(
      () => { if (live(mine) && status) setStatus(""); },
      () => { if (!gone) setStatus(GUIDE.notSaved); },
    );
  };

  const drawNav = () => {
    if (gone) return;
    const step = knownStep(progress.step);
    const next = nextStep(step);
    const busy = !!makePromise;
    const can = !busy && (current ? current.canContinue() : canContinue(step, { admin: admin && !readOnly, report, failed }));
    const mine = epoch;
    const forward = async () => {
      if (!can || busy) return;
      if (current?.onContinue && !(await current.onContinue())) return;
      if (live(mine)) goTo(next);
    };
    mount(navBox, h("p", { class: "row" },
      h("button", { type: "button", disabled: busy, "data-focus": "guide-back", onClick: () => { if (!busy) back(); } }, GUIDE.back),
      next && h("button", { type: "button", class: "primary", disabled: !can, "data-focus": "guide-continue", onClick: forward }, GUIDE.next),
      h("button", { type: "button", disabled: busy, "data-focus": "guide-again", onClick: () => { if (!busy) restart(); } }, GUIDE.again)));
  };

  const welcome = () => mount(stepBox, h("h1", {}, GUIDE.title), h("h2", {}, GUIDE.welcome.title), GUIDE.welcome.lines.map((l) => h("p", {}, l)));

  const computer = async (mine) => {
    const title = GUIDE.computer.title;
    if (!admin || readOnly) return mount(stepBox, h("h1", {}, GUIDE.title), h("h2", {}, title), h("p", {}, GUIDE.computer.askAdmin));
    report = null;
    failed = false;
    mount(stepBox, h("h1", {}, GUIDE.title), h("h2", {}, title), loadingState(GUIDE.computer.checking, { rows: 4 }));
    drawNav();
    const check = async () => {
      try {
        const answer = await a.setupCheck([]);
        if (!live(mine)) return;
        report = answer;
        failed = false;
      } catch (e) {
        if (!live(mine)) return;
        report = null;
        failed = true;
        mount(stepBox, h("h1", {}, GUIDE.title), h("h2", {}, title), errorState(explainError(e, { what: GUIDE.computer.couldNotCheck }), { onRetry: () => again() }));
        drawNav();
        return;
      }
      const rows = setupRows(report).map((r) => setupRowNode(r, { clipboard, notify, alive: () => live(mine), text }));
      mount(stepBox,
        h("h1", {}, GUIDE.title),
        h("h2", {}, title),
        h("p", { role: "status" }, allGreen(report) ? GUIDE.computer.ready : GUIDE.computer.notReady),
        h("ul", { class: "setup-rows" }, rows),
        h("p", {}, h("button", { type: "button", "data-focus": "guide-check", onClick: () => again() }, GUIDE.computer.checkAgain)));
      drawNav();
    };
    const again = () => {
      report = null;
      mount(stepBox, h("h1", {}, GUIDE.title), h("h2", {}, title), loadingState(GUIDE.computer.checking, { rows: 4 }));
      drawNav();
      return check();
    };
    await check();
  };

  // The questions of "Claude and Codex", drawn inside the guide. Its draft goes to the server on every change.
  const claude = (mine) => {
    if (!admin || readOnly) return mount(stepBox, h("h1", {}, "Claude and Codex"), h("p", {}, GUIDE.agents.askAdmin));
    const inner = h("div", {});
    mount(stepBox, inner);
    const onDraft = (d) => {
      if (!live(mine)) return;
      const answers = { ...progress.answers };
      if (d?.done) answers.agents = { draft: d.draft, step: null, done: true };
      else if (d?.draft?.have) answers.agents = { draft: d.draft, step: d.step };
      else delete answers.agents;
      if (JSON.stringify(answers) === JSON.stringify(progress.answers)) return;
      progress = { ...progress, answers };
      save();
    };
    const run = Promise.resolve(agents(inner, { a, admin, readOnly, simple: true, again: false, credentialsHref, clipboard, notify, ask, resume: cleanAgentsDraft(progress.answers.agents) ?? { fresh: true }, onDraft }));
    stopStep = () => void run.then((off) => off?.(), () => {});
    return run.then(() => {}, (e) => {
      if (live(mine)) mount(inner, errorState(explainError(e, { what: GUIDE.loadFailed })));
    });
  };

  // Makes the project of steps 3 to 5 once. The server holds "made once" (guide: true); a lost answer is settled by reading the place again.
  const adopt = (id) => { progress = withAnswer(progress, "repoId", id); };
  const makeProject = () => {
    if (isId(progress.answers.repoId)) return Promise.resolve({ ok: true });
    if (makePromise) return makePromise;
    makePromise = (async () => {
      try {
        await tail; // saves asked before the press land first
        const { starter, name } = progress.answers;
        const r = await a.startProject(starter, { name: String(name ?? "").trim(), guide: true });
        if (!isId(r?.repo?.id)) return { ok: false, kind: "other" };
        adopt(r.repo.id);
        return { ok: true };
      } catch (e) {
        const kind = makeOutcome(e);
        if (kind === "exists" || kind === "lost") {
          try {
            const reply = await a.onboardingProgress();
            if (isId(reply?.answers?.repoId)) {
              adopt(reply.answers.repoId);
              return { ok: true };
            }
          } catch { /* the place could not be read either: the person can try again */ }
        }
        return { ok: false, kind };
      } finally {
        makePromise = null;
        drawNav();
      }
    })();
    drawNav();
    return makePromise;
  };

  // Saves the place, marks the way back and opens the page to connect GitHub. The marker stays until the guide is reached again.
  const connectGithub = async () => {
    try {
      await enqueue(() => a.saveOnboardingProgress(requestOf(progress)));
    } catch {
      if (!gone) setStatus(GUIDE.notSaved);
    }
    if (gone) return;
    markGuideReturn(store, simple ? "simple" : "advanced");
    if (!simple) return go("#/repos");
    const r = await choose("advanced", { hash: () => "#/repos" });
    if (r && !gone) setStatus(r);
  };

  const setAnswer = (key, value, saveNow = true) => {
    progress = withAnswer(progress, key, value);
    if (saveNow) save();
  };

  const later = (info) => mount(stepBox, h("h1", {}, GUIDE.title), h("h2", {}, GUIDE.later.title(info.number)), h("p", {}, GUIDE.later.text));

  function draw() {
    if (gone) return;
    stopStep();
    stopStep = () => {};
    current = null;
    const mine = ++epoch;
    const info = stepInfo(progress.step);
    mount(label, stepLabel(info.id));
    const env = { a, admin: admin && !readOnly, box: stepBox, answers: () => progress.answers, setAnswer, saveNow: save, redrawNav: () => { if (live(mine)) drawNav(); }, live: () => live(mine), goTo, making: () => !!makePromise, make: makeProject, connectGithub };
    const maker = { "step-3": makeStep, "step-4": aboutStep, "step-5": whereStep }[info.id];
    if (maker) {
      current = maker(env);
      stopStep = () => current?.stop?.();
    }
    drawNav();
    const done = info.id === "welcome" ? welcome()
      : info.id === "computer" ? computer(mine)
      : info.id === "agents" ? claude(mine)
      : current ? current.start()
      : later(info);
    Promise.resolve(done).catch(() => {});
  }

  function goTo(id) {
    if (gone) return;
    progress = { ...progress, step: id };
    save();
    draw();
  }

  function back() {
    const prev = prevStep(progress.step);
    if (prev === null) go("#/home");
    else goTo(prev);
  }

  async function restart() {
    const ok = await ask(GUIDE.againConfirm);
    if (!ok || gone) return;
    progress = { step: "welcome", answers: {} };
    const mine = epoch + 1; // the draw below
    enqueue(() => a.clearOnboardingProgress()).then(
      () => { if (live(mine) && status) setStatus(""); },
      () => { if (!gone) setStatus(GUIDE.notSaved); },
    );
    draw();
  }

  async function load() {
    const mine = ++epoch;
    mount(stepBox, h("h1", {}, GUIDE.title), loadingState(GUIDE.loading, { rows: 3 }));
    mount(label, "");
    clearGuideReturn(store);
    await tail; // the saves of an earlier guide on this page come first
    let reply;
    try {
      reply = await a.onboardingProgress();
    } catch (e) {
      if (live(mine)) mount(stepBox, h("h1", {}, GUIDE.title), errorState(explainError(e, { what: GUIDE.loadFailed }), { onRetry: load }));
      return;
    }
    if (!live(mine)) return;
    progress = progressFrom(reply);
    draw();
  }

  await load();
  return () => {
    current?.leave?.();
    gone = true;
    epoch++;
    stopStep();
  };
}
