import { BUSY_OPTIONS, HAVE_OPTIONS, PLAN_OPTIONS, SHARE_OPTIONS, stepsFor } from "./onboarding-agents-model.js";

// The Get started guide: its steps and what is saved. Data and rules, no DOM. The step ids match src/onboarding/progress-store.ts.

export const GUIDE_STEPS = [
  { id: "welcome", number: "1" },
  { id: "computer", number: "2" },
  { id: "agents", number: "2b" },
  { id: "step-3", number: "3" },
  { id: "step-4", number: "4" },
  { id: "step-5", number: "5" },
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
export function canContinue(id, { admin = false, report = null, failed = false, answers = {}, starterIds = [], github = false } = {}) {
  if (nextStep(id) === null) return false;
  const step = knownStep(id);
  if (step === "computer" && admin) return allGreen(report) && !failed;
  const made = isId(answers.repoId);
  if (step === "step-3") return !admin || made || starterIds.includes(answers.starter);
  if (step === "step-4") return made || aboutProblem(answers) === null;
  if (step === "step-5") return !admin || made || (typeof answers.starter === "string" && aboutProblem(answers) === null && (answers.where !== "github" || github));
  return true;
}

const isPlain = (x) => typeof x === "object" && x !== null && !Array.isArray(x);

/** The limits of the guide's texts: the same numbers as the server's GUIDE_TEXT_LIMITS, and the name rule's MAX_NAME. */
export const GUIDE_LIMITS = { who: 200, what: 2000, "style": 200, name: 100, nameMax: 60 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (x) => typeof x === "string" && UUID.test(x);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** What the server's name rule (projectName, then projectSlug) would say about a name: null, "empty", "long", "control" or "letters". */
export function nameProblem(raw) {
  if (typeof raw !== "string") return "empty";
  const name = raw.trim();
  if (!name) return "empty";
  if (name.length > GUIDE_LIMITS.nameMax) return "long";
  if (CONTROL.test(name)) return "control";
  const slug = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug ? null : "letters";
}

const str = (x) => (typeof x === "string" ? x : "");

/** The typed answers of step 4 as strings. */
export const aboutOf = (answers) => ({
  who: str(answers?.about?.who),
  what: str(answers?.about?.what),
  name: str(answers?.name),
  "style": str(answers?.style),
});

/** What step 4 still needs: null, "what" (the text of what it should do) or "name" (no usable name). */
export function aboutProblem(answers) {
  const a = aboutOf(answers);
  if (!a.what.trim()) return "what";
  return nameProblem(a.name) ? "name" : null;
}

/** The starters to offer: the `starters` list only (never `broken`), with a string id. */
export const starterChoices = (reply) =>
  (Array.isArray(reply?.starters) ? reply.starters : [])
    .filter((s) => typeof s?.id === "string")
    .map((s) => ({ id: s.id, title: str(s.title), description: str(s.description) }));

/** What a failed make means: "exists", "gone", "name", "denied", "lost" (no answer) or "other". */
export function makeOutcome(err) {
  const status = err?.status;
  if (status === undefined) return "lost";
  const msg = String(err?.message ?? "");
  if (status === 409 && /exists already/.test(msg)) return "exists";
  if (status === 404 || (status === 409 && /cannot be used/.test(msg))) return "gone";
  if (status === 400) return "name";
  if (status === 403) return "denied";
  return "other";
}

// The way back from the page to connect GitHub: one marker, which view the person had.
export const GUIDE_RETURN_KEY = "scf-guide-return";
export function markGuideReturn(store, view) {
  try { store?.setItem(GUIDE_RETURN_KEY, view === "simple" ? "simple" : "advanced"); } catch { /* no storage: no way back by button */ }
}
export function guideReturnView(store) {
  try {
    const v = store?.getItem(GUIDE_RETURN_KEY);
    return v === "simple" || v === "advanced" ? v : null;
  } catch { return null; }
}
export function clearGuideReturn(store) {
  try { store?.setItem(GUIDE_RETURN_KEY, ""); } catch { /* nothing to clear */ }
}

/**
 * Goes back to the guide in the view the marker names. Returns "" when it is there, null when the person cancelled or there is no marker,
 * and a text when the view could not be switched. The marker is only cleared once the guide is reached.
 */
export async function returnToGuide({ store, choose, go }) {
  const view = guideReturnView(store);
  if (!view) return null;
  if (view === "simple") {
    const r = await choose("simple", { hash: () => "#/start-guide" });
    if (r === "") clearGuideReturn(store);
    return r;
  }
  clearGuideReturn(store);
  go("#/start-guide");
  return "";
}

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
