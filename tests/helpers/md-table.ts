/** Rows of the first markdown table under a heading; cells trimmed; header and separator dropped. */
export function tableRows(text: string, heading: string): string[][] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return [];
  const rows: string[][] = [];
  let started = false;
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (!line.trim().startsWith("|")) {
      if (started) break;
      continue;
    }
    started = true;
    rows.push(line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
  }
  return rows.slice(2); // header and separator
}

/** The text inside the first pair of backticks of a cell. */
export function code(cell: string): string {
  return /`([^`]*)`/.exec(cell)?.[1] ?? "";
}
