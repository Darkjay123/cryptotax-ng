/**
 * Reads exchange and on/off-ramp statements uploaded as PDF.
 *
 * A PDF is never trusted with a tax decision. We only reconstruct its table
 * into the CSV shape the matching reader already knows (Binance Transaction
 * History or P2P orders, Bybit transaction log, Quidax statement), so every
 * kind, dedupe and rule stays in the existing battle-tested readers. An
 * unknown layout goes through the Bybit-style loose reader under the
 * exchange's own name, and rows that do not parse are counted and reported,
 * never guessed. Scanned-image PDFs yield no text at all and are refused with
 * a plain note.
 */
import { num } from './csv.js';

export type Cell = { x: number; end: number; text: string };
export type Line = { y: number; cells: Cell[]; text: string };

export type PdfKind = 'binance_transactions' | 'binance_p2p' | 'bybit' | 'quidax' | 'generic' | 'unknown';

export interface PdfStatement {
  detected: PdfKind;
  exchange: string;      // display name for items from this PDF
  csv: string;           // synthesized CSV for the matching reader ('' when unknown)
  rows: number;          // data rows read into the CSV
  badRows: number;       // rows that had a date but no usable amount
  skippedStatus: number; // rows skipped because they were not completed
  notes: string[];
}

// ---------------------------------------------------------------- text layer

export async function pdfLines(data: Uint8Array): Promise<Line[]> {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await mod.getDocument({ data }).promise;
  const lines: Line[] = [];
  try {
    const cap = Math.min(doc.numPages, 120);
    for (let p = 1; p <= cap; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const groups: { y: number; items: { x: number; end: number; text: string; h: number }[] }[] = [];
      for (const it of tc.items) {
        const t = it.transform;
        if (!it.str || !it.str.trim() || !t || t.length < 6) continue;
        const h = it.height ?? (Math.abs(t[3]) || Math.abs(t[0]) || 10);
        const w = it.width ?? (it.str.length * h * 0.5 + 1);
        const g = groups.find(q => Math.abs(q.y - t[5]) <= Math.max(2, h * 0.5));
        const item = { x: t[4], end: t[4] + w, text: it.str, h };
        if (g) g.items.push(item); else groups.push({ y: t[5], items: [item] });
      }
      for (const g of groups) {
        g.items.sort((m, n) => m.x - n.x);
        const cells: Cell[] = [];
        for (const it of g.items) {
          const last = cells[cells.length - 1];
          // A small gap is a word split across items; a wide one is a new column.
          if (last && it.x - last.end < Math.max(5, it.h)) {
            last.end = Math.max(last.end, it.end);
            last.text += (/\s$/.test(last.text) || /^\s/.test(it.text) ? '' : ' ') + it.text.trim();
          } else {
            cells.push({ x: it.x, end: it.end, text: it.text.trim() });
          }
        }
        const text = cells.map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();
        if (text) lines.push({ y: g.y, cells, text });
      }
    }
  } finally {
    try { await doc.destroy(); } catch { /* best effort */ }
  }
  lines.sort((m, n) => n.y - m.y); // top of page first
  return lines;
}

// ------------------------------------------------------------- column mapping

const HEADS: [RegExp, string][] = [
  [/^(utc|date\(utc\)|date|time|created|transaction_?date|created_?at|date_?time)/i, 'date'],
  [/^(operation|transaction_?type|type|activity|side|action)/i, 'type'],
  [/^(coin|currency|asset|token|symbol|asset_?type)/i, 'coin'],
  [/^(change|amount|quantity|qty|units)/i, 'change'],
  [/^fee/i, 'fee'],
  [/^(price|rate)/i, 'price'],
  [/^(total|fiat|naira|value|amount_?paid|amount_?received)/i, 'fiat'],
  [/^(debit)/i, 'debit'],
  [/^(credit)/i, 'credit'],
  [/^(order)/i, 'order'],
  [/^(status|state)/i, 'status'],
  [/^(remark|note|comment|counterparty|narration|description|details)/i, 'remark'],
];

const canon = (h: string): string => {
  for (const [re, name] of HEADS) if (re.test(h.trim())) return name;
  return '';
};

function headerLine(lines: Line[]): { line: Line; cols: { name: string; from: number; to: number }[] } | null {
  for (const line of lines) {
    const cols: { name: string; from: number; to: number }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < line.cells.length; i++) {
      const name = canon(line.cells[i].text);
      if (name && !seen.has(name)) { seen.add(name); cols.push({ name, from: line.cells[i].x - 4, to: i + 1 < line.cells.length ? line.cells[i + 1].x - 4 : Infinity }); }
    }
    if (seen.size >= 3) return { line, cols };
  }
  return null;
}

function rowValues(line: Line, cols: { name: string; from: number; to: number }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of line.cells) {
    const mid = c.x + Math.min(2, (c.end - c.x) / 2);
    const col = cols.find(k => mid >= k.from && mid < k.to);
    if (!col) continue;
    out[col.name] = (out[col.name] ? out[col.name] + ' ' : '') + c.text.trim();
  }
  return out;
}

// ---------------------------------------------------------------- date / misc

const pad = (n: number) => String(n).padStart(2, '0');

/** Normalizes any date found to "YYYY-MM-DD HH:MM:SS" (what the readers accept). */
export function normWhen(s: string): string {
  if (!s) return '';
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])} ${pad(+m[4])}:${m[5]}:${m[6] ?? '00'}`;
  m = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    let d = +m[1], mo = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    if (d > 12 && mo <= 12) { /* day-first, as Nigerian statements write it */ }
    else if (mo > 12 && d <= 12) { const t = d; d = mo; mo = t; }
    else if (d <= 12 && mo <= 12) { /* ambiguous: Nigerian statements are day-first */ }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    const tm = m[4] != null ? ` ${pad(+m[4])}:${m[5]}:${m[6] ?? '00'}` : ' 00:00:00';
    return `${y}-${pad(mo)}-${pad(d)}${tm}`;
  }
  return '';
}

const DONE = /^(completed|complete|success|successful|finished|done|settled|paid|confirmed)$/i;

const KNOWN_EXCHANGES = ['Binance', 'Bybit', 'Quidax', 'Busha', 'Luno', 'Bitnob', 'Yellow Card', 'NairaEx',
  'Roqqu', 'Breet', 'Apexpay', 'Chipper Cash', 'Mondax', 'Remitano', 'Spenda', 'Azza', 'Monica', 'Dantown',
  'Getkoyn', 'Sekiapp', 'Gexipay', 'Cashwyre', 'Keshpay', 'OKX', 'KuCoin', 'Coinbase', 'Kraken',
  'Crypto.com', 'Bitget', 'MEXC', 'Gate.io', 'HTX', 'Kado', 'Cassava', 'Payday', 'Grey', 'Domum', 'Cleva'];

function detectExchange(name: string, lines: Line[]): string {
  const hay = (name + ' ' + lines.slice(0, 25).map(l => l.text).join(' ')).toLowerCase();
  for (const k of KNOWN_EXCHANGES) if (hay.includes(k.toLowerCase().replace('.com', '')) || hay.includes(k.toLowerCase())) return k;
  return 'your exchange';
}

const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
const csvRow = (...vals: string[]) => vals.map(esc).join(',');

// ----------------------------------------------------------------- the parser

export async function parseStatementPdf(name: string, data: Uint8Array): Promise<PdfStatement> {
  const out: PdfStatement = { detected: 'unknown', exchange: '', csv: '', rows: 0, badRows: 0, skippedStatus: 0, notes: [] };
  let lines: Line[];
  try {
    lines = await pdfLines(data);
  } catch {
    out.notes.push('This PDF could not be opened. It may be damaged or password-protected.');
    return out;
  }
  if (!lines.length) {
    out.notes.push('This PDF has no readable text, so it is probably a scan. Export a CSV, or a PDF with selectable text.');
    return out;
  }
  out.exchange = detectExchange(name, lines);
  const head = headerLine(lines);
  if (!head) {
    out.notes.push(`We could not find a table with date and amount columns in this PDF (${out.exchange}). Nothing was read from it.`);
    return out;
  }
  const { cols } = head;
  const has = (n: string) => cols.some(c => c.name === n);

  // Which reader should receive it? Binance statements say "Operation", Bybit's
  // log says "Transaction Type"; any other table with a date and an amount goes
  // through the loose reader as a generic statement.
  const headText = head.line.text;
  let kind: PdfKind;
  if (has('debit') && has('credit')) kind = 'quidax';
  else if (has('type') && (has('fiat') || has('price')) && has('order')) kind = 'binance_p2p';
  else if (has('type') && has('change') && (out.exchange === 'Binance' || /account/i.test(headText))) kind = 'binance_transactions';
  else if (/transaction.?type/i.test(headText) && (has('change') || has('coin'))) kind = 'bybit';
  else if (has('date') && (has('change') || has('coin'))) kind = 'generic';
  else kind = 'unknown';
  out.detected = kind === 'unknown' ? 'generic' : kind;

  const rows: Record<string, string>[] = [];
  let headerSeen = false;
  for (const line of lines) {
    if (line === head.line && !headerSeen) { headerSeen = true; continue; }
    if (!headerSeen) continue;
    if (/^(total|grand total|sum|page \d|generated|statement period)/i.test(line.text)) continue;
    if (line.cells.some(c => canon(c.text)) && line.cells.length <= cols.length + 1) continue; // repeated page header
    const v = rowValues(line, cols);
    if (!v.date && !v.change && !v.debit && !v.credit) continue;
    rows.push(v);
  }
  if (!rows.length) {
    out.notes.push(`The table in this PDF (${out.exchange}) has a header but no readable rows.`);
    return out;
  }

  const legs: string[] = [];
  for (const v of rows) {
    const when = normWhen(v.date ?? '');
    if (!when) { out.badRows++; continue; }
    if (v.status && !DONE.test(v.status.trim())) { out.skippedStatus++; continue; }
    let change = NaN;
    if (has('debit') && has('credit')) {
      const debit = num(v.debit), credit = num(v.credit);
      change = Number.isFinite(credit) && credit !== 0 ? credit : Number.isFinite(debit) && debit !== 0 ? -debit : NaN;
    } else if (has('change')) {
      change = num((v.change ?? '').replace(/[^\d.,+()\-\s]/g, '').replace(/\(([^)]+)\)/, '-$1'));
    } else if (has('fiat')) {
      change = num(v.fiat);
    }
    if (!Number.isFinite(change)) { out.badRows++; continue; }
    let coin = (v.coin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!coin) { // "0.005 BTC" merged into the change cell, or a coin named in the type/remark
      const m = (v.change ?? v.type ?? v.remark ?? '').match(/([A-Z]{2,10})\b/);
      if (m) coin = m[1];
      const split = (v.change ?? '').match(/^([+-]?[\d,]*\.?\d+)\s+([A-Z]{2,10})$/);
      if (split) { change = num(split[1]); coin = split[2]; }
    }
    if (!coin) { out.badRows++; continue; }
    const type = (v.type ?? v.remark ?? '').trim() || 'Unknown';
    const remark = [v.order, v.remark].filter(Boolean).join(' | ').replace(/"/g, "'");
    if (kind === 'quidax') {
      legs.push(csvRow(when, type, change < 0 ? String(-change) : '', change > 0 ? String(change) : '', coin));
    } else if (kind === 'binance_p2p') {
      legs.push(csvRow(remark || '', type, coin, v.fiat?.match(/[A-Z]{3}/)?.[0] ?? 'NGN', String(num(v.fiat) || 0), String(num(v.price) || 0), String(Math.abs(change)), '', '', '', '', 'Completed', when));
    } else if (kind === 'binance_transactions') {
      legs.push(csvRow('', when, 'Spot', type, coin, String(change), remark));
    } else {
      legs.push(csvRow(when, type, coin, String(change)));
    }
    out.rows++;
  }

  if (!out.rows) {
    out.notes.push(`Every row in this PDF (${out.exchange}) failed to read: ${out.badRows} rows had no date or amount we could trust.`);
    return out;
  }
  if (out.badRows) out.notes.push(`${out.badRows} row(s) in this PDF could not be read and were left out, not guessed.`);
  if (out.skippedStatus) out.notes.push(`${out.skippedStatus} row(s) were not completed (cancelled, failed or reversed) and were left out.`);

  if (kind === 'quidax') {
    out.csv = 'date,description,debit,credit,currency\n' + legs.join('\n') + '\n';
  } else if (kind === 'binance_p2p') {
    out.csv = 'Order Number,Order Type,Asset Type,Fiat Type,Total Price,Price,Quantity,Exchange rate,Maker Fee,Taker Fee,Counterparty,Status,Created Time\n' + legs.join('\n') + '\n';
  } else if (kind === 'binance_transactions') {
    out.csv = 'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark\n' + legs.join('\n') + '\n';
  } else {
    out.csv = 'utc_time,transaction_type,coin,change\n' + legs.join('\n') + '\n';
  }
  return out;
}
