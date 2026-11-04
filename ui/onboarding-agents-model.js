// The "Claude and Codex" page: data and text, no DOM. Plain words; none of them is on the Simple view's forbidden list.

export const TOOL_NAMES = { claude: "Claude Code", codex: "Codex" };

export const HAVE_OPTIONS = [
  { value: "claude", label: "Claude Code", note: "Made by Anthropic. You need a Claude Pro or Max plan, or an API key.", link: { label: "Claude plans", url: "https://claude.com/pricing" } },
  { value: "codex", label: "Codex", note: "Made by OpenAI. It comes with a ChatGPT Plus or Pro plan, or an API key.", link: { label: "ChatGPT plans", url: "https://chatgpt.com/pricing" } },
  { value: "both", label: "Both", note: "When one reaches its limit, the other takes over." },
  { value: "none", label: "Neither yet", note: "Sign up for one first. Claude Code is the one the Foundry uses most." },
];

const API_KEY = { value: "api-key", label: "An API key" };
const UNKNOWN = { value: "unknown", label: "I don't know" };
export const PLAN_OPTIONS = {
  claude: [{ value: "pro", label: "Pro" }, { value: "max", label: "Max" }, API_KEY, UNKNOWN],
  codex: [{ value: "plus", label: "Plus" }, { value: "pro", label: "Pro" }, API_KEY, UNKNOWN],
};

export const SHARE_OPTIONS = [
  { value: "auto", label: "Let the Foundry decide (recommended)", short: "Let the Foundry decide" },
  { value: "claude", label: "Claude Code does most of the work", short: "Claude Code does most of the work" },
  { value: "codex", label: "Codex does most of the work", short: "Codex does most of the work" },
  { value: "even", label: "They share: Claude Code writes, Codex checks", short: "They share" },
];

export const BUSY_OPTIONS = [
  { value: "little", label: "A little", note: "One thing at a time, in the background, so this computer stays quick." },
  { value: "normal", label: "Normal", note: "Gives way a little to your other programs." },
  { value: "fast", label: "As fast as it can", note: "Uses the computer's full speed." },
];

export const QUESTIONS = {
  have: "Which do you have?",
  "plans:claude": "Which Claude plan do you have?",
  "plans:codex": "Which ChatGPT plan do you use for Codex?",
  install: "Is it installed?",
  signin: "Sign in and test",
  share: "How should they share the work?",
  busy: "How busy may the Foundry be?",
};

export const API_KEY_NOTE = "An API key is not entered on this page. The Credentials page lists the credentials the Foundry has stored.";
export const ASK_ADMIN = "Claude and Codex are set up on the computer that the Foundry lives on. Ask the person who looks after it (an admin) to open this page.";
export const CONFLICT = "The settings were changed meanwhile. Here are the answers as they are now. Check them, then change what you still want.";

const KEPT_WORDS = {
  concurrency: "how many things it does at the same time",
  "governor.usage_percent": "when the Foundry slows down",
  "governor.priority": "how much it gives way to your other programs",
  default_model: "which tool does the work by default",
  "router.fallback": "which tool takes over at a limit",
  "router.rules": "which tool does which step",
};
const ROUTING_KEYS = ["default_model", "router.fallback", "router.rules"];

// Simple-safe sentences for what the server says about sign-in and the test call (its own texts use words the Simple view avoids).
const SIGN_IN_WORDS = {
  started: (n) => `The ${n} sign-in has started. A sign-in window opens on the computer the Foundry lives on. Sign in there, then press Test.`,
  done: (n) => `The ${n} sign-in finished on the computer the Foundry lives on. Press Test to check it.`,
  missing: (n) => `${n} is not on the computer the Foundry lives on. Install it first.`,
  failed: (n) => `The ${n} sign-in did not finish. Open a terminal on the computer the Foundry lives on and sign in there.`,
};
const TEST_WORDS = {
  ok: (n) => `${n} works: one tiny call went through.`,
  missing: (n) => `${n} is not on the computer the Foundry lives on. Install it first.`,
  "signed-out": (n) => `${n} is not signed in. Press Sign in, or sign in from a terminal on the computer the Foundry lives on.`,
  failed: (n) => `${n} is installed and signed in, but the tiny call did not work. Try again in a moment.`,
};

/** What to say about an answer of sign-in (`kind` "signin") or test call (`kind` "test"). Simple: fixed words by state; else the server's text. */
export function explainAnswer(kind, tool, answer, simple = false) {
  const words = (kind === "signin" ? SIGN_IN_WORDS : TEST_WORDS)[answer?.state];
  if (simple) return words ? words(TOOL_NAMES[tool]) : "";
  return typeof answer?.explain === "string" && answer.explain ? answer.explain : words ? words(TOOL_NAMES[tool]) : "";
}

export function draftFrom(view) {
  const a = view?.answers;
  if (!a) return { have: null, plans: {}, share: "auto", busy: "normal" };
  return { have: a.have, plans: { ...(a.plans ?? {}) }, share: a.share ?? "auto", busy: a.busy };
}

export const toolsOf = (draft) => (draft?.have === "both" ? ["claude", "codex"] : draft?.have === "claude" || draft?.have === "codex" ? [draft.have] : []);

export function stepsFor(draft) {
  const tools = toolsOf(draft);
  if (!draft?.have) return ["have"];
  if (!tools.length) return ["have", "busy"];
  return ["have", ...tools.map((t) => `plans:${t}`), "install", "signin", ...(draft.have === "both" ? ["share"] : []), "busy"];
}

/** The steps one Change button runs again. */
export function changeSteps(rowId, draft) {
  if (rowId === "have") return stepsFor(draft);
  if (rowId.startsWith("plans:")) return [rowId, "install", "signin"];
  return [rowId];
}

/** The body of the save. */
export function requestOf(draft) {
  const tools = toolsOf(draft);
  const plans = {};
  for (const t of tools) plans[t] = draft.plans?.[t] ?? "unknown";
  return { have: draft.have, plans, ...(draft.have === "both" ? { share: draft.share ?? "auto" } : {}), busy: draft.busy };
}

/**
 * What is known about the sign-in of a tool. `test`: `{ state, seq }` of a test call or sign-in of this visit; `report`: a setup check
 * answer, with `seq` set by the page when it arrived. The newer of the two wins. → "works" | "test-failed" | "signed-in" | "signed-out" | "missing" | null.
 */
export function signState(tool, report, test) {
  const fromTest = { ok: "works", "signed-out": "signed-out", missing: "missing", failed: "test-failed" }[test?.state];
  let fromReport = null;
  const items = Array.isArray(report?.items) ? report.items : [];
  if (items.find((i) => i.id === tool)?.state === "missing") fromReport = "missing";
  else {
    const s = items.find((i) => i.id === `${tool}-sign-in`)?.state;
    if (s === "ok") fromReport = "signed-in";
    else if (s === "signed-out") fromReport = "signed-out";
  }
  // A setup check only says that the sign-in files are there, not that a call works: a failed test call stays until a newer test replaces it.
  if (fromTest === "test-failed" && fromReport === "signed-in") return fromTest;
  if (fromTest && fromReport) return (test.seq ?? 0) >= (report.seq ?? 0) ? fromTest : fromReport;
  return fromTest ?? fromReport;
}

const SIGN_TEXT = { works: "signed in and tested", "test-failed": "signed in, but the test call did not work", "signed-in": "signed in", "signed-out": "not signed in", missing: "not installed" };

const planWord = (plan) => ({ pro: "Pro plan", max: "Max plan", plus: "Plus plan", "api-key": "an API key" })[plan] ?? "plan not known";

/** What the settings in effect do for a tool; "" when an admin's own settings make the claim unsure. */
export function roleOf(tool, draft, kept = []) {
  const other = TOOL_NAMES[tool === "claude" ? "codex" : "claude"];
  if (draft.have !== "both") return kept.some((k) => ROUTING_KEYS.includes(k)) ? "" : "does all of the work";
  if (kept.some((k) => ROUTING_KEYS.includes(k))) return "";
  const share = draft.share ?? "auto";
  if (share === "auto") return tool === "claude" ? "is used as the Foundry sees fit" : `takes over when ${other} reaches its limit`;
  if (share === "even") return tool === "claude" ? "plans and writes the code" : "checks the code and fixes tests that do not pass";
  return share === tool ? "does most of the work" : `takes over when ${other} reaches its limit`;
}

/** The summary: one row per answer. `view` is the last answer of the server; texts follow what it says is in effect. */
export function summaryRows(draft, { report, tests = {}, kept = [] } = {}) {
  const rows = [];
  const tools = toolsOf(draft);
  if (!tools.length) rows.push({ id: "have", text: "You have neither Claude Code nor Codex yet." });
  for (const t of tools) {
    const parts = [TOOL_NAMES[t], planWord(draft.plans?.[t])];
    const s = SIGN_TEXT[signState(t, report, tests[t])];
    if (s) parts.push(s);
    const role = roleOf(t, draft, kept);
    if (role) parts.push(role);
    rows.push({ id: `plans:${t}`, text: `${parts.join(", ")}.`, apiKey: draft.plans?.[t] === "api-key" });
  }
  if (draft.have === "both") {
    const s = SHARE_OPTIONS.find((o) => o.value === (draft.share ?? "auto"));
    const hand = kept.some((k) => ROUTING_KEYS.includes(k));
    rows.push({ id: "share", text: hand ? `How they share the work: ${s?.short ?? ""}. An admin set the routing by hand, so it may work differently.` : `How they share the work: ${s?.short ?? ""}.` });
  }
  const b = BUSY_OPTIONS.find((o) => o.value === draft.busy);
  const handBusy = kept.some((k) => k === "concurrency" || k === "governor.usage_percent" || k === "governor.priority");
  rows.push({ id: "busy", text: `How busy: ${b?.label ?? ""}.${handBusy ? " An admin set some of this by hand, so it may work differently." : ""}` });
  return rows;
}

/** "An admin set these by hand: …" or "". */
export function keptText(kept) {
  const k = (Array.isArray(kept) ? kept : []).map((x) => KEPT_WORDS[x]).filter(Boolean);
  return k.length ? `An admin set these by hand: ${k.join(", ")}. They stay as they are.` : "";
}

const show = (v) => (v === null || v === undefined ? "not set" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** [{ key, current, answers, kept }] for the table of the six settings. */
export function settingRows(view) {
  return Object.keys(KEPT_WORDS).map((key) => ({
    key,
    current: show(view?.current?.[key]),
    answers: view?.settings ? show(view.settings[key]) : "not set",
    kept: Array.isArray(view?.kept) && view.kept.includes(key),
  }));
}

