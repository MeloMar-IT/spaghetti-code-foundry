import { api } from "./api.js";
import { confirmDialog, h, mount, toast } from "./dom.js";
import { allGreen, canContinue, cleanAgentsDraft, knownStep, nextStep, prevStep, progressFrom, requestOf, stepInfo, stepLabel } from "./onboarding-guide-model.js";
import { renderOnboardingAgents } from "./onboarding-agents.js";
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
  go = (hash) => { location.hash = hash; }, agents = renderOnboardingAgents,
} = {}) {
  let gone = false;
  let epoch = 0; // changes with every step and every restart: an answer that arrives for an older one is dropped
  let progress = { step: "welcome", answers: {} };
  let report = null; // the setup check of the computer step
  let failed = false; // the setup check could not be made
  let stopStep = () => {};
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
    const can = canContinue(step, { admin: admin && !readOnly, report, failed });
    mount(navBox, h("p", { class: "row" },
      h("button", { type: "button", "data-focus": "guide-back", onClick: back }, GUIDE.back),
      next && h("button", { type: "button", class: "primary", disabled: !can, "data-focus": "guide-continue", onClick: () => { if (can) goTo(next); } }, GUIDE.next),
      h("button", { type: "button", "data-focus": "guide-again", onClick: restart }, GUIDE.again)));
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

  const later = (info) => mount(stepBox, h("h1", {}, GUIDE.title), h("h2", {}, GUIDE.later.title(info.number)), h("p", {}, GUIDE.later.text));

  function draw() {
    if (gone) return;
    stopStep();
    stopStep = () => {};
    const mine = ++epoch;
    const info = stepInfo(progress.step);
    mount(label, stepLabel(info.id));
    drawNav();
    const done = info.id === "welcome" ? welcome()
      : info.id === "computer" ? computer(mine)
      : info.id === "agents" ? claude(mine)
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
    gone = true;
    epoch++;
    stopStep();
  };
}
