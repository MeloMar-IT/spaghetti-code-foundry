import { api } from "./api.js";
import { confirmDialog, h, mount, table, toast } from "./dom.js";
import {
  API_KEY_NOTE, ASK_ADMIN, BUSY_OPTIONS, CONFLICT, HAVE_OPTIONS, PLAN_OPTIONS, QUESTIONS, SHARE_OPTIONS, TOOL_NAMES,
  changeSteps, draftFrom, explainAnswer, keptText, requestOf, settingRows, stepsFor, summaryRows, toolsOf,
} from "./onboarding-agents-model.js";
import { pageClipboard, setupRowNode, setupRows } from "./setup-check.js";
import { forbiddenIn } from "./simple-words.js";
import { errorState, explainError, loadingState } from "./states.js";

// "Claude and Codex": six plain questions, sign-in and a test per tool, then a summary with Change on every line.
// The page has no input or textarea: answers are buttons. It never asks for a password, key or token.

const SIMPLE_SAFE = "Nothing was changed by this message.";
const call = (what, simple, e) => {
  const info = explainError(e, { what, ...(simple ? { safe: SIMPLE_SAFE } : {}) });
  if (simple) info.what = what;
  return info;
};

// Options for the Get started guide:
// - `resume`: `{ draft, step }` starts at a saved, unfinished draft (it wins over the answers on the server); `{ draft, done: true }` shows the
//   summary of that completed draft (the account's own answers, even when another admin changed the settings since); `{ fresh: true }` starts
//   the questions again at the first one, with the answers on the server chosen and nothing cleared.
// - `onDraft`: `{ draft, step }` on every question, `{ draft, step: null, done: true }` on the summary.
// - `again: false` leaves out the summary's own "Start again" button.
export async function renderOnboardingAgents(box, { a = api, admin = false, readOnly = false, simple = false, credentialsHref = "#/credentials", clipboard = pageClipboard(), notify = toast, ask = confirmDialog, resume = null, onDraft = null, again = true } = {}) {
  if (!admin || readOnly) {
    mount(box, h("div", { class: "card" }, h("h1", {}, "Claude and Codex"), h("p", {}, ASK_ADMIN)));
    return () => {};
  }
  let gone = false;
  let view = null; // the last answer of the server (GET or PUT)
  let draft = draftFrom(null);
  let chain = ["have"];
  let at = 0;
  let mode = "ask"; // "ask" | "summary"
  let report = null; // the setup check, with `seq`
  let seq = 0; // orders the setup check and the test calls: the newer one wins
  const tests = {}; // tool → { state, seq }
  const messages = {}; // tool → what the last sign-in or test said
  const calling = {}; // tool → true while a call runs
  let notice = "";
  let pending = null; // the setup check that is running; a second caller waits for the same one
  const body = h("div", { class: "setup-check" });
  mount(box, body);

  const show = (...nodes) => {
    if (!gone) mount(body, ...nodes);
  };
  const text = (s) => (simple && forbiddenIn(s).length ? "" : s);
  const failure = (what, onRetry, extra) => show(h("h1", {}, "Claude and Codex"), errorState(call(what, simple, extra.e), { onRetry }));

  const choice = (opt, chosen, onPick, extra = []) =>
    h("li", { class: "setup-row" },
      h("button", { type: "button", class: chosen ? "primary" : null, "aria-pressed": chosen ? "true" : "false", "data-focus": `pick-${opt.value}`, onClick: () => onPick(opt.value) }, opt.label),
      opt.note && h("p", { class: "muted" }, opt.note),
      opt.link && h("p", {}, h("a", { href: opt.link.url, target: "_blank", rel: "noopener noreferrer" }, opt.link.label)),
      extra);

  // The answers the summary shows; Back from the first question of a change goes back to them, and nothing typed since is kept.
  let base = null;
  const copyDraft = (d) => ({ ...d, plans: { ...d.plans } });
  const back = () => {
    if (at > 0) at--;
    else if (base) {
      draft = copyDraft(base);
      mode = "summary";
    } else return;
    draw();
  };
  const backButton = () => (at > 0 || base ? h("button", { type: "button", "data-focus": "back", onClick: back }, "Back") : null);
  const emit = (step, done = false) => {
    try {
      if (done) onDraft?.({ draft: copyDraft(draft), step: null, done: true });
      else if (step) onDraft?.({ draft: copyDraft(draft), step });
    } catch {
      // the guide's bookkeeping must not break the questions
    }
  };
  const next = () => {
    if (at + 1 >= chain.length) {
      emit(chain[at]); // the last answer is kept even when the save fails
      save();
    } else {
      at++;
      draw();
    }
  };

  const question = (step, options, current, onPick, extraFor) => {
    const n = `Question ${at + 1} of ${chain.length}`;
    show(
      h("h1", {}, "Claude and Codex"),
      h("p", { class: "muted" }, n),
      h("h2", {}, QUESTIONS[step]),
      h("ul", { class: "setup-rows" }, options.map((o) => choice(o, o.value === current, onPick, extraFor?.(o)))),
      h("p", {}, backButton()));
  };

  // Returns the running check when there is one, so an install step never draws before the answer is in.
  const loadReport = () => {
    if (!pending) {
      pending = a.setupCheck([])
        .then((answer) => {
          if (!gone) report = { ...answer, seq: ++seq };
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };

  const installStep = async () => {
    show(h("h1", {}, "Claude and Codex"), h("h2", {}, QUESTIONS.install), loadingState("Checking this computer", { rows: 3 }));
    try {
      await loadReport();
    } catch (e) {
      failure("The check could not be made.", () => installStep(), { e });
      return;
    }
    if (gone || chain[at] !== "install") return;
    const wanted = toolsOf(draft);
    const rows = setupRows(report).filter((r) => r.id === "claude" || r.id === "codex").filter((r) => wanted.includes(r.id));
    show(
      h("h1", {}, "Claude and Codex"),
      h("p", { class: "muted" }, `Question ${at + 1} of ${chain.length}`),
      h("h2", {}, QUESTIONS.install),
      h("ul", { class: "setup-rows" }, rows.map((r) => setupRowNode(r, { clipboard, notify, alive: () => !gone, text }))),
      h("p", { class: "row" },
        h("button", { type: "button", "data-focus": "again", onClick: () => installStep() }, "Check again"),
        h("button", { type: "button", class: "primary", "data-focus": "next", onClick: next }, "Next"),
        backButton()));
  };

  const run = async (tool, kind) => {
    if (calling[tool] || gone) return;
    calling[tool] = true;
    draw(`${kind}-${tool}`);
    try {
      const answer = await (kind === "signin" ? a.onboardingSignIn(tool) : a.onboardingTestCall(tool));
      if (gone) return;
      messages[tool] = explainAnswer(kind, tool, answer, simple);
      if (kind === "test") tests[tool] = { state: answer?.state, seq: ++seq };
      else if (answer?.state === "missing") tests[tool] = { state: "missing", seq: ++seq };
    } catch (e) {
      if (gone) return;
      messages[tool] = simple
        ? `${TOOL_NAMES[tool]} could not be reached just now. Try again in a moment.`
        : explainError(e, { what: kind === "signin" ? `The ${TOOL_NAMES[tool]} sign-in could not start.` : `The ${TOOL_NAMES[tool]} test could not be made.` }).what;
    } finally {
      calling[tool] = false;
    }
    draw(`${kind}-${tool}`);
  };

  const signinStep = () => {
    const sections = toolsOf(draft).map((t) => {
      const name = TOOL_NAMES[t];
      const short = t === "claude" ? "Claude" : "Codex";
      return h("li", { class: "setup-row" },
        h("div", { class: "setup-name" }, h("strong", {}, name)),
        h("p", { class: "row" },
          h("button", { type: "button", disabled: Boolean(calling[t]), "data-focus": `signin-${t}`, onClick: () => run(t, "signin") }, `Sign in to ${short}`),
          h("button", { type: "button", disabled: Boolean(calling[t]), "data-focus": `test-${t}`, onClick: () => run(t, "test") }, `Test ${short}`)),
        h("p", { role: "status" }, calling[t] ? "Working on it…" : messages[t] ?? ""));
    });
    show(
      h("h1", {}, "Claude and Codex"),
      h("p", { class: "muted" }, `Question ${at + 1} of ${chain.length}`),
      h("h2", {}, QUESTIONS.signin),
      h("p", { class: "muted" }, "Sign-in opens in the tool's own window on the computer the Foundry lives on. This page never asks for a password."),
      h("ul", { class: "setup-rows" }, sections),
      h("p", { class: "row" }, h("button", { type: "button", class: "primary", "data-focus": "next", onClick: next }, "Next"), backButton()));
  };

  const save = async (replace = []) => {
    show(h("h1", {}, "Claude and Codex"), loadingState("Saving your answers", { rows: 2 }));
    try {
      const reply = await a.saveOnboardingAgents(requestOf(draft), replace, view);
      if (gone) return;
      view = reply;
      draft = draftFrom(view);
      mode = "summary";
      notice = "";
      draw();
      refreshReport();
    } catch (e) {
      if (gone) return;
      if (e?.status === 409) {
        // Someone else saved first. Nothing is resent: the page shows what is stored now, and a replacement must be confirmed again.
        try {
          view = await a.onboardingAgents();
        } catch (e2) {
          failure("The answers could not be loaded.", load, { e: e2 });
          return;
        }
        if (gone) return;
        draft = draftFrom(view);
        notice = CONFLICT;
        if (view.answers) mode = "summary";
        else {
          mode = "ask";
          chain = ["have"];
          at = 0;
        }
        draw();
        return;
      }
      failure("The answers could not be saved.", () => save(replace), { e });
    }
  };

  const refreshReport = async () => {
    try {
      await loadReport();
    } catch {
      return; // the lines are drawn without the sign-in state
    }
    if (!gone && mode === "summary") draw();
  };

  const startChain = (steps, from = 0) => {
    chain = steps;
    at = from;
    mode = "ask";
    draw();
  };

  const replaceKept = async () => {
    const kept = view?.kept ?? [];
    const ok = await ask({ title: "Replace the settings an admin set by hand?", text: `${keptText(kept)} Your answers will replace them.`, confirm: "Replace them", danger: false });
    if (ok && !gone) save(kept);
  };

  const summary = () => {
    const kept = view?.kept ?? [];
    const rows = summaryRows(draft, { report, tests, kept });
    const keptLine = keptText(kept);
    const items = rows.map((r) =>
      h("li", { class: "setup-row" },
        h("p", {}, r.text),
        r.apiKey && h("p", { class: "muted" }, API_KEY_NOTE, " ", h("a", { href: credentialsHref }, "Credentials")),
        h("p", {}, h("button", { type: "button", "data-focus": `change-${r.id}`, "aria-label": `Change: ${r.text}`, onClick: () => startChain(changeSteps(r.id, draft)) }, "Change"))));
    const settings = simple ? [] : [
      h("h2", {}, "The settings"),
      table(["Setting", "In effect", "From your answers", "Set by hand"],
        settingRows(view).map((s) => h("tr", {}, h("td", {}, s.key), h("td", {}, s.current), h("td", {}, s.answers), h("td", {}, s.kept ? "yes" : "no"))), { caption: "The six settings" }),
      h("h2", {}, "What this does"),
      h("ul", {}, (view?.summary ?? []).map((l) => h("li", {}, l))),
    ];
    show(
      h("h1", {}, "Claude and Codex"),
      notice && h("p", { role: "status" }, notice),
      view?.warning && !simple && h("p", { role: "status" }, view.warning),
      h("ul", { class: "setup-rows" }, items),
      keptLine && h("p", {}, keptLine, " ", h("button", { type: "button", "data-focus": "replace", onClick: replaceKept }, "Use my answers for these too")),
      draft.have === "none" && h("p", {}, h("a", { href: "#/setup" }, "Open the setup check")),
      again && h("p", {}, h("button", { type: "button", "data-focus": "again", onClick: () => startChain(["have"]) }, "Start again")),
      settings);
  };

  const pickHave = (v) => {
    if (v !== draft.have) draft.plans = {};
    draft.have = v;
    startChain(stepsFor(draft), 1);
  };

  function draw() {
    if (gone) return;
    if (mode === "summary") {
      base = copyDraft(draft);
      emit(null, true);
      return summary();
    }
    const step = chain[at];
    emit(step);
    const pick = (key) => (v) => {
      if (key === "plans") draft.plans = { ...draft.plans, [step.slice(6)]: v };
      else draft[key] = v;
      next();
    };
    if (step === "have") return question(step, HAVE_OPTIONS, draft.have, pickHave);
    if (step.startsWith("plans:")) {
      const tool = step.slice(6);
      return question(step, PLAN_OPTIONS[tool], draft.plans?.[tool], pick("plans"), (o) => (o.value === "api-key" ? [h("p", { class: "muted" }, API_KEY_NOTE, " ", h("a", { href: credentialsHref }, "Credentials"))] : []));
    }
    if (step === "install") return void installStep();
    if (step === "signin") return signinStep();
    if (step === "share") return question(step, SHARE_OPTIONS, draft.share, pick("share"));
    return question(step, BUSY_OPTIONS, draft.busy, pick("busy"));
  }

  async function load() {
    show(h("h1", {}, "Claude and Codex"), loadingState("Loading your answers", { rows: 4 }));
    try {
      view = await a.onboardingAgents();
    } catch (e) {
      if (!gone) failure("The answers could not be loaded.", load, { e });
      return;
    }
    if (gone) return;
    draft = draftFrom(view);
    base = view.answers ? copyDraft(draft) : null;
    if (resume?.done && resume.draft) {
      // a completed draft of this account is its summary, even when the answers on the server changed since
      draft = copyDraft(resume.draft);
      mode = "summary";
      draw();
      refreshReport();
    } else if (resume?.draft) {
      // an unfinished draft of this account wins over the answers saved earlier
      draft = { ...draft, ...resume.draft, plans: { ...resume.draft.plans } };
      const steps = stepsFor(draft);
      startChain(steps, Math.max(0, steps.indexOf(resume.step)));
    } else if (resume?.fresh) {
      startChain(["have"]); // the answers on the server stay chosen, and nothing is cleared
    } else if (view.answers) {
      mode = "summary";
      draw();
      refreshReport();
    } else startChain(stepsFor(draft));
  }

  await load();
  return () => {
    gone = true;
  };
}
