import { describe, it, expect } from 'vitest';
import { detectBybit, readBybit, buildBybit } from '../src/exchange/bybit.js';
import { detectQuidax, readQuidax, buildQuidax } from '../src/exchange/quidax.js';

const price = (m: any) => (m.symbol === 'BTC' ? 30000 : m.symbol === 'ETH' ? 2000 : null);

const bybitCsv = `transaction_type,currency,change,uts
Deposit,BTC,0.5,2026-01-10 10:00:00
Withdraw,BTC,0.2,2026-01-11 09:00:00
Earn Interest Pay,USDT,10.5,2026-01-12 08:00:00
Swap,BTC,-0.1,2026-01-13 12:00:00
Swap,USDT,3000,2026-01-13 12:00:00
Banana Drip,BANANA,5,2026-01-14 12:00:00`;

describe('Bybit', () => {
  it('detects a Bybit export and not a Binance one', () => {
    expect(detectBybit(bybitCsv)).toBe(true);
    expect(detectBybit('UTC_Time,Operation,Coin,Change\n2026-01-10,Deposit,BTC,1\n')).toBe(false);
  });
  it('reads deposits, withdrawals, rewards and a swap', () => {
    const r = readBybit(bybitCsv)!;
    const b = buildBybit({ ...r, name: 'bybit.csv' }, price, 'bybit.csv');
    expect(b.events.some(e => e.type === 'income' && e.units === 10.5)).toBe(true); // Earn interest
    expect(b.withdrawals.some(w => w.units === 0.2)).toBe(true);
    const swap = b.events.find(e => e.type === 'swap');
    expect(swap).toBeTruthy();
    expect(swap!.assetOut).toBe('BTC');
    expect(swap!.usdFmvOut).toBe(3000);
    expect(b.items.filter(i => i.review).length).toBeGreaterThanOrEqual(1); // Mystery Transfer
    expect(b.files[0].name).toBe('bybit.csv');
  });
});

const quidaxNaira = `Date,Description,Debit,Credit
14/01/2026 09:00,Buy USDT,1200000,
14/01/2026 15:30,Sell USDT,,1300000`;

const quidaxCrypto = `Date,Description,Debit,Credit,Currency
14/01/2026 09:00,Instant Buy USDT,,700,USDT
14/01/2026 15:30,Instant Sell USDT,760,,USDT
14/01/2026 16:00,Deposit USDT,,100,USDT
14/01/2026 17:00,Staking Reward,,5,USDT`;

describe('Quidax', () => {
  it('detects a Quidax statement', () => {
    expect(detectQuidax(quidaxNaira)).toBe(true);
    expect(detectQuidax(quidaxCrypto)).toBe(true);
  });
  it('pairs naira legs with crypto legs for buys and sells', () => {
    const n = readQuidax(quidaxNaira)!, c = readQuidax(quidaxCrypto)!;
    const merged = { legs: c.legs, nairaLegs: n.nairaLegs, files: [...n.files, ...c.files], notes: [], name: 'quidax.csv' };
    const q = buildQuidax(merged, price, 'quidax.csv');
    const buy = q.events.find(e => e.type === 'buy_fiat');
    expect(buy).toBeTruthy();
    expect(buy!.asset).toBe('USDT');
    expect(buy!.naira).toBe(1200000);
    const sell = q.events.find(e => e.type === 'sell_fiat');
    expect(sell!.naira).toBe(1300000);
    expect(q.withdrawals.length).toBe(0);
    expect(q.deposits.some(d => d.units === 100)).toBe(true); // deposit transfer, not taxable
    const income = q.events.find(e => e.type === 'income');
    expect(income!.units).toBe(5);
  });
  it('flags an unmatched sale for review instead of guessing the naira', () => {
    const c = readQuidax(`Date,Description,Debit,Credit,Currency\n14/01/2026 15:30,Instant Sell USDT,,760,USDT\n`)!;
    const q = buildQuidax({ ...c, nairaLegs: [], name: 'x.csv' }, price, 'x.csv');
    expect(q.events.filter(e => e.type === 'sell_fiat').length).toBe(0);
    expect(q.items.filter(i => i.review).length).toBe(1);
  });
});
