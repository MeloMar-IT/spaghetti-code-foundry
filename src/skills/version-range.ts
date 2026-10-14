import { compareSkillVersions } from "./schema.js";

// Version ranges (^, ~, >=, ||) against versions and release lines. Pure: no file system, no process, no clock.

const PART = "(\\d{1,15}|x|X|\\*)";
const VERSION_RE = new RegExp(`^v?${PART}(?:\\.${PART})?(?:\\.${PART})?(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,63}))?$`);
const TOKEN_RE = /^(>=|<=|>|<|=|\^|~)?(.+)$/;
const MAX_TOKENS = 64;

export interface Partial3 { n: number; parts: number[]; pre?: string }
type Core = [number, number, number];

export function parsePartial(text: string): Partial3 | undefined {
  const m = VERSION_RE.exec(text);
  if (!m) return undefined;
  const parts: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const p = m[i];
    if (p === undefined || /^[xX*]$/.test(p)) break;
    parts.push(Number(p));
  }
  const pre = m[4];
  // A prerelease tag only makes sense on a full version.
  if (pre !== undefined && parts.length < 3) return undefined;
  return { n: parts.length, parts, ...(pre !== undefined ? { pre } : {}) };
}
const pad = (p: readonly number[]): Core => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
const str = (c: Core, pre?: string) => `${c[0]}.${c[1]}.${c[2]}${pre ? `-${pre}` : ""}`;
const bump = (p: readonly number[], i: number): Core => {
  const c = pad(p);
  c[i] = c[i]! + 1;
  for (let j = i + 1; j < 3; j++) c[j] = 0;
  return c;
};
const coreOf = (v: string): Core => {
  const [a, b, c] = (v.split("-")[0] ?? "").split(".").map(Number);
  return [a!, b!, c!];
};

/** version < U, and no prerelease of U itself. */
const below = (v: string, u: Core): boolean => {
  const same = v.includes("-") && coreOf(v).every((x, i) => x === u[i]);
  return compareSkillVersions(v, str(u)) < 0 && !same;
};
const atLeast = (v: string, c: Core, pre?: string): boolean => compareSkillVersions(v, str(c, pre)) >= 0;

type Test = (v: string) => boolean;
function comparator(token: string): Test | undefined {
  const m = TOKEN_RE.exec(token);
  if (!m) return undefined;
  const op = m[1] ?? "";
  const p = parsePartial(m[2]!);
  if (!p) return undefined;
  const any: Test = () => true;
  const lowFrom = (): Core => pad(p.parts);
  switch (op) {
    case "":
    case "=":
      if (p.n === 0) return any;
      if (p.pre !== undefined) return (v) => compareSkillVersions(v, str(lowFrom(), p.pre)) === 0;
      return (v) => atLeast(v, lowFrom()) && below(v, bump(p.parts, p.n - 1));
    case ">=":
      return p.n === 0 ? any : (v) => atLeast(v, lowFrom(), p.pre);
    case ">":
      if (p.n === 0) return () => false;
      if (p.n < 3) return (v) => atLeast(v, bump(p.parts, p.n - 1));
      return (v) => compareSkillVersions(v, str(lowFrom(), p.pre)) > 0;
    case "<=":
      if (p.n === 0) return any;
      if (p.n < 3) return (v) => below(v, bump(p.parts, p.n - 1));
      return (v) => compareSkillVersions(v, str(lowFrom(), p.pre)) <= 0;
    case "<":
      if (p.n === 0) return () => false;
      if (p.pre !== undefined) return (v) => compareSkillVersions(v, str(lowFrom(), p.pre)) < 0;
      return (v) => below(v, lowFrom());
    case "^": {
      if (p.n === 0) return any;
      let i = p.parts.findIndex((x) => x !== 0);
      if (i < 0) i = p.n - 1;
      return (v) => atLeast(v, lowFrom(), p.pre) && below(v, bump(p.parts, i));
    }
    default: {
      if (p.n === 0) return any;
      return (v) => atLeast(v, lowFrom(), p.pre) && below(v, bump(p.parts, p.n === 1 ? 0 : 1));
    }
  }
}

/** The tokens of a range, alternative by alternative; undefined when the range is empty, too long or has an empty alternative. */
function alternativesOf(range: string): string[][] | undefined {
  const alternatives = range.split("||").map((a) => a.trim().split(/\s+/).filter(Boolean));
  if (alternatives.some((a) => !a.length) || alternatives.reduce((n, a) => n + a.length, 0) > MAX_TOKENS) return undefined;
  return alternatives;
}

/** Does `version` satisfy `range`? undefined: the range or the version cannot be read. */
export function rangeSatisfied(range: string, version: string): boolean | undefined {
  const pv = parsePartial(version);
  if (!pv || pv.n !== 3) return undefined;
  const v = str(pad(pv.parts), pv.pre);
  const alternatives = alternativesOf(range);
  if (!alternatives) return undefined;
  let ok = false;
  for (const alt of alternatives) {
    const tests = alt.map(comparator);
    if (tests.some((t) => !t)) return undefined;
    if (tests.every((t) => t!(v))) ok = true;
  }
  return ok;
}

/**
 * Can any version of a release line ("17", "3.5") satisfy `range`? undefined: the range or the line cannot be read, or the
 * answer depends on prerelease versions that are not sampled (a range with a prerelease bound that lies inside the line).
 */
export function rangeAdmitsLine(range: string, line: string): boolean | undefined {
  const pl = parsePartial(line);
  if (!pl || pl.pre !== undefined || (pl.n !== 1 && pl.n !== 2)) return undefined;
  const alternatives = alternativesOf(range);
  if (!alternatives) return undefined;
  const inLine = (c: readonly number[]) => pl.parts.every((x, i) => c[i] === x);
  const samples = new Set<string>();
  const fill = (n: number) => str(pad([...pl.parts, n, n].slice(0, 3)));
  samples.add(fill(0));
  samples.add(fill(999999));
  let preInLine = false;
  for (const token of alternatives.flat()) {
    const m = TOKEN_RE.exec(token);
    const p = m ? parsePartial(m[2]!) : undefined;
    if (!p) return undefined;
    if (p.n === 0) continue;
    const base = pad(p.parts);
    for (const c of [base, bump(p.parts, 2), bump(p.parts, 1), bump(p.parts, 0)]) if (inLine(c)) samples.add(str(c));
    if (p.pre !== undefined && inLine(base)) {
      preInLine = true;
      samples.add(str(base, p.pre));
    }
  }
  let any = false;
  for (const s of samples) {
    const r = rangeSatisfied(range, s);
    if (r === undefined) return undefined;
    if (r) any = true;
  }
  return any ? true : preInLine ? undefined : false;
}
