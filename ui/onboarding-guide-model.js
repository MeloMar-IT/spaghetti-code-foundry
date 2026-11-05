import { BUSY_OPTIONS, HAVE_OPTIONS, PLAN_OPTIONS, SHARE_OPTIONS, stepsFor } from "./onboarding-agents-model.js";

// The Get started guide: its steps and what is saved. Data and rules, no DOM. The step ids match src/onboarding/progress-store.ts.

export const GUIDE_STEPS = [
  { id: "welcome", number: "1" },
  { id: "computer", number: "2" },
  { id: "agents", number: "2b" },
  { id: "step-3", number: "3", later: true },
  { id: "step-4", number: "4", later: true },
  { id: "step-5", number: "5", later: true },
  { id: "step-6", number: "6", later: true },
  { id: "step-7", number: "7", later: true },
];
export const STEP_IDS = GUIDE_STEPS.map((s) => s.id);

/** The id when the guide has that step, else "welcome" (a saved step a later version renamed opens at the start). */
export const knownStep = (id) => (STEP_IDS.includes(id) ? id : "welcome");
export const stepInfo = (id) => GUIDE_STEPS.find((s) => s.id === knownStep(id));
export const nextStep = (id) => STEP_IDS[STEP_IDS.indexOf(knownStep(id)) + 1] ?? null;
export const prevStep = (id) => STEP_IDS[STEP_IDS.indexOf(knownStep(id)) - 1] ?? null;
export const stepLabel = (id) => `Step ${stepInfo(id).number} of ${GUIDE_STEPS[GUIDE_STEPS.length - 1].number}`;

/** True when the check says the computer is ready and every row it shows is green, the optional ones too. */
export const allGreen = (report) => report?.ready === true && Array.isArray(report.items) && report.items.length > 0 && report.items.every((i) => i?.state === "ok");

/**
 * Whether Continue is on. The last step has no Continue. The computer step, for an admin, needs a check with every row green.
 * Someone who cannot run the check (not an admin, or a read-only view) can go on.
 */
export function canContinue(id, { admin = false, report = null, failed = false } = {}) {
  if (nextStep(id) === null) return false;
  if (knownStep(id) === "computer" && admin) return allGreen(report) && !failed;
  return true;
}

const isPlain = (x) => typeof x === "object" && x !== null && !Array.isArray(x);

/** The server's answer as `{ step, answers }`; a missing step opens at the start. */
export function progressFrom(reply) {
  return { step: knownStep(reply?.step), answers: isPlain(reply?.answers) ? reply.answers : {} };
}

/** The body of a save. */
export const requestOf = (progress) => ({ step: knownStep(progress?.step), answers: isPlain(progress?.answers) ? progress.answers : {} });

/** The progress with one answer set; `value` null or undefined removes it. */
export function withAnswer(progress, key, value) {
  const answers = { ...(isPlain(progress?.answers) ? progress.answers : {}) };
  if (value === null || value === undefined) delete answers[key];
  else answers[key] = value;
  return { step: progress?.step, answers };
}

const known = (options, v) => (options.some((o) => o.value === v) ? v : undefined);

/**
 * A saved draft of the Claude and Codex questions, checked against the options: `{ draft, step }`, or `{ draft, step: null, done: true }`
 * when the questions were completed; null when nothing usable is saved. Nothing unknown is kept.
 */
export function cleanAgentsDraft(x) {
  if (!isPlain(x) || !isPlain(x.draft)) return null;
  const d = x.draft;
  const have = known(HAVE_OPTIONS, d.have);
  if (!have) return null;
  const plans = {};
  if (isPlain(d.plans)) {
    for (const t of Object.keys(PLAN_OPTIONS)) {
      const v = known(PLAN_OPTIONS[t], d.plans[t]);
      if (v) plans[t] = v;
    }
  }
  const draft = { have, plans, share: known(SHARE_OPTIONS, d.share) ?? "auto", busy: known(BUSY_OPTIONS, d.busy) ?? "normal" };
  if (x.done === true) return { draft, step: null, done: true };
  const steps = stepsFor(draft);
  return { draft, step: steps.includes(x.step) ? x.step : steps[0] };
}
