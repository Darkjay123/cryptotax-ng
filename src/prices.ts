/**
 * Historical USD prices from DefiLlama (public, no key). Stablecoins are
 * valued at their peg (Guidelines para 9.1.1(2)); everything else uses the
 * market price at the transaction time. The Guidelines say the NRS will
 * publish approved price sources; until it does, the report names this one.
 */
import { STABLECOINS } from './rules.js';
import type { Movement } from './wallet/types.js';

export type PriceFn = (m: Movement) => number | null;

export async function loadPrices(moves: Movement[], f: typeof fetch = fetch): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const need = new Map<number, Set<string>>(); // hour bucket -> keys
  for (const m of moves) {
    if (STABLECOINS[m.symbol]) continue;
    const hour = Math.floor(m.timestamp / 3600) * 3600;
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
          const r = await f(`https://coins.llama.fi/prices/historical/${hour}/${chunk.map(encodeURIComponent).join(',')}?searchWidth=6h`, { signal: AbortSignal.timeout(20_000) });
          if (!r.ok) continue;
          const j: any = await r.json();
          for (const key of chunk) {
            const p = j.coins?.[key]?.price;
            if (typeof p === 'number' && p > 0) out.set(`${key}@${hour}`, p);
          }
        } catch { /* leave as unpriced */ }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

export function priceFn(table: Map<string, number | null>): PriceFn {
  return (m) => {
    if (STABLECOINS[m.symbol]) return 1;
    return table.get(`${m.priceKey}@${Math.floor(m.timestamp / 3600) * 3600}`) ?? null;
  };
}
