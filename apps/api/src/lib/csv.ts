/**
 * RFC 4180 CSV. Text cells that a spreadsheet would read as a formula
 * (leading = + - @ tab or CR) are prefixed with an apostrophe, so member-chosen
 * values such as nicknames cannot run formulas when an admin opens the file.
 */
export type Cell = string | number | null | undefined;

export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Cell[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
