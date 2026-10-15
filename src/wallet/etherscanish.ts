/**
 * EVM wallet history from keyless Etherscan-compatible APIs (Routescan's free API for now).
 * Covers chains with no Blockscout instance, same Movement shape as the Blockscout reader.
 */
import { ChainId, FetchOptions, Movement, isoDate } from './types.js';

export interface EsChain { api: string; native: string; nativeKey: string; llama: string; chainid?: string }

export const ES_CHAINS: Record<'avalanche' | 'metis', EsChain> = {
  avalanche: { api: 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api', native: 'AVAX', nativeKey: 'coingecko:avalanche-2', llama: 'avalanche' },
  metis:     { api: 'https://api.routescan.io/v2/network/mainnet/evm/1088/etherscan/api', native: 'METIS', nativeKey: 'coingecko:metis-token', llama: 'metis' },
};

type EsChainId = keyof typeof ES_CHAINS;

const ES_HEADERS = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };

async function esGet(api: string, params: URLSearchParams, f: typeof fetch): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await f(`${api}?${params}`, { headers: ES_HEADERS, signal: AbortSignal.timeout(25_000) });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`api ${r.status}`);
    return r.json();
  }
  throw new Error('api rate limit');
}

/** Etherscan-style result: list of rows, [] when none found, throw on a real error message. */
const rowsOf = (j: any): any[] => {
  if (Array.isArray(j?.result)) return j.result;
  const msg = String(j?.result ?? j?.message ?? '');
  if (/no transactions/i.test(msg)) return [];
  throw new Error(msg || 'api error');
};

async function esPages(chain: EsChainId, action: string, wallet: string, o: FetchOptions, each: (item: any) => void) {
  const f = o.fetchImpl ?? fetch;
  const c = ES_CHAINS[chain];
  const max = o.maxPages ?? 40;
  for (let p = 1; p <= max; p++) {
    const params = new URLSearchParams({ module: 'account', action, address: wallet, page: String(p), offset: '100', sort: 'desc' });
    if (c.chainid) params.set('chainid', c.chainid);
    const items = rowsOf(await esGet(c.api, params, f));
    if (!items.length) break;
    let older = false;
    for (const it of items) {
      const ts = Number(it.timeStamp);
      if (o.from && ts < o.from) { older = true; continue; }
      each(it);
    }
    if (older || items.length < 100) break;
    if (p === max) o.onTruncated?.(action);
  }
}

export async function fetchEs(chain: EsChainId, wallet: string, o: FetchOptions = {}): Promise<Movement[]> {
  const c = ES_CHAINS[chain];
  const f = o.fetchImpl ?? fetch;
  void f;
  const me = wallet.toLowerCase();
  const out: Movement[] = [];
  const base = { chain: chain as ChainId, wallet: me };

  await esPages(chain, 'tokentx', wallet, o, it => {
    const ts = Number(it.timeStamp);
    if (o.to && ts > o.to) return;
    const from = String(it.from ?? '').toLowerCase(), to = String(it.to ?? '').toLowerCase();
    const dir = to === me ? 'in' : from === me ? 'out' : null;
    if (!dir || from === to) return;
    const dec = Number(it.tokenDecimal);
    if (!(dec > 0)) return; // ERC-721 rows carry no decimals
    const units = Number(it.value ?? 0) / 10 ** dec;
    if (!(units > 0)) return;
    const addr = String(it.contractAddress ?? '').toLowerCase();
    out.push({ ...base, hash: String(it.hash), timestamp: ts, date: isoDate(ts), direction: dir,
      counterparty: dir === 'in' ? from : to,
      symbol: String(it.tokenSymbol ?? '?').toUpperCase(), token: addr, decimals: dec, units,
      priceKey: `${c.llama}:${addr}` });
  });

  await esPages(chain, 'txlist', wallet, o, it => {
    if (String(it.isError ?? '0') === '1') return;
    const ts = Number(it.timeStamp);
    if (o.to && ts > o.to) return;
    const v = Number(it.value ?? 0) / 1e18;
    if (!(v > 0)) return;
    const from = String(it.from ?? '').toLowerCase(), to = String(it.to ?? '').toLowerCase();
    const dir = to === me ? 'in' : from === me ? 'out' : null;
    if (!dir || from === to) return;
    out.push({ ...base, hash: String(it.hash), timestamp: ts, date: isoDate(ts), direction: dir,
      counterparty: dir === 'in' ? from : to, symbol: c.native, token: null, decimals: 18, units: v,
      priceKey: c.nativeKey });
  });

  // Native coin sent by contracts (bridges, exchange withdrawals) shows up only as an internal transaction.
  const seen = new Set(out.filter(m => m.token === null).map(m => `${m.hash}:${m.direction}`));
  await esPages(chain, 'txlistinternal', wallet, o, it => {
    if (String(it.isError ?? '0') === '1') return;
    const ts = Number(it.timeStamp);
    if (o.to && ts > o.to) return;
    const v = Number(it.value ?? 0) / 1e18;
    if (!(v > 0)) return;
    const from = String(it.from ?? '').toLowerCase(), to = String(it.to ?? '').toLowerCase();
    const dir = to === me ? 'in' : from === me ? 'out' : null;
    if (!dir || from === to) return;
    const hash = String(it.hash);
    if (seen.has(`${hash}:${dir}`)) return;
    out.push({ ...base, hash, timestamp: ts, date: isoDate(ts), direction: dir,
      counterparty: dir === 'in' ? from : to, symbol: c.native, token: null, decimals: 18, units: v,
      priceKey: c.nativeKey });
  });

  return out;
}
