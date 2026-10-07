import { oneLine, type Draft } from "./draft.js";
import { draftMark } from "./draft-impact.js";
import type { SplitRefs } from "./draft-split.js";
import type { Talk } from "./talk.js";
import { LIST_TITLE, TALK_FIRST_LINE, TALK_MAX_BYTES, byteLength, cutBytes, list } from "./talk-text.js";

/** The heading of the person's own way; the length in characters follows in brackets, as for the question of the person. */
export const OWN_WAY_HEADING = "## The person's own way";
export const DRAFT_HEADING = "## The draft to split";

export interface SplitInput {
  idea: string;
  brief?: string;
  talk: Talk;
  /** The draft to split, and all drafts of the session (in their order). */
  draft: Draft;
  drafts: Draft[];
  /** The person's own way, checked (see ownWay). It is the last part and is never cut. */
  own?: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HEAD_DRAFT = new RegExp(`^Draft: (${UUID})$`);
const HEAD_IDS = new RegExp(`^Ids:((?: C\\d+=${UUID})*)$`);
const HEAD_ASKED = /^Asked: ([0-9a-f]{64})$/;

/**
 * The draft, the ids behind C1, C2, … and the mark of the draft when it was asked, read back from the four head lines of a split
 * task. Undefined for any other text.
 */
export function splitOf(task: string): { draft: string; refs: SplitRefs } | undefined {
  const [first, second, third, fourth] = task.split("\n", 4);
  if (first !== TALK_FIRST_LINE.split) return undefined;
  const d = HEAD_DRAFT.exec(second ?? "");
  const ids = HEAD_IDS.exec(third ?? "");
  const asked = HEAD_ASKED.exec(fourth ?? "");
  if (!d || !ids || !asked) return undefined;
  const criteria: Record<string, string> = {};
  for (const pair of ids[1]!.trim().split(" ").filter(Boolean)) {
    const [key, id] = pair.split("=");
    criteria[key!] = id!;
  }
  return { draft: d[1]!, refs: { criteria, mark: asked[1]! } };
}

/** The draft as the checker reads it: the criteria are the lines `- C<n>: …` of "### Acceptance criteria". Every text is on one line. */
function draftPart(d: Draft, drafts: Draft[]): string {
  const part = (label: string, f?: { text: string }) => `${label}: ${f ? oneLine(f.text) : "(empty)"}`;
  const deps = d.dependsOn.map((x) => (x.issue !== undefined ? `#${x.issue}` : `draft ${drafts.find((o) => o.id === x.draft)?.title?.text ?? "(no title)"}`));
  return [
    DRAFT_HEADING,
    part("Title", d.title),
    part("Who", d.who),
    part("What", d.what),
    part("Why", d.why),
    "### Acceptance criteria",
    d.criteria.length ? d.criteria.map((c, i) => `- C${i + 1}: ${oneLine(c.text)}`).join("\n") : "(none)",
    "### Out of scope",
    d.outOfScope ? oneLine(d.outOfScope.text) : "(empty)",
    "### Depends on",
    list(deps.map(oneLine)),
    "### Notes for the builder",
    d.notes ? oneLine(d.notes.text) : "(empty)",
  ].join("\n");
}

/**
 * The task of a split run. Pure. Four head lines (what is asked; the draft; the ids behind the numbers C1, C2, … of its criteria; the
 * mark of the draft as it is now), then the draft, the idea, the brief, the map, the other drafts and the person's own way. The draft
 * comes first so the first "## The draft to split" is the real one. Over TALK_MAX_BYTES, the brief is cut first, then other drafts
 * and entries of the map from the end, last the idea; a notice says what is missing. The draft and the own way are never cut, and the
 * mark is that of the whole draft.
 */
export function splitText(input: SplitInput): string {
  const { talk, draft } = input;
  const brief = input.brief ?? "";
  const others = input.drafts.flatMap((d, i) => (d.id === draft.id ? [] : [{ n: i + 1, d }]));
  const rules = talk.map.rules.map((e) => oneLine(e.text));
  const examples = talk.map.examples.map((e) => oneLine(e.text));
  const open = talk.map.open.map((e) => oneLine(e.text));
  const full = { rules: rules.length, examples: examples.length, open: open.length, others: others.length };
  const ids = draft.criteria.map((c, i) => ` C${i + 1}=${c.id}`).join("");
  const drafted = draftPart(draft, input.drafts);
  const own = input.own === undefined ? [] : [`${OWN_WAY_HEADING} (${[...input.own].length} characters)\n${input.own}`];

  const build = (n: typeof full, briefText: string, briefCut: boolean, ideaText: string, ideaCut: boolean): string => {
    const left: string[] = [];
    if (briefCut) left.push(brief && !briefText ? "The context brief was left out." : "The context brief was cut: only its first part is here.");
    const missing = [
      [full.rules - n.rules, "rules"],
      [full.examples - n.examples, "examples"],
      [full.open - n.open, "open questions"],
      [full.others - n.others, "other drafts"],
    ].filter(([k]) => (k as number) > 0);
    if (missing.length) left.push(`These were left out because they did not fit: ${missing.map(([k, w]) => `${k} ${w}`).join(", ")}.`);
    if (ideaCut) left.push("The idea was cut: only its first part is here.");
    const parts = [
      `${TALK_FIRST_LINE.split}\nDraft: ${draft.id}\nIds:${ids}\nAsked: ${draftMark(draft)}`,
      drafted,
      `## The idea\n${ideaText}`,
      `## The context brief\n${briefText || "(none)"}`,
      [
        "## The map of the story so far",
        `### ${LIST_TITLE.rule}\n${list(rules.slice(0, n.rules))}`,
        `### ${LIST_TITLE.example}\n${list(examples.slice(0, n.examples))}`,
        `### ${LIST_TITLE.open}\n${list(open.slice(0, n.open))}`,
      ].join("\n"),
      `## The other drafts of this session\n${list(others.slice(0, n.others).map((x) => `D${x.n}: ${oneLine(x.d.title?.text ?? "(no title)")}`))}`,
      ...(left.length ? [`## Left out\n${left.join("\n")}`] : []),
      ...own,
    ];
    return parts.join("\n\n");
  };

  const fits = (t: string) => byteLength(t) <= TALK_MAX_BYTES;
  const n = { ...full };
  const whole = build(n, brief, false, input.idea, false);
  if (fits(whole)) return whole;
  // The brief first.
  if (brief) {
    const probe = build(n, "x", true, input.idea, false);
    const room = TALK_MAX_BYTES - byteLength(probe) + 1;
    if (room > 0) {
      const t = build(n, cutBytes(brief, room), true, input.idea, false);
      if (fits(t)) return t;
    }
  }
  // Then other drafts and the map, from the end, a whole line at a time.
  let text = build(n, "", brief !== "", input.idea, false);
  for (const key of ["others", "open", "examples", "rules"] as const) {
    while (!fits(text) && n[key] > 0) {
      n[key]--;
      text = build(n, "", brief !== "", input.idea, false);
    }
  }
  if (fits(text)) return text;
  // Last, the end of the idea.
  const bare = build(n, "", brief !== "", "", true);
  return build(n, "", brief !== "", cutBytes(input.idea, Math.max(0, TALK_MAX_BYTES - byteLength(bare))), true);
}
