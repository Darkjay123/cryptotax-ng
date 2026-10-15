import { describe, it, expect } from 'vitest';
import { estimateIndividual } from '../src/estimate.js';
import { computeReport } from '../src/engine.js';

describe('reinvestment relief (estimate-level)', () => {
  const r = computeReport(
    [{ type: 'income', kind: 'professional', date: '2026-03-15', asset: 'USDT', units: 1000, usdFmv: 1000 }],
    { rate: () => 1500 },
  );
  it('reduces total chargeable income without touching other-income tax', () => {
    const base = estimateIndividual(r, 800_000);
    const relieved = estimateIndividual(r, 800_000, 500_000);
    expect(relieved.totalChargeableNaira).toBe(base.totalChargeableNaira - 500_000);
    expect(relieved.otherChargeableNaira).toBe(800_000);
    expect(relieved.reinvestedNaira).toBe(500_000);
    expect(relieved.taxFromCrypto).toBeLessThan(base.taxFromCrypto);
  });
  it('never pushes chargeable income below zero', () => {
    const e = estimateIndividual(r, 100_000, 999_999);
    expect(e.totalChargeableNaira).toBe(0);
    expect(e.taxFromCrypto).toBe(0);
  });
  it('defaults to no relief', () => {
    const base = estimateIndividual(r, 800_000);
    expect(base.reinvestedNaira).toBe(0);
    expect(base.totalChargeableNaira).toBe(estimateIndividual(r, 800_000, 0).totalChargeableNaira);
  });
});
