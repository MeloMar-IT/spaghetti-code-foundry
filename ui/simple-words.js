// The word list of the Simple view: Foundry terms → plain words. The Simple pages take all of their own text from here.
// Pure data and text functions, no imports (the UI has no build step, so it cannot import src/words.ts; a test keeps both in step).

/** Foundry term → the Simple word. For the docs and the tests. */
export const TERMS = {
  story: "change", issue: "change", run: "work", failed: "got stuck", release: "final version",
  repository: "project", queued: "planned", merged: "done", step: "step",
};

/** The distinct Simple words of TERMS, in order. */
export const termWords = () => [...new Set(Object.values(TERMS))];

/** A plain meaning for each Simple word. */
export const TERM_MEANINGS = {
  change: "Something you asked for: a new part of your project, a fix or an improvement.",
  work: "What the Foundry does to make one change.",
  "got stuck": "The Foundry could not finish the work by itself and needs a person.",
  "final version": "A version of your project that is finished and ready to use.",
  project: "One thing the Foundry makes for you, such as an app or a website.",
  planned: "The work waits its turn and starts soon.",
  done: "The change is finished and part of your project.",
  step: "One part of the work: planning, building, testing or finishing.",
};

/** The text of the Help page. */
export const HELP = {
  title: "Help",
  wordsTitle: "What the words mean",
  wordsIntro: "The Foundry uses these words on your pages.",
  howTitle: "How do I …",
  howtos: [
    { q: "How do I change the colours?", a: "Ask for a change and say which colours you want, for example: Make the buttons dark blue. Use Ask for a change on your project's page; if it has no such button yet, switch to the Advanced view with View at the top and use Start work." },
    { q: "How do I make it public?", a: "Whether and how a project becomes public depends on how it was set up. Some final versions go out by themselves; others need a step from you or from someone else. Ask the person who set up the Foundry for you for the public address and the steps." },
  ],
  agentsTitle: "Claude and Codex",
  agentsText: "Which AI helpers the Foundry uses, and how busy it may be.",
  agentsLink: "Set up Claude and Codex",
  contactTitle: "Who to ask",
};

export const WORDS = {
  myProjects: "My projects",
  todo: "What you need to do",
  nothingTodo: "Nothing — the Foundry is working.",
  making: "What is being made",
  planned: "Planned",
  building: "Being built",
  check: "Ready for you to check",
  done: "Done",
  empty: "No projects yet. Switch to the Advanced view with View at the top to add one.",
  open: "Open project",
  back: "My projects",
  notFound: "This project is not in your list.",
  showAllDone: (n) => `Show all done (${n})`,
  nothingInGroup: "Nothing here.",
  untitled: "A change",
  newTab: " (opens in a new tab)",
  loading: "Loading your projects",
  loadFailed: "This page could not be loaded.",
  actions: { change: "Ask for a change", tryIt: "Try it", final: "Make this version final" },
};

/** The card of a finished version that waits for the owner's OK (the daily release of a local project). */
export const FINAL = {
  line: "A new version of your project is ready.",
  what: "What goes in:",
  yes: WORDS.actions.final,
  notYet: "Not yet",
  why: "Why not yet? (optional)",
  keep: "Keep it as it is",
  sent: "Thank you. The Foundry goes on by itself.",
  failed: "That did not work. Try again.",
};

const NEEDS_YOU = { todo: "Take a look", line: "It needs you." };

/** Per kind of next step: `todo` is the button label (kinds a person can act on), `line` the card sentence ("" for kinds Simple hides). */
export const KIND_WORDS = {
  questions: { todo: "Answer the questions", line: "The Foundry has questions for you." },
  planner_questions: { todo: "Answer the questions", line: "The Foundry has questions for you." },
  owner_action: { todo: "Do what it asks", line: "The Foundry needs something only you can do." },
  approve_plan: { todo: "Check the plan", line: "The plan waits for your OK." },
  approve_split: { todo: "Check the smaller parts", line: "It is too big for one change, so the Foundry proposes smaller ones." },
  approval: { todo: "Give your OK", line: "It waits for your OK." },
  stopped: { todo: "See what it needs", line: "It stopped and needs a person." },
  release: { todo: "Check the result", line: "It is finished and waits for you." },
  failed: { todo: "See why it got stuck", line: "It got stuck." },
  monitor_needs_you: { todo: "Take a look", line: "Something needs a look from you." },
  red_base: { todo: "See what it needs", line: "It waits until the project's checks pass again." },
  queued: { line: "It starts soon." },
  starting: { line: "It starts soon." },
  checking: { line: "The Foundry reads it first." },
  dependency: { line: "It starts after other work is done." },
  one_at_a_time: { line: "It waits for other work to finish." },
  area_lock: { line: "It waits for other work to finish." },
  usage_limit: { line: "It is paused for now and goes on by itself." },
  daily_budget: { line: "It is paused for now and goes on by itself." },
  user_limit: { line: "It is paused for now and goes on by itself." },
  project_limit: { line: "The Foundry has done enough for today; it continues tomorrow." },
  restart: { line: "It is paused for now and goes on by itself." },
  bug_first: { line: "A repair goes first." },
  interrupted: { line: "It was cut off and goes on later." },
  running: { line: "The Foundry is making it." },
  done: { line: "It is done." },
  cancelled: { line: "" },
  parked: { line: "" },
  epic: { line: "" },
  watcher_error: { line: "" },
  monitor_stopped: { line: "" },
  watcher_stale: { line: "" },
  closed_elsewhere: { line: "" },
  issue_closed: { line: "" },
  chore_late: { line: "" },
  superseded: { line: "" },
};

/**
 * The words of a kind. A record that waits for the person (`who` is "You" or "Something is wrong") always gets a button
 * label, also for kinds that usually go on by themselves (an interrupted item nobody watches, a signed-out limit).
 */
export function kindWords(kind, who) {
  const w = KIND_WORDS[kind];
  const mine = who === "You" || who === "Something is wrong";
  if (!w) return NEEDS_YOU;
  if (mine && !w.todo) return { todo: NEEDS_YOU.todo, line: w.line && !w.line.includes("by itself") && !w.line.includes("later") ? w.line : NEEDS_YOU.line };
  return w;
}

const TERM_WORDS = [
  [/\bstory\b/gi, "change"], [/\bissue\b/gi, "change"], [/\brun\b/gi, "work"], [/\bfailed\b/gi, "got stuck"],
  [/\brelease\b/gi, "final version"], [/\brepository\b/gi, "project"], [/\bqueued\b/gi, "planned"], [/\bmerged\b/gi, "done"],
];

/** Foundry terms in user text (a title or a summary) → their Simple words. */
export const mapTerms = (s) => TERM_WORDS.reduce((t, [re, word]) => t.replace(re, word), String(s ?? ""));

/**
 * User text for a card: the terms mapped, and "" (or `fallback`) when a forbidden term is still left, for example "logs" or
 * "branch". The person's own words are never shown with a forbidden term in them.
 */
export function safeText(s, fallback = "") {
  const t = mapTerms(plainText(s)).trim();
  return t && forbiddenIn(t).length === 0 ? t : fallback;
}

export const PHASES =["planning", "building", "testing", "finishing"];

/** The phase (0–3) of a step id of a flow. Steps before the work starts count as planning, whatever their name has in it. */
export function phaseOf(stepId) {
  const s = String(stepId ?? "");
  if (/implement|guard|address_review/.test(s)) return 1;
  if (/plan|ticket|branch|baseline|clone|split|size|risk|claim|wait_for|send_back|approve|fetch/.test(s)) return 0;
  if (/test|review/.test(s)) return 2;
  return s ? 3 : 0;
}

export const progressText = (i) => `Step ${i + 1} of 4: ${PHASES[i]}`;

const things = (n) => `${n} ${n === 1 ? "thing" : "things"}`;

/** The one-line state of a project. */
export function stateLine({ needs = 0, needsAnswer = false, building = 0, planned = 0, done = 0 } = {}) {
  if (needsAnswer) return "Waiting for your answer";
  if (needs) return "Ready for you to check";
  if (building) return `Building ${things(building)}`;
  if (planned) return `${things(planned)} planned`;
  if (done) return "All done";
  return "Nothing yet";
}

/** Foundry terms that must not show in the Simple view. */
export const FORBIDDEN = [
  /\bcosts?\b/i, /\$\s?\d/, /\btokens?\b/i, /\bmodels?\b/i, /\bagents?\b/i, /\blogs?\b/i, /\btranscripts?\b/i,
  /\bbranch(es)?\b/i, /\bcommits?\b/i, /\bflows?\b/i, /\blabels?\b/i, /#\d+/, /\bissues?\b/i,
  /\bruns?\b/i, /\bstor(y|ies)\b/i, /\breleases?d?\b/i, /\bfailed\b/i, /\brepositor(y|ies)\b/i,
  /\bpull requests?\b/i, /\bmerged?\b/i, /\bwatchers?\b/i, /\bepics?\b/i,
];

/** The forbidden terms found in the text (the matched words). */
export function forbiddenIn(text) {
  const s = String(text ?? "");
  return FORBIDDEN.flatMap((re) => { const m = re.exec(s); return m ? [m[0]] : []; });
}

/** User content made plain: no #numbers, links or markdown; one line; cut at `max` characters with "…". */
export function plainText(s, max = 140) {
  const t = String(s ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/#\d+/g, "")
    .replace(/^\s*(#+\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?)])/g, "$1")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * A longer text (a reply of Ask SCF) in plain words: per line and per sentence the terms are mapped, and a sentence
 * that still has a forbidden term is left out. Line breaks stay. `fallback` when nothing is left.
 */
export function plainWords(s, fallback = "") {
  const lines = String(s ?? "").replace(/\r\n/g, "\n").split("\n").map((line) => {
    // a sentence ends at . ! or ? followed by a space: "1.5" and "example.com" stay whole
    const sentences = line.split(/(?<=[.!?])\s+/);
    return sentences.map((sentence) => {
      const t = sentence.trim();
      if (!t) return "";
      const mapped = mapTerms(t);
      if (forbiddenIn(mapped).length > 0) return "";
      const capital = t[0] !== t[0].toLowerCase();
      return capital ? mapped[0].toUpperCase() + mapped.slice(1) : mapped;
    }).filter(Boolean).join(" ");
  }).filter((l) => l.trim());
  const out = lines.join("\n");
  return out || fallback;
}

/** The words of Ask SCF in the Simple view. Fixed text: a test keeps it free of forbidden terms. */
export const ASK = {
  suggestions: ["What can Ask SCF help me with?", "What does this word mean?", "Why does my change wait?", "How do I ask for a change?"],
  noPlainAnswer: "Ask SCF answered in words of the Advanced view. Switch to the Advanced view with View at the top to read it.",
  project: "Your project",
  stateSource: "What the Foundry saw of your work",
  docSource: "The guide of the Foundry",
  noAnswer: "Ask SCF could not answer.",
  checkTitle: "A check",
  checkOutcomes: { read: "Read again", passed: "Works", failed: "Does not work" },
};

/** The first sentence of the first prose line after the title; "" when there is none. */
export function summaryOf(task) {
  const lines = String(task ?? "").split(/\r?\n/).slice(1);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^#/.test(line) || /^(\*\*|__)[^*_]+(\*\*|__)/.test(line)) continue; // headings and "**Label:** …" lines
    const text = plainText(line, 400);
    if (!text) continue;
    const m = /^.*?[.!?](?=\s|$)/.exec(text);
    return plainText(m ? m[0] : text);
  }
  return "";
}
