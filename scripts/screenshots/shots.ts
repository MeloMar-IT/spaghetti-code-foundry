// The manifest of guide screenshots: what each shot is, which guide uses it, and what must be
// visible on the page for the shot to count. `validateManifest` is pure, so tests can check it.

export type Shot = {
  name: string;
  guide: "admin" | "user";
  role: "none" | "admin" | "user";
  path: string;
  /** Visible text or selector that must be on the page before the shot (never "network idle":
   *  run pages keep an event stream open). */
  expect: string;
};

export type Prepare = Record<string, unknown>;

function pathFits(s: Shot): boolean {
  if (s.role === "none") return s.path === "/";
  if (s.role === "admin") return s.path.startsWith("/#/");
  return s.path.startsWith("/user/");
}

export function validateManifest(shots: readonly Shot[], prepare: Prepare = {}): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of shots) {
    if (seen.has(s.name)) problems.push(`duplicate shot: ${s.name}`);
    seen.add(s.name);
    if (!/^[a-z0-9-]+$/.test(s.name)) problems.push(`bad shot name: ${s.name}`);
    if (!s.expect.trim()) problems.push(`shot without an expected locator: ${s.name}`);
    if (!pathFits(s)) problems.push(`shot path does not fit its role: ${s.name}`);
  }
  for (const key of Object.keys(prepare)) {
    if (!seen.has(key)) problems.push(`prepare step for unknown shot: ${key}`);
  }
  return problems;
}

/** Replaces {key} with ids[key]. Throws `unknown placeholder {key} in <path>`. */
export function fillPath(path: string, ids: Readonly<Record<string, string>>): string {
  return path.replace(/\{([^}]+)\}/g, (_m, key: string) => {
    const v = ids[key];
    if (v === undefined) throw new Error(`unknown placeholder {${key}} in ${path}`);
    return v;
  });
}

/** "/user/#/repos" → { display: "/user/", hash: "#/repos" }; no "#" → hash "". */
export function splitPath(path: string): { display: string; hash: string } {
  const i = path.indexOf("#");
  return i < 0 ? { display: path, hash: "" } : { display: path.slice(0, i), hash: path.slice(i) };
}

const TMP = "[^\\s\"'<>]*ui-harness-[A-Za-z0-9]+";

/** Rewrites host paths to demo paths so no image shows a private folder. */
export function demoPath(text: string, root: string, home: string): string {
  let out = text
    .replace(new RegExp(`${TMP}/repo(?![\\w-])`, "g"), "~/code/my-project")
    .replace(new RegExp(`${TMP}/home(?![\\w-])`, "g"), "~/.spaghetti-code-foundry")
    .replace(new RegExp(`${TMP}/runs(?![\\w-])`, "g"), "~/.spaghetti-code-foundry/runs")
    .replace(new RegExp(TMP, "g"), "~");
  if (root) out = out.split(root).join("~/spaghetti-code-foundry");
  if (home) out = out.split(home).join("~");
  return out;
}

/** File names (with ".png") of ![…](images/x.png) and ![…](docs/images/x.png), in document order, duplicates kept. */
export function imageLinks(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(\s*(?:docs\/)?images\/([^)\s]+\.png)[^)]*\)/g)].map((m) => m[1]!);
}

export const SHOTS: readonly Shot[] = [
  { name: "sign-in", guide: "user", role: "none", path: "/", expect: "Sign in" },
  { name: "board", guide: "admin", role: "admin", path: "/#/board", expect: "acme/app" },
  { name: "runs", guide: "admin", role: "admin", path: "/#/runs", expect: "Seeded failed run" },
  { name: "flows", guide: "admin", role: "admin", path: "/#/flows/issue-gitflow", expect: "▶ Run" },
  { name: "flow-yaml", guide: "admin", role: "admin", path: "/#/flows/issue-gitflow", expect: "YAML" },
  { name: "library", guide: "admin", role: "admin", path: "/#/library", expect: "Block library" },
  { name: "models", guide: "admin", role: "admin", path: "/#/models", expect: "Agents, providers and which model runs which step" },
  { name: "run-dialog", guide: "admin", role: "admin", path: "/#/flows/gate", expect: "Run gate" },
  { name: "run-log", guide: "admin", role: "admin", path: "/#/runs/{waiting}", expect: "Live log" },
  { name: "run-steps", guide: "admin", role: "admin", path: "/#/runs/{waiting}", expect: "Steps & transcripts" },
  { name: "run-diff", guide: "admin", role: "admin", path: "/#/runs/{diffRun}", expect: "big.txt" },
  { name: "run-waiting", guide: "admin", role: "admin", path: "/#/runs/{waiting}", expect: "Seeded gate run" },
  { name: "settings", guide: "admin", role: "admin", path: "/#/settings", expect: "Settings" },
  { name: "dashboard", guide: "admin", role: "admin", path: "/#/dashboard", expect: "last 30 days" },
  { name: "repos", guide: "user", role: "user", path: "/user/#/repos", expect: "acme/app" },
  { name: "watchers", guide: "admin", role: "admin", path: "/#/watchers", expect: "+ Add watcher" },
  { name: "watcher-form", guide: "admin", role: "admin", path: "/#/watchers", expect: "Add a watcher" },
];
