import { describe, expect, it } from 'vitest';
import { tronHexToBase58, isTronAddress } from '../src/wallet/tron.js';
import { EVM_CHAINS, fetchEvm } from '../src/wallet/evm.js';
import { fetchBtc, isBtcAddress } from '../src/wallet/btc.js';
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

describe('multichain wallet reading', () => {
  it('every EVM chain in the table has a full config and a priceable native coin', () => {
    expect(Object.keys(EVM_CHAINS).length).toBeGreaterThanOrEqual(61);
    // Chains whose native coin has no listing yet price everything else fine; their native-coin
    // rows come out flagged for review instead of guessed. Keep this list honest and short.
    const unpricedNative = new Set(['blackfort', 'datachain', 'playblock', 'kite', 'awaji', 'mizuhiki', 'numine', 'stability', 'cross']);
    for (const [id, c] of Object.entries(EVM_CHAINS)) {
      expect(c.api.startsWith('https://'), id).toBe(true);
      expect(c.native.length, id).toBeGreaterThan(0);
      if (unpricedNative.has(id)) expect(c.nativeKey, id).toBe('');
      else expect(c.nativeKey.includes(':'), id).toBe(true);
      expect(c.llama.length, id).toBeGreaterThan(0);
    }
  });

  it('skips chains the address never touched (one gate request, no deep read)', async () => {
    const calls: string[] = [];
    const f = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ has_token_transfers: false, has_transactions: false, has_internal_transactions: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const moves = await fetchEvm('base', '0x46dAeC8FE29132Eee301636100c9B5f7Af0F058e', { fetchImpl: f });
    expect(moves).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/addresses/0x');
    expect(calls[0]).not.toContain('token-transfers');
  });

  it('recognises Bitcoin addresses and rejects others', () => {
    expect(isBtcAddress('bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97')).toBe(true);
    expect(isBtcAddress('bc1pgu3ckmgsd3nsqsjk4suq2hyawuqtkpzhwkyzshh6yc4xvstprx9qzcs9l3')).toBe(true);
    expect(isBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    expect(isBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    expect(isBtcAddress('0x46dAeC8FE29132Eee301636100c9B5f7Af0F058e')).toBe(false);
    expect(isBtcAddress('bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw9i')).toBe(false); // i is not in the bech32 data charset
  });

  it('reads bitcoin history: receive, spend net of change, self-transfer skipped', async () => {
    const me = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97';
    const tx = (vin: any[], vout: any[], blockTime: number) => ({
      txid: `t${blockTime}`, vin: vin.map(v => ({ prevout: { scriptpubkey_address: v.a, value: v.v } })), vout: vout.map(v => ({ scriptpubkey_address: v.a, value: v.v })),
      status: { confirmed: true, block_time: blockTime },
    });
    const inTx = tx([{ a: 'other', v: 200_000 }], [{ a: me, v: 150_000 }, { a: 'other', v: 50_000 }], 1_750_000_000);
    const spendTx = tx([{ a: me, v: 150_000 }], [{ a: 'merchant', v: 100_000 }, { a: me, v: 49_000 }], 1_760_000_000); // fee 1000 sats
    const selfTx = tx([{ a: me, v: 49_000 }], [{ a: me, v: 48_500 }], 1_770_000_000);
    const f = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/txs/chain')) return new Response(JSON.stringify([selfTx, spendTx, inTx]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 }); // page 2 empty
    }) as unknown as typeof fetch;
    const moves = await fetchBtc(me, { fetchImpl: f });
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({ chain: 'bitcoin', direction: 'in', units: 0.0015, symbol: 'BTC', counterparty: 'other', priceKey: 'coingecko:bitcoin' });
    expect(moves[1]).toMatchObject({ chain: 'bitcoin', direction: 'out', units: 0.00101, symbol: 'BTC', counterparty: 'merchant' });
  });

  it('bitcoin receive with no counterparty (coinbase) keeps the movement', async () => {
    const me = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97';
    const cb = { txid: 'cb', vin: [{ prevout: null }], vout: [{ scriptpubkey_address: me, value: 625_000 }], status: { confirmed: true, block_time: 1_740_000_000 } };
    const f = (async () => new Response(JSON.stringify([cb]), { status: 200 })) as unknown as typeof fetch;
    const moves = await fetchBtc(me, { fetchImpl: f });
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ direction: 'in', counterparty: 'multiple', units: 0.00625 });
  });
});
