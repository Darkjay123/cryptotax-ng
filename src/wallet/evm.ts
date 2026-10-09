/**
 * EVM wallet history from public Blockscout explorers (no key).
 * Covers ERC-20 transfers and native coin transfers.
 */
import { ChainId, FetchOptions, Movement, isoDate } from './types.js';

export const EVM_CHAINS: Record<Exclude<ChainId, 'tron'>, { api: string; native: string; nativeKey: string; llama: string }> = {
  ethereum: { api: 'https://eth.blockscout.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'ethereum' },
  optimism: { api: 'https://explorer.optimism.io/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'optimism' },
  gnosis: { api: 'https://gnosis.blockscout.com/api/v2', native: 'XDAI', nativeKey: 'coingecko:xdai', llama: 'xdai' },
};

export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

async function getJson(url: string, f: typeof fetch, timeoutMs = 25_000): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`explorer ${r.status}`);
    return r.json();
  }
  throw new Error('explorer rate limit');
}

const tsOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const inRange = (ts: number, o: FetchOptions) => (!o.from || ts >= o.from) && (!o.to || ts <= o.to);

async function pages(base: string, path: string, o: FetchOptions, each: (item: any) => void, timeoutMs?: number) {
  const f = o.fetchImpl ?? fetch;
  let params = '';
  const max = o.maxPages ?? 40;
  for (let p = 0; p < max; p++) {
    const j = await getJson(`${base}${path}${params}`, f, timeoutMs);
    let older = false;
    for (const it of j.items ?? []) {
      const ts = tsOf(it.timestamp);
      if (o.from && ts < o.from) { older = true; continue; } // newest first: stop once we pass the start
      each(it);
    }
    if (older || !j.next_page_params) break;
    if (p === max - 1) { o.onTruncated?.(path.split('?')[0].split('/').pop() ?? 'history'); break; }
    const q = new URLSearchParams(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)]));
    params = (path.includes('?') ? '&' : '?') + q.toString();
  }
}

export async function fetchEvm(chain: Exclude<ChainId, 'tron'>, wallet: string, o: FetchOptions = {}): Promise<Movement[]> {
  const c = EVM_CHAINS[chain];
  const me = wallet.toLowerCase();
  const out: Movement[] = [];

  await pages(c.api, `/addresses/${wallet}/token-transfers?type=ERC-20`, o, it => {
    const ts = tsOf(it.timestamp);
    if (!inRange(ts, o)) return;
    const from = String(it.from?.hash ?? '').toLowerCase(), to = String(it.to?.hash ?? '').toLowerCase();
    const dir = to === me ? 'in' : from === me ? 'out' : null;
    if (!dir || from === to) return;
    const dec = Number(it.total?.decimals ?? it.token?.decimals ?? 18);
    const units = Number(it.total?.value ?? 0) / 10 ** dec;
    if (!(units > 0)) return;
    const addr = String(it.token?.address_hash ?? it.token?.address ?? '').toLowerCase();
    out.push({
      chain, hash: it.transaction_hash ?? it.tx_hash, timestamp: ts, date: isoDate(ts), wallet: me,
      direction: dir, counterparty: dir === 'in' ? from : to,
      symbol: String(it.token?.symbol ?? '?').toUpperCase(), token: addr, decimals: dec, units,
      priceKey: `${c.llama}:${addr}`,
    });
  });

  await pages(c.api, `/addresses/${wallet}/transactions`, o, it => {
    const ts = tsOf(it.timestamp);
    if (!inRange(ts, o) || it.status === 'error') return;
    const v = Number(it.value ?? 0) / 1e18;
    if (!(v > 0)) return;
    const from = String(it.from?.hash ?? '').toLowerCase(), to = String(it.to?.hash ?? '').toLowerCase();
    const dir = to === me ? 'in' : from === me ? 'out' : null;
    if (!dir || from === to) return;
    out.push({
      chain, hash: it.hash, timestamp: ts, date: isoDate(ts), wallet: me, direction: dir,
      counterparty: dir === 'in' ? from : to, symbol: c.native, token: null, decimals: 18, units: v,
      priceKey: c.nativeKey,
    });
  });

  // Native coin sent by contracts (bridges, exchanges' hot wallets, DEX refunds, withdrawals) shows up
  // only as an internal transaction. Without these, coins look like they arrived from nowhere.
  const seen = new Set(out.filter(m => m.token === null).map(m => `${m.hash}:${m.direction}`));
  await pages(c.api, `/addresses/${wallet}/internal-transactions`, { ...o, maxPages: Math.min(o.maxPages ?? 40, 20) }, it => {
    const ts = tsOf(it.timestamp);
    if (!inRange(ts, o) || it.success === false || it.error) return;
    const v = Number(it.value ?? 0) / 1e18;
    if (!(v > 0)) return;
    const from = String(it.from?.hash ?? '').toLowerCase(), to = String(it.to?.hash ?? '').toLowerCase();
    const dir = to === me ? 'in' : from === me ? 'out' : null;
    if (!dir || from === to) return;
    const hash = it.transaction_hash;
    if (seen.has(`${hash}:${dir}`)) return;
    out.push({
      chain, hash, timestamp: ts, date: isoDate(ts), wallet: me, direction: dir,
      counterparty: dir === 'in' ? from : to, symbol: c.native, token: null, decimals: 18, units: v,
      priceKey: c.nativeKey,
    });
  }, 100_000).catch(() => o.onTruncated?.('internal-transactions (contract payouts, could not be read)'));

  return out.sort((a, b) => a.timestamp - b.timestamp);
}
