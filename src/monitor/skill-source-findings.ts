import { dayOf, type Finding } from "./findings.js";

// Findings of the scheduled skill source checks. Pure: no I/O. The sweeper (src/server/skill-update-sweep.ts) reads and saves.

export const SKILL_SOURCE_DETECTOR = "skill-source-check";
/** The key of problems that belong to no single source (the catalogue as a whole). */
export const CATALOGUE_KEY = "*";
export const MAX_SENTENCES = 5;
export const MAX_SUMMARY = 300;

export const sourceFingerprint = (key: string, sentence: string): string => `${SKILL_SOURCE_DETECTOR}|${key}|${sentence}`;

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
const keyOf = (f: Finding): string | undefined => (f.detector === SKILL_SOURCE_DETECTOR ? f.fingerprint.split("|")[1] : undefined);

function goneCopy(f: Finding, at: string): Finding {
  return { ...f, gone: true, streak: 0, ...(f.report ? { missedAt: at } : {}) };
}

/**
 * The newest check of a source replaces its findings: each sentence is opened or refreshed, other open findings of the
 * source are marked gone. An empty list marks all of them gone. Sources not in `checked` stay as they are.
 * The identity of a finding is the whole cleaned sentence; only the summary is cut.
 */
export function applySourceChecks(stored: readonly Finding[], checked: ReadonlyMap<string, readonly string[]>, now: Date): { findings: Finding[]; changed: boolean } {
  const at = now.toISOString();
  const out: Finding[] = [...stored];
  let changed = false;
  for (const [key, list] of checked) {
    const sentences = [...new Set(list.map(clean).filter(Boolean))].slice(0, MAX_SENTENCES);
    const wanted = new Set(sentences.map((s) => sourceFingerprint(key, s)));
    for (let i = 0; i < out.length; i++) {
      const f = out[i]!;
      if (keyOf(f) === key && !f.gone && !wanted.has(f.fingerprint)) {
        out[i] = goneCopy(f, at);
        changed = true;
      }
    }
    for (const s of sentences) {
      const fingerprint = sourceFingerprint(key, s);
      const i = out.findIndex((f) => f.detector === SKILL_SOURCE_DETECTOR && f.fingerprint === fingerprint);
      const have = i >= 0 ? out[i]! : undefined;
      const days = [...new Set([...(have?.days ?? []), dayOf(now)])].slice(-3);
      if (have && !have.gone) {
        out[i] = { ...have, lastSeen: at, count: have.count + 1, streak: (have.streak ?? have.count) + 1, days };
      } else if (have) {
        const { quietStart: _q, ...rest } = have;
        out[i] = { ...rest, firstSeen: at, lastSeen: at, count: 1, gone: false, streak: 1, days };
      } else {
        const summary = (key === CATALOGUE_KEY ? `Skill source checks: ${s}` : `Skill source ${key}: ${s}`).slice(0, MAX_SUMMARY);
        out.push({ detector: SKILL_SOURCE_DETECTOR, fingerprint, severity: "major", summary, evidence: {}, about: "project", firstSeen: at, lastSeen: at, count: 1, gone: false, streak: 1, days });
      }
      changed = true;
    }
  }
  return { findings: out, changed };
}

/** Marks every open finding of this detector gone. */
export function clearSourceChecks(stored: readonly Finding[], now: Date = new Date()): { findings: Finding[]; changed: boolean } {
  const at = now.toISOString();
  let changed = false;
  const findings = stored.map((f) => {
    if (f.detector !== SKILL_SOURCE_DETECTOR || f.gone) return f;
    changed = true;
    return goneCopy(f, at);
  });
  return { findings, changed };
}
