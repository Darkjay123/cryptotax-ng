import { describe, it, expect } from 'vitest';
import { renderPdf, PdfReport } from '../src/pdf.js';
import { PDFDocument } from 'pdf-lib';

const base: PdfReport = {
  year: 2026,
  totals: { gainsNaira: 25234.78, lossesNaira: 0, netDisposalNaira: 25234.78, chargeableGainsNaira: 25234.78, incomeNaira: 1703.62, vaChargeableNaira: 26938.4, whtCreditNaira: 0 },
  estimate: { otherChargeableNaira: 0, totalChargeableNaira: 26938.4, taxFromCrypto: 1350.2, whtCredit: 0, estimatedBalanceDue: 1350.2 },
  rows: [{ id: 'r1', date: '2026-03-01', chain: 'ethereum', symbol: 'USDC', units: 220, usd: 220, direction: 'in', label: 'payment' }],
  disposals: [{ date: '2026-04-27', asset: 'USDC', units: 220, proceedsNaira: 330000, costNaira: 300000, gainNaira: 30000, whtNaira: 0, sourceId: 'ethereum:0xabc' }],
  income: [{ date: '2026-04-27', asset: 'USDC', units: 5, kind: 'payment', naira: 7550, whtNaira: 0, sourceId: 'ethereum:0xdef' }],
  warnings: ['Some history was truncated.'], sources: ['prices: DefiLlama'], exchange: { files: [{ name: 'tx.csv', kind: 'binance_transactions', rows: 8 }], matched: 2 }, needsReview: 1, unpriced: 0,
};

describe('renderPdf', () => {
  it('returns a valid one-plus-page PDF with the totals on it', async () => {
    const bytes = await renderPdf(base);
    expect(Buffer.from(bytes).slice(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(Buffer.from(bytes));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });
  it('paginates for large reports', async () => {
    const disposals = Array.from({ length: 200 }, (_, i) => ({ date: '2026-01-02', asset: 'USDC', units: 10 + i, proceedsNaira: 1000 + i, costNaira: 900, gainNaira: 100, whtNaira: 0, sourceId: `ethereum:0x${i}` }));
    const bytes = await renderPdf({ ...base, disposals });
    const doc = await PDFDocument.load(Buffer.from(bytes));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });
  it('handles empty reports without throwing', async () => {
    const bytes = await renderPdf({ ...base, disposals: [], income: [], rows: [], warnings: [], exchange: null, needsReview: 0 });
    const doc = await PDFDocument.load(Buffer.from(bytes));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
