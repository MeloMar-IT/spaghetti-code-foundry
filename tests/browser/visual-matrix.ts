import type { SeedData } from "./seed.js";
import type { Width } from "./widths.js";

export type Theme = "light" | "dark";
export type Density = "default" | "compact";
export const THEMES: readonly Theme[] = ["light", "dark"];
export const DENSITIES: readonly Density[] = ["default", "compact"];
export const FULL_WIDTH = 1440;
/** Light/default only. */
export const EXTRA_WIDTHS = [360, 768, 1024] as const;
export const FIXED_NOW = "2026-01-01T00:10:00.000Z";
/** The only platform that has committed baselines. */
export const BASELINE_PLATFORM = "darwin";

export interface VisualPage {
  /** kebab-case, first part of the file name */
  id: string;
  kind: "display" | "signin" | "file";
  /** null for the sign-in page and the gallery file */
  role: "admin" | "user" | null;
  hash: (s: SeedData) => string;
  /** every text must be in the ready root (#main for a display, body otherwise) */
  ready: (string | RegExp)[];
  /** CSS selectors (Playwright syntax) of the parts that change between runs */
  masks: (s: SeedData) => string[];
}
export interface VisualCase { name: string; page: VisualPage; theme: Theme; density: Density; width: Width }

const LIVE = ["Seeded gate run", "Seeded hold run"];
const none = (): string[] => [];
const noHash = (): string => "";
// #repo shows the temporary repository path
const REPO = "#repo";

export const PAGES: VisualPage[] = [
  { id: "gallery", kind: "file", role: null, hash: noHash, ready: ["Visual system demo", "Refinement talk"], masks: none },
  { id: "signin", kind: "signin", role: null, hash: noHash, ready: ["Sign in"], masks: none },
  {
    id: "admin-home", kind: "display", role: "admin", hash: () => "#/home", ready: LIVE,
    // the whole section: the card header of a live run shows the temporary repository path
    masks: () => [REPO, ...LIVE.map((t) => `#main .home-section:has-text("${t}")`)],
  },
  { id: "admin-board", kind: "display", role: "admin", hash: () => "#/board", ready: ["acme/app"], masks: () => [REPO] },
  {
    id: "admin-runs", kind: "display", role: "admin", hash: () => "#/runs", ready: ["Seeded failed run", "Seeded hold run"],
    masks: () => [REPO, ...LIVE.map((t) => `#main tr.link:has-text("${t}")`)],
  },
  {
    id: "admin-run-failed", kind: "display", role: "admin", hash: (s) => `#/runs/${s.runs.failed}`,
    ready: ["Seeded failed run", "ui-failed", "Test Admin"], masks: () => [REPO],
  },
  { id: "admin-repos", kind: "display", role: "admin", hash: () => "#/repos", ready: [/No repositories yet/], masks: () => [REPO] },
  {
    id: "admin-users", kind: "display", role: "admin", hash: () => "#/users", ready: ["ann@example.com"],
    masks: () => [REPO, "#main table.scf-table tbody td:nth-child(5)"],
  },
  { id: "user-home", kind: "display", role: "user", hash: () => "#/home", ready: ["Seeded failed run"], masks: none },
  { id: "user-runs", kind: "display", role: "user", hash: () => "#/runs", ready: ["Seeded succeeded run"], masks: none },
  { id: "user-run", kind: "display", role: "user", hash: () => "#/runs/ui-user-succeeded", ready: ["Seeded succeeded run"], masks: none },
  {
    // the session id is a new UUID on every start and shows in the page title
    id: "user-refinement-session", kind: "display", role: "user", hash: (s) => `#/refinement/${s.sessionId}`,
    ready: ["Show the build status", "Idea"], masks: () => ["#page-title"],
  },
];

export const caseName = (pageId: string, theme: Theme, density: Density, width: number): string =>
  `${pageId}-${theme}-${density}-${width}`;

/** 7 cases per page: theme × density at 1440 first, then light/default at the extra widths. */
export function visualCases(pages: VisualPage[] = PAGES): VisualCase[] {
  const out: VisualCase[] = [];
  for (const page of pages) {
    for (const theme of THEMES) for (const density of DENSITIES) {
      out.push({ name: caseName(page.id, theme, density, FULL_WIDTH), page, theme, density, width: FULL_WIDTH });
    }
    for (const w of EXTRA_WIDTHS) {
      out.push({ name: caseName(page.id, "light", "default", w), page, theme: "light", density: "default", width: w });
    }
  }
  return out;
}

/** True when a run may write baselines (`--update-snapshots`). */
export const isUpdating = (updateSnapshots: string): boolean => updateSnapshots === "all" || updateSnapshots === "changed";

/** True when the visual tests must skip: not the baseline platform (even when updating), or no baseline folder yet and not updating. */
export function skipVisual(platform: string, hasBaselineDir: boolean, updateSnapshots: string): boolean {
  if (platform !== BASELINE_PLATFORM) return true;
  return !hasBaselineDir && !isUpdating(updateSnapshots);
}

export const noBaselinesMessage = (platform: string): string =>
  platform !== BASELINE_PLATFORM
    ? `screenshot baselines exist for ${BASELINE_PLATFORM} only, this is ${platform}: the visual check is skipped.`
    : `no screenshot baselines for ${platform} (tests/browser/__screenshots__/${platform}/): the visual check is skipped. Make them with: npm run test:ui -- --update-snapshots`;
