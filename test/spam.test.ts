import { describe, it, expect } from 'vitest';
import { looksSpam, classify } from '../src/classify.js';

describe('spam and fake tokens', () => {
  it('flags web-address, emoji and look-alike token names seen in real wallets', () => {
    for (const s of ['WWW.BASEX.CFD', 'WWW.FSWAP.CLUB 🟢', 'WWW.BETW.LAT 🟢', 'ℰ⊤ℋ', 'Visit usdt-claim.com', '$1000 REWARD']) expect(looksSpam(s)).toBe(true);
  });
  it('leaves real coins alone', () => {
    for (const s of ['ETH', 'USDT', 'USDC', 'TRX', 'WBTC', 'stETH', 'PENDLE', 'GPU']) expect(looksSpam(s)).toBe(false);
  });
  it('auto-ignores spam and unpriced receipts instead of asking the user, and counts them', () => {
    const base = { chain: 'ethereum', direction: 'in' as const, counterparty: '0xabc', date: '2026-02-01', units: 100 };
    const moves = [
      { ...base, hash: '0x1', symbol: 'WWW.FSWAP.CLUB 🟢' },
      { ...base, hash: '0x2', symbol: 'OBSCURE' },
      { ...base, hash: '0x3', symbol: 'ETH', units: 1 },
    ] as any;
    const c = classify(moves, m => (m.symbol === 'ETH' ? 2500 : null), ['0xme']);
    expect(c.spam).toBe(1);
    expect(c.unpriced.length).toBe(1);
    expect(c.needsReview).toBe(1); // only the real, priced ETH receipt needs a human answer
  });
});
