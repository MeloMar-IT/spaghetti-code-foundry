import { githubNameOf } from "../auth/repo-url.js";
import { GATE_MESSAGES, type AutoSkillFailure } from "../skills/auto-updates.js";
import { RELEASE_GATES, type ReleaseGate } from "../skills/release-publish.js";
import { SKILL_ID_RE } from "../skills/schema.js";
import type { SkillLibrarySource } from "../skills/sources.js";
import { createIssue, ensureIssueLabel, openIssueTitles, type CatalogueContext } from "./catalogue-git.js";
import type { SourceAccess } from "./source-access.js";

// One issue in the source's own repository for each skill the automatic update left out (#800). The title, the body and every line
// hold the skill id, the gate, the source id and the Foundry's own sentence only: no upstream text, no text of gh, no token.

export const failureIssueSettings = { maxPerRun: 20 };
export const FAILURE_LABEL_COLOR = "d93f0b";
export const FAILURE_LABEL_TEXT = "A skill the automatic update left out";
const LIST_LIMIT = 1000;

export const failureIssueTitle = (f: { skill: string; gate: ReleaseGate }): string => `Skill ${f.skill} failed the ${f.gate} gate`;

export function failureIssueText(f: AutoSkillFailure, sourceId: string): { title: string; body: string } {
  const body = [
    "### What to fix",
    "",
    `The automatic update of the source \`${sourceId}\` left out the skill \`${f.skill}\`.`,
    "",
    `- Gate: \`${f.gate}\``,
    `- The Foundry says: ${GATE_MESSAGES[f.gate]}`,
    "",
    "Fix the skill in this repository so that it passes the gate. The next automatic update checks it again.",
    "",
    "Opened by the Foundry. It holds the skill id, the gate and the Foundry's own sentence only.",
    "",
  ].join("\n");
  return { title: failureIssueTitle(f), body };
}

export const usableFailure = (f: AutoSkillFailure): boolean => SKILL_ID_RE.test(f.skill) && (RELEASE_GATES as readonly string[]).includes(f.gate);

type IssueSource = SkillLibrarySource;

export interface FailureIssueInput {
  source: IssueSource;
  failed: readonly AutoSkillFailure[];
  label: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  /** Yields to the event loop (a signal that came in during a synchronous gh call is delivered then). Must not throw. */
  tick: () => Promise<void>;
  access: (s: IssueSource) => Promise<SourceAccess>;
  out: (line: string) => void;
  audit: (ok: boolean, detail: string) => void;
}
export interface FailureIssueResult {
  made: { skill: string; gate: string; number: number; url: string }[];
  open: number;
  failed: boolean;
}

/** The environment of a private source's calls: the app token, and no token of the host. */
function tokenEnv(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...env };
  delete e.GH_TOKEN;
  delete e.GITHUB_TOKEN;
  delete e.GH_ENTERPRISE_TOKEN;
  return { ...e, GH_TOKEN: token, GH_HOST: "github.com" };
}

/** Opens the issues. Never throws: a problem is one NOTE and one failed audit line, and the update goes on. */
export async function openFailureIssues(o: FailureIssueInput): Promise<FailureIssueResult> {
  const result: FailureIssueResult = { made: [], open: 0, failed: false };
  const id = o.source.id;
  try {
    const seen = new Set<string>();
    const todo = o.failed.filter(usableFailure).filter((f) => {
      const t = failureIssueTitle(f);
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    if (todo.length === 0) return result;
    const repo = githubNameOf(o.source.repository);
    if (!repo) {
      o.out(`NOTE ${id} is not a GitHub repository; no issue was opened for its failed skills`);
      o.audit(false, "not on GitHub");
      result.failed = true;
      return result;
    }
    let env = o.env;
    if (o.source.access) {
      const got = await o.access(o.source);
      if (!got.ok || !got.credential) {
        o.out(`NOTE no issue was opened for ${id}: ${got.ok ? "no credential was given" : got.problem}`);
        o.audit(false, "access");
        result.failed = true;
        return result;
      }
      env = tokenEnv(o.env, got.credential.password);
    }
    const ctx: CatalogueContext = { cwd: o.cwd, env };

    await o.tick();
    if (o.signal.aborted) return result;
    let titles: Set<string>;
    try {
      const listed = openIssueTitles(ctx, repo, LIST_LIMIT);
      if (listed.cut) {
        o.out(`NOTE the repository of ${id} has too many open issues to check; no issue was opened`);
        o.audit(false, "list cut");
        result.failed = true;
        return result;
      }
      titles = new Set(listed.titles);
    } catch {
      o.out(`NOTE the open issues of ${id}'s repository could not be listed with gh; no issue was opened`);
      o.audit(false, "list");
      result.failed = true;
      return result;
    }

    let labelled = false;
    let skipped = 0;
    for (let i = 0; i < todo.length; i++) {
      const f = todo[i]!;
      const { title, body } = failureIssueText(f, id);
      if (titles.has(title)) {
        o.out(`NOTE an issue for ${f.skill} (${f.gate}) is open already; no new one`);
        result.open++;
        continue;
      }
      if (result.made.length >= failureIssueSettings.maxPerRun) {
        skipped = todo.slice(i).filter((x) => !titles.has(failureIssueTitle(x))).length;
        break;
      }
      await o.tick();
      if (o.signal.aborted) return result;
      if (!labelled) {
        ensureIssueLabel(ctx, repo, o.label, FAILURE_LABEL_COLOR, FAILURE_LABEL_TEXT);
        labelled = true;
        await o.tick();
        if (o.signal.aborted) return result;
      }
      try {
        const made = createIssue(ctx, { repo, title, body, labels: [o.label] });
        titles.add(title);
        result.made.push({ skill: f.skill, gate: f.gate, ...made });
        o.out(`NOTE opened ${made.url} for ${f.skill} (${f.gate})`);
        o.audit(true, `${f.skill} ${f.gate} #${made.number}`);
      } catch {
        o.out(`NOTE the issue for ${f.skill} (${f.gate}) could not be opened with gh; the update goes on`);
        o.audit(false, `${f.skill} ${f.gate} not opened`);
        result.failed = true;
        break;
      }
    }
    if (skipped > 0 && !result.failed) {
      o.out(`NOTE ${skipped} more failed skills got no issue in this run (at most ${failureIssueSettings.maxPerRun})`);
    }
  } catch {
    o.out(`NOTE the issues for the failed skills of ${id} could not be opened; the update goes on`);
    try {
      o.audit(false, "error");
    } catch {
      // the audit is best effort
    }
    result.failed = true;
  }
  return result;
}
