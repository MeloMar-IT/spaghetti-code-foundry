import { spawnSync } from "node:child_process";

// Runs `git` in a local clone for the project pins reader (src/skills/project-pins.ts): read-only plumbing, argument arrays only,
// no GIT_* variable from the environment, a time limit and an output limit. Never throws. No network command is started here.

export type LocalGit = (args: readonly string[]) => { status: number | null; stdout: Buffer };

export function localGit(workdir: string, limits: { timeoutMs: number; maxBytes: number }): LocalGit {
  return (args) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
    try {
      const r = spawnSync("git", [...args], { cwd: workdir, stdio: ["ignore", "pipe", "ignore"], timeout: limits.timeoutMs, maxBuffer: limits.maxBytes, env });
      return r.error || r.signal ? { status: null, stdout: Buffer.alloc(0) } : { status: r.status, stdout: r.stdout ?? Buffer.alloc(0) };
    } catch {
      return { status: null, stdout: Buffer.alloc(0) };
    }
  };
}
