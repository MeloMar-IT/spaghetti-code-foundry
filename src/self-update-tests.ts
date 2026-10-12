const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const FAIL = /^\s*FAIL\s+(\S+\.(?:test|spec)\.\w+ > .+)$/;
const CROSS = /^\s*[×✗]\s+(.+?)(?:\s+\d+\s?ms)?(?:\s+\(retry x\d+\))?\s*$/;

/** The names of the failing tests in the output of a vitest run: " FAIL  file > name" and "×" lines. At most 20; [] when none. */
export function failingTests(output: string): string[] {
  const lines = output.replace(ANSI, "").split("\n");
  const fails = new Set<string>();
  for (const l of lines) {
    const m = FAIL.exec(l);
    if (m?.[1]) fails.add(m[1].trim());
  }
  const all = new Set(fails);
  for (const l of lines) {
    const name = CROSS.exec(l)?.[1]?.trim();
    if (!name) continue;
    // vitest prints the same test in both forms
    if ([...fails].some((f) => f === name || f.endsWith(` > ${name}`))) continue;
    all.add(name);
  }
  return [...all].slice(0, 20);
}
