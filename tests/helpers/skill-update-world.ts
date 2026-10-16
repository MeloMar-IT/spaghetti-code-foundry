import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { skillUpdateCommand, type SkillUpdateOptions } from "../../src/skill-import/update-cli.js";

// Real local git for the tests of `scf skills update`: a bare upstream, a bare catalogue remote and a clone of it whose `origin`
// address is a GitHub address that `url.<bare>.insteadOf` (given by the environment) maps to the bare repository. gh is
// tests/fixtures/fake-gh.sh. No network, no real service.

export const FAKE_GH = join(__dirname, "..", "fixtures", "fake-gh.sh");
export const NOW = new Date("2026-10-15T10:00:00Z");
export const SENTINEL = "SENTINEL-UPSTREAM-BODY-TEXT";
export const CATALOGUE_URL = "https://github.com/acme/catalogue.git";
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\n${SENTINEL}\n`;
const MIT = "MIT License\n\nCopyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software.\n";

/** Filled in by `useWorlds()` before the first test: the folder, the upstream and its two commits. */
export const W = { root: "", upstream: "", c1: "", c2: "" };
let n = 0;

export const baseEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: W.root,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: baseEnv() }).trim();

/** Registers the set-up and the clean-up of the shared upstream. Call it once at the top of a test file. */
export function useWorlds(): void {
  beforeAll(() => {
    W.root = mkdtempSync(join(tmpdir(), "skill-update-cli-"));
    const work = join(W.root, "upstream-work");
    mkdirSync(join(work, "skills", "a"), { recursive: true });
    git(W.root, "init", "--quiet", "-b", "main", work);
    writeFileSync(join(work, "skills", "a", "SKILL.md"), md("a"));
    writeFileSync(join(work, "LICENSE"), MIT);
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "one");
    W.c1 = git(work, "rev-parse", "HEAD");
    mkdirSync(join(work, "skills", "b"), { recursive: true });
    writeFileSync(join(work, "skills", "b", "SKILL.md"), md("b"));
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "two");
    W.c2 = git(work, "rev-parse", "HEAD");
    W.upstream = join(W.root, "upstream.git");
    git(W.root, "clone", "--quiet", "--bare", work, W.upstream);
  });
  afterAll(() => rmSync(W.root, { recursive: true, force: true }));
}

const lib = (approved: string, review = `{by: '@octocat', on: '2026-01-01', commit: ${approved}, licence: MIT}`) =>
  [
    "  # a community library",
    "  - id: lib",
    "    repository: https://github.com/example/skills",
    "    status: enabled",
    `    ref: {track: main, approved: '${approved}'}`,
    "    paths: [skills]",
    "    adapter: agent-skills",
    "    trust: community",
    "    licence: {allow: [MIT]}",
    "    update: {cadence: manual}",
    "    owner: '@octocat'",
    `    review: ${review}`,
  ].join("\n");
const ver = (approved: string) =>
  [
    "  - id: ver",
    "    repository: https://github.com/example/verified",
    "    status: enabled",
    "    ref:",
    "      track: main # follow main",
    `      approved: ${approved}`,
    "    paths: [skills]",
    "    adapter: agent-skills",
    "    trust: verified",
    "    licence: {allow: [MIT]}",
    "    update: {cadence: manual}",
    "    owner: '@octocat'",
  ].join("\n");
const off = (id: string, status: string) =>
  [`  - id: ${id}`, `    repository: https://github.com/example/${id}`, `    status: ${status}`, "    reason: not now", "    ref: {track: main}", "    paths: [skills]", "    adapter: agent-skills", "    trust: verified", "    licence: {allow: [MIT]}", "    update: {cadence: manual}", "    owner: '@octocat'"].join("\n");

/** The catalogue file: a community entry `lib`, a verified entry `ver` and three entries that are not enabled. */
export const catalogueYaml = (o: { lib?: string; ver?: string; extra?: string[] } = {}) =>
  ["# the catalogue's skill sources", "schema: 1", "sources:", lib(o.lib ?? W.c1), ver(o.ver ?? W.c1), off("gone", "disabled"), off("held", "quarantined"), off("old", "retired"), ...(o.extra ?? []), ""].join("\n");

export interface World {
  dir: string;
  bare: string;
  clone: string;
  home: string;
  log: string;
  env: Record<string, string>;
  yaml: string;
}

const templates = new Map<string, string>();
/** A catalogue repository and its clone for one file text, built once and copied for each test. */
function template(yaml: string, sub: string): string {
  const key = `${sub}\0${yaml}`;
  const known = templates.get(key);
  if (known) return known;
  const dir = join(W.root, `t${++n}`);
  const seed = join(dir, "seed");
  mkdirSync(join(seed, sub), { recursive: true });
  git(dir, "init", "--quiet", "-b", "main", seed);
  writeFileSync(join(seed, sub, "skill-sources.yaml"), yaml);
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "catalogue");
  git(dir, "clone", "--quiet", "--bare", seed, join(dir, "catalogue.git"));
  git(dir, "clone", "--quiet", join(dir, "catalogue.git"), join(dir, "clone"));
  git(join(dir, "clone"), "config", "remote.origin.url", CATALOGUE_URL);
  git(join(dir, "clone"), "remote", "add", "upstream", W.upstream);
  rmSync(seed, { recursive: true, force: true });
  templates.set(key, dir);
  return dir;
}

/** `sub`: the catalogue file lives in this folder of the clone, and the command runs there (`clone` is that folder). */
export function world(yaml = catalogueYaml(), extraEnv: Record<string, string> = {}, sub = ""): World {
  const dir = join(W.root, `w${++n}`);
  cpSync(template(yaml, sub), dir, { recursive: true });
  const bare = join(dir, "catalogue.git");
  const log = join(dir, "gh.log");
  // `origin` is a GitHub address; git maps it to the bare repository (no configuration file of the clone holds a path)
  const map = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: CATALOGUE_URL };
  return { dir, bare, clone: join(dir, "clone", sub), home: join(dir, "home"), log, yaml, env: { ...baseEnv(), ...map, FACTORY_GH_BIN: FAKE_GH, FAKE_GH_LOG: log, GH_REPO: "other/repo", ...extraEnv } };
}

export async function update(w: World, positionals: string[], values: Record<string, unknown> = {}, o: Partial<SkillUpdateOptions> & { env?: Record<string, string> } = {}) {
  const lines: string[] = [];
  const rc = await skillUpdateCommand({ positionals, values }, (l) => lines.push(l), { cwd: w.clone, home: w.home, remote: W.upstream, now: NOW, ...o, env: { ...w.env, ...o.env } });
  return { rc, lines, text: lines.join("\n") };
}
export const ghCalls = (w: World) => (existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter((l) => l.startsWith("gh ")) : []);
/** The title and body of every pull request the fake gh holds, by address. */
export const bodies = (w: World): Record<string, { title: string; body: string }> => (existsSync(`${w.log}.bodies.json`) ? JSON.parse(readFileSync(`${w.log}.bodies.json`, "utf8")) : {});
export const setBody = (w: World, url: string, patch: Partial<{ title: string; body: string }>) => {
  const all = bodies(w);
  all[url] = { ...all[url]!, ...patch };
  writeFileSync(`${w.log}.bodies.json`, JSON.stringify(all));
};
/** Open pull requests of the fake gh: written before a run, they are what `gh pr list` answers. */
export const setOpenPullRequests = (w: World, list: { url: string; headRefName: string; state?: string; createdAt?: string }[]) =>
  writeFileSync(`${w.log}.prs.json`, JSON.stringify(list.map((p) => ({ state: "OPEN", ...p }))));
/** The gh calls that would merge, review, close or approve. There must never be one. */
export const forbiddenCalls = (w: World) => ghCalls(w).filter((c) => /^gh pr (?:merge|review|close)\b/.test(c) || c.includes("--approve"));
export const branches =(w: World) => git(w.bare, "for-each-ref", "--format=%(refname)", "refs/heads/skill-update/").split("\n").filter(Boolean);
export const branchOf = (id: string, commit: string) => `skill-update/${id}-${commit.slice(0, 12)}`;
export const snapshot = (w: World) => ({
  file: readFileSync(join(w.clone, "skill-sources.yaml"), "utf8"),
  status: git(w.clone, "status", "--porcelain"),
  heads: git(w.clone, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
  head: git(w.clone, "rev-parse", "HEAD"),
  staged: git(w.clone, "diff", "--cached", "--name-only"),
});
export const sigCounts = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
export const GOOD_REVIEW = { reviewer: "@rev" };
