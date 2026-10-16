import { execFileSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { ConfigSchema, type SkillsConfig } from "../../src/config.js";
import { releaseProposeCommand } from "../../src/skill-import/release-propose-cli.js";
import { rawPublicKey, signApproval } from "../../src/skills/release-signature.js";
import { publishRelease, readReleaseContent } from "../../src/skills/release-store.js";
import { baseEnv, FAKE_GH, git } from "./skill-update-world.js";
import { writeV2Release } from "./skill-release-v2.js";

// Real local git for the tests of `scf skills release propose`: a bare deployment repository and a clone of it whose `origin`
// address is a GitHub address that `url.<bare>.insteadOf` maps to the bare repository. gh is tests/fixtures/fake-gh.sh.

export const DEPLOY_URL = "https://github.com/acme/deploy.git";
export const FILE = "deploy/config.yaml";
export const P = { root: "", store: "", d100: "", d110: "", d090: "", art090: "" };

export interface Rel {
  root: string;
  digest: string;
  manifest: ReturnType<typeof writeV2Release>["manifest"];
}
let counter = 0;

/** A schema-2 release folder in `parent`. `skills`: ids, written as packages; `revoked`: ids revoked in this release. */
export function makeRelease(parent: string, version: string, skills: string[], revoked: string[] = []): Rel {
  const root = join(parent, `art-${++counter}`);
  for (const id of skills) {
    const d = join(root, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
    writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: 1.0.0\n`);
  }
  const { approved, manifest } = writeV2Release(root, {
    catalogue: "acme",
    version,
    attribution: Object.fromEntries(skills.map((s) => [s, { "LICENSE.txt": "MIT\n" }])),
    revoked: Object.fromEntries(revoked.map((s) => [s, { on: "2026-03-01", reason: "REASON-MARKER" }])),
  });
  return { root, digest: approved.digest, manifest };
}
const publish = (r: Rel, home: string) => publishRelease(readReleaseContent(realpathSync(r.root), r.manifest) as never, { home });

/** The store holds acme@1.0.0 (alpha, beta) and acme@1.1.0 (alpha, gamma, beta revoked). 0.9.0 is outside the store. */
export function useProposeWorld(): void {
  beforeAll(() => {
    P.root = realpathSync(mkdtempSync(join(tmpdir(), "skill-release-propose-")));
    P.store = join(P.root, "store");
    const a = makeRelease(P.root, "1.0.0", ["alpha", "beta"]);
    const b = makeRelease(P.root, "1.1.0", ["alpha", "beta", "gamma"], ["beta"]);
    const c = makeRelease(P.root, "0.9.0", ["alpha"]);
    publish(a, P.store);
    publish(b, P.store);
    P.d100 = a.digest;
    P.d110 = b.digest;
    P.d090 = c.digest;
    P.art090 = c.root;
  });
  afterAll(() => rmSync(P.root, { recursive: true, force: true }));
}

export const keyPair = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, id: "k1", pub: rawPublicKey(privateKey) };
};
export const sign = (priv: KeyObject, version: string, digest: string) => signApproval({ catalogue: "acme", version, digest }, priv);

/** The deployment config: comments, a block list with acme@<version> and, optionally, keys. */
export const deployYaml = (o: { approved?: { version: string; digest: string }[]; keys?: { id: string; pub: string }[]; extra?: string } = {}) => {
  const approved = o.approved ?? [{ version: "1.0.0", digest: P.d100 }];
  return [
    "# deployment config",
    "skills:",
    "  releases:",
    ...(o.keys ? ["    keys:", ...o.keys.map((k) => `      - {id: ${k.id}, ed25519: ${k.pub}}`)] : []),
    "    # approved catalogue releases",
    ...(!approved.length ? ["    approved: []"] : ["    approved:", ...approved.flatMap((a) => ["      - catalogue: acme", `        version: ${a.version}`, `        digest: ${a.digest} # pinned`])]),
    o.extra ?? "",
    "# end of file",
    "",
  ].join("\n");
};

export const skillsConfig = (o: { repository?: string; approved?: unknown[]; keys?: unknown[]; deployment?: boolean } = {}): SkillsConfig =>
  ConfigSchema.parse({
    skills: { roots: [], releases: { approved: o.approved ?? [], keys: o.keys ?? [], ...(o.deployment === false ? {} : { deployment: { repository: o.repository ?? "acme/deploy", file: FILE } }) } },
  }).skills;

export interface PWorld {
  dir: string;
  bare: string;
  clone: string;
  log: string;
  env: Record<string, string>;
  yaml: string;
}
const templates = new Map<string, string>();
function template(yaml: string): string {
  const known = templates.get(yaml);
  if (known) return known;
  const dir = join(P.root, `t${++counter}`);
  const seed = join(dir, "seed");
  mkdirSync(join(seed, "deploy"), { recursive: true });
  git(dir, "init", "--quiet", "-b", "main", seed);
  writeFileSync(join(seed, FILE), yaml);
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "deploy");
  git(dir, "clone", "--quiet", "--bare", seed, join(dir, "deploy.git"));
  git(dir, "clone", "--quiet", join(dir, "deploy.git"), join(dir, "clone"));
  git(join(dir, "clone"), "config", "remote.origin.url", DEPLOY_URL);
  rmSync(seed, { recursive: true, force: true });
  templates.set(yaml, dir);
  return dir;
}

export function pworld(yaml = deployYaml(), extraEnv: Record<string, string> = {}): PWorld {
  const dir = join(P.root, `w${++counter}`);
  cpSync(template(yaml), dir, { recursive: true });
  const bare = join(dir, "deploy.git");
  const log = join(dir, "gh.log");
  const map = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: DEPLOY_URL };
  return { dir, bare, clone: join(dir, "clone"), log, yaml, env: { ...baseEnv(), ...map, HOME: P.root, FACTORY_GH_BIN: FAKE_GH, FAKE_GH_LOG: log, GH_REPO: "other/repo", ...extraEnv } };
}

export async function propose(w: PWorld, positionals: string[], values: Record<string, unknown> = {}, skills: SkillsConfig | null = skillsConfig()) {
  const lines: string[] = [];
  const rc = await releaseProposeCommand({ positionals, values }, (l) => lines.push(l), { cwd: w.clone, home: P.store, userHome: P.root, env: w.env, skills: skills ?? undefined });
  return { rc, lines, text: lines.join("\n") };
}

export const pBranches = (w: PWorld) => git(w.bare, "for-each-ref", "--format=%(refname)", "refs/heads/skill-catalogue/").split("\n").filter(Boolean);
export const pCalls = (w: PWorld) => (existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter((l) => l.startsWith("gh ")) : []);
export const pBodies = (w: PWorld): Record<string, { title: string; body: string }> => (existsSync(`${w.log}.bodies.json`) ? JSON.parse(readFileSync(`${w.log}.bodies.json`, "utf8")) : {});
/** The file on a branch of the bare remote, byte for byte (the git helper trims). */
export const fileOnBranch = (w: PWorld, branch: string) => execFileSync("git", ["show", `${branch}:${FILE}`], { cwd: w.bare, encoding: "utf8", env: baseEnv() });

/** Every path below `dir` with its size, for "nothing was written". */
export function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else out.push(`${rel}${e.name} ${statSync(p).size}`);
    }
  };
  walk(dir, "");
  return out.sort();
}
export const wcSnapshot = (w: PWorld) => ({
  file: readFileSync(join(w.clone, FILE), "utf8"),
  status: git(w.clone, "status", "--porcelain"),
  heads: git(w.clone, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
  head: git(w.clone, "rev-parse", "HEAD"),
  staged: git(w.clone, "diff", "--cached", "--name-only"),
});
