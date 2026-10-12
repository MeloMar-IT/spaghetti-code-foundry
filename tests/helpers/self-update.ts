import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SelfUpdater, type UpdaterOptions } from "../../src/self-update.js";
import { loadUpdateState, type UpdateStep } from "../../src/self-update-state.js";

// Local git repositories only: a bare remote, a seed clone that publishes commits, and the install (the checkout the Foundry runs from).
export const V1: Record<string, string> = {
  "app.txt": "v1\n",
  "server.mjs": "process.exit(0);\n",
  "package-lock.json": "{}\n",
  ".gitignore": "dist/\nbreak-*\n.break-here\n",
  "install.sh": "[ -e break-install ] && exit 1\nexit 0\n",
  "build.sh": '[ -e break-build ] && { echo "build broke"; exit 1; }\nmkdir -p dist && cp app.txt dist/app.js\n',
  "test.sh": "exit 0\n",
  // the updater runs the tests through the running version's test slot tool
  "tools/test-slot": readFileSync(resolve("tools/test-slot"), "utf8"),
};
export const STEPS: UpdateStep[] = [
  { name: "install", cmd: "sh", args: ["install.sh"] },
  { name: "build", cmd: "sh", args: ["build.sh"] },
  { name: "test", cmd: "sh", args: ["test.sh"] },
];

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const sha7 = (s: string) => s.slice(0, 7);

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" });

const roots: string[] = [];
export function removeFixtures() {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "scf-su-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const install = join(root, "install");
  const file = join(root, "data", "self-update.json");
  mkdirSync(join(root, "data"));
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main", seed);
  git(seed, "remote", "add", "origin", remote);
  const write = (files: Record<string, string>) => {
    for (const [k, v] of Object.entries(files)) {
      mkdirSync(dirname(join(seed, k)), { recursive: true });
      writeFileSync(join(seed, k), v);
    }
  };
  write(V1);
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "v1");
  git(seed, "push", "origin", "main");
  git(root, "clone", remote, install);
  execFileSync("sh", ["build.sh"], { cwd: install });
  const fx = {
    root, remote, seed, install, file,
    head: () => git(install, "rev-parse", "HEAD"),
    dist: () => readFileSync(join(install, "dist", "app.js"), "utf8").trim(),
    state: () => loadUpdateState(file).state,
    stage: join(root, "data", "self-update-stage"),
    publish(files: Record<string, string>, o: { replace?: boolean } = {}) {
      if (o.replace) git(seed, "reset", "--hard", "HEAD~1");
      write(files);
      git(seed, "add", "-A");
      git(seed, "commit", "-m", "next");
      git(seed, "push", ...(o.replace ? ["--force"] : []), "origin", "main");
      return git(seed, "rev-parse", "HEAD");
    },
    /** Takes the new commit into the install without the updater (a half-done install). */
    takeIn(sha: string) {
      git(install, "fetch", "origin");
      git(install, "merge", "--ff-only", sha);
    },
  };
  return fx;
}
export type Fx = ReturnType<typeof fixture>;

export function updater(f: Fx, over: Partial<UpdaterOptions> = {}) {
  const t = {
    idle: true, drained: 0, exits: [] as number[], logs: [] as string[], before: 0,
  };
  const u = new SelfUpdater({
    config: () => ({ enabled: true, repo: "acme/foundry" }),
    idle: () => t.idle,
    drain: () => { t.drained++; },
    beforeExit: () => { t.before++; },
    log: (m) => t.logs.push(m),
    dir: f.install, file: f.file, steps: STEPS,
    originRepo: () => "acme/foundry",
    guarded: true,
    exit: (c) => t.exits.push(c),
    slot: { waitSec: 0, pollMs: 50 },
    ...over,
  });
  return Object.assign(t, { u });
}
