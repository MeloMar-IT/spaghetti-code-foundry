// The pass/fail rule of the run-index speed test, kept apart so it can be unit-tested without a server.

export interface SpeedSample { cpuMs: number; wallMs: number; parses: number }

/** The middle value; the mean of the two middle values for an even count; NaN for none. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The problems of one endpoint, as lines (empty when it is fine). Time is judged by CPU time only: the median must
 * be under `limitMs`, and no single call may reach twice that. Wall time is only reported.
 */
export function speedProblems(label: string, samples: SpeedSample[], o: { limitMs: number; maxParses: number }): string[] {
  if (samples.length === 0) return [`${label}: no calls`];
  const out: string[] = [];
  const med = median(samples.map((s) => s.cpuMs));
  if (!(med < o.limitMs)) {
    const cpu = samples.map((s) => Math.round(s.cpuMs)).join(", ");
    const wall = samples.map((s) => Math.round(s.wallMs)).join(", ");
    out.push(`${label}: median ${Math.round(med)} ms CPU is not under ${o.limitMs} ms (CPU: ${cpu} ms; wall: ${wall} ms)`);
  }
  samples.forEach((s, i) => {
    if (!(s.cpuMs < 2 * o.limitMs)) out.push(`${label} call ${i + 1}: ${Math.round(s.cpuMs)} ms CPU is not under ${2 * o.limitMs} ms`);
    if (s.parses > o.maxParses) out.push(`${label} call ${i + 1}: parsed ${s.parses} run files (at most ${o.maxParses})`);
  });
  return out;
}
