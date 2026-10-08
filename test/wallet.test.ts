import { describe, expect, it } from 'vitest';
import { tronHexToBase58, isTronAddress } from '../src/wallet/tron.js';
import { buildRateTable, rateOn } from '../src/rates.js';
import { classify } from '../src/classify.js';
import type { Movement } from '../src/wallet/types.js';

describe('tron addresses', () => {
  it('converts 41-hex to base58 (USDT-TRC20 contract)', () => {
    expect(tronHexToBase58('41a614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(isTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
  });
});

describe('CBN rates', () => {
  const t = buildRateTable([
    { currency: 'US DOLLAR', ratedate: '2026-10-02', centralrate: '1325.5' },
    { currency: 'US DOLLAR', ratedate: '2026-10-05', centralrate: '1329.9' },
    { currency: 'EURO', ratedate: '2026-10-05', centralrate: '1500' },
  ]);
  it('uses the exact date when published', () => expect(rateOn(t, '2026-10-05')).toEqual({ rate: 1329.9, rateDate: '2026-10-05' }));
  it('falls back to the last published rate over a weekend', () => expect(rateOn(t, '2026-10-04')).toEqual({ rate: 1325.5, rateDate: '2026-10-02' }));
  it('ignores other currencies', () => expect(t.dates).toEqual(['2026-10-02', '2026-10-05']));
});

const mv = (p: Partial<Movement>): Movement => ({
  chain: 'tron', hash: 'h', timestamp: 1767225600, date: '2026-01-01', wallet: 'TME', direction: 'in',
  counterparty: 'TOTHER', symbol: 'USDT', token: 'x', decimals: 6, units: 100, priceKey: 'tron:x', ...p,
});

describe('classification', () => {
  it('stablecoin received from a stranger is guessed as income', () => {
    const c = classify([mv({})], () => 1, ['TME']);
    expect(c.events[0]).toMatchObject({ type: 'income', usdFmv: 100 });
  });
  it('transfer from your own wallet is not taxable', () => {
    const c = classify([mv({ counterparty: 'TME2' })], () => 1, ['TME', 'TME2']);
    expect(c.events).toHaveLength(0);
  });
  it('out and in of different assets in one tx is a swap', () => {
    const c = classify([
      mv({ hash: 's', direction: 'out', symbol: 'TRX', units: 1000, counterparty: 'POOL' }),
      mv({ hash: 's', direction: 'in', symbol: 'USDT', units: 290, counterparty: 'POOL' }),
    ], m => (m.symbol === 'TRX' ? 0.29 : 1), ['TME']);
    expect(c.events[0]).toMatchObject({ type: 'swap', assetOut: 'TRX', assetIn: 'USDT', usdFmvOut: 290 });
  });
  it('a user label overrides the guess', () => {
    const rows = classify([mv({})], () => 1, ['TME']).rows;
    const c = classify([mv({})], () => 1, ['TME'], { [rows[0].id]: { kind: 'bought', naira: 160_000 } });
    expect(c.events[0]).toMatchObject({ type: 'buy_fiat', naira: 160_000 });
  });
});
