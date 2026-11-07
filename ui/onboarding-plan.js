import { h, mount } from "./dom.js";
import {
  ACCEPT_REASON, MAX_BUILD_ACTIONS, canContinue, guideWatcherId, isId, issuesWatcherOf, nextBuildAction, planItems, planPhase,
} from "./onboarding-guide-model.js";
import { GUIDE, plainWords, safeText } from "./simple-words.js";
import { loadingState } from "./states.js";

// Steps 6 and 7 of the Get started guide: your plan, and watch it grow. Each step is a controller like those of onboarding-project.js:
// `{ start(), canContinue(), leave?(), stop() }`.
//
// env = { a, admin, box, answers(), setAnswer(key, value, save = true), persist(), redrawNav(), live(), goTo(id), go(hash), ask(dialog), wait(ms) }
// `persist()` saves the guide now and returns a promise that fails when the save fails: nothing is built on an answer that was not stored.

const POLL_MS = 4000;

/** A save of the guide's answers that did not work (as opposed to a call to the Foundry that did not). */
class SaveFailed extends Error {}
const heading = (title) => [h("h1", {}, GUIDE.title), h("h2", {}, title)];

/**
 * Makes sure the project has an enabled watcher for its stories, then asks it to look now. An enabled one that is there is used; else
 * `guide-<8 characters of the id>` is added (or switched on again). A failed look is not a failure: the watcher looks again by itself.
 */
export async function ensureWatcher(a, repoId) {
  const id = guideWatcherId(repoId);
  let found = issuesWatcherOf(await a.repoWatchers(repoId));
  if (!found) {
    try {
      found = await a.addRepoWatcher(repoId, { id, source: "issues" });
    } catch (e) {
      if (e?.status !== 409) throw e;
      const rows = await a.repoWatchers(repoId); // made meanwhile (another tab), or switched off
      const own = (Array.isArray(rows) ? rows : []).find((w) => w?.id === id);
      found = issuesWatcherOf(rows) ?? (own && own.enabled === false ? await a.saveRepoWatcher(repoId, id, { enabled: true }) : own);
      if (!found) throw e;
    }
  }
  try {
    await a.tickWatcher(found.id ?? id);
  } catch { /* it looks again by itself */ }
  return found;
}

// ---- step 6: your plan -------------------------------------------------------------------------------------------

export function planStep(env) {
  const { a, admin, box, answers, setAnswer, persist, redrawNav, live, goTo, go, ask } = env;
  const wait = env.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const W = GUIDE.plan;
  let stopped = false;
  let session = null; // the latest view of the guide's session
  let building = false;
  let message = ""; // a plain text under the plan
  let blockedDraft = null; // a draft whose plan item is not met
  let editing = null; // the id of the card being changed
  let pending = 0; // edits (save or remove) asked and not answered yet: a build waits for them
  const asked = { brief: false, plan: false }; // each is asked once per start; a second time is a "try again"
  const ok = () => !stopped && live();
  const repoId = () => answers().repoId;
  const store = async () => {
    try {
      await persist();
    } catch (e) {
      throw new SaveFailed("not saved", { cause: e });
    }
  };

  const show = (...nodes) => { if (ok()) mount(box, ...nodes); };
  const drawWorking = (text = W.working) => show(...heading(W.title), loadingState(text, { rows: 3 }));
  const drawProblem = (text, retry, label = W.retry) =>
    show(...heading(W.title), h("p", { role: "status" }, text), h("p", {}, h("button", { type: "button", class: "primary", "data-focus": "guide-plan-retry", onClick: retry }, label)));

  const cards = () => {
    const items = planItems(session, { title: (s) => safeText(s), what: (s) => plainWords(s) });
    return items.map((it) => {
      if (editing === it.id) return editCard(it);
      const stuck = blockedDraft === it.id;
      return h("li", { class: "plan-item" },
        h("h3", {}, it.title),
        it.what ? h("p", {}, it.what) : null,
        it.published ? h("p", { class: "muted" }, W.onItsWay) : null,
        stuck ? h("p", { role: "status" }, W.blocked) : null,
        h("p", { class: "row" },
          h("button", { type: "button", disabled: building || it.published, "data-focus": `guide-change-${it.id}`, onClick: () => { editing = it.id; drawPlan(); } }, W.change),
          h("button", { type: "button", disabled: building || it.published, "data-focus": `guide-remove-${it.id}`, onClick: () => removeItem(it.id) }, W.remove),
          stuck ? h("button", { type: "button", disabled: building, "data-focus": `guide-recheck-${it.id}`, onClick: () => { blockedDraft = null; message = ""; void build(); } }, W.checkAgain) : null));
    });
  };

  const editCard = (it) => {
    const raw = session.drafts.find((d) => d.id === it.id);
    const title = h("input", { type: "text", id: `guide-plan-title-${it.id}`, name: "title", "data-focus": `guide-plan-title-${it.id}` });
    title.value = String(raw?.title?.text ?? "");
    const what = h("textarea", { id: `guide-plan-what-${it.id}`, name: "what", rows: 4 });
    what.value = String(raw?.what?.text ?? "");
    return h("li", { class: "plan-item" },
      h("label", { for: title.id }, W.titleLabel), title,
      h("label", { for: what.id }, W.whatLabel), what,
      h("p", { class: "row" },
        h("button", { type: "button", class: "primary", "data-focus": `guide-plan-save-${it.id}`, onClick: () => saveItem(it.id, String(title.value), String(what.value)) }, W.save),
        h("button", { type: "button", onClick: () => { editing = null; drawPlan(); } }, W.cancel)));
  };

  function drawPlan() {
    const name = safeText(answers().name) || "your project";
    const items = planItems(session);
    show(...heading(W.title), h("h3", {}, W.headline(name)), h("p", {}, W.intro),
      h("ul", { class: "plan-items" }, cards()),
      message ? h("p", { role: "status" }, message) : null,
      building ? h("p", { role: "status" }, W.building) : null,
      h("p", {}, h("button", { type: "button", class: "primary", disabled: building || editing !== null || pending > 0 || items.length === 0, "data-focus": "guide-build", onClick: () => { message = ""; void build(); } }, W.build)));
  }

  const failed = () => {
    if (!ok()) return;
    message = W.problem;
    building = false;
    editing = null;
    drawPlan();
  };

  // The edit is counted while it is on its way: a build started meanwhile would publish the text from before it.
  async function saveItem(did, title, what) {
    if (building) return;
    pending += 1;
    try {
      session = await a.saveDraft(session.id, did, { title, what });
      editing = null;
      message = "";
    } catch {
      message = W.problem;
    } finally {
      pending -= 1;
    }
    if (ok()) drawPlan();
  }

  async function removeItem(did) {
    if (building || !(await ask(W.removeConfirm)) || !ok()) return;
    pending += 1;
    try {
      session = await a.removeDraft(session.id, did);
      if (blockedDraft === did) blockedDraft = null;
      message = "";
    } catch {
      message = W.problem;
    } finally {
      pending -= 1;
    }
    if (ok()) drawPlan();
  }

  const reread = async () => { session = await a.refinementSession(session.id, true); };

  // Brings the session to a plan: asks the architect to read the project, then to write the plan, and waits for each.
  async function advance() {
    for (;;) {
      if (!ok()) return;
      const phase = planPhase(session);
      if (phase === "working") {
        drawWorking();
        await wait(POLL_MS);
        if (!ok()) return;
        await reread();
      } else if (phase === "stopped") {
        return drawProblem(W.stopped, () => { void retryAsk(); });
      } else if (phase === "need-brief" || phase === "need-plan") {
        const kind = phase === "need-brief" ? "brief" : "plan";
        if (asked[kind]) return drawProblem(kind === "plan" ? W.empty : W.stopped, () => { asked[kind] = false; void run(); });
        asked[kind] = true;
        session = kind === "brief" ? await a.askArchitect(session.id) : await a.askUnderstand(session.id, "simple");
      } else {
        return drawPlan();
      }
    }
  }

  // "Try again" after the architect stopped: asking again resumes a paused run or starts a new one.
  async function retryAsk() {
    drawWorking();
    try {
      session = session?.architect?.kind === "understand" ? await a.askUnderstand(session.id, "simple") : await a.askArchitect(session.id);
      await advance();
    } catch {
      if (ok()) drawProblem(W.problem, () => { void run(); });
    }
  }

  async function run() {
    drawWorking();
    try {
      await persist(); // the answers are stored before the session is made from them
    } catch {
      return drawProblem(W.notSaved, () => { void run(); });
    }
    if (!ok()) return;
    try {
      session = await a.guideSession();
      if (!ok()) return;
      if (answers().session !== session.id) setAnswer("session", session.id, false);
      redrawNav();
      if (answers().build === true) return await build(); // Yes, build this was pressed before: go on
      await advance();
    } catch {
      if (ok()) drawProblem(W.problem, () => { void run(); });
    }
  }

  async function stopBuild(text) {
    building = false;
    message = text;
    setAnswer("build", null, false);
    try {
      await persist();
    } catch { /* the flag only makes the build go on when the step opens again */ }
    drawPlan();
  }

  async function build() {
    if (building || !session) return;
    if (pending > 0 || editing !== null) {
      message = W.saveFirst; // the button is off meanwhile; this guards a press that came in before it was drawn off
      drawPlan();
      return;
    }
    building = true;
    drawPlan();
    try {
      if (answers().build !== true) {
        setAnswer("build", true, false);
        await store(); // before the first change: a build that was started is picked up again
        if (!ok()) return;
      }
      for (let n = 0; n < MAX_BUILD_ACTIONS; n++) {
        if (!ok()) return;
        const act = nextBuildAction(session);
        if (act.type === "wait") {
          await wait(POLL_MS);
          if (!ok()) return;
          await reread();
        } else if (act.type === "check") session = await a.checkReady(session.id, act.draft);
        else if (act.type === "accept") session = await a.acceptAnyway(session.id, act.draft, act.item, ACCEPT_REASON);
        else if (act.type === "publish") {
          await a.publish(session.id, { drafts: act.drafts.map((draft) => ({ draft, startBuilding: true })) });
          await reread();
        } else if (act.type === "blocked") {
          blockedDraft = act.draft;
          return void (await stopBuild(""));
        } else if (act.type === "stopped" || act.type === "empty") return void (await stopBuild(W.stopped));
        else return await finish();
        if (ok()) drawPlan();
      }
      await stopBuild(W.problem);
    } catch (e) {
      // a stored build flag stays: the person presses the button again (or opens the step again) and the build goes on where it stopped
      if (!ok()) return;
      if (!(e instanceof SaveFailed)) return failed();
      building = false;
      setAnswer("build", null, false);
      setAnswer("plan", null, false);
      message = W.notSaved;
      drawPlan();
    }
  }

  // Everything is on its way: the watcher builds it. The guide is saved as done before it leaves for the project's page.
  async function finish() {
    await ensureWatcher(a, repoId());
    if (!ok()) return;
    setAnswer("build", null, false);
    setAnswer("plan", "built", false);
    await store();
    if (!ok()) return;
    building = false;
    goTo("step-7");
    go(`#/repos/${repoId()}`);
  }

  return {
    start() {
      if (!admin) {
        mount(box, ...heading(W.title), h("p", {}, W.askAdmin));
        return undefined;
      }
      if (!isId(repoId())) {
        mount(box, ...heading(W.title), h("p", {}, W.noProject), h("p", {}, h("button", { type: "button", "data-focus": "guide-to-step-5", onClick: () => goTo("step-5") }, W.toProject)));
        return undefined;
      }
      return run();
    },
    canContinue: () => canContinue("step-6", { admin, answers: answers() }),
    stop() { stopped = true; },
  };
}

// ---- step 7: watch it grow ---------------------------------------------------------------------------------------

export function growStep(env) {
  const { box, answers, admin } = env;
  const W = GUIDE.grow;
  return {
    start() {
      const id = answers().repoId;
      if (!admin) mount(box, ...heading(W.title), h("p", {}, W.askAdmin));
      else if (!isId(id)) mount(box, ...heading(W.title), h("p", {}, W.noProject));
      else mount(box, ...heading(W.title), h("p", {}, W.text), h("p", {}, h("a", { href: `#/repos/${id}`, class: "button primary", "data-focus": "guide-open-project" }, W.open)));
      return undefined;
    },
    canContinue: () => false,
    stop() {},
  };
}
