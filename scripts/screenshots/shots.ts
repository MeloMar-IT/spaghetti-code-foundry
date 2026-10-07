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

export function validateManifest(shots: readonly Shot[], prepare: Prepare = {}): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of shots) {
    if (seen.has(s.name)) problems.push(`duplicate shot: ${s.name}`);
    seen.add(s.name);
    if (!s.expect.trim()) problems.push(`shot without an expected locator: ${s.name}`);
  }
  for (const key of Object.keys(prepare)) {
    if (!seen.has(key)) problems.push(`prepare step for unknown shot: ${key}`);
  }
  return problems;
}

export const SHOTS: readonly Shot[] = [];
