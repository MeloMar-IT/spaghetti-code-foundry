// No import of the guard here: contract.ts imports this file, and the guard leads back to the contract (a cycle).
// The check of the project names, which needs the guard, is `simpleProjects` in simple-projects.ts.

/**
 * Ask Foundry in the Simple view: plain words, only the asker's own work, and only the pages of the Simple view.
 * Pure data and pure functions. The UI keeps the same word list in `ui/simple-words.js` (it has no build step and
 * cannot import this file); a test keeps both equal.
 */

/** Foundry term → the Simple word. Equal to `TERMS` in `ui/simple-words.js`. */
export const SIMPLE_TERMS: Readonly<Record<string, string>> = {
  story: "change", issue: "change", run: "work", failed: "got stuck", release: "final version",
  repository: "project", queued: "planned", merged: "done", step: "step",
};

/** Terms a Simple answer must not use. */
export const SIMPLE_AVOID: readonly string[] = [
  "costs", "tokens", "models", "agents", "logs", "transcripts", "branches", "commits", "flows", "labels", "issue numbers", "pull requests", "watchers", "epics",
];

/** The pages every Simple asker has; the titles equal `WORDS.myProjects` and `HELP.title` of `ui/simple-words.js`. */
export const SIMPLE_FIXED: readonly { to: "#/home" | "#/help"; title: string }[] = [
  { to: "#/home", title: "My projects" },
  { to: "#/help", title: "Help" },
];

export const SIMPLE_PROJECTS_MAX = 20;
const NAME_MAX = 80;
const ID_SHAPE = /^[A-Za-z0-9-]{1,64}$/;

/** What the server leaves out of a Simple reply, as fixed words. */
export const SIMPLE_DROPPED = {
  link: "link: not a Simple page",
  draft: "draft: not in the Simple view",
  action: "action: not in the Simple view",
  offer: "offer: not in the Simple view",
} as const;

export interface SimpleProject {
  id: string;
  name: string;
}

/** The page of a link in the Simple view: Home, Help or one of the asker's own projects. Anything else is undefined. */
export function simplePage(to: string, projects: readonly SimpleProject[]): { to: string; title: string } | undefined {
  const fixed = SIMPLE_FIXED.find((p) => p.to === to);
  if (fixed) return { to: fixed.to, title: fixed.title };
  const p = projects.find((x) => `#/repos/${x.id}` === to);
  return p ? { to, title: p.name } : undefined;
}

/** The shape of a project id a Simple prompt may name, and the longest project name it keeps. */
export const SIMPLE_ID_SHAPE = ID_SHAPE;
export const SIMPLE_NAME_MAX = NAME_MAX;

/** The prompt lines of a Simple turn. */
export function simpleRules(projects: readonly SimpleProject[]): string[] {
  const pairs = Object.entries(SIMPLE_TERMS).filter(([a, b]) => a !== b).map(([a, b]) => `${a} → ${b}`);
  return [
    "- The person uses the Simple view: write in plain words for someone who does not know the Foundry.",
    `- Use these words: ${pairs.join(", ")}.`,
    `- Do not use these: ${SIMPLE_AVOID.join(", ")}.`,
    projects.length
      ? `- You may link only to "#/home", "#/help", and the person's own projects: ${projects.map((p) => `"#/repos/${p.id}"`).join(", ")} (see \`projects\` in the data). Give no other link.`
      : '- You may link only to "#/home" and "#/help". Give no other link.',
    "- Give no drafts, actions or offers.",
  ];
}
