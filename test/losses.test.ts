/** Losses brought forward (para 9.4): the form input offsets this year's gains and carries the rest. */
import { describe, expect, it } from 'vitest';
import { computeReport } from '../src/engine.js';

const rate = () => 1500;
const base = [
  { type: 'opening' as const, date: '2025-01-10', asset: 'ETH', units: 1, usdCost: 1000 },
  { type: 'sell_fiat' as const, date: '2026-03-01', asset: 'ETH', units: 1, naira: 3_000_000 },
];

describe('losses brought forward', () => {
  it('offsets this year\'s gains', () => {
    const r = computeReport(base, { rate, lossesBroughtForwardNaira: 1_000_000 });
    expect(r.totals.netDisposalNaira).toBe(1_500_000);
    expect(r.totals.lossesUsedNaira).toBe(1_000_000);
    expect(r.totals.chargeableGainsNaira).toBe(500_000);
    expect(r.totals.lossCarriedForwardNaira).toBe(0);
  });

  it('carries forward what the year could not use', () => {
    const r = computeReport(base, { rate, lossesBroughtForwardNaira: 2_000_000 });
    expect(r.totals.chargeableGainsNaira).toBe(0);
    expect(r.totals.lossesUsedNaira).toBe(1_500_000);
    expect(r.totals.lossCarriedForwardNaira).toBe(500_000);
  });

  it('is preserved in a loss year and stacks with the new loss', () => {
    const events = [
      { type: 'opening' as const, date: '2025-01-10', asset: 'ETH', units: 1, usdCost: 2000 },
      { type: 'sell_fiat' as const, date: '2026-03-01', asset: 'ETH', units: 1, naira: 1_500_000 },
    ];
    const r = computeReport(events, { rate, lossesBroughtForwardNaira: 400_000 });
    expect(r.totals.netDisposalNaira).toBe(-1_500_000);
    expect(r.totals.lossCarriedForwardNaira).toBe(1_900_000);
  });

  it('does nothing when there is no gain to offset', () => {
    const r = computeReport(base, { rate });
    expect(r.totals.chargeableGainsNaira).toBe(1_500_000);
  });
});
