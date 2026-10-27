/**
 * Reads the citations of a plan: the context entries (`[source: s-<16 hex>]`) that its Requirements, Constraints and
 * Acceptance criteria sections rest on. Pure: no file access.
 */

export const CITED_SECTIONS = ["requirements", "constraints", "acceptance-criteria"] as const;
export type CitedSection = (typeof CITED_SECTIONS)[number];

export interface SectionCitations {
  name: CitedSection;
  present: boolean;
  /** Known ids, in the order of first appearance. */
  cited: string[];
  /** Well-formed ids that are not in the known set. */
  unknown: string[];
}

export interface PlanCitations {
  sections: SectionCitations[];
  /** How many of the three sections are missing or cite no known id. */
  uncited: number;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const NAME = /^(requirements|constraints|acceptance criteria)(?![a-z0-9])/;
const CITATION = /\[source:\s*([^\]\n]*)\]/gi;
const SOURCE_ID = /^s-[0-9a-f]{16}$/;

const toSection = (n: string): CitedSection => (n === "acceptance criteria" ? "acceptance-criteria" : (n as CitedSection));

export function planCitations(output: string, known: ReadonlySet<string>): PlanCitations {
  const sections: SectionCitations[] = CITED_SECTIONS.map((name) => ({ name, present: false, cited: [], unknown: [] }));
  const byName = new Map(sections.map((s) => [s.name, s]));
  // A fence opens with 3 or more backticks (or tildes) and closes only with the same character, at least as long, and nothing else on the line.
  let fence: { char: string; length: number } | undefined;
  let current: { section: SectionCitations; level: number } | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      if (current && level <= current.level) current = undefined;
      const m = NAME.exec(h[2]!.toLowerCase().replace(/[*_`]/g, "").trim());
      if (m) {
        const section = byName.get(toSection(m[1]!))!;
        section.present = true;
        current = { section, level };
      }
      continue;
    }
    if (!current) continue;
    for (const c of line.matchAll(CITATION)) {
      for (const raw of c[1]!.split(",")) {
        const id = raw.trim();
        if (!SOURCE_ID.test(id)) continue;
        const list = known.has(id) ? current.section.cited : current.section.unknown;
        if (!list.includes(id)) list.push(id);
      }
    }
  }
  return { sections, uncited: sections.filter((s) => !s.present || s.cited.length === 0).length };
}
