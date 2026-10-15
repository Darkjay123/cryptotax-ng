/**
 * Official CBN naira-per-dollar rates (central rate), from the CBN's public
 * exchange-rate feed. The Guidelines require the CBN/NAFEM rate on each
 * transaction date; on weekends and holidays we use the last published rate
 * before that date and say so.
 */
const CBN_URL = 'https://www.cbn.gov.ng/api/GetAllExchangeRates';

export interface RateTable { dates: string[]; rates: Map<string, number>; fetchedAt: number; fallback?: boolean }

import { FALLBACK_RATE_SNAPSHOT_AT, FALLBACK_RATES } from './rates-fallback.js';

let cache: RateTable | null = null;
const TTL = 6 * 3600_000;

/** Test hook: forget the cached rate table. */
export function clearRateCacheForTests(): void { cache = null; }

export function buildRateTable(rows: Array<{ currency: string; ratedate: string; centralrate: string }>): RateTable {
  const rates = new Map<string, number>();
  for (const r of rows) {
    if (!/US\s*DOLLAR/i.test(r.currency)) continue;
    const v = Number(r.centralrate);
    if (v > 0) rates.set(String(r.ratedate).slice(0, 10), v);
  }
  return { dates: [...rates.keys()].sort(), rates, fetchedAt: Date.now() };
}

export async function loadRates(f: typeof fetch = fetch): Promise<RateTable> {
  if (cache && Date.now() - cache.fetchedAt < TTL) return cache;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await f(CBN_URL, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`CBN rates ${r.status}`);
      const t = buildRateTable(await r.json());
      if (!t.dates.length) throw new Error('CBN rates feed had no US dollar rows');
      cache = t;
      return cache;
    } catch { if (i === 1) break; await new Promise((res) => setTimeout(res, 800)); }
  }
  // The live feed could not be reached. A bundled snapshot of the same official
  // CBN central rates keeps the report working; the report says so.
  const rates = new Map<string, number>();
  for (const [d, v] of Object.entries(FALLBACK_RATES)) { const n = Number(v); if (n > 0) rates.set(d, n); }
  cache = { dates: [...rates.keys()].sort(), rates, fetchedAt: Date.now(), fallback: true };
  return cache;
}

/** Rate on `date`, or the last published rate before it. */
export function rateOn(t: RateTable, date: string): { rate: number; rateDate: string } {
  const exact = t.rates.get(date);
  if (exact) return { rate: exact, rateDate: date };
  let lo = 0, hi = t.dates.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.dates[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) throw new Error(`no CBN rate on or before ${date}`);
  const d = t.dates[best];
  return { rate: t.rates.get(d)!, rateDate: d };
}
