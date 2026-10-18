/**
 * EVM wallet history from Ankr's Advanced API (needs ANKR_API_KEY in the
 * environment; Ankr's free plan). Covers chains with no keyless explorer we
 * can reach: BSC and Fantom. (Ankr's Advanced API dropped opBNB and Sonic:
 * their docs list the supported aliases and neither name is allowed any more,
 * confirmed live 18 Oct 2026 with "invalid blockchain name" errors.) Ankr
 * quirks learned on RugRadar
 * (live-verified on BSC): address and blockchain are ARRAYS and the sort key
 * is "descOrder" (a boolean flag, not a "sort" value) and the cursor
 * is "pageToken" (response "nextPageToken"). Sending a "sort" value is
 * silently ignored and pages come back oldest-first, which we hit live on
 * 18 Oct 2026: long BSC wallets read the oldest 2,000 records and showed
 * zero rows for 2026.
 */
import { ChainId, FetchOptions, Movement, isoDate } from './types.js';

export interface AnkrChain { slug: string; native: string; nativeKey: string; llama: string }

export const ANKR_CHAINS: Record<'bsc' | 'fantom', AnkrChain> = {
  bsc:    { slug: 'bsc',    native: 'BNB', nativeKey: 'coingecko:binancecoin', llama: 'bsc' },
  fantom: { slug: 'fantom', native: 'FTM', nativeKey: 'coingecko:fantom',      llama: 'fantom' },
};

export type AnkrChainId = keyof typeof ANKR_CHAINS;

export const ankrKey = (): string => (process.env.ANKR_API_KEY ?? '').trim();

const API = 'https://rpc.ankr.com/multichain';
const HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

async function ankrPost(key: string, params: unknown, f: typeof fetch): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await f(API, {
      method: 'POST',
      headers: { ...HEADERS, 'x-api-key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ankr_getTransactionsByAddress', params }),
      signal: AbortSignal.timeout(25_000),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`api ${r.status}`);
    const j = await r.json();
    if (j?.error) throw new Error(String(j.error.message ?? j.error).slice(0, 200));
    return j?.result ?? j;
  }
  throw new Error('api rate limit');
}

const tsOf = (v: any): number => {
  const raw = String(v ?? '').trim();
  const n = typeof v === 'number' ? v : /^0x[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw) / 1000;
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1e14) return Math.floor(n / 1e9); // nanoseconds
  if (n > 1e11) return Math.floor(n / 1e3); // milliseconds
  return Math.floor(n);
};

export async function fetchAnkr(chain: AnkrChainId, wallet: string, o: FetchOptions = {}): Promise<Movement[]> {
  const key = ankrKey();
  if (!key) throw new Error('this chain is read through Ankr, which needs an ANKR_API_KEY that is not configured');
  const c = ANKR_CHAINS[chain];
  const f = o.fetchImpl ?? fetch;
  const me = wallet.toLowerCase();
  const out: Movement[] = [];
  const seenNative = new Set<string>();
  let cursor: string | undefined;
  let prev: string | undefined;
  let skippedUnknown = 0;
  let hitCap = false;
  const max = o.maxPages ?? 40;
  for (let p = 1; p <= max; p++) {
    const params: any = {
      address: [wallet],
      blockchain: [c.slug],
      descOrder: true,
      pageSize: 1000,
      fromBlock: 0,
      toBlock: 'latest',
    };
    if (o.from) params.fromDate = isoDate(o.from);
    if (o.to) params.toDate = isoDate(o.to);
    if (cursor) params.pageToken = cursor;
    const j = await ankrPost(key, params, f);
    const txs: any[] = Array.isArray(j?.transactions) ? j.transactions : [];
    for (const it of txs) {
      if (String(it.blockchain ?? '').toLowerCase() !== c.slug.toLowerCase()) continue;
      const ts = tsOf(it.timestamp ?? it.blockTimestamp);
      if (!ts || (o.from && ts < o.from) || (o.to && ts > o.to)) continue;
      const from = String(it.from ?? '').toLowerCase(), to = String(it.to ?? '').toLowerCase();
      if (!from || !to) continue;
      const dir: 'in' | 'out' | null = to === me ? 'in' : from === me ? 'out' : null;
      if (!dir || from === to) continue;
      const hash = String(it.transactionHash ?? it.transaction_hash ?? it.hash ?? '');
      if (!hash) continue;
      let token: string | null = null;
      let decimals = 18;
      const contract = String(it.contractAddress ?? it.contract_address ?? '').toLowerCase();
      if (contract) {
        const d = Number(it.decimals ?? it.valueDecimals);
        if (!Number.isInteger(d) || d < 0) { skippedUnknown++; continue; }
        token = contract;
        decimals = d;
      }
      const units = Number(it.value ?? 0) / 10 ** decimals;
      if (!(units > 0)) continue;
      if (!token) {
        const k = `${hash}:${dir}`;
        if (seenNative.has(k)) continue;
        seenNative.add(k);
      }
      out.push({
        chain: chain as ChainId, hash, timestamp: ts, date: isoDate(ts), wallet: me,
        direction: dir, counterparty: dir === 'in' ? from : to,
        symbol: token ? String(it.symbol ?? '?').toUpperCase() : c.native,
        token, decimals, units,
        priceKey: token ? `${c.llama}:${token}` : c.nativeKey,
      });
    }
    prev = cursor;
    cursor = j?.nextPageToken ?? j?.next_page_token;
    if (!cursor || cursor === prev || txs.length === 0) break;
    if (p === max) hitCap = true;
  }
  if (hitCap || cursor) o.onTruncated?.('history (the wallet is very long; only the most recent pages were read)');
  if (skippedUnknown) o.onTruncated?.('records with unknown token precision were skipped');
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
