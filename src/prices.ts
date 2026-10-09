/**
 * Historical USD prices from DefiLlama (public, no key). Stablecoins are
 * valued at their peg (Guidelines para 9.1.1(2)); everything else uses the
 * market price at the transaction time. The Guidelines say the NRS will
 * publish approved price sources; until it does, the report names this one.
 */
import { STABLECOINS } from './rules.js';
import { looksSpam } from './classify.js';

// One price per token per day (the Guidelines value assets on the transaction date). Daily buckets keep
// a 1,500-transaction wallet to a few hundred price requests instead of thousands.
const DAY = 86_400;
const bucket = (ts: number) => Math.floor(ts / DAY) * DAY + DAY / 2; // noon UTC

async function fetchRetry(url: string, f: typeof fetch): Promise<Response | null> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await f(url, { signal: AbortSignal.timeout(25_000) });
      if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 1200 * (i + 1))); continue; }
      return r;
    } catch { await new Promise(res => setTimeout(res, 800 * (i + 1))); }
  }
  return null;
}
import type { Movement } from './wallet/types.js';

export type PriceFn = (m: Movement) => number | null;

export async function loadPrices(moves: Movement[], f: typeof fetch = fetch): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const need = new Map<number, Set<string>>(); // hour bucket -> keys
  for (const m of moves) {
    if (STABLECOINS[m.symbol] || looksSpam(m.symbol)) continue;
    const hour = bucket(m.timestamp);
    const k = `${m.priceKey}@${hour}`;
    if (out.has(k)) continue;
    out.set(k, null);
    if (!need.has(hour)) need.set(hour, new Set());
    need.get(hour)!.add(m.priceKey);
  }
  const jobs = [...need.entries()];
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const [hour, keys] = jobs[i++];
      const list = [...keys];
      for (let s = 0; s < list.length; s += 40) {
        const chunk = list.slice(s, s + 40);
        try {
          const r = await fetchRetry(`https://coins.llama.fi/prices/historical/${hour}/${chunk.map(encodeURIComponent).join(',')}?searchWidth=12h`, f);
          if (!r || !r.ok) continue;
          const j: any = await r.json();
          for (const key of chunk) {
            const p = j.coins?.[key]?.price;
            if (typeof p === 'number' && p > 0) out.set(`${key}@${hour}`, p);
          }
        } catch { /* leave as unpriced */ }
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  return out;
}

export function priceFn(table: Map<string, number | null>): PriceFn {
  return (m) => {
    if (STABLECOINS[m.symbol]) return 1;
    return table.get(`${m.priceKey}@${bucket(m.timestamp)}`) ?? null;
  };
}
