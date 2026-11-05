import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach } from "vitest";
import { dataHome } from "../../src/auth/store.js";
import { ConfigSchema } from "../../src/config.js";
import { readAutoUpdates } from "../../src/skills/auto-updates.js";
import { LICENCE_TEMPLATES } from "../../src/skills/licence-rules.js";
import { sourceQualifiedId } from "../../src/skills/normalize.js";
import { verifyRelease } from "../../src/skills/release-verify.js";
import { catalogueYaml, git, NOW, update, useWorlds, W, world, type World } from "./skill-update-world.js";

// Shared by the tests of the automatic update chain (#799): a private copy of the local upstream, the catalogue with an `update.auto`
// first-party source `ver`, and readers for what a run leaves in the data folder (the shared test data folder of the test file).

export { world, type World };
export const home = dataHome();
export const skills = ConfigSchema.parse({}).skills;
export const KEY = "github.com/example/verified";
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text.replace("{name}", "the copyright holder");
const idOf = (name: string) => sourceQualifiedId({ source: "ver", repositoryKey: KEY }, name);
export const A = () => idOf("a");
export const B = () => idOf("b");

/** Call once at the top of a test file: the shared upstream, and a clean data folder and clock before each test. */
export function useAutoWorld(): void {
  useWorlds();
  beforeEach(() => {
    for (const f of ["skill-approvals.json", "skill-update-checks.json", "skill-auto-updates.json", "skill-releases", "skill-quarantine", "skill-evaluations", "audit.jsonl"]) {
      rmSync(join(home, f), { recursive: true, force: true });
    }
    runs = 0;
  });
}

/** The catalogue: `ver` is first-party with `update.auto`; `lib` is a community source with the given cadence. */
export function yaml(o: { lib?: string; libReviewer?: string; ver?: string } = {}): string {
  let n = 0;
  return catalogueYaml({ lib: W.c1, ver: o.ver ?? W.c1 })
    .replace("trust: verified", "trust: first-party")
    .replace(/update: \{cadence: manual\}/g, (m) => {
      n++;
      if (n === 1) return `update: {cadence: ${o.lib ?? "manual"}${o.libReviewer ? `, reviewer: '${o.libReviewer}'` : ""}}`;
      if (n === 2) return "update: {cadence: weekly, auto: true}";
      return m;
    });
}

export interface Up {
  bare: string;
  work: string;
}
let copies = 0;
/** A private copy of the shared upstream, so a test can add commits. */
export function upstream(): Up {
  const dir = mkdtempSync(join(W.root, `auto${++copies}-`));
  const bare = join(dir, "up.git");
  cpSync(W.upstream, bare, { recursive: true });
  const work = join(dir, "work");
  git(dir, "clone", "--quiet", bare, work);
  // the shared upstream has a short licence text that the licence check does not recognise
  writeFileSync(join(work, "LICENSE"), MIT);
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "full licence text");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  return { bare, work };
}
export const head = (up: Up) => git(up.bare, "rev-parse", "main");
export function commit(up: Up, edit: (work: string) => void): string {
  edit(up.work);
  git(up.work, "add", "-A");
  git(up.work, "commit", "--quiet", "-m", "change");
  git(up.work, "push", "--quiet", "origin", "HEAD:main");
  return head(up);
}
export const skillMd = (name: string, body: string, extra = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\n${body}\n`;
export const write = (work: string, path: string, text: string) => {
  mkdirSync(join(work, path, ".."), { recursive: true });
  writeFileSync(join(work, path), text);
};

type RunOpts = Parameters<typeof update>[3];
// Every run is a week later than the one before, so the weekly cadence is due again.
let runs = 0;
export const run = (w: World, up: Up, o: RunOpts = {}) =>
  update(w, [], { due: true }, { home, remote: up.bare, skills, now: new Date(NOW.getTime() + ++runs * 8 * 86_400_000), resolve: async () => ({ commit: head(up) }), ...o });

export const manifestOf = (catalogue: string, version: string) => {
  const v = verifyRelease(join(home, "skill-releases", catalogue, version));
  if (!v.ok) throw new Error(`release ${catalogue}@${version} does not verify: ${v.reason}`);
  return v.manifest;
};
export const versionsOf = (version: string) => Object.fromEntries(manifestOf("ver", version).skills.map((s) => [s.id, s.version]));
export const record = () => {
  const r = readAutoUpdates({ home });
  if (r.state !== "ok") throw new Error(`skill-auto-updates.json is ${r.state}`);
  return r.sources;
};
export const auditLines = (): { action: string; result: string; target?: string; detail?: string }[] =>
  existsSync(join(home, "audit.jsonl")) ? readFileSync(join(home, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
/** The output, the record and the audit lines as one text: upstream text must be in none of them. */
export const everything = (extra: string) => [extra, existsSync(join(home, "skill-auto-updates.json")) ? readFileSync(join(home, "skill-auto-updates.json"), "utf8") : "", JSON.stringify(auditLines())].join("\n");
export const releaseNames = () => (existsSync(join(home, "skill-releases", "ver")) ? readdirSync(join(home, "skill-releases", "ver")).filter((n) => !n.startsWith(".")).sort() : []);
