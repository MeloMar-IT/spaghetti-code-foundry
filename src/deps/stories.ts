// The stories of the weekly dependency check (flow deps-weekly, step file_stories): grouping, bodies, markers, ignore rules and dedupe.
// Pure logic; tools/deps-weekly reads and writes (issues, filed.json) and calls this.
import { safeSentence } from "../failure.js";
import {
  type Advisory, type DepKind, type DepTool, type DepUpdate, type DepsReport, type UpdateClass,
  VERSION, classify, compareVersions, isDepName,
} from "./check.js";

export type Group = "updates" | "major" | "security";
export interface DepsSettings { labels: string[]; majorsGo: boolean }

/** A story body stays well under GitHub's limit of 65,536 characters. */
export const BODY_MAX = 60_000;
const DEFAULT_LABEL = "Factory_go";
// ASSUMED: a label is 1 to 50 characters without a comma or a control character, and there are at most 20 of them. This accepts every
// label GitHub does (it allows 50 characters of any kind); the limit on the count only stops a typo from making a huge request.
const LABEL_MAX = 50;
const LABELS_MAX = 20;

/**
 * deps_labels and deps_majors_go. ASSUMED: a wrong value stops the filing step with a message (before any call to GitHub) instead of
 * filing with the wrong trigger labels: a story with a wrong label would start a build, or never start one, without a person looking.
 */
export function parseDepsSettings(env: Record<string, string | undefined>): DepsSettings {
  const raw = (env.FACTORY_VAR_DEPS_LABELS ?? "").trim();
  const labels = raw ? [...new Set(raw.split(",").map((l) => l.trim()).filter(Boolean))] : [DEFAULT_LABEL];
  // eslint-disable-next-line no-control-regex
  if (labels.length < 1 || labels.length > LABELS_MAX || labels.some((l) => l.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(l))) {
    throw new Error(`deps_labels must be 1 to ${LABELS_MAX} labels separated by commas; each is 1 to ${LABEL_MAX} characters`);
  }
  const m = (env.FACTORY_VAR_DEPS_MAJORS_GO ?? "").trim().toLowerCase();
  if (!["", "yes", "no", "true", "false"].includes(m)) throw new Error("deps_majors_go must be yes or no");
  return { labels, majorsGo: m === "yes" || m === "true" };
}

// ── deps_ignore ──
const IGNORE_EXACT = /^[A-Za-z0-9_.@/-]+(?::[A-Za-z0-9_.-]+){0,2}$/;
const IGNORE_GROUP = /^[A-Za-z0-9_.-]+:\*$/;

/** The entries of deps_ignore (commas or spaces): a dependency name, or `group:*` for every name that starts with `group:`. */
export function parseIgnore(raw: string): { rules: string[]; bad: string[] } {
  const rules: string[] = [];
  const bad: string[] = [];
  for (const e of String(raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (e.length <= 214 && (IGNORE_EXACT.test(e) || IGNORE_GROUP.test(e))) {
      if (!rules.includes(e)) rules.push(e);
    } else bad.push(e.length > 60 ? `${e.slice(0, 60)}…` : e);
  }
  return { rules, bad };
}

export function isIgnored(name: string, rules: readonly string[]): boolean {
  return rules.some((r) => (r.endsWith(":*") ? name.startsWith(r.slice(0, -1)) : r === name));
}

/** The report without the ignored dependencies: no update, no advisory and no unlisted advisory of them. */
export function withoutIgnored(r: DepsReport, rules: readonly string[]): DepsReport {
  if (rules.length === 0) return r;
  const keep = (n: string) => !isIgnored(n, rules);
  return { ...r, updates: r.updates.filter((u) => keep(u.name)), advisories: r.advisories.filter((a) => keep(a.package)), unlisted: r.unlisted.filter((a) => keep(a.package)) };
}

// ── markers ──
export const marker = (name: string, version: string) => `<!-- deps-weekly: ${name}@${version} -->`;
export const groupMarker = (g: Group) => `<!-- deps-weekly story: ${g} -->`;
const MARKER = /<!-- deps-weekly: (\S+)@([^\s@]+) -->/g;

export function markersIn(body: string): { name: string; version: string }[] {
  return [...String(body ?? "").matchAll(MARKER)].map((m) => ({ name: m[1]!, version: m[2]! }));
}
export function groupIn(body: string): Group | undefined {
  const g = /<!-- deps-weekly story: (updates|major|security) -->/.exec(String(body ?? ""))?.[1];
  return g as Group | undefined;
}
export const groupOf = (u: DepUpdate): Group => (u.security ? "security" : u.class === "major" ? "major" : "updates");

// ── the report, checked again ──
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const KINDS: DepKind[] = ["dependency", "plugin", "parent"];
const CLASSES: UpdateClass[] = ["patch", "minor", "major"];
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const URL_OK = /^https:\/\/[^\s()<>"`]{1,300}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface CheckedReport { updates: DepUpdate[]; advisories: Advisory[]; branch: string; commit: string; unavailable: number; dropped: number }

/** What deps.json says, with every name, version and word checked again before it goes into a title or a body. */
export function validReport(r: unknown): CheckedReport {
  const out: CheckedReport = { updates: [], advisories: [], branch: "", commit: "", unavailable: 0, dropped: 0 };
  if (!isObj(r)) return out;
  if (typeof r.branch === "string" && r.branch.length <= 200 && BRANCH.test(r.branch)) out.branch = r.branch;
  if (typeof r.commit === "string" && /^[0-9a-f]{40}$/.test(r.commit)) out.commit = r.commit;
  if (typeof r.unavailable === "number" && Number.isInteger(r.unavailable) && r.unavailable >= 0) out.unavailable = r.unavailable;
  const seen = new Set<string>();
  for (const u of Array.isArray(r.updates) ? r.updates : []) {
    if (
      !isObj(u) || (u.tool !== "maven" && u.tool !== "npm") || !KINDS.includes(u.kind as DepKind) || !CLASSES.includes(u.class as UpdateClass) ||
      typeof u.name !== "string" || !isDepName(u.tool, u.name) || typeof u.current !== "string" || !VERSION.test(u.current) ||
      typeof u.latest !== "string" || !VERSION.test(u.latest) || typeof u.security !== "boolean" || seen.has(`${u.tool}\u0000${u.name}`)
    ) {
      out.dropped++;
      continue;
    }
    seen.add(`${u.tool}\u0000${u.name}`);
    out.updates.push({ tool: u.tool, kind: u.kind as DepKind, name: u.name, current: u.current, latest: u.latest, class: u.class as UpdateClass, security: u.security });
  }
  for (const a of Array.isArray(r.advisories) ? r.advisories : []) {
    if (!isObj(a) || typeof a.package !== "string" || !isDepName("npm", a.package) || !SEVERITIES.includes(a.severity as string)) continue;
    out.advisories.push({
      package: a.package, severity: a.severity as Advisory["severity"], title: typeof a.title === "string" ? safeSentence(a.title, 120) : "",
      url: typeof a.url === "string" && URL_OK.test(a.url) ? a.url : "", fix: a.fix === true,
    });
  }
  return out;
}

// ── text ──
const RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 } as const;
const TOOL_NAME: Record<DepTool, string> = { maven: "Maven", npm: "npm" };
const SECURITY_WORD = ", security: ";

/** One update, one line, ending with its marker. Names sit in backticks, so an npm scope never becomes a mention. */
export function updateLine(u: DepUpdate, advisories: readonly Advisory[]): string {
  let sec = "";
  if (u.security) {
    const hits = advisories.filter((a) => a.package === u.name && u.tool === "npm");
    const worst = hits.length > 0 ? hits.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a)) : undefined;
    sec = `${SECURITY_WORD}${worst ? worst.severity : "reported by the audit"}${worst?.url && URL_OK.test(worst.url) ? ` — ${worst.url}` : ""}`;
  }
  const kind = u.kind === "dependency" ? "dependency" : u.kind;
  return `- \`${u.name}\` — ${TOOL_NAME[u.tool]} ${kind}: ${u.current} → ${u.latest} (${u.class})${sec} ${marker(u.name, u.latest)}`;
}

export function storyTitle(g: Group, ups: readonly DepUpdate[], part?: { i: number; n: number }): string {
  const of = part && part.n > 1 ? ` (part ${part.i} of ${part.n})` : "";
  if (g === "major") return `Update ${ups[0]!.name} to ${ups[0]!.latest} (major)`;
  if (g === "security") return `Fix ${ups.length} vulnerable ${ups.length === 1 ? "dependency" : "dependencies"}${of}`;
  return `Update ${ups.length} ${ups.length === 1 ? "dependency" : "dependencies"} (patch and minor)${of}`;
}

/** What the repository has: used to name the commands a story asks for. */
export interface BuildInfo { maven?: { wrapper: boolean }; npm?: { lock: boolean; build: boolean; test: boolean } }

/** The commands for the tools of these updates: install, build and test as the manifests say (as tools/detect-commands does). */
export function buildCommands(tools: ReadonlySet<DepTool>, info: BuildInfo): string[] {
  const cmds: string[] = [];
  if (tools.has("maven")) cmds.push(`${info.maven?.wrapper ? "./mvnw" : "mvn"} -B verify`);
  if (tools.has("npm")) {
    const n = info.npm ?? { lock: true, build: false, test: true };
    cmds.push(n.lock ? "npm ci" : "npm install");
    if (n.build) cmds.push("npm run build");
    if (n.test) cmds.push("npm test");
  }
  return cmds;
}

export interface BodyCtx { branch: string; commit: string; advisories: readonly Advisory[]; build: BuildInfo }

export function storyBody(g: Group, ups: readonly DepUpdate[], ctx: BodyCtx): string {
  const cmds = buildCommands(new Set(ups.map((u) => u.tool)), ctx.build);
  const at = ctx.branch ? ` on \`${ctx.branch}\`${ctx.commit ? ` at \`${ctx.commit.slice(0, 7)}\`` : ""}` : "";
  const lines = [
    `Found by the weekly dependency check${at}.`, "", "## Updates", "",
    ...ups.map((u) => updateLine(u, ctx.advisories)), "", "## Build", "",
    ...(cmds.length > 0 ? cmds.map((c) => `- \`${c}\``) : ["- the build of the repository"]), "", "## Acceptance criteria", "",
    "- [ ] Each dependency in the list is at its new version (the one after the arrow); no other version changes, except what they pull in.",
    `- [ ] ${cmds.length > 0 ? "These commands pass" : "The build and the tests pass"}.`,
  ];
  if (g === "major") lines.push("- [ ] The breaking changes of the new major version are handled, and the code is changed where needed.");
  if (g === "security") {
    lines.push("- [ ] The vulnerable versions are gone from the project.");
    if (ups.some((u) => u.tool === "npm")) lines.push("- [ ] `npm audit` no longer lists these packages.");
  }
  lines.push("", groupMarker(g));
  return lines.join("\n");
}

export function labelsFor(g: Group, s: DepsSettings): string[] {
  const l = g === "updates" ? [...s.labels, "enhancement"] : g === "security" ? [...s.labels, "bug"] : ["enhancement", ...(s.majorsGo ? s.labels : [])];
  return [...new Set(l)];
}

// ── the plan ──
export interface KnownIssue { number: number; state: "open" | "closed"; stateReason: string | null; title: string; body: string }
/** What filed.json holds for one issue this run made or changed. */
export interface FiledEntry { number: number; url?: string; markers: string[]; edit: boolean }
export interface PlannedStory { group: Group; title: string; body: string; labels: string[]; updates: DepUpdate[] }
/** An open story to change: `updates` are the lines it now shows; `moved` are the updates whose line leaves it for their own story. */
export interface PlannedEdit { number: number; title?: string; body: string; addLabels: string[]; updates: DepUpdate[]; moved: string[] }
export type SkipWhy = "open" | "closed" | "not_planned";
export interface FilePlan {
  found: number; stories: PlannedStory[]; edits: PlannedEdit[];
  skipped: { u: DepUpdate; issue: number; why: SkipWhy }[];
  /** Updates an earlier part of this same run already filed (filed.json). */
  mine: { filed: number; updated: number; stories: number };
  unavailable: number; notes: string[];
}

export interface PlanInput { report: CheckedReport; issues: readonly KnownIssue[]; settings: DepsSettings; filed: readonly FiledEntry[]; build: BuildInfo }

function dropLine(body: string, name: string, version: string): string {
  return body.split("\n").filter((l) => !l.includes(marker(name, version))).join("\n");
}

function replaceLine(body: string, name: string, version: string, line: string): string {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.includes(marker(name, version)));
  if (at >= 0) lines[at] = line;
  return lines.join("\n");
}

/**
 * Decides what to write; nothing is read or written here.
 *  1. An update this run already filed (filed.json) counts as filed.
 *  2. The exact marker `name@latest` in an issue: skipped (open, closed, or closed as not planned). A security update whose open story
 *     does not say so yet is reconciled: its line is edited and the story gets the trigger labels and `bug`.
 *  3. An open story of the same group that holds the name at an older version is edited in place (line and marker; the title of a major
 *     story). When the group differs (a minor story that now has a major version), the line leaves a story of non-security updates and the
 *     update is filed in its own story: no trigger label reaches a major update unless deps_majors_go is on. An open story at a higher
 *     version means skipped, except that a security update still escalates that story (line, trigger labels, bug).
 *  4. What is left is filed: all patch and minor in one story, each major alone, all security in one story (split only when the text
 *     would not fit in one issue).
 */
export function planFiling(i: PlanInput): FilePlan {
  const { report, settings } = i;
  const plan: FilePlan = { found: report.updates.length, stories: [], edits: [], skipped: [], mine: { filed: 0, updated: 0, stories: 0 }, unavailable: report.unavailable, notes: [] };
  const known = i.issues.map((is) => ({ is, marks: markersIn(is.body), group: groupIn(is.body) }));
  const mineMarks = new Map<string, FiledEntry>();
  for (const e of i.filed) for (const m of e.markers) mineMarks.set(m, e);
  const mineEntries = new Set<FiledEntry>();
  const edits = new Map<number, PlannedEdit>();
  const todo: DepUpdate[] = [];

  const getEdit = (k: (typeof known)[number]) => {
    let e = edits.get(k.is.number);
    if (!e) {
      e = { number: k.is.number, body: k.is.body, addLabels: [], updates: [], moved: [] };
      edits.set(k.is.number, e);
    }
    return e;
  };
  // Replaces the line of `oldVersion` with the line of u (u.latest is the version the new line shows).
  const edit = (k: (typeof known)[number], u: DepUpdate, oldVersion: string) => {
    const e = getEdit(k);
    e.body = replaceLine(e.body, u.name, oldVersion, updateLine(u, report.advisories));
    if (k.group === "major" && oldVersion !== u.latest) e.title = storyTitle("major", [u]);
    if (u.security) for (const l of labelsFor("security", settings)) if (!e.addLabels.includes(l)) e.addLabels.push(l);
    e.updates.push(u);
  };

  for (const u of report.updates) {
    const mk = marker(u.name, u.latest);
    const mine = mineMarks.get(mk);
    if (mine) {
      mineEntries.add(mine);
      if (mine.edit) plan.mine.updated++;
      else plan.mine.filed++;
      continue;
    }
    const same = known.filter((k) => k.marks.some((m) => m.name === u.name && m.version === u.latest));
    if (same.length > 0) {
      const open = same.find((k) => k.is.state === "open");
      if (open) {
        const line = open.is.body.split("\n").find((l) => l.includes(mk)) ?? "";
        if (u.security && !line.includes(SECURITY_WORD)) edit(open, u, u.latest);
        else plan.skipped.push({ u, issue: open.is.number, why: "open" });
      } else {
        const c = same[0]!;
        plan.skipped.push({ u, issue: c.is.number, why: c.is.stateReason === "not_planned" ? "not_planned" : "closed" });
      }
      continue;
    }
    const older = known.filter((k) => k.is.state === "open" && k.marks.some((m) => m.name === u.name && m.version !== u.latest));
    if (older.length > 0) {
      const versionIn = (k: (typeof known)[number]) => k.marks.find((m) => m.name === u.name)!.version;
      const ahead = older.find((k) => compareVersions(versionIn(k), u.latest) === 1);
      if (ahead) {
        // The story keeps the higher version it asks for. A security update still reaches it: the line, the trigger labels and bug.
        const v = versionIn(ahead);
        const line = ahead.is.body.split("\n").find((l) => l.includes(marker(u.name, v))) ?? "";
        if (u.security && !line.includes(SECURITY_WORD)) edit(ahead, { ...u, latest: v, class: classify(u.current, v) ?? u.class }, v);
        else plan.skipped.push({ u, issue: ahead.is.number, why: "open" });
        continue;
      }
      const g = groupOf(u);
      const same = older.filter((k) => k.group === g);
      if (same.length > 0) {
        const k = same.reduce((a, b) => (b.is.number > a.is.number ? b : a));
        edit(k, u, versionIn(k));
        continue;
      }
      // The open story holds an older version in another group. A line leaves a story of non-security updates (its trigger labels
      // would start a build for a major or a security update) and the update is filed in its group. Any other story is left alone.
      for (const o of older) {
        if (o.group === "updates" && (g === "major" || g === "security")) {
          const e = getEdit(o);
          e.body = dropLine(e.body, u.name, versionIn(o));
          e.moved.push(u.name);
        }
      }
    }
    todo.push(u);
  }

  plan.edits = [...edits.values()];
  plan.mine.stories = [...mineEntries].filter((e) => !e.edit).length;
  const ctx: BodyCtx = { branch: report.branch, commit: report.commit, advisories: report.advisories, build: i.build };
  const add = (g: Group, ups: DepUpdate[], part?: { i: number; n: number }) =>
    plan.stories.push({ group: g, title: storyTitle(g, ups, part), body: storyBody(g, ups, ctx), labels: labelsFor(g, settings), updates: ups });
  for (const g of ["security", "updates"] as const) {
    const ups = todo.filter((u) => groupOf(u) === g);
    if (ups.length === 0) continue;
    // One story, unless its text would not fit in one issue: then as few stories as fit (ASSUMED: this is rare; it is said in a note).
    const parts: DepUpdate[][] = [];
    let cur: DepUpdate[] = [];
    let size = storyBody(g, [], ctx).length;
    for (const u of ups) {
      const len = updateLine(u, report.advisories).length + 1;
      if (cur.length > 0 && size + len > BODY_MAX) {
        parts.push(cur);
        cur = [];
        size = storyBody(g, [], ctx).length;
      }
      cur.push(u);
      size += len;
    }
    parts.push(cur);
    if (parts.length > 1) plan.notes.push(`${ups.length} ${g} updates do not fit in one issue; they are filed in ${parts.length} stories`);
    parts.forEach((p, n) => add(g, p, { i: n + 1, n: parts.length }));
  }
  for (const u of todo.filter((x) => groupOf(x) === "major")) add("major", [u]);
  return plan;
}

// ── the result ──
export function fileSummary(p: FilePlan): string {
  const filed = p.mine.filed + p.stories.reduce((n, s) => n + s.updates.length, 0);
  const updated = p.mine.updated + p.edits.reduce((n, e) => n + e.updates.length, 0);
  return `Updates found: ${p.found}. Filed: ${filed} in ${p.mine.stories + p.stories.length} stories. Updated in open stories: ${updated}. Skipped as already filed: ${p.skipped.length}. Tools not available: ${p.unavailable}.`;
}

const WHY: Record<SkipWhy, string> = { open: "in open #", closed: "in closed #", not_planned: "in #" };
/** The lines the step prints: what was done, what was skipped, the notes, and the summary line last. `made` maps a planned story to its number. */
export function fileText(p: FilePlan, made: { stories: { number: number }[] }): string {
  const out: string[] = [];
  p.stories.forEach((s, n) => {
    const num = made.stories[n]?.number;
    out.push(`${num ? `Filed #${num}` : "Would file"}: ${s.title} [${s.labels.join(", ")}]`);
  });
  for (const e of p.edits) {
    if (e.updates.length > 0) out.push(`Updated #${e.number}: ${e.updates.map((u) => `${u.name}@${u.latest}`).join(", ")}${e.addLabels.length > 0 ? ` (labels: ${e.addLabels.join(", ")})` : ""}`);
    if (e.moved.length > 0) out.push(`Moved ${e.moved.join(", ")} out of #${e.number}: filed in their own story`);
  }
  for (const s of p.skipped) out.push(`Skipped ${s.u.name}@${s.u.latest}: already filed ${WHY[s.why]}${s.issue}${s.why === "not_planned" ? " (closed as not planned)" : ""}`);
  for (const n of p.notes) out.push(`Note: ${n}`);
  out.push(fileSummary(p));
  return out.join("\n");
}
