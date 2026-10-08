/**
 * Every figure here is copied from the worked examples in NRS Information
 * Circular 2026/21 (31 July 2026). If these fail, the engine disagrees with the NRS.
 */
import { describe, expect, it } from 'vitest';
import { computeReport } from '../src/engine.js';
import { estimateIndividual } from '../src/estimate.js';
import { STAMP_DUTY_RATE, personalIncomeTax } from '../src/rules.js';

const rates = (m: Record<string, number>) => (d: string) => {
  const r = m[d]; if (!r) throw new Error('no rate for ' + d); return r;
};

describe('Illustration 1: stamp duty on token/fiat', () => {
  it('withholds 1.5% of the token from the buyer', () => {
    expect(1 - 1 * STAMP_DUTY_RATE).toBeCloseTo(0.985, 10);
    expect(0.985 * (1 - STAMP_DUTY_RATE)).toBeCloseTo(0.970225, 10);
  });
});

describe('Illustration 2: disposal for fiat, dollar-referenced gain', () => {
  const r = computeReport([
    { type: 'buy_fiat', date: '2026-01-10', asset: 'BTC', unitsNet: 0.985, naira: 1_000_000 },
    { type: 'sell_fiat', date: '2026-06-10', asset: 'BTC', units: 0.985, naira: 1_970_000 },
  ], { rate: rates({ '2026-01-10': 1000, '2026-06-10': 1500 }) });
  const d = r.disposals[0];
  it('dollar cost base is $1,000', () => expect(d.usdCost).toBeCloseTo(1000, 6));
  it('dollar proceeds are $1,313.33', () => expect(d.usdProceeds).toBeCloseTo(1313.333333, 5));
  it('dollar gain is $313.33', () => expect(d.usdGain).toBeCloseTo(313.333333, 5));
  it('taxable naira gain is N470,000, not N970,000', () => expect(d.nairaGain).toBe(470_000));
});

describe('Illustration 3: token/token swap', () => {
  const r = computeReport([
    { type: 'opening', date: '2026-01-05', asset: 'ETH', units: 2, usdCost: 3000 },
    { type: 'swap', date: '2026-07-01', assetOut: 'ETH', unitsOut: 2, assetIn: 'BTC', unitsIn: 0.1, usdFmvOut: 4000, viaVasp: true },
  ], { rate: rates({ '2026-01-05': 1500, '2026-07-01': 1600 }) });
  const d = r.disposals[0];
  it('dollar gain is $1,000', () => expect(d.usdGain).toBe(1000));
  it('taxable naira gain is N1,600,000', () => expect(d.nairaGain).toBe(1_600_000));
  it('VASP withholds 0.02 ETH', () => expect(d.whtUnits).toBe(0.02));
  it('new BTC cost base is $4,000', () => expect(r.holdings.BTC).toEqual({ units: 0.1, usdCost: 4000 }));
});

describe('Para 9.5(1): stablecoins', () => {
  it('USDT sold at its peg has nil gain and no WHT', () => {
    const r = computeReport([
      { type: 'income', kind: 'professional', date: '2026-03-15', asset: 'USDT', units: 500, usdFmv: 500 },
      { type: 'sell_fiat', date: '2026-03-20', asset: 'USDT', units: 500, naira: 500 * 1600, viaVasp: true },
    ], { rate: () => 1600 });
    expect(r.income[0].naira).toBe(800_000);       // the fee itself is income at receipt
    expect(r.disposals[0].nairaGain).toBe(0);
    expect(r.disposals[0].whtUnits).toBe(0);
  });
});

describe('Para 7.2.2 / 10.1: own-wallet moves and wraps are not disposals', () => {
  it('wrapping carries the cost base across', () => {
    const r = computeReport([
      { type: 'opening', date: '2026-01-01', asset: 'BTC', units: 1, usdCost: 30000 },
      { type: 'self_transfer', date: '2026-02-01', asset: 'BTC', units: 1, toAsset: 'WBTC' },
    ], { rate: () => 1500 });
    expect(r.disposals).toHaveLength(0);
    expect(r.holdings.WBTC).toEqual({ units: 1, usdCost: 30000 });
  });
});

describe('Para 9.4: annual netting', () => {
  it('losses offset gains, net loss carries forward', () => {
    const r = computeReport([
      { type: 'opening', date: '2026-01-01', asset: 'SOL', units: 10, usdCost: 2000 },
      { type: 'opening', date: '2026-01-01', asset: 'ETH', units: 1, usdCost: 1000 },
      { type: 'sell_fiat', date: '2026-04-01', asset: 'SOL', units: 10, naira: 1000 * 1500 }, // -$1000
      { type: 'sell_fiat', date: '2026-05-01', asset: 'ETH', units: 1, naira: 1400 * 1500 },  // +$400
    ], { rate: () => 1500 });
    expect(r.totals.netDisposalNaira).toBe(-900_000);
    expect(r.totals.chargeableGainsNaira).toBe(0);
    expect(r.totals.lossCarriedForwardNaira).toBe(900_000);
  });
});

describe('NTA 2025 bands', () => {
  it('first N800k is tax free', () => expect(personalIncomeTax(800_000)).toBe(0));
  it('N3m pays 15% of N2.2m', () => expect(personalIncomeTax(3_000_000)).toBe(330_000));
  it('crypto tax is the extra tax on top of other income', () => {
    const r = computeReport([
      { type: 'income', kind: 'professional', date: '2026-03-15', asset: 'USDT', units: 1000, usdFmv: 1000 },
    ], { rate: () => 1500 });
    const e = estimateIndividual(r, 800_000);
    expect(e.taxFromCrypto).toBe(225_000); // N1.5m at 15%
  });
});
