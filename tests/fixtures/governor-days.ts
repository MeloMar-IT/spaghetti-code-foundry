import type { Sample } from "../../src/ops/governor.js";

/** SYNTHETIC (no recorded load, no real machine data): 1-minute loads → samples with 5- and 15-minute averages that start at the given values. */
export function withAverages(load1: number[], l5 = load1[0]!, l15 = l5): Sample[] {
  return load1.map((l1) => {
    l5 += (l1 - l5) * (1 - Math.exp(-1 / 5));
    l15 += (l1 - l15) * (1 - Math.exp(-1 / 15));
    return { load1: l1, load5: l5, load15: l15, pressure: 1 };
  });
}

export const minutes = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

/** Cores and the use of one run in `gameDay()`. */
export const GAME_CORES = 16;
export const GAME_PER_RUN = 1.9;

/**
 * SYNTHETIC: a deterministic day of 1440 one-minute samples from midnight, with the measurement the usage check
 * would give. A game uses about 6 cores of 16 from 09:00 to 21:00 (with a two-minute burst of 2 more cores about
 * every 97 minutes) and the machine has peaks of 5 to 14 per core at 10:00, 12:00, 14:00, 16:00, 18:00 and 20:00.
 * The rest of the day only 0.5 cores are used by other programs.
 */
export function gameDay(): Sample[] {
  let seed = 751;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const peaks: Record<number, number> = { 600: 6, 720: 14, 840: 8, 960: 5, 1080: 12, 1200: 10 };
  const load1: number[] = [];
  const other: number[] = [];
  for (let i = 0; i < 1440; i++) {
    const work = i >= 540 && i < 1260;
    let o = work ? 6 + (rand() * 2 - 1) * 0.6 : 0.5;
    let l = work ? 0.85 + rand() * 0.05 : 0.3 + rand() * 0.05;
    if (work && i % 97 < 2) {
      o += 2;
      l += 0.15;
    }
    for (const [start, p] of Object.entries(peaks)) {
      const k = i - Number(start);
      if (k >= 0 && k < 3) l = [p, 0.9 * p, Math.max(0.8 * p, 4.2)][k]!;
    }
    load1.push(l);
    other.push(o);
  }
  return withAverages(load1, 0.3, 0.3).map((x, i) => ({ ...x, measured: { cores: GAME_CORES, other: other[i]!, perRun: GAME_PER_RUN } }));
}
