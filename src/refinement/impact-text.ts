import { oneLine, type Draft } from "./draft.js";
import { draftMark, type ImpactRefs } from "./draft-impact.js";
import type { Talk } from "./talk.js";
import { LIST_TITLE, TALK_FIRST_LINE, TALK_MAX_BYTES, byteLength, cutBytes, draftPart, list } from "./talk-text.js";

export interface ImpactInput {
  idea: string;
  brief?: string;
  talk: Talk;
  /** The draft the view is for, and all drafts of the session (in their order). */
  draft: Draft;
  drafts: Draft[];
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HEAD_DRAFT = new RegExp(`^Draft: (${UUID})$`);
const HEAD_IDS = new RegExp(`^Ids:((?: D\\d+=${UUID})*)$`);
const HEAD_ASKED = /^Asked: ([0-9a-f]{64})$/;

/**
 * The draft, the ids behind D1, D2, … and the mark of the draft when it was asked, read back from the four head lines of an impact
 * task. Undefined for any other text.
 */
export function impactOf(task: string): { draft: string; refs: ImpactRefs } | undefined {
  const [first, second, third, fourth] = task.split("\n", 4);
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
  return { draft: d[1]!, refs: { drafts, mark: asked[1]! } };
}

/**
 * The task of an impact run. Pure. Four head lines (what is asked; the draft; the ids behind the numbers D1, D2, … of the other
 * drafts; the mark of the draft as it is now), then the idea, the brief, the map, the draft and the other drafts. Over TALK_MAX_BYTES,
 * the brief is cut first, then other drafts and entries of the map from the end, last the end of the draft; a notice says what is
 * missing. The ids line names only drafts that are in the text. The mark is always that of the whole draft.
 */
export function impactText(input: ImpactInput): string {
  const { talk, draft } = input;
  const brief = input.brief ?? "";
  const others = input.drafts.flatMap((d, i) => (d.id === draft.id ? [] : [{ n: i + 1, d }]));
  const rules = talk.map.rules.map((e) => oneLine(e.text));
  const examples = talk.map.examples.map((e) => oneLine(e.text));
  const open = talk.map.open.map((e) => oneLine(e.text));
  const full = { rules: rules.length, examples: examples.length, open: open.length, others: others.length };
  const mark = draftMark(draft);

  const build = (n: typeof full, briefText: string, briefCut: boolean, draftText: string, draftCut: boolean): string => {
    const o = others.slice(0, n.others);
    const left: string[] = [];
    if (briefCut) left.push(brief && !briefText ? "The context brief was left out." : "The context brief was cut: only its first part is here.");
    const missing = [
      [full.rules - n.rules, "rules"],
      [full.examples - n.examples, "examples"],
      [full.open - n.open, "open questions"],
      [full.others - n.others, "other drafts"],
    ].filter(([k]) => (k as number) > 0);
    if (missing.length) left.push(`These were left out because they did not fit: ${missing.map(([k, w]) => `${k} ${w}`).join(", ")}.`);
    if (draftCut) left.push("The draft was cut: the end did not fit.");
    const parts = [
      `${TALK_FIRST_LINE.impact}\nDraft: ${draft.id}\nIds:${o.map((x) => ` D${x.n}=${x.d.id}`).join("")}\nAsked: ${mark}`,
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
  for (const key of ["others", "open", "examples", "rules"] as const) {
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
