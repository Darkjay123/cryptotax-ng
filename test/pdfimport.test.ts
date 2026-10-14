import { describe, expect, it } from 'vitest';
import { parseStatementPdf, normWhen } from '../src/exchange/pdfimport.js';
import { readBinanceFiles } from '../src/exchange/binance.js';
import { detectBybit, readBybit } from '../src/exchange/bybit.js';
import { detectQuidax } from '../src/exchange/quidax.js';

/** Builds a tiny valid PDF with text placed at real coordinates, like an exchange export. */
function makePdf(rows: { x: number; y: number; text: string }[]): Uint8Array {
  const enc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let stream = '';
  for (const r of rows) stream += `BT /F1 10 Tf ${r.x} ${r.y} Td (${enc(r.text)}) Tj ET\n`;
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

// A Binance-style statement: each cell its own item, columns ~70pt apart.
const binanceRows = (rows: string[][]): { x: number; y: number; text: string }[] => {
  const out = [{ x: 40, y: 750, text: 'Binance Transaction History' }];
  const cols = [40, 170, 250, 330, 420, 500];
  rows.forEach((r, i) => { r.forEach((c, j) => out.push({ x: cols[j], y: 720 - i * 20, text: c })); });
  return out;
};

describe('exchange PDF statements', () => {
  it('reads a Binance-style statement PDF into the Binance reader', async () => {
    const pdf = makePdf(binanceRows([
      ['Date(UTC)', 'Account', 'Operation', 'Coin', 'Change', 'Remark'],
      ['2026-02-10 12:33:05', 'Spot', 'Buy', 'USDT', '1000.00000000', ''],
      ['2026-03-04 09:10:00', 'Spot', 'Sell', 'BTC', '-0.02000000', ''],
      ['2026-03-20 18:02:11', 'Spot', 'Deposit', 'USDT', '500.00000000', 'Cash deposit'],
    ]));
    const st = await parseStatementPdf('binance.pdf', pdf);
    expect(st.detected).toBe('binance_transactions');
    expect(st.exchange).toBe('Binance');
    expect(st.rows).toBe(3);
    expect(st.badRows).toBe(0);
    const read = readBinanceFiles([{ name: 'binance.pdf', text: st.csv }]);
    expect(read.legs.filter(l => !Number.isNaN(l.change)).length).toBeGreaterThanOrEqual(3);
    expect(read.files[0]?.kind).toBe('binance_transactions');
  });

  it('reads a Quidax-style statement PDF into the Quidax reader', async () => {
    const rows: { x: number; y: number; text: string }[] = [];
    const cols = [40, 150, 300, 420, 500];
    const table = [
      ['Date', 'Description', 'Debit', 'Credit', 'Currency'],
      ['05/03/2026 10:00', 'Sold USDT', '', '1,450,000.00', 'NGN'],
      ['06/03/2026 11:30', 'Bought USDT', '500.00', '', 'USDT'],
    ];
    rows.push({ x: 40, y: 750, text: 'Quidax Account Statement' });
    table.forEach((r, i) => r.forEach((c, j) => rows.push({ x: cols[j], y: 720 - i * 20, text: c })));
    const st = await parseStatementPdf('quidax.pdf', makePdf(rows));
    expect(st.detected).toBe('quidax');
    expect(st.exchange).toBe('Quidax');
    expect(st.rows).toBe(2);
    expect(detectQuidax(st.csv)).toBe(true);
  });

  it('reads an unknown exchange layout as a generic statement under its own name', async () => {
    const rows: { x: number; y: number; text: string }[] = [];
    const cols = [40, 160, 280, 400, 470, 545];
    const table = [
      ['Date', 'Type', 'Coin', 'Amount', 'Fee', 'Status'],
      ['2026-01-15 08:00:00', 'Deposit', 'USDT', '250.00', '0', 'Completed'],
      ['2026-02-02 13:40:00', 'Swap', 'USDT', '-100.00', '0.1', 'Completed'],
      ['2026-02-02 13:40:00', 'Swap', 'BTC', '0.0015', '0', 'Completed'],
      ['2026-03-01 09:00:00', 'Withdrawal', 'USDT', '-75.00', '1', 'Completed'],
      ['2026-03-05 09:00:00', 'Buy', 'USDT', '100.00', '0', 'Cancelled'],
    ];
    rows.push({ x: 40, y: 750, text: 'Busha statement of account' });
    table.forEach((r, i) => r.forEach((c, j) => rows.push({ x: cols[j], y: 720 - i * 20, text: c })));
    const st = await parseStatementPdf('busha.pdf', makePdf(rows));
    expect(st.detected).toBe('generic');
    expect(st.exchange).toBe('Busha');
    expect(st.rows).toBe(4);           // the cancelled row is skipped, counted separately
    expect(st.skippedStatus).toBe(1);
    expect(detectBybit(st.csv)).toBe(true);
    const read = readBybit(st.csv);
    expect(read?.legs.length).toBe(4);
  });

  it('refuses a scanned PDF with a plain note and reads nothing', async () => {
    const st = await parseStatementPdf('scan.pdf', makePdf([]));
    expect(st.detected).toBe('unknown');
    expect(st.csv).toBe('');
    expect(st.notes.join(' ')).toMatch(/scan|readable text/i);
  });

  it('reports rows it cannot read instead of guessing them', async () => {
    const rows: { x: number; y: number; text: string }[] = [];
    const cols = [40, 160, 280, 400];
    const table = [
      ['Date', 'Type', 'Coin', 'Amount'],
      ['2026-01-15 08:00:00', 'Deposit', 'USDT', '250.00'],
      ['not-a-date', 'Deposit', 'USDT', '10.00'],
    ];
    table.forEach((r, i) => r.forEach((c, j) => rows.push({ x: cols[j], y: 750 - i * 20, text: c })));
    const st = await parseStatementPdf('odd.pdf', makePdf(rows));
    expect(st.rows).toBe(1);
    expect(st.badRows).toBe(1);
    expect(st.notes.join(' ')).toMatch(/could not be read/);
  });

  it('reads Nigerian day-first dates as day-first', () => {
    expect(normWhen('05/03/2026 10:00')).toBe('2026-03-05 10:00:00');
    expect(normWhen('2026-03-05 10:00:00')).toBe('2026-03-05 10:00:00');
  });
});
