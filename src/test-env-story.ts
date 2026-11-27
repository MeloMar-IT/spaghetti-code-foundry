// A Docker Engine that refuses the API version of Testcontainers: tools/test-env leaves the facts in `docker-api.json` in the
// run folder (the test step has no credential), and the server files one bug story with the version advice. Only values
// that pass a check here go into the story, never text from the repository or the test output.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { githubKey } from "./auth/repo-url.js";
import { redactText } from "./credentials/redact.js";
import type { RunSummary } from "./engine/state.js";
import { safeSentence } from "./failure.js";
import type { RestIssue } from "./github.js";
import { inOrder } from "./queue/release-trigger.js";
import type { StoryStore } from "./stories/store.js";

export interface DockerApiFact {
  version: 1;
  testcontainers?: string;
  buildFile?: string;
  clientApi?: string;
  minApi: string;
  engine?: string;
  firstWorking?: { "1.x": string; "2.x": string };
  at: string;
}

const FACT_FILE = "docker-api.json";
/** In the run folder: the story of this run's facts is filed (or was found). */
const DONE_FILE = "docker-api-story.json";
const MAX_FACT = 8 * 1024;
const VERSION = /^\d+\.\d+(\.\d+)?([.-][A-Za-z0-9]+)?$/;
const API = /^\d{1,3}\.\d{1,3}$/;
const BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts", "gradle/libs.versions.toml"];
const LABEL = "bug";

const matches = (v: unknown, re: RegExp): v is string => typeof v === "string" && v.length <= 40 && re.test(v);

/** The facts of a run that ended; undefined when there are none, or a field fails its check. Never throws. */
export function readDockerApi(run: Pick<RunSummary, "runDir" | "status">): DockerApiFact | undefined {
  if (run.status === "running" || run.status === "waiting") return undefined;
  try {
    const file = join(run.runDir, FACT_FILE);
    const st = lstatSync(file);
    if (!st.isFile() || st.size > MAX_FACT) return undefined;
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (j.version !== 1 || !matches(j.minApi, API) || typeof j.at !== "string" || Number.isNaN(Date.parse(j.at))) return undefined;
    const optional: [unknown, RegExp][] = [[j.testcontainers, VERSION], [j.clientApi, API], [j.engine, VERSION]];
    if (optional.some(([v, re]) => v !== undefined && !matches(v, re))) return undefined;
    if (j.buildFile !== undefined && !BUILD_FILES.includes(j.buildFile as string)) return undefined;
    const w = j.firstWorking as Record<string, unknown> | undefined;
    if (w !== undefined && !(w && matches(w["1.x"], VERSION) && matches(w["2.x"], VERSION))) return undefined;
    return {
      version: 1, minApi: j.minApi, at: j.at,
      ...(j.testcontainers !== undefined ? { testcontainers: j.testcontainers as string } : {}),
      ...(j.buildFile !== undefined ? { buildFile: j.buildFile as string } : {}),
      ...(j.clientApi !== undefined ? { clientApi: j.clientApi as string } : {}),
      ...(j.engine !== undefined ? { engine: j.engine as string } : {}),
      ...(w ? { firstWorking: { "1.x": w["1.x"] as string, "2.x": w["2.x"] as string } } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The bug story. The marker is one per repository, Testcontainers version and minimum API version. */
export function dockerApiStory(repo: string, f: DockerApiFact): { title: string; body: string; marker: string } {
  const key = `${githubKey(repo)}|${f.testcontainers ?? ""}|${f.minApi}`;
  const marker = `<!-- claude-factory docker-api=${createHash("sha256").update(key).digest("hex").slice(0, 24)} -->`;
  // the table of first working versions is for the Java library, whose version is read from Maven and Gradle files
  const java = f.buildFile !== undefined;
  const advice = !f.firstWorking
    ? "Use the newest Testcontainers release."
    : `${java ? "" : "For Testcontainers for Java: "}the first versions that work are ${f.firstWorking["1.x"]} (1.x line) and ${f.firstWorking["2.x"]} (2.x line).${java ? "" : " For another language, use the newest release."}`;
  const body = [
    "## What happened",
    "",
    `The container tests did not run: the installed Docker Engine${f.engine ? ` (${f.engine})` : ""} refused the API version${f.clientApi ? ` ${f.clientApi}` : ""} of the Docker client. The Engine needs API ${f.minApi} or newer. The Foundry found this by itself.`,
    "",
    "## Version in use",
    "",
    f.testcontainers ? `Testcontainers ${f.testcontainers} (read from \`${f.buildFile}\`).` : "The Testcontainers version could not be read from the build files.",
    "",
    "## The first version that works",
    "",
    advice.charAt(0).toUpperCase() + advice.slice(1),
    "",
    "## What to do",
    "",
    "Upgrade Testcontainers, then run the full tests and check that the container tests really run (none are skipped).",
    "",
    marker,
  ].join("\n");
  return { title: `Upgrade Testcontainers: ${f.testcontainers ?? "the version in use"} is too old for the installed Docker Engine (API ${f.minApi})`, body, marker };
}

/** Per marker: a story that is being created (since `pendingAt`) or that exists. Kept next to the runs folder. */
interface Filed { issue?: number; url?: string; pendingAt?: string }
function readState(file: string): Record<string, Filed> {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { version?: number; stories?: Record<string, Filed> };
    if (j.version === 1 && j.stories && typeof j.stories === "object") return j.stories;
  } catch {
    // a missing or broken file is no state
  }
  return {};
}
function writeState(file: string, marker: string, filed: Filed): void {
  const stories = { ...readState(file), [marker]: filed };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, stories }), { mode: 0o600 });
  renameSync(tmp, file);
}

export const dockerApiStateFile = (runsDir: string): string => join(dirname(runsDir), "docker-api-stories.json");

/** Whether a run has facts whose story is not filed yet (files only). */
export const needsDockerApiStory = (run: Pick<RunSummary, "runDir">): boolean => existsSync(join(run.runDir, FACT_FILE)) && !existsSync(join(run.runDir, DONE_FILE));

/** GitHub said no to the label itself: only then is the story made without it. Any other error may mean the story exists. */
const labelRefused = (e: unknown): boolean => {
  const text = `${(e as { stderr?: unknown }).stderr ?? ""} ${(e as Error).message}`;
  return /HTTP 422|Validation Failed/i.test(text) && /\blabels?\b/i.test(text);
};

export interface DockerApiFiling {
  repo: string;
  runs: RunSummary[];
  store: Pick<StoryStore, "listAll" | "create">;
  stateFile: string;
  log: (m: string) => void;
}

/**
 * Files the stories of runs that have facts and no story yet; returns the ones made now. Calls of one repository run one after
 * the other. Before a story is made, it is noted as pending: when the answer of GitHub gets lost, the next call finds the
 * story by its marker, and makes none while a cut list cannot show that it is missing.
 */
export function fileDockerApiStories(o: DockerApiFiling): Promise<RestIssue[]> {
  return inOrder(`docker-api:${githubKey(o.repo)}`, async () => {
    const made: RestIssue[] = [];
    for (const run of o.runs) {
      if (!needsDockerApiStory(run)) continue;
      const fact = readDockerApi(run);
      if (!fact) continue;
      const story = dockerApiStory(o.repo, fact);
      const done = (issue: number, url: string | undefined) => {
        writeState(o.stateFile, story.marker, { issue, ...(url ? { url } : {}) });
        writeFileSync(join(run.runDir, DONE_FILE), JSON.stringify({ issue, ...(url ? { url } : {}) }));
      };
      const before = readState(o.stateFile)[story.marker];
      const { issues, cut } = await o.store.listAll({ pages: 10, timeoutMs: 20_000 });
      const found = issues.find((i) => !i.pull_request && (i.body ?? "").includes(story.marker));
      if (found) {
        done(found.number, found.html_url);
        continue;
      }
      // filed before (it may be older than what the list reaches)
      if (before?.issue && cut) {
        done(before.issue, before.url);
        continue;
      }
      const since = before?.pendingAt ? Date.parse(before.pendingAt) : Number.NaN;
      if (cut && !Number.isNaN(since) && !issues.some((i) => Date.parse(i.created_at) < since - 3_600_000)) {
        o.log("the Docker version story is not made yet: the list of stories is cut, so it may exist already");
        continue;
      }
      writeState(o.stateFile, story.marker, { pendingAt: before?.pendingAt ?? new Date().toISOString() });
      const create = (labels: string[]) => o.store.create({ title: story.title, body: story.body, labels }, 30_000);
      let issue: RestIssue;
      try {
        issue = await create([LABEL]);
      } catch (e) {
        if (!labelRefused(e)) throw e;
        issue = await create([]);
      }
      done(issue.number, issue.html_url);
      made.push(issue);
      o.log(`created the story #${issue.number}: Testcontainers is too old for the Docker Engine`);
    }
    return made;
  });
}

/** One line of an error, safe for a log. */
export const dockerApiProblem = (e: unknown): string => `the Docker version story could not be filed: ${safeSentence(redactText(String((e as Error).message).split("\n")[0] ?? ""), 200)}`;
