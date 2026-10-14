import { describe, it, expect } from 'vitest';
import { runPipeline } from '../src/pipeline.js';

const CBN_URL = 'https://www.cbn.gov.ng/api/GetAllExchangeRates';
const fakeFetch: typeof fetch = (async (url: any) => {
  const u = String(url);
  if (u.startsWith('https://www.cbn.gov.ng/')) {
    const rows = ['2026-01-02', '2026-01-13', '2026-04-26', '2026-05-01'].map(d => ({ currency: 'US DOLLAR', ratedate: d, centralrate: '1500' }));
    return new Response(JSON.stringify(rows), { status: 200 }) as any;
  }
  if (u.startsWith('https://coins.llama.fi/')) {
    const hour = u.split('/prices/historical/')[1]?.split('/')[0];
    return new Response(JSON.stringify({ coins: { 'coingecko:bitcoin': { price: 30000 } }, at: hour }), { status: 200 }) as any;
  }
  throw new Error(`unexpected fetch ${u}`);
}) as unknown as typeof fetch;

const bybit = "transaction_type,currency,change,uts\nDeposit,USDC,220,2026-03-01 10:00:00\nSwap,BTC,-0.05,2026-04-27 12:00:00\nSwap,USDC,3000,2026-04-27 12:00:00\nEarn Interest Pay,USDT,10.5,2026-05-01 08:00:00";
const qnaira = "Date,Description,Debit,Credit\n14/01/2026 09:00,Buy USDT,1200000,\n27/04/2026 15:30,Sell USDT,,900000";
const qcrypto = "Date,Description,Debit,Credit,Currency\n14/01/2026 09:00,Instant Buy USDT,,700,USDT\n27/04/2026 15:30,Instant Sell USDT,700,,USDT\n27/01/2026 16:00,Deposit USDT,,100,USDT\n27/02/2026 17:00,Staking Reward,,5,USDT";

describe('mixed exchange files end to end', () => {
  it('pairs Quidax naira and crypto statements and keeps Bybit events', async () => {
    const out = await runPipeline({
      wallets: [], year: 2026,
      exchangeFiles: [
        { name: 'bybit.csv', text: bybit },
        { name: 'quidax-naira.csv', text: qnaira },
        { name: 'quidax-crypto.csv', text: qcrypto },
      ],
      fetchImpl: fakeFetch,
    });
    const ex = out.exchange!;
    const kinds = ex.files.map(f => f.kind);
    expect(kinds).toContain('bybit_transactions');
    expect(kinds.filter(k => k === 'quidax_statement').length).toBe(2);
    expect(kinds.filter(k => k === 'unknown').length).toBe(0); // duplicates dropped
    const buy = ex.events.find(e => e.type === 'buy_fiat');
    expect(buy?.naira).toBe(1200000);
    const sell = ex.events.find(e => e.type === 'sell_fiat');
    expect(sell?.naira).toBe(900000);
    expect(ex.events.some(e => e.type === 'income' && e.units === 5)).toBe(true);   // quidax staking
    expect(ex.events.some(e => e.type === 'income' && e.units === 10.5)).toBe(true); // bybit interest
    expect(ex.events.some(e => e.type === 'swap' && e.assetOut === 'BTC')).toBe(true);
    expect(ex.items.length).toBeGreaterThanOrEqual(6);
  });
}, 120_000);
