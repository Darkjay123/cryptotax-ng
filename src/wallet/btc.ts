/**
 * Bitcoin wallet history from mempool.space (no key, public data).
 * Bitcoin has no contracts: a transaction's effect on the wallet is
 *   received - spent (in satoshis). Positive => acquisition, negative => disposal
 *   (the change returned to the wallet is netted out; the network fee is part of the spend).
 */
import { FetchOptions, Movement, isoDate } from './types.js';

export const isBtcAddress = (a: string) =>
  /^(1|3)[1-9A-HJ-NP-Za-km-z]{25,39}$/.test(a) || /^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{11,71}$/.test(a);

const API = 'https://mempool.space/api';
const PAGE = 25;

export async function fetchBtc(wallet: string, o: FetchOptions = {}): Promise<Movement[]> {
  const f = o.fetchImpl ?? fetch;
  const out: Movement[] = [];
  const max = o.maxPages ?? 80;
  let cursor = ''; // '' = newest page

  for (let p = 0; p < max; p++) {
    const url = cursor ? `${API}/address/${wallet}/txs/chain/${cursor}` : `${API}/address/${wallet}/txs/chain`;
    const r = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(25_000) });
    if (!r.ok) throw new Error(`mempool.space ${r.status}`);
    const txs: any[] = await r.json();
    if (!txs.length) break;

    let passedStart = false;
    for (const tx of txs) {
      const ts = Number(tx?.status?.block_time ?? 0);
      if (!ts) continue; // unconfirmed: not on the ledger yet
      if (o.from && ts < o.from) { passedStart = true; continue; }
      if (o.to && ts > o.to) continue;
      const vinFromUser = (tx.vin ?? []).reduce((s: number, v: any) =>
        s + (v?.prevout?.scriptpubkey_address === wallet ? Number(v.prevout.value) : 0), 0);
      const voutToUser = (tx.vout ?? []).reduce((s: number, v: any) =>
        s + (v?.scriptpubkey_address === wallet ? Number(v.value) : 0), 0);
      const diff = voutToUser - vinFromUser;
      if (diff === 0) continue; // pure self-transfer
      const dir = diff > 0 ? 'in' as const : 'out' as const;
      const others = dir === 'in'
        ? (tx.vin ?? []).map((v: any) => v?.prevout?.scriptpubkey_address).filter((a: string | undefined) => a && a !== wallet)
        : (tx.vout ?? []).map((v: any) => v.scriptpubkey_address).filter((a: string) => a && a !== wallet);
      if (dir === 'out' && others.length === 0) continue; // every output came back to the wallet: only the network fee left, a self-transfer, not a sale
      out.push({
        chain: 'bitcoin', hash: tx.txid, timestamp: ts, date: isoDate(ts), wallet,
        direction: dir, counterparty: others[0] ?? 'multiple',
        symbol: 'BTC', token: null, decimals: 8, units: Math.abs(diff) / 1e8,
        priceKey: 'coingecko:bitcoin',
      });
    }
    if (passedStart) break;
    if (txs.length < PAGE) break;
    cursor = txs[txs.length - 1].txid; // newest-first: page into older history
    if (p === max - 1) o.onTruncated?.('bitcoin history');
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
