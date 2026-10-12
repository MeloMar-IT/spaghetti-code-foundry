import { cols, fields, table, type Column } from "../render.js";
import type { Cmd, Flag } from "../spec.js";

// The answers are read loosely: a field that is missing prints as nothing, never as an error.
type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);

/** "2026-10-01T08:30:12.000Z" → "2026-10-01 08:30" (UTC, as the server keeps it). */
const when = (iso: unknown): string => (typeof iso === "string" && iso.length >= 16 ? iso.slice(0, 16).replace("T", " ") : "");
const firstLine = (t: unknown): string => (typeof t === "string" ? (t.trim().split("\n", 1)[0] ?? "") : "");
const words = (v: unknown, before = ""): string => (Array.isArray(v) ? v.map((w) => `${before}${w}`).join(", ") : "");
/** A table without the columns that no row fills (the owner for a user, the error of steps that went well). */
const filled = (rows: Obj[], columns: Column[], empty?: string): string => table(rows, columns.filter((c) => rows.some((r) => r[c.key] !== undefined && r[c.key] !== "")), empty);
const blocks = (parts: (string | undefined | false)[]): string => parts.filter((p): p is string => !!p).join("\n\n");
const duration = (ms: unknown): string => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const min = Math.round(ms / 60_000);
  return min < 1 ? `${Math.round(ms / 1000)} s` : min < 120 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
};

/** What a run is for: its issue ("acme/app#7") when it has one, else the first line of its task. */
function runFor(r: Obj): string {
  const v = obj(r.vars);
  const n = v.issue || v.pr;
  if (v.github_repo && n) return `${v.github_repo}#${n}`;
  return firstLine(r.task) || v.github_repo || "";
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
/** The place a "what happens next" record is about. A run without a repository names a folder of the server there: the run says more. */
const place = (n: Obj): string => (n.issue !== undefined ? `${n.repo ?? ""}#${n.issue}` : n.runId ? `${REPO.test(n.repo ?? "") ? `${n.repo} ` : ""}run ${n.runId}` : (n.repo ?? ""));

const RUN_COLUMNS: Column[] = [...cols("id", "flow", "status"), { key: "for", max: 50 }, ...cols("started", "owner"), { key: "next", max: 50 }];

function showRuns(d: unknown): string {
  const rows = list(d).map((r) => ({ id: r.runId, flow: r.flow, status: `${r.status ?? ""}${r.superseded ? " (replaced)" : ""}`, for: runFor(r), started: when(r.startedAt), owner: r.ownerName, next: obj(r.next).status }));
  return filled(rows, RUN_COLUMNS, "no runs");
}

function showRun(d: unknown): string {
  const r = obj(d);
  const next = obj(r.next);
  const head = fields({
    id: r.runId, flow: r.flow, status: r.status, reason: r.reason === obj(r.waiting).message ? undefined : r.reason, for: runFor(r), task: firstLine(r.task) === runFor(r) ? undefined : firstLine(r.task), started: when(r.startedAt), finished: when(r.finishedAt),
    branch: r.branch, owner: r.ownerName ?? r.owner, cost: typeof r.totalCostUsd === "number" ? `$${r.totalCostUsd.toFixed(2)}` : undefined,
    archived: when(r.archivedAt), "waits for": obj(r.waiting).message, next: next.status, "to do": next.who === "You" ? next.action : undefined,
  });
  // the number is what `scf runs log <id> <n>` takes
  const steps = list(r.history).map((h, n) => ({ n, step: h.id, type: h.type, ok: h.ok ? "yes" : "no", started: when(h.startedAt), took: duration(h.durationMs), error: firstLine(h.error) }));
  const answer = r.canAnswer ? `Answer with: scf runs answer ${r.runId} "<your answer>"` : undefined;
  return blocks([head, steps.length > 0 && filled(steps, [...cols("n", "step", "type", "ok", "started", "took"), { key: "error", max: 70 }]), typeof r.questions === "string" && `Questions:\n${r.questions}`, answer]);
}

function showDiff(d: unknown): string {
  const x = obj(d);
  if (!x.stat && !x.patch) return "no changes";
  return blocks([x.stat?.trimEnd(), x.patch?.trimEnd(), x.truncated && "(the changes are too long: the rest is left out)"]);
}

function showTranscript(d: unknown): string {
  const x = obj(d);
  const lines = list(x.events).map((e) => {
    if (e.kind === "tool") return `> ${e.name} ${JSON.stringify(e.input ?? {})}${e.result ? `\n${e.result}` : ""}`;
    if (e.kind === "result") return `= ${e.text ?? ""}`;
    return String(e.text ?? "");
  });
  return blocks([`step ${x.step} (${x.type})`, ...(lines.length ? lines : ["nothing was written down for this step"])]);
}

const turnRows = (items: Obj[]) =>
  items.map((i) => {
    const n = obj(i.next);
    return { key: i.key, what: `${n.issue !== undefined ? `#${n.issue} ` : ""}${i.what ?? ""}`, asked: [n.status, n.action].filter(Boolean).join(": "), since: when(i.since), owner: i.ownerName, "you can": words(i.acts) };
  });
// the key is never cut: the other commands take it as it is
const TURN_COLUMNS: Column[] = [{ key: "key", max: 1000 }, { key: "what", max: 50 }, { key: "asked", max: 70 }, ...cols("since", "you can")];

/** The "your turn" page: per repository what waits, what is asked, and the key the other `turn` commands take. */
function showTurn(d: unknown): string {
  const t = obj(d);
  const groups = list(t.groups).map((g) => `${REPO.test(g.repo ?? "") ? g.repo : "(no repository)"}\n${filled(turnRows(list(g.items)), TURN_COLUMNS)}`);
  const going = list(t.continuing);
  return blocks([
    ...(groups.length ? groups : [t.empty || "nothing waits for you"]),
    going.length > 0 && `Done, continuing:\n${filled(turnRows(going), TURN_COLUMNS.slice(0, 2))}`,
    t.dismissed > 0 && `${t.dismissed} dismissed (scf turn restore brings them back)`,
  ]);
}

function showTurnDetail(d: unknown): string {
  const x = obj(d);
  const p = obj(x.proposal);
  const questions = list(x.questions).map((q) => `Q${q.n}. ${q.title ?? ""}\n${q.text ?? ""}${q.recommendation ? `\nRecommended: ${q.recommendation}` : ""}`);
  const body = questions.length ? questions : [fields({ risk: p.risk, split: p.split, reason: p.reason, gate: p.gate }), p.text || x.text];
  return blocks([fields({ kind: x.kind, "you can": words(x.acts), stamp: x.stamp, digest: x.digest }), ...body]);
}

function showBoard(d: unknown): string {
  const b = obj(d);
  const repos = list(b.repos).map((r) => {
    const cards = list(r.columns).flatMap((c) => list(c.cards).map((k) => ({ column: c.title, issue: `#${k.issue}`, title: k.title, step: k.step ?? obj(k.next).status, run: k.runId, since: when(k.since), after: words(k.after, "#") })));
    return `${r.repo}\n${filled(cards, [...cols("column", "issue"), { key: "title", max: 50 }, { key: "step", max: 40 }, ...cols("run", "since", "after")], "no stories")}`;
  });
  return repos.length ? blocks(repos) : b.empty || "no stories";
}

function showNext(d: unknown): string {
  const x = obj(d);
  const rows = ["server", "watchers", "issues", "runs"].flatMap((part) => list(x[part]).map((n) => ({ who: n.who, where: place(n), status: n.status, "to do": n.who === "You" || n.who === "Something is wrong" ? n.action : "", until: when(n.until) })));
  return filled(rows, [...cols("who", "where"), { key: "status", max: 50 }, { key: "to do", max: 60 }, ...cols("until")], "nothing is going on");
}

function showSince(d: unknown): string {
  const x = obj(d);
  const groups = list(x.groups).filter((g) => g.count > 0).map((g) => {
    // an entry without an issue is a run or a pull request: its link says which one
    const other = (i: Obj) => [REPO.test(i.repo ?? "") ? i.repo : "", /^#\/runs\/([\w-]+)$/.exec(obj(i.where).url ?? "")?.[1]?.replace(/^/, "run ") ?? obj(i.where).label].filter(Boolean).join(" ");
    const items = list(g.items).map((i) => ({ at: when(i.at), where: i.issue !== undefined ? `${i.repo}#${i.issue}` : other(i), title: i.title }));
    return `${g.label}${g.count > items.length ? ` (the newest ${items.length})` : ""}\n${table(items, [...cols("at", "where"), { key: "title", max: 70 }])}`;
  });
  return blocks([`since ${when(x.since)}: ${x.total === 1 ? "1 change" : `${x.total ?? 0} changes`}`, ...groups, ...(Array.isArray(x.notes) ? (x.notes as string[]) : [])]);
}

function showClarity(d: unknown): string {
  const x = obj(d);
  if (x.sampled === false) return "nothing was measured yet";
  const misses = list(x.misses).map((m) => ({ what: m.id, status: m.status, since: when(m.since), until: when(m.until) }));
  return blocks([
    fields({ "waiting now": x.waitingNow, "oldest since": when(x.oldestSince), "waits ended (30 days)": x.count, "half took at most": duration(x.halfMs), longest: duration(x.longestMs), dismissed: x.dismissed, "missed by Your turn": x.missed, "missed now": x.missedNow }),
    misses.length > 0 && `Missed:\n${table(misses, cols("what", "status", "since", "until"))}`,
  ]);
}

function showFound(d: unknown): string {
  const x = obj(d);
  const groups = list(x.groups).map((g) => {
    const hits = list(g.hits).map((h) => ({ id: h.id, title: h.title, status: h.status, repo: h.repo, detail: h.detail, when: when(h.at) }));
    return `${g.label}${g.more ? " (there are more)" : ""}\n${filled(hits, [...cols("id"), { key: "title", max: 60 }, ...cols("status", "repo", "detail", "when")])}`;
  });
  return groups.length ? blocks(groups) : "nothing found";
}

const queued = (word: string) => (d: unknown) => `run ${obj(d).runId} ${word}`;

// POST your-turn/act refuses a call without what `turn show` printed: it proves the person saw the current item.
const STAMP: Flag = { type: "string", required: true, help: "the stamp that `scf turn show <key>` printed" };
const DIGEST: Flag = { type: "string", required: true, help: "the digest that `scf turn show <key>` printed" };
const act = (action: string, apiAction: string, help: string, more: Partial<Cmd> = {}): Cmd =>
  ({ area: "turn", action, method: "POST", path: "your-turn/act", args: ["key"], fixed: { action: apiAction }, locked: ["action", "key"], help, show: showTurn, ...more, flags: { stamp: STAMP, digest: DIGEST, ...more.flags } });

/** Runs and the day-to-day work around them: your turn, the board, and search. */
export const WORK: Cmd[] = [
  { area: "runs", action: "list", method: "GET", path: "runs", args: ["q"], optional: ["q"], show: showRuns,
    help: "list the newest runs (a user: their own); [q] is text to look for, e.g. an id or #7",
    flags: {
      status: { type: "string", help: "running, waiting, stopped, failed, succeeded or cancelled" },
      flow: { type: "string", help: "only runs of this flow" },
      repo: { type: "string", help: "only runs on this repository (owner/name)" },
      since: { type: "string", help: "only runs started at or after this time, e.g. 2026-10-01" },
      owner: { type: "string", help: "only runs of this account (its id; admin only)" },
      // the server takes "1" and nothing else, and a yes/no flag would send "true"
      archived: { type: "boolean", value: "1", help: "list the archived runs instead" },
    } },
  { area: "runs", action: "show", method: "GET", path: "runs/:id", args: ["id"], show: showRun, help: "read a run: what it is for, where it stands and its steps" },
  { area: "runs", action: "start", method: "POST", path: "runs", args: ["flow", "task"], optional: ["task"],
    help: "start a run of a flow (a user: a published flow on one of their own repositories)",
    show: (d) => `run ${obj(d).runId} ${obj(d).queued ? "is queued" : "started"}`,
    flags: {
      vars: { type: "string", as: "json", help: 'the inputs of the flow as JSON, e.g. \'{"github_repo":"owner/name","issue":"7"}\'' },
      repo: { type: "string", help: "the folder on the server to work in (admin only)" },
      "like-user": { type: "boolean", help: "start under the rules of a user (for an admin)" },
    } },
  { area: "runs", action: "log", method: "GET", path: "runs/:id/transcript/:n", args: ["id", "n"], show: showTranscript, help: "what the agent said and did in a step; <n> is the step's number in `scf runs show`" },
  { area: "runs", action: "diff", method: "GET", path: "runs/:id/diff", args: ["id"], show: showDiff },
  { area: "runs", action: "answer", method: "POST", path: "runs/:id/answer", args: ["id", "text"], show: queued("continues with your answer") },
  { area: "runs", action: "approve", method: "POST", path: "runs/:id/approve", args: ["id"], show: queued("continues: approved"), help: "approve a run that waits for a decision",
    flags: { note: { type: "string", help: "a note for the run" } } },
  { area: "runs", action: "reject", method: "POST", path: "runs/:id/reject", args: ["id"], show: queued("continues: rejected"), help: "reject a run that waits for a decision",
    flags: { note: { type: "string", help: "what to change" } } },
  { area: "runs", action: "resume", method: "POST", path: "runs/:id/resume", args: ["id"], show: queued("is resumed"), help: "let a stopped or failed run go on where it stopped",
    flags: { from: { type: "string", help: "start again at this step (admin only)" } } },
  { area: "runs", action: "cancel", method: "POST", path: "runs/:id/cancel", args: ["id"], confirm: "This stops the run; the work of the step that is running is lost.",
    show: (d, a) => (obj(d).cancelled ? `run ${a.id} is cancelled` : `run ${a.id} is not running or queued: nothing to cancel`) },
  { area: "runs", action: "archive", method: "POST", path: "runs/:id/archive", args: ["id"], help: "take a finished run out of the list of runs; nothing is deleted",
    show: (d) => `run ${obj(d).runId} is archived` },
  { area: "runs", action: "unarchive", method: "POST", path: "runs/:id/unarchive", args: ["id"], show: (d) => `run ${obj(d).runId} is back in the list of runs` },
  { area: "runs", action: "owners", method: "GET", path: "run-owners", help: "the accounts that have runs, with their ids", show: (d) => table(list(d), cols("id", "name", "runs"), "no account has runs") },
  { area: "runs", action: "filters", method: "GET", path: "run-filters", help: "the repositories and flows of the runs you can see",
    show: (d) => fields({ repositories: (obj(d).repos ?? []).join(", ") || "none", flows: (obj(d).flows ?? []).join(", ") || "none" }) },

  { area: "turn", action: "list", method: "GET", path: "your-turn", show: showTurn, help: "what waits for you, with the key of each item" },
  { area: "turn", action: "show", method: "GET", path: "your-turn/detail", args: ["key"], show: showTurnDetail, help: "the questions, plan or split of an item, and the stamp and digest an action needs" },
  { area: "turn", action: "dismiss", method: "POST", path: "your-turn/dismiss", args: ["key"], show: showTurn, help: "hide an item until it changes" },
  { area: "turn", action: "restore", method: "POST", path: "your-turn/restore", args: ["key"], optional: ["key"], show: showTurn, help: "bring dismissed items back: the one with [key], or all of them" },
  act("answer", "answer", "answer the questions of an item, as a comment on the issue", { flags: { answers: { type: "string", as: "json", required: true, help: 'your answers as JSON, e.g. \'[{"n":1,"text":"yes"},{"n":2,"text":"the second option"}]\'' } } }),
  act("defaults", "defaults", "take the recommended answer to every question of an item"),
  act("approve", "approve", "approve the plan, split or request of an item, as a comment on the issue", { flags: { text: { type: "string", help: "a note to add" } } }),
  act("reject", "reject", "reject the plan, split or request of an item; <text> says what to change", { args: ["key", "text"] }),
  act("retry", "retry", "let a failed item try again", { flags: { stamp: { ...STAMP, required: false }, digest: { ...DIGEST, required: false } } }),
  act("retry-hint", "retry_hint", "let a failed item try again, with a hint as a comment on the issue", { args: ["key", "text"], flags: { digest: { ...DIGEST, required: false } } }),
  { area: "turn", action: "clarity", method: "GET", path: "clarity", show: showClarity },

  { area: "board", action: "show", method: "GET", path: "board", show: showBoard, help: "every story per repository, with the column it is in" },
  { area: "board", action: "next", method: "GET", path: "next", show: showNext, help: "what happens next, for the watchers, every tracked issue and every run" },
  { area: "board", action: "since", method: "GET", path: "since", args: ["since"], show: showSince, help: "what was done, released, failed or came to wait since a time, e.g. 2026-10-01" },

  { area: "find", action: "all", method: "GET", path: "search", args: ["q"], show: showFound, help: "find runs, repositories, refinement sessions and flows by text; quote more than one word" },
  { area: "find", action: "id", method: "GET", path: "search", args: ["id"], show: showFound, help: "look one thing up by <type>:<id>; type is run, issue, refinement, repo or flow" },
];
