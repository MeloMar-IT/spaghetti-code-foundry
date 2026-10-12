/** Process ids in a text, whitespace separated. Blank entries and anything but a safe integer above 1 are dropped. */
export function pidsIn(text: string): number[] {
  return text
    .split(/\s+/)
    .filter((t) => /^\d+$/.test(t))
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 1);
}

/** SIGKILLs each pid in the text. Never signals 0, 1 or a group. */
export function killPids(text: string, kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill): void {
  for (const pid of pidsIn(text)) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
