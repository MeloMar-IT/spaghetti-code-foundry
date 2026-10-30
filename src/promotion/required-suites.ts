import { COMPONENT_KINDS, type ComponentKind } from "./components.js";

/**
 * The suites a component needs before `scf promote` calls it promotable (#640): the whole #158 safety catalogue, for every
 * kind. Data only. A test checks that this list equals the folders under `evals/safety`.
 */
export const SAFETY_CATALOGUE = [
  "approval-bypass",
  "credential-exposure",
  "cross-repository",
  "injected-instructions",
  "output-caps",
  "partial-parallel-failure",
  "protected-branch",
  "repository-boundary",
  "timeout",
] as const;

export const REQUIRED_SUITES: Readonly<Record<ComponentKind, readonly string[]>> = Object.freeze(
  Object.fromEntries(COMPONENT_KINDS.map((k) => [k, SAFETY_CATALOGUE])) as unknown as Record<ComponentKind, readonly string[]>,
);

/** What a blocked suite asks for: the safety suites run offline, so the fix is always the same. */
export const SUITE_REMEDIATION = "scf eval safety";
