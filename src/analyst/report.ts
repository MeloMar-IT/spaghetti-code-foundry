import { MIN_VISITS, type Advice, type Verdict } from "./advise.js";
import type { Collected } from "./collect.js";
import { modelOf, trusted, type Reference } from "./reference.js";

const HEAD: Record<Verdict, string> = {
  raise: "Try a higher level",
  time: "Time limit, not model",
  watch: "Look at this",
  lower: "Try a lower level",
  keep: "Keep as it is",
  few: "Too few visits to judge",
};

const day = (iso: string) => iso.slice(0, 10);
/** "claude:anthropic:claude-sonnet-5-5" names its model; "codex:openai" runs the model set in the tool itself. */
const modelName = (agent: string) => (agent.split(":").length >= 3 ? modelOf(agent) : `${agent.split(":")[0]} (its own default)`);
const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "–");

/** The report as Markdown: advice first, then the numbers behind it, then the published figures and how they were weighed. */
export function report(c: Collected, advice: Advice[], ref: Reference, note = ""): string {
  const out = [`# Model performance report`, "", `Runs from ${day(c.from)} to ${day(c.to)}: ${c.runs} runs, ${advice.length} step and model pairs.`, "", "This is advice to try, one step at a time. The analyst changes no flow and no setting.", ""];
  for (const verdict of Object.keys(HEAD) as Verdict[]) {
    const rows = advice.filter((a) => a.verdict === verdict);
    if (!rows.length || verdict === "few") continue;
    out.push(`## ${HEAD[verdict]}`, "");
    for (const a of rows) {
      const on = `${modelName(a.agent)}${a.effort ? `, effort ${a.effort}` : ""}`;
      out.push(`- **${a.flow} / ${a.step}** (${on}; ${(a.share * 100).toFixed(1)}% of all tokens)${a.to ? ` → **${a.to}**` : ""}. ${a.why}`);
    }
    out.push("");
  }
  out.push("## The numbers", "", "| Flow / step | Model | Effort | Visits | Worked | Timed out | Repaired | Sent back | Minutes | Input k | Output k | Token share |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  const shown = advice.filter((a) => a.stats.visits >= MIN_VISITS).sort((x, y) => y.share - x.share);
  for (const a of shown) {
    const s = a.stats;
    out.push(
      `| ${s.flow} / ${s.step} | ${modelName(s.agent)} | ${s.effort || "default"} | ${s.visits} | ${pct(s.ok, s.visits - s.limited)} | ${pct(s.timeouts, s.visits)} | ${pct(s.fixed, s.ok)} | ${pct(s.changed, s.ok)} | ${(s.minutes / s.visits).toFixed(1)} | ${Math.round(s.inputTokens / s.visits / 1000)} | ${(s.outputTokens / s.visits / 1000).toFixed(1)} | ${(a.share * 100).toFixed(1)}% |`,
    );
  }
  out.push("", ...(advice.length > shown.length ? [`${advice.length - shown.length} pairs with fewer than ${MIN_VISITS} visits are left out.`, ""] : []), "\"Repaired\": a `fix_*` step came next. \"Sent back\": a review led to an `address_*` or `revise_*` step. For a review step, \"Sent back\" is how often the review led to a change. A flow rule also decides when work is sent back (for example the risk above which a plan is revised), so compare these rates only between periods with the same flow settings.", "");

  out.push("## Published figures", "");
  if (!ref.figures.length) out.push(`None yet${note ? ` (${note})` : ""}. The advice above rests on your own runs only.`, "");
  else {
    out.push(`Checked ${day(ref.checkedAt)}${note ? ` (${note})` : ""}. Independent measurements are used when they exist. Makers' own figures and unattributed ones are lowered by a tenth and never outweigh your own runs.`, "", "| Model | Agentic coding | Test | Based on | Makers' figure above independent |", "|---|---|---|---|---|");
    for (const model of [...new Set(ref.figures.map((f) => f.model))].sort()) {
      const t = trusted(ref, model, "agentic-coding");
      if (t) out.push(`| ${model} | ${t.value.toFixed(0)} | ${t.test || "–"} | ${t.basis === "independent" ? "independent runs" : "makers' figures, lowered"} (${t.figures}) | ${t.gap !== undefined ? `${(t.gap * 100).toFixed(0)}%` : "–"} |`);
    }
    out.push("", "Sources:", ...[...new Set(ref.figures.map((f) => f.source).filter(Boolean))].sort().map((u) => `- ${u}`), "");
  }
  return out.join("\n");
}
