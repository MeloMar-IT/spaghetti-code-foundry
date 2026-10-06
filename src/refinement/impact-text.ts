import { oneLine, type Draft } from "./draft.js";
import { draftMark, safeAreas, type ImpactRefs, type KnownAreas } from "./draft-impact.js";
import type { Talk } from "./talk.js";
import { LIST_TITLE, TALK_FIRST_LINE, TALK_MAX_BYTES, byteLength, cutBytes, draftPart, list } from "./talk-text.js";

/** An issue of this repository whose areas the Foundry knows (`active`: a run for it is queued, running, paused or waiting). */
export interface KnownIssue {
  issue: number;
  areas: string[];
  active: boolean;
}
/** A draft of another session of the owner, on the same repository, with a stored view. */
export interface KnownDraft {
  id: string;
  title: string;
  areas: string[];
}

export interface ImpactInput {
  idea: string;
  brief?: string;
  talk: Talk;
  /** The draft the view is for, and all drafts of the session (in their order). */
  draft: Draft;
  drafts: Draft[];
  /** The areas the Foundry knows: issues (in the order to keep) and drafts of other sessions. */
  known?: { issues: KnownIssue[]; drafts: KnownDraft[] };
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HEAD_DRAFT = new RegExp(`^Draft: (${UUID})$`);
const HEAD_IDS = new RegExp(`^Ids:((?: D\\d+=${UUID})*)$`);
const HEAD_ASKED = /^Asked: ([0-9a-f]{64})$/;

/**
 * The draft, the ids behind D1, D2, … and the mark of the draft when it was asked, read back from the four head lines of an impact
 * task. Undefined for any other text.
 */
const KNOWN_HEADING = "## Areas the Foundry knows";
// Areas are written as JSON, so any path the schema accepts (spaces, commas) survives: `#12, being built: ["src/a","b c"]` and
// `D2, a draft: [["src/a"],"Title"]` (areas, then title).
const KNOWN_ISSUE_LINE = /^- #(\d+)(, being built)?: (.+)$/;
const KNOWN_DRAFT_LINE = /^- (D\d{1,6}), a draft: (\[.+\])$/;
const NO_AREAS = "(no areas yet)";
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const parse = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The part "Areas the Foundry knows", read from its fixed place (right after the four head lines); text of people comes later. */
function knownOf(lines: string[]): KnownAreas | undefined {
  // A task from before this part existed has none: that is not the same as an empty part.
  if (lines[4] !== "" || lines[5] !== KNOWN_HEADING) return undefined;
  const known: KnownAreas = { issues: {}, drafts: {} };
  for (const line of lines.slice(6)) {
    if (line === "") break;
    const i = KNOWN_ISSUE_LINE.exec(line);
    if (i) {
      const areas = i[3] === NO_AREAS ? [] : parse(i[3]!);
      if (strings(areas)) known.issues[i[1]!] = { areas, ...(i[2] ? { active: true as const } : {}) };
      continue;
    }
    const d = KNOWN_DRAFT_LINE.exec(line);
    const pair = d ? parse(d[2]!) : undefined;
    if (d && Array.isArray(pair) && strings(pair[0])) known.drafts[d[1]!] = pair[0];
  }
  return known;
}

export function impactOf(task: string): { draft: string; refs: ImpactRefs } | undefined {
  const lines = task.split("\n");
  const [first, second, third, fourth] = lines;
  if (first !== TALK_FIRST_LINE.impact) return undefined;
  const d = HEAD_DRAFT.exec(second ?? "");
  const ids = HEAD_IDS.exec(third ?? "");
  const asked = HEAD_ASKED.exec(fourth ?? "");
  if (!d || !ids || !asked) return undefined;
  const drafts: Record<string, string> = {};
  for (const pair of ids[1]!.trim().split(" ").filter(Boolean)) {
    const [key, id] = pair.split("=");
    drafts[key!] = id!;
  }
  return { draft: d[1]!, refs: { drafts, mark: asked[1]!, known: knownOf(lines) } };
}

/**
 * The task of an impact run. Pure. Four head lines (what is asked; the draft; the ids behind the numbers D1, D2, … of the other
 * drafts; the mark of the draft as it is now), then the areas the Foundry knows, the idea, the brief, the map, the draft and the other
 * drafts. Over TALK_MAX_BYTES, the brief is cut first, then other drafts and entries of the map from the end, then lines of known
 * areas from the end, last the end of the draft; a notice says what is missing. The ids line names only drafts that are in the text.
 * The mark is always that of the whole draft.
 */
export function impactText(input: ImpactInput): string {
  const { talk, draft } = input;
  const brief = input.brief ?? "";
  const others = input.drafts.flatMap((d, i) => (d.id === draft.id ? [] : [{ n: i + 1, d }]));
  const rules = talk.map.rules.map((e) => oneLine(e.text));
  const examples = talk.map.examples.map((e) => oneLine(e.text));
  const open = talk.map.open.map((e) => oneLine(e.text));
  const cut200 = (t: string) => [...oneLine(t)].slice(0, 200).join("");
  const draftLine = (n: number, areas: string[], title: string | undefined) => (areas.length ? [{ n, text: `D${n}, a draft: ${JSON.stringify([areas, cut200(title ?? "(no title)")])}` }] : []);
  // Known lines: issues, then drafts of this session, then drafts of other sessions (numbered after the drafts of this session).
  const known = [
    ...(input.known?.issues ?? []).flatMap((k) => (k.areas.length || k.active ? [{ n: 0, text: `#${k.issue}${k.active ? ", being built" : ""}: ${k.areas.length ? JSON.stringify(k.areas) : NO_AREAS}` }] : [])),
    ...input.drafts.flatMap((d, i) => (d.id === draft.id || !d.impact ? [] : draftLine(i + 1, safeAreas(d.impact.areas.map((a) => a.area)), d.title?.text))),
    ...(input.known?.drafts ?? []).flatMap((d, j) => draftLine(input.drafts.length + j + 1, safeAreas(d.areas), d.title || undefined)),
  ];
  const otherSessions = new Map((input.known?.drafts ?? []).map((d, j) => [input.drafts.length + j + 1, d.id]));
  const full = { rules: rules.length, examples: examples.length, open: open.length, others: others.length, known: known.length };
  const mark = draftMark(draft);

  const build = (n: typeof full, briefText: string, briefCut: boolean, draftText: string, draftCut: boolean): string => {
    const o = others.slice(0, n.others);
    const kept = known.slice(0, n.known);
    // The ids behind the numbers: other drafts of this session that are in the text (list or known line), and drafts of other sessions in kept lines.
    const ids = new Map<number, string>(o.map((x) => [x.n, x.d.id]));
    for (const k of kept) {
      const num = Number(/^D(\d+),/.exec(k.text)?.[1]);
      const id = otherSessions.get(num) ?? input.drafts[num - 1]?.id;
      if (num && id) ids.set(num, id);
    }
    const left: string[] = [];
    if (briefCut) left.push(brief && !briefText ? "The context brief was left out." : "The context brief was cut: only its first part is here.");
    const missing = [
      [full.rules - n.rules, "rules"],
      [full.examples - n.examples, "examples"],
      [full.open - n.open, "open questions"],
      [full.others - n.others, "other drafts"],
      [full.known - n.known, "lines of known areas"],
    ].filter(([k]) => (k as number) > 0);
    if (missing.length) left.push(`These were left out because they did not fit: ${missing.map(([k, w]) => `${k} ${w}`).join(", ")}.`);
    if (draftCut) left.push("The draft was cut: the end did not fit.");
    const parts = [
      `${TALK_FIRST_LINE.impact}\nDraft: ${draft.id}\nIds:${[...ids].sort((x, y) => x[0] - y[0]).map(([k, id]) => ` D${k}=${id}`).join("")}\nAsked: ${mark}`,
      `${KNOWN_HEADING}\n${list(kept.map((k) => k.text))}`,
      `## The idea\n${input.idea}`,
      `## The context brief\n${briefText || "(none)"}`,
      [
        "## The map of the story so far",
        `### ${LIST_TITLE.rule}\n${list(rules.slice(0, n.rules))}`,
        `### ${LIST_TITLE.example}\n${list(examples.slice(0, n.examples))}`,
        `### ${LIST_TITLE.open}\n${list(open.slice(0, n.open))}`,
      ].join("\n"),
      draftText,
      `## The other drafts of this session\n${list(o.map((x) => `D${x.n}: ${oneLine(x.d.title?.text ?? "(no title)")}`))}`,
      ...(left.length ? [`## Left out\n${left.join("\n")}`] : []),
    ];
    return parts.join("\n\n");
  };

  const fits = (t: string) => byteLength(t) <= TALK_MAX_BYTES;
  const drafted = draftPart(draft, input.drafts);
  const n = { ...full };
  const whole = build(n, brief, false, drafted, false);
  if (fits(whole)) return whole;
  // The brief first.
  if (brief) {
    const probe = build(n, "x", true, drafted, false);
    const room = TALK_MAX_BYTES - byteLength(probe) + 1;
    if (room > 0) {
      const t = build(n, cutBytes(brief, room), true, drafted, false);
      if (fits(t)) return t;
    }
  }
  // Then other drafts and the map, from the end, a whole line at a time.
  let text = build(n, "", brief !== "", drafted, false);
  for (const key of ["others", "open", "examples", "rules", "known"] as const) {
    while (!fits(text) && n[key] > 0) {
      n[key]--;
      text = build(n, "", brief !== "", drafted, false);
    }
  }
  if (fits(text)) return text;
  // Last, the end of the draft.
  const bare = build(n, "", brief !== "", "", true);
  return build(n, "", brief !== "", cutBytes(drafted, Math.max(0, TALK_MAX_BYTES - byteLength(bare))), true);
}
