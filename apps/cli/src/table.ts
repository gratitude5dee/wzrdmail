type Cell = string | number | boolean | null | undefined;

const render = (cell: Cell): string => {
  if (cell === null || cell === undefined) return "";
  return String(cell);
};

/** Column-aligned plain-text table for human output. */
export function formatTable(
  columns: string[],
  rows: Cell[][]
): string {
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...rows.map((row) => render(row[i]).length))
  );
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out = [line(columns)];
  for (const row of rows) out.push(line(row.map(render)));
  return out.join("\n");
}

/** `key: value` lines for a single record. */
export function formatRecord(record: object): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    const rendered =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    lines.push(`${key}: ${rendered}`);
  }
  return lines.join("\n");
}
