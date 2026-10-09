/** Minimal RFC 4180 CSV reader (quoted fields, commas and newlines inside quotes, BOM). */
export function parseCsv(text: string): Record<string, string>[] {
  const t = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map(normHeader);
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export const normHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** "1,234.50" / "₦1,234" / "-0.5" -> number; NaN when empty. */
export function num(s: string | undefined): number {
  if (s == null) return NaN;
  const c = s.replace(/[₦$,\s]/g, '');
  return c === '' ? NaN : Number(c);
}
