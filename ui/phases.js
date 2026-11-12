// The five phases of work and the table that maps a flow step id to one of them. Pure data and text, no imports.
// A test (tests/ui-phases.test.ts) checks that every step of every shipped flow is in STEP_PHASES.

export const PHASES = Object.freeze([
  Object.freeze({ key: "understand", word: "Understand", line: "Reading your request and looking at your project." }),
  Object.freeze({ key: "plan", word: "Plan", line: "Deciding how to make the change." }),
  Object.freeze({ key: "build", word: "Build", line: "Making the change." }),
  Object.freeze({ key: "check", word: "Check", line: "Testing the change and fixing what the tests find." }),
  Object.freeze({ key: "deliver", word: "Deliver", line: "Adding the change to your project." }),
]);

const LISTS = {
  understand: "pull_ticket clone feature_branch daily_branch plan_check baseline_tests baseline_failed fetch_main baseline_main hotfix_branch read_issues read_issue list_issues lock resolve find_branch changes check_repo pull_repo",
  plan: "plan plan_review revise_gate revise_plan wait_for_story send_back split_gate approve_split create_split size_gate force_split risk_gate approve_plan close_parts claim_areas wait_for_area wait_for_merge ask ask_for_info brief round pick triage split_ticket",
  build: "implement guard fix_guard write build",
  check: "run_tests fix_tests review_1 address_review_1 run_tests_1 fix_tests_1 review_gate review_2 address_review_2 run_tests_2 fix_tests_2 verify check measure review after_review check_brief check_round",
  deliver: "docs final_guard fixed_tests fix_fixed_tests commit push push_feature pretest_merge pretest_tests merge_develop resolve_conflicts finish_merge test_develop red_develop fix_develop commit_develop_fix push_develop wait_local_tree merge_main test_main red_main push_main merge_back resolve_back finish_back test_back red_back fix_back commit_back_fix push_back hotfix_done report post post_plan push_plan push_result open_pr wait_ci upload publish release_pr handoff final_ask make_final final_merge final_close final_files final_report final_rejected",
};

/** Step id → phase key. No prototype, so "__proto__" and "constructor" are never found. */
export const STEP_PHASES = (() => {
  const t = Object.create(null);
  for (const [key, ids] of Object.entries(LISTS)) for (const id of ids.split(" ")) t[id] = key;
  return Object.freeze(t);
})();

// For a step id that is not in the table (a person's own flow). The first rule that matches wins.
const NAME_RULES = [
  ["deliver", /commit|push|merge|publish|upload|report|release|handoff|open_pr|wait_ci|^post|^final/],
  ["check", /test|review|verify|check|guard|measure|lint|^red_/],
  ["build", /implement|build|write|code|fix|address|docs|resolve/],
  ["plan", /plan|split|size|risk|claim|approve|wait_for|send_back|ask|gate|brief|round|triage/],
  ["understand", /clone|fetch|pull|read|list|lock|find|branch|baseline|changes/],
];

const KEYS = PHASES.map((p) => p.key);
const validAt = (at) => at != null && typeof at === "object" && Number.isInteger(at.index) && Number.isInteger(at.total) && at.index >= 0 && at.index < at.total;

/**
 * The phase of a step: { key, index (0–4), word, line, source }. `at` is `{ index, total }`, the step's place in its flow, when known.
 * `source` says how it was found: "step" (the table), "name" (the id's words), "position" or "default". Never throws.
 */
export function stepPhase(stepId, at) {
  const id = typeof stepId === "string" ? stepId : "";
  let key;
  let source;
  if (Object.hasOwn(STEP_PHASES, id)) { key = STEP_PHASES[id]; source = "step"; }
  else {
    const rule = id ? NAME_RULES.find(([, re]) => re.test(id)) : undefined;
    if (rule) { key = rule[0]; source = "name"; }
    else if (id && validAt(at)) { key = KEYS[Math.min(4, Math.floor((at.index * 5) / at.total))]; source = "position"; }
    else { key = id ? "build" : "understand"; source = "default"; }
  }
  const index = KEYS.indexOf(key);
  return { key, index, word: PHASES[index].word, line: PHASES[index].line, source };
}

/**
 * The phase a run is in: { key, index, word, line, source }, or null when it has no step yet. The step is `state.next`, else the
 * last step of the history (the same choice as the Simple cards); its place in `flowDef.steps` helps for an id the table does not know.
 */
export function runPhase(run) {
  const step = run?.state?.next ?? run?.history?.at?.(-1)?.id;
  if (typeof step !== "string" || step === "") return null;
  const steps = Array.isArray(run?.flowDef?.steps) ? run.flowDef.steps : [];
  const index = steps.findIndex((s) => s?.id === step);
  return stepPhase(step, index >= 0 ? { index, total: steps.length } : undefined);
}

export const phaseText =(p) => `${p.word}: ${p.line}`;
