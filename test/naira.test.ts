import { describe, it, expect } from 'vitest';
import { detectNairaVendor, detectNaira, readNaira, buildNaira, classifyNairaDesc } from '../src/exchange/naira.js';
import { computeReport } from '../src/engine.js';

const price = (m: any) => (m.symbol === 'BTC' ? 100_000 : m.symbol === 'BNB' ? 600 : null);

// Shape modeled on the statement columns Spenda-style apps print:
// Date, Type, Asset, Amount, NGN Value, Status.
const spenda = `Date,Type,Asset,Amount,NGN Value,Status
10/02/2026 09:00,Deposit,USDT,500,,Completed
10/02/2026 09:05,Sold,USDT,-500,765000,Completed
10/02/2026 09:06,Bank transfer,NGN,-764000,,Completed
11/02/2026 10:00,Bill payment,NGN,-20000,,Completed
12/02/2026 11:00,Mystery entry,BNB,-0.1,,Completed
12/02/2026 12:00,Buy,BTC,,Cancelled`;

// Shape modeled on Azza (the WhatsApp off-ramp): Date, Description, Asset,
// Amount, NGN Received, Status.
const azza = `Date,Description,Asset,Amount,NGN Received,Status
12/01/2026 14:00,Buy USDT,USDT,100,155000,Completed
12/01/2026 15:00,Sell USDT,USDT,50,78000,Completed
13/01/2026 09:00,Referral bonus,USDT,2,,Completed`;

// No naira column: the crypto line must pair with the bank payout within 10 min.
const breet = `Date,Type,Coin,Amount
05/03/2026 10:00,Sell,BTC,-0.01
05/03/2026 10:02,Bank payout,NGN,1500000`;

describe('Nigerian exchange and off-ramp statements', () => {
  it('names the vendor from the file name or the text', () => {
    expect(detectNairaVendor('', 'spenda-statement.csv')).toBe('Spenda');
    expect(detectNairaVendor('AZZA transaction history\nDate,Amount', 'x.csv')).toBe('Azza');
    expect(detectNairaVendor('Date,Amount\n1,2', 'random.csv')).toBe(null);
  });

  it('detects a naira statement and refuses a Binance one', () => {
    expect(detectNaira(spenda, 'spenda.csv')).toBe('Spenda');
    expect(detectNaira('a,b,c\n1,2,3', 'random.csv')).toBe(null);
    expect(detectNairaVendor('Date,Time,Operation,Coin,Change,Remark\n2026-02-01,10:00,Deposit,BTC,1,', 'tx.csv')).toBe(null);
  });

  it('reads direct sells with a naira value and skips cancelled rows', () => {
    const r = readNaira(spenda, 'Spenda')!;
    const b = buildNaira(r, price, 'spenda.csv');
    const sell = b.events.find(e => e.type === 'sell_fiat');
    expect(sell).toEqual(expect.objectContaining({ asset: 'USDT', units: 500, naira: 765000 }));
    expect(b.deposits.some(d => d.symbol === 'USDT' && d.units === 500)).toBe(true);
    // The bank transfer and the bill payment are plain naira lines, noted not counted.
    expect(b.notes.some(n => /2 naira line\(s\)/.test(n))).toBe(true);
    // The cancelled buy was skipped, not counted and not reviewed.
    expect(b.items.some(i => /Buy/.test(i.text) && i.date === '2026-02-12')).toBe(false);
    // The mystery BNB entry goes to review, never guessed.
    expect(b.items.some(i => i.review && /Mystery entry/.test(i.text))).toBe(true);
    expect(b.files[0]).toEqual({ name: 'spenda.csv', kind: 'naira_statement', rows: 5 });
  });

  it('reads Azza-style buys, sells and referral income', () => {
    const b = buildNaira(readNaira(azza, 'Azza')!, price, 'azza.csv');
    const buy = b.events.find(e => e.type === 'buy_fiat');
    expect(buy).toEqual(expect.objectContaining({ asset: 'USDT', unitsNet: 100, naira: 155000 }));
    const sell = b.events.find(e => e.type === 'sell_fiat');
    expect(sell).toEqual(expect.objectContaining({ asset: 'USDT', units: 50, naira: 78000 }));
    const inc = b.events.find(e => e.type === 'income');
    expect(inc).toEqual(expect.objectContaining({ asset: 'USDT', units: 2, usdFmv: 2, viaVasp: true }));
    // Items are named after the vendor, not "your exchange".
    expect(b.items.every(i => i.source === 'Azza')).toBe(true);
  });

  it('pairs a crypto sale with the bank payout when no naira value column exists', () => {
    const b = buildNaira(readNaira(breet, 'Breet')!, price, 'breet.csv');
    const sell = b.events.find(e => e.type === 'sell_fiat');
    expect(sell).toEqual(expect.objectContaining({ asset: 'BTC', units: 0.01, naira: 1500000 }));
  });

  it('treats a card or bill payment in crypto as a disposal at market value', () => {
    const card = `Date,Type,Asset,Amount,Status
14/02/2026 10:00,Card payment,BNB,-0.05,Completed`;
    const b = buildNaira(readNaira(card, 'Spenda')!, price, 'card.csv');
    const swap = b.events.find(e => e.type === 'swap');
    expect(swap).toEqual(expect.objectContaining({ assetOut: 'BNB', unitsOut: 0.05, usdFmvOut: 30 }));
  });

  it('classifies the common ramp wording', () => {
    expect(classifyNairaDesc('Sold USDT').cls).toBe('sell');
    expect(classifyNairaDesc('cashed out to bank').cls).toBe('sell');
    expect(classifyNairaDesc('Bought BTC').cls).toBe('buy');
    expect(classifyNairaDesc('Airtime purchase').cls).toBe('payment');
    expect(classifyNairaDesc('Received USDT').cls).toBe('deposit');
    expect(classifyNairaDesc('Withdraw BTC').cls).toBe('withdraw');
    expect(classifyNairaDesc('Referral bonus').cls).toBe('reward');
    expect(classifyNairaDesc('Transfer to funding').cls).toBe('internal');
    expect(classifyNairaDesc('Hmm').cls).toBe('unknown');
  });

  it('computes a tax report end to end through the new events', () => {
    const b = buildNaira(readNaira(azza, 'Azza')!, price, 'azza.csv');
    const rep = computeReport(b.events, { rate: () => 1550 });
    expect(rep.warnings.length).toBe(0);
    expect(rep.disposals.length + rep.income.length).toBeGreaterThan(0);
  });
});
