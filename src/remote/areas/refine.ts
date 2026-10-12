import { cols, fields, pick, table, type Column } from "../render.js";
import type { Cmd, Flag } from "../spec.js";

/*
 * Refinement: a person and the architect turn an idea into story drafts and publish them as GitHub issues.
 * Names: what works on the session is a plain word (list, start, show, round, publish); what works on a thing inside
 * the session has that thing first (draft-set, suggestion-accept, entry-remove). Arguments follow the path: the
 * session id first, then the id of the draft, then the id of the thing inside the draft.
 */

type Row = Record<string, unknown>;
const rows = (d: unknown, path: string): Row[] => {
  const v = pick(d, path);
  return Array.isArray(v) ? (v as Row[]) : [];
};
const text = (d: unknown, path: string): string => {
  const v = pick(d, path);
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
};
const yesNo = (v: unknown): string => (v === true ? "yes" : v === false ? "no" : v === undefined || v === null ? "" : String(v));
/** Blocks of output with an empty line between them; empty blocks are left out. */
const blocks = (...parts: (string | false | undefined)[]): string => parts.filter(Boolean).join("\n\n");
const titled = (title: string, list: Row[], columns: Column[]): string | false => list.length > 0 && `${title}\n${table(list, columns)}`;

// ---- sessions --------------------------------------------------------------------------------------

function showList(d: unknown): string {
  const sessions = rows(d, "sessions");
  const repos = rows(d, "repos") as unknown as string[];
  // only an admin gets the owner of each session
  const owner: Column[] = sessions.some((s) => s.ownerName !== undefined) ? [{ key: "ownerName", head: "owner" }] : [];
  return blocks(
    table(sessions, [...cols("id"), { key: "title", max: 50 }, ...cols("repo", "state", "updated"), ...owner], "no refinement sessions"),
    repos.length ? `repositories for a new session: ${repos.join(", ")}` : "no GitHub repository yet: add one before you start a session",
  );
}

/** The architect's run in a few words: "idle", "running (suggest)", "failed (review): the reason". */
function architectLine(d: unknown): string {
  const kind = text(d, "architect.kind");
  const reason = text(d, "architect.reason") || text(d, "architect.doing");
  return `${text(d, "architect.state") || "idle"}${kind ? ` (${kind})` : ""}${reason ? `: ${reason}` : ""}`;
}

const draftRow = (d: Row): Row => ({
  id: d.id,
  title: text(d, "title.text") || "(no title)",
  state: d.state,
  criteria: rows(d, "criteria").length,
  suggestions: rows(d, "suggestions").length || "",
  issue: pick(d, "published.issue") !== undefined ? `#${text(d, "published.issue")}` : "",
});
const DRAFT_COLUMNS: Column[] = [...cols("id"), { key: "title", max: 50 }, ...cols("state", "criteria", "suggestions", "issue")];

function showDrafts(d: unknown): string {
  if (pick(d, "draftsHidden") === true) return "the drafts are hidden: the repository of this session is not yours any more";
  return table(rows(d, "drafts").map(draftRow), DRAFT_COLUMNS, "no story drafts yet: scf refine draft-add <id>");
}

function showSession(d: unknown): string {
  const waiting = rows(d, "talk.rounds").flatMap((r) => rows(r, "questions")).filter((q) => q.answer === undefined);
  const questions = waiting.map((q) => [`${text(q, "id")}  ${text(q, "text")}`, ...rows(q, "options").map((o, i) => `  ${i + 1}. ${text(o, "text")} (${text(o, "tradeoff")})${q.recommended === i + 1 ? " — recommended" : ""}`)].join("\n"));
  const map = (["rules", "examples", "open"] as const).flatMap((k) => rows(d, `talk.map.${k}`).map((e) => ({ id: e.id, list: k === "open" ? "open question" : k.slice(0, -1), text: e.text })));
  const head = fields({
    id: pick(d, "id"),
    title: pick(d, "title"),
    repo: pick(d, "repo"),
    state: pick(d, "state"),
    owner: pick(d, "ownerName"),
    idea: pick(d, "idea"),
    "from issue": pick(d, "source.issue") !== undefined ? `#${text(d, "source.issue")}` : undefined,
    epic: pick(d, "epic") !== undefined ? `#${text(d, "epic")}` : undefined,
    architect: architectLine(d),
    brief: pick(d, "brief") !== undefined ? "read (see --json)" : pick(d, "briefHidden") === true ? "hidden" : "not read yet: scf refine brief <id>",
    created: pick(d, "created"),
    updated: pick(d, "updated"),
    dropped: pick(d, "droppedAt"),
    "removed on": pick(d, "removedOn"),
  });
  return blocks(
    head,
    `Story drafts\n${showDrafts(d)}`,
    questions.length > 0 && `Questions waiting for an answer\n${questions.join("\n")}`,
    titled("Proposals waiting", rows(d, "talk.proposals"), [...cols("id", "list"), { key: "text", max: 100 }]),
    titled("Rules, examples and open questions", map, [...cols("id", "list"), { key: "text", max: 100 }]),
  );
}

function showDraft(d: unknown, args: Record<string, string>): string {
  const draft = rows(d, "drafts").find((x) => x.id === args.did);
  if (!draft) return pick(d, "draftsHidden") === true ? showDrafts(d) : `no story draft ${args.did} in this session: scf refine draft-list ${args.id}`;
  const head = fields({
    id: draft.id,
    state: draft.state,
    issue: text(draft, "published.url") || undefined,
    "split into": rows(draft, "splitInto").length ? (draft.splitInto as unknown[]).join(", ") : undefined,
    "part of": pick(draft, "part.of"),
    "review label": draft.addReviewLabel === true ? "added when published" : undefined,
  });
  // the preview is the story as it would be on GitHub: the full text, not cut
  const story = `${text(draft, "preview.title") || "(no title)"}\n\n${text(draft, "preview.body")}`;
  const remarks = [...rows(draft, "remarks").map((r) => ({ ...r, by: "code" })), ...rows(draft, "review.remarks").map((r) => ({ ...r, by: r.stale === true ? "architect (text changed since)" : "architect" }))];
  return blocks(
    head,
    story,
    titled("Acceptance criteria", rows(draft, "criteria"), [...cols("id"), { key: "text", max: 100 }]),
    titled("Suggestions waiting", rows(draft, "suggestions").map((s) => ({ ...s, text: s.text ?? (s.issue !== undefined ? `#${String(s.issue)}` : `draft ${String(s.draft)}`) })), [...cols("id", "field"), { key: "text", max: 100 }]),
    titled("Remarks", remarks, [...cols("field", "kind", "by"), { key: "text", max: 120 }]),
    titled(`Definition of Ready${pick(draft, "readiness.stale") === true ? " (the list changed since the check)" : ""}`, rows(draft, "readiness.items"), [...cols("id", "result", "by"), { key: "reason", max: 120 }]),
    titled("Accepted anyway", rows(draft, "acceptedAnyway"), [...cols("id"), { key: "reason", max: 120 }]),
  );
}

function showBacklog(d: unknown): string {
  const list = rows(d, "issues").map((i) => ({
    issue: `#${text(i, "number")}`,
    title: i.title,
    criteria: yesNo(pick(i, "checks.criteria")),
    value: yesNo(pick(i, "checks.value")),
    depends: yesNo(pick(i, "checks.dependencies")),
    questions: yesNo(pick(i, "checks.questions")),
    session: i.session,
  }));
  return blocks(
    table(list, [...cols("issue"), { key: "title", max: 60 }, ...cols("criteria", "value", "depends", "questions", "session")], `no open issue of ${text(d, "repo")} is waiting to be refined`),
    pick(d, "cut") === true && "Only the newest 100 issues and pull requests were read: older open issues may be missing.",
  );
}

// ---- publishing ------------------------------------------------------------------------------------

function showPlan(d: unknown): string {
  const items = rows(d, "items").map((i) => ({
    n: i.n,
    draft: i.draft,
    title: i.title,
    state: i.state,
    issue: i.issue !== undefined ? `#${String(i.issue)}` : i.updates !== undefined ? `replaces #${String(i.updates)}` : "",
    labels: rows(i, "labels").join(", "),
    after: rows(i, "dependsOn").map((x) => (x.issue !== undefined ? `#${String(x.issue)}` : `new ${String(x.item)}`)).join(", "),
    reason: i.reason,
  }));
  const changed = pick(d, "changedOnGithub");
  const replaces = pick(d, "replaces");
  const left = rows(d, "leftBehind").map((l) => `"${text(l, "title")}" was split and still holds ${rows(l, "criteria").length} criteria that are in no part`);
  const notes = [
    `A publish creates ${rows(d, "willCreate").length} and changes ${rows(d, "willUpdate").length} issue(s) in ${text(d, "repo")}.`,
    text(d, "buildLabel") ? `Build label: ${text(d, "buildLabel")}` : text(d, "noBuildLabel"),
    text(d, "reviewLabel") && `Review label: ${text(d, "reviewLabel")}`,
    pick(d, "notChanged") !== undefined && `No draft stands for issue #${text(d, "notChanged")}: it is not changed.`,
    changed !== undefined && `Issue #${text(changed, "issue")} changed on GitHub since this session read it. Compare both with --json, then publish with --data '{"source":{"keep":"mine","seen":"${text(changed, "seen")}"}}' (or "github" to keep that text).`,
    replaces !== undefined && `Issue #${text(replaces, "issue")} was split: a publish replaces it by its parts${pick(replaces, "staysOpen") !== undefined ? " and leaves it open" : ""} (details with --json).`,
    ...left,
  ];
  return blocks(
    table(items, [...cols("n", "draft"), { key: "title", max: 50 }, ...cols("state", "issue", "labels", "after"), { key: "reason", max: 100 }], "no story drafts to publish"),
    notes.filter(Boolean).join("\n"),
  );
}

function showPublished(d: unknown): string {
  const line = (what: string) => (m: Row) => ({ what, issue: `#${text(m, "issue")}`, draft: m.draft, url: m.url });
  const done = [...rows(d, "created").map(line("created")), ...rows(d, "updated").map(line("updated"))];
  return blocks(table(done, cols("what", "issue", "draft", "url"), "nothing was published: no draft is ready (scf refine publish-plan <id>)"), `session: ${text(d, "state")}`);
}

// ---- the table -------------------------------------------------------------------------------------

const cmd = (action: string, method: Cmd["method"], path: string, rest: Omit<Cmd, "area" | "action" | "method" | "path"> = {}): Cmd => ({ area: "refine", action, method, path: path ? `refinement/${path}` : "refinement", ...rest });
const S = ["id"];
const D = ["id", "did"];
const one = (help: string): Flag => ({ type: "string", help });
const RUN = "one architect run per account at a time; see its state with: scf refine show <id>";

export const REFINE: Cmd[] = [
  // sessions
  cmd("list", "GET", "", { show: showList, help: "your refinement sessions and the repositories a new one can use (an admin: all sessions)" }),
  cmd("start", "POST", "", {
    args: ["repo"],
    help: "start a session on one of your GitHub repositories (owner/name), from an idea or from an open issue",
    flags: { idea: one("the idea, in your own words"), title: one("a title (default: the start of the idea)"), issue: { type: "string", as: "number", help: "start from this open issue instead of an idea" } },
    show: showSession,
  }),
  cmd("backlog", "GET", "backlog", { args: ["repo"], show: showBacklog, help: "the open issues of your repository (owner/name) the Foundry has not built, each with four quick checks" }),
  cmd("show", "GET", ":id", { args: S, show: showSession, help: "a session: its state, drafts, the architect's questions and proposals, and the rules and examples" }),
  cmd("rename", "PUT", ":id", { args: ["id", "title"], show: showSession }),
  cmd("drop", "POST", ":id/drop", { args: S, show: showSession, confirm: "This drops the session and cancels its architect run; it is removed for good after 30 days." }),
  cmd("restore", "POST", ":id/restore", { args: S, show: showSession }),
  cmd("source-unlabel", "POST", ":id/source/remove-build-label", { args: S, show: showSession, help: "remove the build label from the issue this session came from, on GitHub" }),
  cmd("epic-set", "PUT", ":id/epic", { args: S, flags: { issue: { type: "string", as: "number", required: true, help: "the issue number of the Epic" } }, show: showSession, help: "set the Epic of the session" }),
  cmd("epic-clear", "PUT", ":id/epic", { args: S, fixed: { issue: null }, show: showSession, help: "the session has no Epic any more" }),

  // the talk with the architect
  cmd("brief", "POST", ":id/architect", { args: S, show: showSession, help: `ask the architect to read the repository, or resume a paused read (${RUN})` }),
  cmd("round", "POST", ":id/round", { args: S, show: showSession, help: `ask the architect for a round of questions, or resume a paused round (${RUN})` }),
  cmd("ask", "POST", ":id/ask", { args: ["id", "question"], show: showSession, help: "ask the architect a question of your own; the answer is in: scf refine show <id> --json (talk.asked)" }),
  cmd("question-answer", "POST", ":id/questions/:qid/answer", {
    args: ["id", "qid"],
    help: "answer a question of the architect: give exactly one of --option, --text, --unknown",
    flags: { option: { type: "string", as: "number", help: "the number of the option you choose (1 to 4)" }, text: one("your own answer"), unknown: { type: "boolean", help: "\"I don't know yet\": it becomes an open question" } },
    show: showSession,
  }),
  cmd("proposal-accept", "POST", ":id/proposals/:pid/accept", { args: ["id", "pid"], show: showSession, help: "accept a proposed entry: it goes into the rules, examples or open questions" }),
  cmd("proposal-reject", "POST", ":id/proposals/:pid/reject", { args: ["id", "pid"], show: showSession, help: "reject a proposed entry; it is removed" }),
  cmd("entry-set", "PUT", ":id/map/:eid", { args: ["id", "eid", "text"], show: showSession, help: "change the text of a rule, example or open question" }),
  cmd("entry-remove", "DELETE", ":id/map/:eid", { args: ["id", "eid"], show: showSession, confirm: "This removes the rule, example or open question from the session.", help: "remove a rule, example or open question" }),

  // story drafts
  cmd("draft-list", "GET", ":id", { args: S, show: showDrafts, help: "the story drafts of a session: title, state, and the issue when it is on GitHub" }),
  // the draft id is not part of the call: the server answers the whole session and the draft is picked here
  cmd("draft-show", "GET", ":id", { args: D, local: ["did"], show: showDraft, help: "one story draft as it would be on GitHub, with its criteria, suggestions, remarks and readiness (--json: the whole session)" }),
  cmd("draft-add", "POST", ":id/drafts", { args: S, show: showDrafts, help: "add an empty story draft (at most 20); its id is the last of the list" }),
  cmd("draft-set", "PUT", ":id/drafts/:did", {
    args: D,
    help: "save fields of a story draft; only the fields you give change (criteria and dependsOn are lists: use --data)",
    flags: { title: one("the title"), who: one("As …"), what: one("I want …"), why: one("so that …"), "out-of-scope": one("what is out of scope"), notes: one("notes for the builder") },
    show: showDraft,
  }),
  cmd("draft-remove", "DELETE", ":id/drafts/:did", { args: D, show: showDrafts, confirm: "This removes the story draft and its texts.", help: "remove a story draft" }),
  cmd("draft-suggest", "POST", ":id/drafts/:did/suggest", { args: ["id", "did", "field"], show: showDraft, help: "ask the architect for a suggestion for one field: title, who, what, why, criteria, outOfScope, dependsOn or notes" }),
  cmd("draft-review", "POST", ":id/drafts/:did/review", { args: D, show: showDraft, help: "ask the architect to review a story draft, or resume a paused review; no field changes" }),
  cmd("draft-impact", "POST", ":id/drafts/:did/impact", { args: D, help: "ask the architect what a story draft touches, how risky and how big it is; no field changes (answer: show --json)" }),
  cmd("draft-ready-check", "POST", ":id/drafts/:did/ready-check", { args: D, show: showDraft, help: "check a story draft against the Definition of Ready of its repository; the architect judges what code cannot" }),
  cmd("draft-split", "POST", ":id/drafts/:did/split", { args: D, flags: { own: one("a way to split of your own, in a sentence") }, help: "ask the architect for ways to split a story draft; nothing is split yet (answer: show --json)" }),
  cmd("draft-split-confirm", "POST", ":id/drafts/:did/split/confirm", {
    args: D,
    help: "split a story draft into parts; the plan comes from --data: { parts: [{ title, sentence?, criteria, dependsOn }], unplaced }",
    flags: { way: { type: "string", as: "number", help: "the number of the architect's way this plan comes from, counted from 0" } },
    show: showDrafts,
  }),
  cmd("draft-merge", "POST", ":id/drafts/:did/merge", { args: ["id", "did", "with"], show: showDrafts, confirm: "This merges the second draft into the first; the second draft is removed.", help: "merge another story draft of the session into this one" }),
  cmd("draft-to-notes", "POST", ":id/drafts/:did/move-to-notes", {
    args: D,
    help: "move a text that says how to build to the notes for the builder, as a wish",
    flags: { field: { type: "string", required: true, help: "title, who, what, why, criteria or outOfScope" }, item: one("the id of the criterion (only with --field criteria)") },
    show: showDraft,
  }),
  cmd("criterion-move", "POST", ":id/drafts/:did/criteria/:cid/move", { args: ["id", "did", "cid", "to"], show: showDrafts, help: "move an acceptance criterion between a split story draft and its parts, or between two parts (<to>: a draft id)" }),
  cmd("review-label-add", "PUT", ":id/drafts/:did/review-label", { args: D, fixed: { add: true }, show: showDraft, help: "the story draft gets the review label when it is published; nothing is sent to GitHub now" }),
  cmd("review-label-remove", "PUT", ":id/drafts/:did/review-label", { args: D, fixed: { add: false }, show: showDraft, help: "the story draft does not get the review label when it is published" }),
  cmd("ready-accept", "POST", ":id/drafts/:did/ready/:item/accept", { args: ["id", "did", "item"], flags: { reason: { type: "string", required: true, help: "why the item is accepted anyway (one line)" } }, show: showDraft, help: "accept an item of the Definition of Ready anyway for a story draft, with a reason" }),
  cmd("ready-unaccept", "DELETE", ":id/drafts/:did/ready/:item/accept", { args: ["id", "did", "item"], show: showDraft, help: "take back the \"accepted anyway\" mark of an item of the Definition of Ready" }),
  cmd("suggestion-accept", "POST", ":id/drafts/:did/suggestions/:sid/accept", { args: ["id", "did", "sid"], flags: { text: one("your own text instead of the suggested one") }, show: showDraft, help: "accept a suggestion of the architect, as it is or with your own text; it goes into the draft" }),
  cmd("suggestion-reject", "POST", ":id/drafts/:did/suggestions/:sid/reject", { args: ["id", "did", "sid"], flags: { reason: one("why (one line); the architect reads it before the next suggestion") }, show: showDraft, help: "reject a suggestion of the architect; it is removed" }),

  // publishing
  cmd("publish-plan", "GET", ":id/publish", { args: S, show: showPlan, help: "what a publish would do: the issues it creates or changes, their order, labels and dependencies; nothing is written" }),
  cmd("publish", "POST", ":id/publish", {
    args: S,
    confirm: "This creates or changes issues on GitHub for every ready story draft of the session.",
    help: "publish the ready story drafts as GitHub issues (look at publish-plan first); choices per draft go in --data",
    show: showPublished,
  }),
];
