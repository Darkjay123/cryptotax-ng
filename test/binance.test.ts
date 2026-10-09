import { describe, it, expect } from 'vitest';
import { readBinanceFiles, buildBinance, matchTransfers, detect, classifyOp } from '../src/exchange/binance.js';
import { computeReport } from '../src/engine.js';

// Same column layout as Binance's "Export Transaction Records" file.
const TX = `"User_ID","UTC_Time","Account","Operation","Coin","Change","Remark"
"1","2026-02-01 10:00:00","Funding","P2P Trading","USDT","500.00000000",""
"1","2026-02-03 09:00:00","Spot","Transaction Spend","USDT","-300.00000000",""
"1","2026-02-03 09:00:00","Spot","Transaction Buy","BTC","0.00300000",""
"1","2026-02-03 09:00:00","Spot","Transaction Fee","BNB","-0.00100000",""
"1","2026-03-01 08:00:00","Spot","Simple Earn Flexible Interest","USDT","1.25000000",""
"1","2026-03-05 12:00:00","Spot","Withdraw","USDT","-150.00000000","Withdraw fee is included"
"1","2026-03-06 12:00:00","Spot","Mystery Op","USDT","-2.00000000",""
"1","2026-04-01 10:00:00","Funding","P2P Trading","USDT","-100.00000000",""
`;
// Binance P2P (C2C) Order History layout.
const P2P = `Order Number,Order Type,Asset Type,Fiat Type,Total Price,Price,Quantity,Exchange rate,Maker Fee,Taker Fee,Couterparty,Status,Created Time
22806199268250521600,Buy,USDT,NGN,"775,000",1550,500,,0,0,Seller_A,Completed,2026-02-01 09:58:12
22806199268250521601,Sell,USDT,NGN,"162,000",1620,100,,0,0,Buyer_B,Completed,2026-04-01 09:59:40
22806199268250521602,Buy,USDT,NGN,"10,000",1600,6.25,,0,0,Seller_C,Cancelled,2026-04-02 10:00:00
`;
const price = (m: any) => (m.symbol === 'BTC' ? 100_000 : m.symbol === 'BNB' ? 600 : null);

describe('Binance import', () => {
  it('detects both export types', () => {
    expect(detect(TX)).toBe('binance_transactions');
    expect(detect(P2P)).toBe('binance_p2p');
    expect(detect('a,b,c\n1,2,3')).toBe('unknown');
  });

  it('uses P2P naira amounts and skips the duplicate P2P lines', () => {
    const ex = buildBinance(readBinanceFiles([{ name: 'tx.csv', text: TX }, { name: 'p2p.csv', text: P2P }]), price as any);
    const buys = ex.events.filter(e => e.type === 'buy_fiat');
    const sells = ex.events.filter(e => e.type === 'sell_fiat');
    expect(buys).toEqual([expect.objectContaining({ asset: 'USDT', unitsNet: 500, naira: 775000 })]);
    expect(sells).toEqual([expect.objectContaining({ asset: 'USDT', units: 100, naira: 162000 })]);
    expect(ex.notes.join(' ')).toMatch(/skipped 2 matching P2P lines/);
    // Cancelled order ignored, and P2P lines not counted twice as openings.
    expect(ex.events.filter(e => e.type === 'opening')).toHaveLength(0);
  });

  it('turns a spot trade into a swap valued at what was given up, with the BNB fee as a small disposal', () => {
    const ex = buildBinance(readBinanceFiles([{ name: 'tx.csv', text: TX }]), price as any);
    const swaps = ex.events.filter(e => e.type === 'swap') as any[];
    expect(swaps).toContainEqual(expect.objectContaining({ assetOut: 'USDT', unitsOut: 300, assetIn: 'BTC', unitsIn: 0.003, usdFmvOut: 300 }));
    expect(swaps).toContainEqual(expect.objectContaining({ assetOut: 'BNB', unitsOut: 0.001, assetIn: '__SPENT__', usdFmvOut: 0.6 }));
  });

  it('counts Earn interest as income, flags unknown operations, and records withdrawals', () => {
    const ex = buildBinance(readBinanceFiles([{ name: 'tx.csv', text: TX }]), price as any);
    expect(ex.events).toContainEqual(expect.objectContaining({ type: 'income', kind: 'staking', asset: 'USDT', units: 1.25, usdFmv: 1.25 }));
    expect(ex.items.find(i => i.kind === 'unknown')?.review).toMatch(/do not recognise/);
    expect(ex.withdrawals).toEqual([expect.objectContaining({ symbol: 'USDT', units: 150, date: '2026-03-05' })]);
    // Without the P2P file, P2P lines need the user (no naira amount).
    expect(ex.items.filter(i => i.kind.startsWith('p2p') && i.review)).toHaveLength(2);
  });

  it('matches a wallet deposit to a Binance withdrawal (less network fee) as own money', () => {
    const ex = buildBinance(readBinanceFiles([{ name: 'tx.csv', text: TX }]), price as any);
    const ts = Date.UTC(2026, 2, 5, 12, 20) / 1000;
    const moves: any[] = [
      { chain: 'tron', hash: 'h1', timestamp: ts, date: '2026-03-05', wallet: 'T1', direction: 'in', counterparty: 'Tbinance', symbol: 'USDT', token: 'x', decimals: 6, units: 149, priceKey: 'k' },
      { chain: 'tron', hash: 'h2', timestamp: ts, date: '2026-03-05', wallet: 'T1', direction: 'in', counterparty: 'Tclient', symbol: 'USDT', token: 'x', decimals: 6, units: 1000, priceKey: 'k' },
    ];
    const m = matchTransfers(moves, ex);
    expect([...m.keys()]).toEqual([0]);
    expect(m.get(0)).toMatch(/Binance withdrawal of 150 USDT/);
  });

  it('runs through the tax engine: naira buy then sell at a higher naira price on a stablecoin', () => {
    const ex = buildBinance(readBinanceFiles([{ name: 'p2p.csv', text: P2P }]), price as any);
    const r = computeReport(ex.events, { rate: d => (d < '2026-03-01' ? 1550 : 1620) });
    // 100 USDT cost $100 (775,000/500 = ₦1,550 = $1 at that day's rate); sold for ₦162,000 = $100 at ₦1,620. No dollar gain.
    expect(r.disposals).toHaveLength(1);
    expect(Math.abs(r.disposals[0].usdGain)).toBeLessThan(0.01);
  });

  it('knows common Binance operation names', () => {
    expect(classifyOp('Transaction Revenue').cls).toBe('trade');
    expect(classifyOp('Binance Convert').cls).toBe('trade');
    expect(classifyOp('Simple Earn Flexible Subscription').cls).toBe('internal');
    expect(classifyOp('Airdrop Assets')).toMatchObject({ cls: 'reward', incomeKind: 'airdrop' });
    expect(classifyOp('Transfer Between Main and Funding Wallet').cls).toBe('internal');
    expect(classifyOp('Fiat Deposit').cls).toBe('fiat');
  });
});
