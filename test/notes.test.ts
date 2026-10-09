import { describe, it, expect } from 'vitest';
import { probs, understand, nairaIn, fnv1a, norm } from '../src/model/notes.js';
import gold from './notes_golden.json';

describe('notes model', () => {
  it('matches the Python featurizer and weights exactly', () => {
    expect(fnv1a('w:refund')).toBe(730480718);
    expect(norm('Fhenix pay me ₦150,000 for ambassador work!!')).toBe('fhenix pay me naira 0 0 for ambassador work');
    for (const g of gold as { text: string; probs: number[] }[]) {
      const p = Object.values(probs(g.text));
      p.forEach((v, i) => expect(Math.abs(v - g.probs[i])).toBeLessThan(1e-4));
    }
  });

  it("reads John's Fhenix cases", () => {
    expect(understand('a', 'Fhenix paid me for ambassador work', 'in').key).toBe('income:professional');
    expect(understand('b', 'fhenix refund my flight for the event', 'in').key).toBe('reimbursement');
    expect(understand('c', 'na my binance i send am from', 'in').key).toBe('own_wallet');
  });

  it('respects direction and pulls the naira amount for P2P', () => {
    const buy = understand('d', 'bought with 150k naira on p2p', 'in');
    expect(buy.label).toEqual({ kind: 'bought', naira: 150000 });
    const sell = understand('e', 'i sold am for ₦300,000 p2p', 'out');
    expect(sell.label).toEqual({ kind: 'sold', naira: 300000 });
    expect(understand('f', 'my brother borrowed me', 'in').name).toBe('Loan received');
  });

  it('says it is not sure instead of guessing on nonsense', () => {
    const u = understand('g', 'zzzz qqq', 'in');
    expect(u.sure).toBe(false);
    expect(u.label).toBeNull();
  });

  it('extracts naira only when the note is about naira', () => {
    expect(nairaIn('sold for N1.2m')).toBe(1_200_000);
    expect(nairaIn('won 2nd place')).toBeUndefined();
  });
});
