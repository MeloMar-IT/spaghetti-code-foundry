/** Numbers and tables of the skill catalogue. Data only and no imports, so config.ts can use it without a cycle. */
export const CATALOGUE_DEFAULTS = { maxCandidates: 20, maxTokens: 2000 } as const;
export const CATALOGUE_RANGE = { maxCandidates: [1, 50], maxTokens: [100, 20000], include: 50, exclude: 500 } as const;
export const CATALOGUE_SCORING = { textWeight: 10, textCap: 30, minTermChars: 2, taskChars: 5000, modulePathChars: 200 } as const;
export const CATALOGUE_DETAILS = ["full", "compact", "minimal"] as const;
export type CatalogueDetail = (typeof CATALOGUE_DETAILS)[number];
/** Lengths are JavaScript string lengths (UTF-16 units) everywhere: in the cuts and in the schema. */
export const CATALOGUE_DETAIL: Record<CatalogueDetail, { descriptionChars: number; capabilities: number; evidence: number }> = {
  full: { descriptionChars: 160, capabilities: 6, evidence: 2 },
  compact: { descriptionChars: 80, capabilities: 3, evidence: 0 },
  // Even the smallest form keeps a short description and the first capability.
  minimal: { descriptionChars: 40, capabilities: 1, evidence: 0 },
};
export const CATALOGUE_TEXT = { evidenceChars: 100, pathChars: 60, textTerms: 3, bytesPerToken: 4 } as const;
/** Worst-case estimated tokens: the header line, and one minimal entry (64-char id, version and capability, 40 four-byte chars). */
export const CATALOGUE_COST = { header: 45, minimalEntry: 110 } as const;
