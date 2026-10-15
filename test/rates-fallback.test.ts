/** The report must survive a CBN feed outage on the bundled snapshot, and say it did. */
import { afterAll, describe, expect, it } from 'vitest';
import { clearRateCacheForTests, loadRates, rateOn } from '../src/rates.js';

const failing = (async () => { throw new Error('network down'); }) as typeof fetch;

describe('CBN rate fallback', () => {
  afterAll(() => clearRateCacheForTests());

  it('falls back to the bundled snapshot when the feed is unreachable', async () => {
    clearRateCacheForTests();
    const t = await loadRates(failing);
    expect(t.fallback).toBe(true);
    expect(t.dates.length).toBeGreaterThan(1000);
    const { rate, rateDate } = rateOn(t, '2026-06-15');
    expect(rate).toBeGreaterThan(500);
    expect(rateDate).toBe('2026-06-15');
  });

  it('covers older cost-base dates too', async () => {
    clearRateCacheForTests();
    const t = await loadRates(failing);
    const { rate } = rateOn(t, '2021-06-15');
    expect(rate).toBeGreaterThan(300);
  });

  it('clears back to a live fetch', async () => {
    clearRateCacheForTests();
    const ok = (async () => new Response(JSON.stringify([
      { currency: 'US DOLLAR', ratedate: '2026-06-15', centralrate: '1600.00' },
    ]), { status: 200 })) as unknown as typeof fetch;
    const t = await loadRates(ok);
    expect(t.fallback).toBeFalsy();
    expect(rateOn(t, '2026-06-15').rate).toBe(1600);
    clearRateCacheForTests();
  });
});
