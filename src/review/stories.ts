// The logic of the repo-review flow: read the answers of the two agents, check refs, plan the stories, write their bodies and the summary.
// Pure, except checkRef (it reads files of the clone). tools/repo-review does the input and output around it.
// Agent text is untrusted: it is redacted, one-lined or made safe before it reaches an issue, so it cannot plant a heading,
// a "Depends on" line, a marker or a mention that another tool reads.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { redactText } from "../credentials/redact.js";
import { safeSentence } from "../failure.js";
import { CREDENTIAL_RULES } from "../skills/credential-scan.js";

export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];
export type Kind = "bug" | "enhancement";
export interface Finding { id: string; category: string; severity: Severity; title: string; detail: string; refs: string[] }
export interface VerifiedStory {
  title: string; kind: Kind; severity: Severity; who: string; what: string; why: string; problem: string; where: string;
  refs: string[]; fix: string; criteria: string[]; ownerNeeds: string; coveredBy?: number; findings: string[];
}
export interface VerifyAnswer { stories: VerifiedStory[]; dropped: { finding: string; reason: string }[] }
export interface Settings { maxStories: number; labels: string[]; summaryIssue: boolean; scheduled: boolean }
export interface Baseline {
  state: "green" | "red" | "unknown"; branch: string; commit: string; failing: string[]; named: string[]; configRefs: string[];
  testCmd: string; buildCmd: string; note: string;
}
export interface OpenIssue { number: number; title: string }
export interface PlannedStory { key: string; title: string; body: string; labels: string[]; kind: Kind; severity: Severity; dependsOnBuild: boolean }
export interface Plan {
  version: 1; repo: string; runId: string; baseline: Baseline; stories: PlannedStory[]; buildIssue?: number;
  skipped: { title: string; reason: string }[]; dropped: { finding: string; title: string; reason: string }[];
  summaryIssue: boolean; notes: string[];
}
export type Filed = Record<string, { number: number; url?: string }>;

export const BUILD_TITLE = "Make it build and test";
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const REF = /^([^\s:]+):(\d+)(?:-(\d+))?$/;
const DEP_LINE = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)?(?:depends[ \t]+on|blocked[ \t]+by)\b/i;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$/;

export function parseSettings(env: Record<string, string | undefined>): Settings {
  const max = (env.FACTORY_VAR_MAX_STORIES ?? "").trim();
  if (max && !/^[1-9]\d?$/.test(max)) throw new Error("max_stories must be a whole number from 1 to 50");
  const maxStories = max ? Number(max) : 10;
  if (maxStories > 50) throw new Error("max_stories must be a whole number from 1 to 50");
  const raw = (env.FACTORY_VAR_LABELS ?? "").trim();
  const labels = raw ? [...new Set(raw.split(",").map((l) => l.trim()).filter(Boolean))] : ["Factory_go"];
  if (labels.length < 1 || labels.length > 10 || labels.some((l) => !LABEL.test(l))) {
    throw new Error("labels must be 1 to 10 names separated by commas; each is 1 to 50 characters of letters, digits, space and . _ : / -");
  }
  const s = (env.FACTORY_VAR_SUMMARY_ISSUE ?? "").trim().toLowerCase();
  if (s !== "" && s !== "yes" && s !== "no") throw new Error("summary_issue must be yes or no");
  return { maxStories, labels, summaryIssue: s === "yes", scheduled: (env.FACTORY_VAR_CHORE_WATCHER ?? "").trim() !== "" };
}

/** The JSON object of an answer: inside a ```json fence, or from the first "{" to the last "}". */
export function extractJson(text: string): unknown {
  const t = String(text ?? "");
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(t);
  const body = fence ? fence[1]! : t;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("the answer holds no JSON object");
  try {
    return JSON.parse(body.slice(a, b + 1));
  } catch {
    throw new Error("the answer is not valid JSON");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.trim().length >= min && v.length <= max;
const refOk = (v: unknown): v is string => typeof v === "string" && v.length <= 300 && REF.test(v);

/** The findings of the review. Single bad entries are listed as invalid; an answer without a findings list throws. */
export function parseReview(text: string): { findings: Finding[]; invalid: { index: number; reason: string }[] } {
  const o = extractJson(text);
  if (!isObj(o) || !Array.isArray(o.findings)) throw new Error('the review answer is not {"findings": [...]}');
  const findings: Finding[] = [];
  const invalid: { index: number; reason: string }[] = [];
  const seen = new Set<string>();
  o.findings.forEach((f, index) => {
    const bad = (reason: string) => invalid.push({ index, reason });
    if (!isObj(f)) return bad("not an object");
    if (!str(f.id, 1, 20) || seen.has(f.id)) return bad("no id, or the id is used twice");
    if (!SEVERITIES.includes(f.severity as Severity)) return bad("unknown severity");
    if (!str(f.title, 1, 200) || !str(f.category, 1, 80) || !str(f.detail, 1, 4000)) return bad("title, category or detail is missing or too long");
    if (!Array.isArray(f.refs) || f.refs.length > 20 || !f.refs.every(refOk)) return bad("refs must be path:line");
    seen.add(f.id);
    findings.push({ id: f.id, category: f.category, severity: f.severity as Severity, title: f.title, detail: f.detail, refs: f.refs as string[] });
  });
  return { findings, invalid };
}

const STORY_KEYS = ["title", "kind", "severity", "who", "what", "why", "problem", "where", "refs", "fix", "criteria", "owner_needs", "covered_by", "findings"];

/** The form of the verify answer. Every problem is one line; with problems there is no answer. */
export function checkVerify(text: string, ids: ReadonlySet<string>): { answer?: VerifyAnswer; problems: string[] } {
  let o: unknown;
  try {
    o = extractJson(text);
  } catch (e) {
    return { problems: [(e as Error).message] };
  }
  const problems: string[] = [];
  if (!isObj(o) || !Array.isArray(o.stories) || !Array.isArray(o.dropped)) return { problems: ['the answer must be {"stories": [...], "dropped": [...]}'] };
  for (const k of Object.keys(o)) if (k !== "stories" && k !== "dropped") problems.push(`unknown key "${k}" in the answer`);
  const used = new Map<string, number>();
  const use = (id: unknown, where: string) => {
    if (typeof id !== "string" || !ids.has(id)) return problems.push(`${where}: "${String(id).slice(0, 40)}" is not a finding id`);
    used.set(id, (used.get(id) ?? 0) + 1);
    if (used.get(id)! > 1) problems.push(`${where}: finding ${id} appears more than once`);
  };
  const stories: VerifiedStory[] = [];
  o.stories.forEach((s, i) => {
    const w = `story ${i + 1}`;
    if (!isObj(s)) return void problems.push(`${w} is not an object`);
    const before = problems.length;
    for (const k of Object.keys(s)) if (!STORY_KEYS.includes(k)) problems.push(`${w}: unknown key "${k}"`);
    if (!str(s.title, 1, 120)) problems.push(`${w}: title must be 1 to 120 characters`);
    if (s.kind !== "bug" && s.kind !== "enhancement") problems.push(`${w}: kind must be bug or enhancement`);
    if (!SEVERITIES.includes(s.severity as Severity)) problems.push(`${w}: severity must be one of ${SEVERITIES.join(", ")}`);
    for (const k of ["who", "what", "why", "problem", "where", "fix"]) if (!str(s[k], 1, 2000)) problems.push(`${w}: ${k} must be 1 to 2000 characters`);
    if (!Array.isArray(s.criteria) || s.criteria.length < 1 || s.criteria.length > 10 || !s.criteria.every((c) => str(c, 1, 500))) problems.push(`${w}: criteria must be 1 to 10 texts of at most 500 characters`);
    if (!Array.isArray(s.refs) || s.refs.length < 1 || s.refs.length > 20 || !s.refs.every(refOk)) problems.push(`${w}: refs must be 1 to 20 entries like path:line`);
    if (s.owner_needs !== undefined && !str(s.owner_needs, 0, 2000)) problems.push(`${w}: owner_needs must be text of at most 2000 characters`);
    if (s.covered_by !== undefined && !(Number.isSafeInteger(s.covered_by) && (s.covered_by as number) > 0)) problems.push(`${w}: covered_by must be an issue number`);
    if (!Array.isArray(s.findings) || s.findings.length < 1) problems.push(`${w}: findings must list at least one finding id`);
    else s.findings.forEach((id) => use(id, w));
    if (problems.length === before) {
      stories.push({
        title: s.title as string, kind: s.kind as Kind, severity: s.severity as Severity, who: s.who as string, what: s.what as string, why: s.why as string,
        problem: s.problem as string, where: s.where as string, refs: s.refs as string[], fix: s.fix as string, criteria: s.criteria as string[],
        ownerNeeds: typeof s.owner_needs === "string" ? s.owner_needs : "", coveredBy: s.covered_by as number | undefined, findings: s.findings as string[],
      });
    }
  });
  const dropped: { finding: string; reason: string }[] = [];
  o.dropped.forEach((d, i) => {
    const w = `dropped ${i + 1}`;
    if (!isObj(d)) return void problems.push(`${w} is not an object`);
    for (const k of Object.keys(d)) if (k !== "finding" && k !== "reason") problems.push(`${w}: unknown key "${k}"`);
    use(d.finding, w);
    if (!str(d.reason, 1, 1000)) problems.push(`${w}: a reason of 1 to 1000 characters is needed`);
    else dropped.push({ finding: String(d.finding), reason: d.reason });
  });
  return problems.length ? { problems: problems.slice(0, 30) } : { answer: { stories, dropped }, problems };
}

/** undefined when the ref `path:line[-line]` names a line of a file inside the clone; else the reason. */
export function checkRef(root: string, ref: string): string | undefined {
  const m = REF.exec(ref);
  if (!m) return "not path:line";
  const path = m[1]!;
  if (isAbsolute(path) || path.split("/").some((p) => p === ".." || p === ".git")) return "path not allowed";
  let file: string;
  let top: string;
  try {
    top = realpathSync(root);
    file = realpathSync(join(root, path));
  } catch {
    return "no such file";
  }
  const rel = relative(top, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".git")) return "outside the repository";
  let text: string;
  try {
    if (!statSync(file).isFile()) return "not a file";
    text = readFileSync(file, "utf8");
  } catch {
    return "cannot be read";
  }
  const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  const from = Number(m[2]);
  const to = m[3] ? Number(m[3]) : from;
  if (from < 1 || to < from || to > lines) return `no line ${m[3] ?? m[2]} (the file has ${lines})`;
  return undefined;
}

/** Token shapes (the credential rules of the scans) and stored secrets replaced by [redacted]. */
export function redactTokens(text: string): string {
  let t = String(text ?? "");
  for (const [, re] of CREDENTIAL_RULES) t = t.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[redacted]");
  return redactText(t);
}

export const marker = (runId: string, key: string): string => `<!-- claude-factory run=${runId} repo-review story=${key} -->`;
const line = (t: string, max = 240) => safeSentence(redactTokens(t), max);

/** Text of several lines that cannot plant a marker, a heading, a mention or a "Depends on" line. */
function safeBlock(text: string, max = 2000): string {
  return redactTokens(String(text ?? "").slice(0, max))
    .replace(/\r\n?/g, "\n")
    .replace(/<!--/g, "<! --")
    .replace(/@(?=\w)/g, "@​")
    .split("\n")
    .map((l) => {
      let x = l.replace(/^([ \t]*)#/, "$1\\#");
      if (DEP_LINE.test(x)) x = `- ${x.trim()}`;
      return x;
    })
    .join("\n")
    .trim();
}

const covers = (entry: string, test: string) => test === entry || test.startsWith(`${entry}.`);
const nameSafe = (n: string) =>
  n.length > 0 && n.length <= 300 && n === n.trim() && /^[A-Za-z0-9_$]/.test(n) && !/[\u0000-\u001f\u007f`<@]/.test(n) &&
  !/depends[ \t]+on|blocked[ \t]+by/i.test(n) && redactTokens(n) === n;

/** The names the build story lists: the failing tests as they are, else their class prefixes; undefined when neither is safe. */
export function namedEntries(failing: string[]): string[] | undefined {
  const all = [...new Set(failing)];
  if (all.length === 0) return [];
  if (all.length <= 100 && all.every(nameSafe)) return all;
  const prefixes = [...new Set(all.map((n) => n.slice(0, Math.max(n.lastIndexOf("."), 0))).filter((p) => p && nameSafe(p)))];
  if (prefixes.length === 0 || prefixes.length > 100) return undefined;
  return all.every((t) => prefixes.some((p) => covers(p, t))) ? prefixes : undefined;
}

export interface BaselineInput {
  ok: boolean; timed: string; failing: string[]; unidentified: number; configRefs: string[]; testCmd: string; buildCmd: string; branch: string; commit: string;
}
/** green, red (a build story is filed) or unknown (no story, and the summary says why). */
export function decideBaseline(i: BaselineInput): Baseline {
  const b: Baseline = { state: "unknown", branch: i.branch, commit: i.commit, failing: [...new Set(i.failing)], named: [], configRefs: i.configRefs, testCmd: i.testCmd, buildCmd: i.buildCmd, note: "" };
  if (i.timed) b.note = "the build or the tests did not finish in time";
  else if (!i.testCmd && !i.buildCmd) b.note = "no build or test command was found";
  else if (i.ok) b.state = "green";
  else if (i.configRefs.length === 0) b.note = "no build or test configuration file was found to point at";
  else if (i.unidentified > 0) {
    // The command failed and some failure has no name in the reports: the build-fix story goes on with no named tests
    // (baseline-tests accepts a ## Build to fix body for unnamed failures). The base stays red.
    Object.assign(b, { state: "red", named: [] });
  } else {
    const named = namedEntries(b.failing);
    if (named) Object.assign(b, { state: "red", named });
    else b.note = "the failing tests cannot be named safely";
  }
  return b;
}

const para = (title: string, text: string) => `## ${title}\n\n${text}\n`;
const story = (who: string, what: string, why: string) => `As ${line(who, 200).replace(/\.$/, "")}, I want ${line(what, 300).replace(/\.$/, "")}, so that ${line(why, 300).replace(/\.$/, "")}.\n`;
const codeList = (refs: string[]) => refs.filter((r) => REF.test(r)).map((r) => `- \`${r}\``).join("\n");

/** Story 1 of a red base. The failed commands are in the problem text, the validated config files under Code. */
export function buildFixStory(b: Baseline, repo: string, runId: string): { title: string; body: string } {
  const cmds = [b.buildCmd && `\`${line(b.buildCmd, 200)}\``, b.testCmd && `\`${line(b.testCmd, 200)}\``].filter(Boolean).join(" and ");
  const sha = /^[0-9a-f]{7,64}$/i.test(b.commit) ? ` at commit ${b.commit.slice(0, 8)}` : "";
  const names = b.named.length > 0
    ? para("Failing tests to fix", b.named.map((n) => `- ${n}`).join("\n"))
    : para("Build to fix", "No failing test can be named. Make the build and the tests run and pass.");
  const body = [
    story("the owner of this repository", "the build and the tests to pass on a clean checkout", "every other change can be checked by them"),
    para("Problem", `The build or the tests of ${line(repo, 100)} fail on branch ${line(b.branch, 100)}${sha}. Commands that ran: ${cmds || "none"}.`),
    para("Where it applies", "The build and test setup of the repository, and the code the failing tests cover."),
    para("Code", codeList(b.configRefs)),
    names,
    para("Fix", "Find why the build or the tests fail and fix it, in the code or in the setup. Do not delete or disable tests to make them pass."),
    para("Acceptance criteria", "- [ ] The build passes.\n- [ ] All tests pass."),
    marker(runId, "1"),
  ].join("\n");
  return { title: BUILD_TITLE, body };
}

export function storyBody(s: VerifiedStory, runId: string, key: string): string {
  const owner = s.ownerNeeds.trim()
    ? para("Only the owner can provide", `${safeBlock(s.ownerNeeds)}\n\nAsk the owner for this as an \`owner_action\` question before building.`)
    : "";
  return [
    story(s.who, s.what, s.why),
    para("Problem", safeBlock(s.problem)),
    para("Where it applies", safeBlock(s.where)),
    para("Code", codeList(s.refs)),
    para("Fix", safeBlock(s.fix)),
    para("Acceptance criteria", s.criteria.map((c) => `- [ ] ${line(c, 500)}`).join("\n")),
    owner,
    marker(runId, key),
  ].filter(Boolean).join("\n");
}

/** Puts "### Depends on" with the issue before the marker line (or at the end). */
export function withDependsOn(body: string, issue: number): string {
  const block = `### Depends on\n\n- #${issue}\n`;
  const at = body.lastIndexOf("<!-- claude-factory run=");
  return at < 0 ? `${body}\n${block}` : `${body.slice(0, at)}${block}\n${body.slice(at)}`;
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

export interface PlanInput {
  repo: string; runId: string; repoRoot: string; review: ReturnType<typeof parseReview>; answer: VerifyAnswer;
  baseline: Baseline; open: OpenIssue[]; settings: Settings;
}
export function planStories(o: PlanInput): Plan {
  const skipped: Plan["skipped"] = [];
  const dropped: Plan["dropped"] = [];
  const notes: string[] = [];
  const byId = new Map(o.review.findings.map((f) => [f.id, f]));
  const openTitle = new Map(o.open.map((i) => [norm(i.title), i.number]));
  const openNumbers = new Set(o.open.map((i) => i.number));
  const seen = new Set<string>();
  for (const inv of o.review.invalid) dropped.push({ finding: `#${inv.index + 1}`, title: "", reason: `the review entry is not valid (${inv.reason})` });
  for (const d of o.answer.dropped) dropped.push({ finding: d.finding, title: byId.get(d.finding)?.title ?? "", reason: `dropped by the verify step: ${d.reason}` });
  const placed = new Set(o.answer.dropped.map((d) => d.finding));
  const first: { title: string; body: string }[] = [];
  let buildIssue: number | undefined;
  if (o.baseline.state === "red") {
    const refs = o.baseline.configRefs.filter((r) => checkRef(o.repoRoot, r) === undefined);
    const b = buildFixStory({ ...o.baseline, configRefs: refs }, o.repo, o.runId);
    seen.add(norm(b.title));
    buildIssue = openTitle.get(norm(b.title));
    if (buildIssue) skipped.push({ title: b.title, reason: `covered by #${buildIssue}` });
    else first.push(b);
  } else if (o.baseline.state === "unknown") notes.push(`The state of the build is unknown: ${o.baseline.note}. No build story was made.`);
  const kept: VerifiedStory[] = [];
  for (const s of o.answer.stories) {
    s.findings.forEach((id) => placed.add(id));
    const bad = s.refs.map((r) => [r, checkRef(o.repoRoot, r)] as const).find(([, why]) => why);
    if (bad) {
      dropped.push({ finding: s.findings.join(", "), title: s.title, reason: `the ref ${bad[0]} does not hold: ${bad[1]}` });
      continue;
    }
    const key = norm(s.title);
    const cover = s.coveredBy && openNumbers.has(s.coveredBy) ? s.coveredBy : openTitle.get(key);
    if (cover) skipped.push({ title: s.title, reason: `covered by #${cover}` });
    else if (seen.has(key)) skipped.push({ title: s.title, reason: "the same title as an earlier story" });
    else {
      seen.add(key);
      kept.push(s);
    }
  }
  for (const f of o.review.findings) if (!placed.has(f.id)) dropped.push({ finding: f.id, title: f.title, reason: "not placed by the verify step" });
  kept.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const room = Math.max(0, o.settings.maxStories - first.length);
  for (const s of kept.slice(room)) skipped.push({ title: s.title, reason: `not filed: over the limit of ${o.settings.maxStories} stories` });
  const red = o.baseline.state === "red";
  const labelsFor = (kind: Kind) => [...new Set([...o.settings.labels, kind])];
  const items = [
    ...first.map((b) => ({ title: b.title, kind: "bug" as Kind, severity: "high" as Severity, dependsOnBuild: false, body: () => b.body })),
    ...kept.slice(0, room).map((s) => ({ title: s.title, kind: s.kind, severity: s.severity, dependsOnBuild: red, body: (k: string) => storyBody(s, o.runId, k) })),
  ];
  const stories: PlannedStory[] = items.map((p, i) => {
    const key = String(i + 1);
    return { key, title: line(p.title, 120), body: p.body(key), labels: labelsFor(p.kind), kind: p.kind, severity: p.severity, dependsOnBuild: p.dependsOnBuild };
  });
  return { version: 1, repo: o.repo, runId: o.runId, baseline: o.baseline, stories, ...(buildIssue ? { buildIssue } : {}), skipped, dropped, summaryIssue: o.settings.summaryIssue, notes };
}

/** The summary of the review, for the run page (and one issue). Every text in it is one safe line. */
export function summaryText(plan: Plan, filed: Filed): string {
  const b = plan.baseline;
  const out = [`### Repository review of ${line(plan.repo, 100)}`, ""];
  const sha = /^[0-9a-f]{7,64}$/i.test(b.commit) ? `@${b.commit.slice(0, 8)}` : "";
  out.push(`Base: ${line(b.branch, 100)}${sha} — ${b.state === "red" ? "the build or the tests fail" : b.state === "green" ? "the build and the tests pass" : `unknown (${line(b.note)})`}`, "");
  const done = plan.stories.filter((s) => filed[s.key]);
  out.push(Object.keys(filed).length > 0 ? `Filed ${done.length} of ${plan.stories.length} stories:` : `Stories to file (${plan.stories.length}):`);
  for (const s of plan.stories) {
    const f = filed[s.key];
    out.push(`- ${f ? `#${f.number} ` : ""}${line(s.title, 120)} (${s.kind}, ${s.severity})${f?.url ? ` ${f.url}` : ""}`);
  }
  if (plan.stories.length === 0) out.push("- none");
  if (plan.skipped.length > 0) out.push("", "Not filed:", ...plan.skipped.map((s) => `- ${line(s.title, 120)} — ${line(s.reason)}`));
  if (plan.dropped.length > 0) out.push("", "Dropped findings:", ...plan.dropped.map((d) => `- ${line(d.finding, 60)}${d.title ? ` ${line(d.title, 120)}` : ""} — ${line(d.reason, 300)}`));
  if (plan.notes.length > 0) out.push("", ...plan.notes.map((n) => line(n, 300)));
  return out.join("\n");
}
