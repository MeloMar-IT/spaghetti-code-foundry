import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Published figures about models, kept in <data folder>/analyst/reference.json.
 * `vendor`: the maker measured it, or a board repeats the maker's figures. `independent`: a third
 * party ran the test itself. `aggregator`: a site that collects figures and does not say who measured.
 */
/** The highest value that makes sense per metric (the lowest is 0): scores are 0-100, prices dollars per million tokens, speed tokens per second. */
const HIGHEST: Record<string, number> = { "agentic-coding": 100, "intelligence-index": 100, "price-input": 10_000, "price-output": 10_000, speed: 100_000 };

const Figure = z
  .object({
    model: z.string().min(1).max(80),
    /** What was measured, e.g. "agentic-coding" (higher is better, 0-100). */
    metric: z.string().min(1).max(60),
    value: z.number().finite().min(0),
    kind: z.enum(["vendor", "independent", "aggregator"]),
    source: z.string().max(300),
    /** The test, in lower case with dashes, e.g. "terminal-bench-4.0". Scores of different tests are never compared. */
    test: z.string().max(60).default(""),
    /** Who ran it and how, e.g. "Artificial Analysis, max effort". */
    note: z.string().max(200).default(""),
  })
  .refine((f) => f.value <= (HIGHEST[f.metric] ?? 1_000_000));
export type Figure = z.infer<typeof Figure>;

/** `triedAt`: the last lookup that failed or gave nothing, so that it is not repeated at every check. */
const Reference = z.object({ checkedAt: z.string(), triedAt: z.string().optional(), figures: z.array(Figure).max(400) });
export type Reference = z.infer<typeof Reference>;

export const EMPTY: Reference = { checkedAt: "", figures: [] };
/** A maker's own figure counts for this much: the makers' runs we could compare came out about a tenth above independent runs. */
export const VENDOR_DISCOUNT = 0.9;
export const REFRESH_DAYS = 7;
/** After a lookup that failed or gave nothing, the next one is this many days later at the earliest. */
export const RETRY_DAYS = 1;

export function loadReference(path: string): Reference {
  if (!existsSync(path)) return EMPTY;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { figures?: unknown };
    // one figure that is out of range (a file of an older version, an edit by hand) does not lose the rest
    const figures = (Array.isArray(raw.figures) ? raw.figures : []).filter((f) => Figure.safeParse(f).success);
    return Reference.parse({ ...raw, figures });
  } catch {
    return EMPTY;
  }
}

export function saveReference(path: string, ref: Reference) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(ref, null, 2));
  renameSync(path + ".tmp", path);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** "claude:anthropic:claude-sonnet-5-5" and "claude-sonnet-5-5" name the same model. */
export const modelOf = (agent: string) => agent.split(":").pop()!.toLowerCase();

export interface Trusted { value: number; basis: "independent" | "discounted"; figures: number; test: string; gap?: number }

/**
 * One figure to work with for a model and metric. Independent measurements win; without them the
 * makers' and aggregators' figures are used after a discount. `gap`: how far the makers' figure is
 * above the independent one, as a fraction, when both exist.
 */
export function trusted(ref: Reference, model: string, metric: string, test?: string): Trusted | undefined {
  const mine = ref.figures.filter((f) => f.model.toLowerCase() === model.toLowerCase() && f.metric === metric);
  // one test only: the given one, else the test with independent figures, else the one with the most figures
  const tests = [...new Set(mine.map((f) => f.test))];
  const score = (t: string) => mine.filter((f) => f.test === t).reduce((n, f) => n + (f.kind === "independent" ? 100 : 1), 0);
  const use = test ?? tests.sort((a, b) => score(b) - score(a))[0];
  const all = mine.filter((f) => f.test === use);
  if (!all.length) return undefined;
  const own = all.filter((f) => f.kind === "independent").map((f) => f.value);
  const other = all.filter((f) => f.kind !== "independent").map((f) => f.value);
  if (own.length) {
    const value = median(own);
    const gap = other.length && value > 0 ? median(other) / value - 1 : undefined;
    return { value, basis: "independent", figures: all.length, test: use!, ...(gap !== undefined ? { gap } : {}) };
  }
  return { value: median(other) * VENDOR_DISCOUNT, basis: "discounted", figures: all.length, test: use! };
}

/** The same test for two models, so that their scores can be compared; independent figures for both are preferred. */
export function trustedPair(ref: Reference, a: string, b: string, metric: string): [Trusted, Trusted] | undefined {
  // a coding score without the name of its test cannot be told to be the same test as another one
  const named = (f: Figure) => f.test !== "" || metric !== "agentic-coding";
  const testsOf = (m: string) => new Set(ref.figures.filter((f) => f.model.toLowerCase() === m.toLowerCase() && f.metric === metric && named(f)).map((f) => f.test));
  const tb = testsOf(b);
  const pairs = [...testsOf(a)].filter((t) => tb.has(t)).map((t) => [trusted(ref, a, metric, t)!, trusted(ref, b, metric, t)!] as [Trusted, Trusted]);
  const rank = (p: [Trusted, Trusted]) => p.filter((t) => t.basis === "independent").length;
  return pairs.sort((x, y) => rank(y) - rank(x))[0];
}

const olderThan = (at: string | undefined, days: number, now: Date) => !at || !(now.getTime() - Date.parse(at) <= days * 86_400_000);
/** Time to look the figures up again: they are a week old, and the last lookup that failed was not within the last day. */
export const isStale = (ref: Reference, now: Date) => olderThan(ref.checkedAt, REFRESH_DAYS, now) && olderThan(ref.triedAt, RETRY_DAYS, now);

export function refreshPrompt(models: string[]): string {
  return `Search the web for current, published measurements of these AI models on software work:
${models.map((m) => `- ${m}`).join("\n")}
Also look up, for each maker, the model one level below and one level above each of them when it exists (for example the smallest current model of the same family). These matter as much as the models listed.

Find for each model, where published:
- metric "agentic-coding": a score from 0 to 100 on a test where the model works as a coding agent in a repository or terminal (for example Terminal-Bench, SWE-bench Pro, SWE-bench Verified, Aider polyglot). Put the test in "test", in lower case with dashes and its version, e.g. "terminal-bench-4.0" or "swe-bench-pro"; always write the same test the same way.
- metric "intelligence-index": the Artificial Analysis Intelligence Index.
- metric "price-input" and "price-output": US dollars per million tokens.
- metric "speed": output tokens per second.

For every figure say who measured it:
- "independent": a third party ran the test itself and says so (for example Artificial Analysis, vals.ai, METR, the Aider leaderboard, LiveBench).
- "vendor": the maker of the model published it, or a board that repeats the makers' figures.
- "aggregator": a site that lists the figure without saying who measured it.
When you are not sure, use "aggregator". Do not invent figures; leave out what you cannot find. Give the same model several times when sources differ.

Answer with JSON only, no other text:
{"figures":[{"model":"<model id as written above when it is one of them>","metric":"...","value":0,"kind":"independent|vendor|aggregator","test":"<test, or empty for prices and speed>","source":"<url>","note":"<who ran it, and the effort setting>"}]}`;
}

/** The JSON object in a model's answer, also when it is wrapped in a code fence or in Claude Code's own JSON result. */
export function parseAnswer(text: string): Figure[] {
  let body = text;
  try {
    const outer = JSON.parse(text) as { result?: unknown };
    if (typeof outer.result === "string") body = outer.result;
  } catch {
    // plain text answer
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the answer holds no JSON");
  const raw = (JSON.parse(body.slice(start, end + 1)) as { figures?: unknown[] }).figures;
  if (!Array.isArray(raw)) throw new Error("the answer holds no figures");
  // one bad figure does not lose the rest
  return raw.flatMap((f) => {
    const r = Figure.safeParse(f);
    return r.success ? [r.data] : [];
  });
}

export type Ask = (prompt: string) => Promise<string>;

const WEB_TOOLS = "WebSearch,WebFetch";

/**
 * The session reads pages from the web, so it gets the two web tools and nothing else: `--tools`
 * takes the other tools away (`--allowedTools` alone only approves), no MCP servers, no personal
 * settings or hooks, no slash commands. Project and local settings are read from the working
 * folder, which is a new empty one (see askClaude).
 */
export const askClaudeArgs = (prompt: string, model: string) => [
  "-p", prompt, "--model", model, "--output-format", "json",
  "--tools", WEB_TOOLS, "--allowedTools", WEB_TOOLS,
  "--strict-mcp-config", "--setting-sources", "project,local", "--disable-slash-commands",
];

/** Ask Claude Code, with web search only, for the figures. Uses the Claude sign-in of this machine. */
export const askClaude = (bin = "claude", model = "claude-sonnet-5-5"): Ask => (prompt) =>
  new Promise((resolve, reject) => {
    // an empty folder of its own: nothing to read, no project settings, and removed afterwards
    const cwd = mkdtempSync(join(tmpdir(), "scf-analyst-ask-"));
    execFile(bin, askClaudeArgs(prompt, model), { cwd, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      rmSync(cwd, { recursive: true, force: true });
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/**
 * Fetch new figures. The old ones are kept when the answer cannot be used or holds nothing, and the
 * attempt is remembered (`triedAt`) so that the next one comes a day later, not at the next check.
 */
export async function refresh(old: Reference, models: string[], ask: Ask, now: Date): Promise<{ ref: Reference; note: string }> {
  const kept = { ...old, triedAt: now.toISOString() };
  try {
    const figures = parseAnswer(await ask(refreshPrompt(models)));
    if (!figures.length) return { ref: kept, note: "the search gave no usable figures; the earlier ones are kept" };
    return { ref: { checkedAt: now.toISOString(), figures: figures.slice(0, 400) }, note: `${figures.length} published figures read` };
  } catch (e) {
    return { ref: kept, note: `the published figures could not be read (${e instanceof Error ? e.message.slice(0, 120) : "error"}); the earlier ones are kept` };
  }
}
