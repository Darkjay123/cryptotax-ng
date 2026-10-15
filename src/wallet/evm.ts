/**
 * EVM wallet history from public Blockscout explorers (no key).
 * Covers ERC-20 transfers, native coin transfers, and contract payouts (internal transactions).
 * One request gates each chain: only chains where the address actually has activity are read deeply.
 */
import { ChainId, FetchOptions, Movement, isoDate } from './types.js';

type EvmChainId = Exclude<ChainId, 'tron' | 'bitcoin'>;

export const EVM_CHAINS: Record<EvmChainId, { api: string; native: string; nativeKey: string; llama: string }> = {
  ethereum:         { api: 'https://eth.blockscout.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'ethereum' },
  optimism:         { api: 'https://explorer.optimism.io/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'optimism' },
  gnosis:           { api: 'https://gnosis.blockscout.com/api/v2', native: 'XDAI', nativeKey: 'coingecko:xdai', llama: 'xdai' },
  base:             { api: 'https://base.blockscout.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'base' },
  arbitrum:         { api: 'https://arbitrum.blockscout.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'arbitrum' },
  arbitrum_nova:    { api: 'https://arbitrum-nova.blockscout.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'arbitrum_nova' },
  polygon:          { api: 'https://polygon.blockscout.com/api/v2', native: 'POL', nativeKey: 'coingecko:polygon-ecosystem-token', llama: 'polygon' },
  ethereum_classic: { api: 'https://etc.blockscout.com/api/v2', native: 'ETC', nativeKey: 'coingecko:ethereum-classic', llama: 'ethereum_classic' },
  celo:             { api: 'https://celo.blockscout.com/api/v2', native: 'CELO', nativeKey: 'coingecko:celo', llama: 'celo' },
  zksync:           { api: 'https://zksync.blockscout.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'zksync' },
  scroll:           { api: 'https://scrollscan.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'scroll' },
  lisk:             { api: 'https://blockscout.lisk.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'lisk' },
  mode:             { api: 'https://explorer.mode.network/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'mode' },
  ink:              { api: 'https://explorer.inkonchain.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'ink' },
  unichain:         { api: 'https://unichain.blockscout.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'unichain' },
  soneium:          { api: 'https://soneium.blockscout.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'soneium' },
  worldchain:       { api: 'https://worldchain-mainnet.explorer.alchemy.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'worldchain' },
  shape:            { api: 'https://shapescan.xyz/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'shape' },
  immutable:        { api: 'https://explorer.immutable.com/api/v2', native: 'IMX', nativeKey: 'coingecko:immutable-x', llama: 'immutable_zkevm' },
  ronin:            { api: 'https://explorer.roninchain.com/api/v2', native: 'RON', nativeKey: 'coingecko:ronin', llama: 'ronin' },
  filecoin:         { api: 'https://filecoin.blockscout.com/api/v2', native: 'FIL', nativeKey: 'coingecko:filecoin', llama: 'filecoin' },
  rootstock:        { api: 'https://rootstock.blockscout.com/api/v2', native: 'RBTC', nativeKey: 'coingecko:bitcoin', llama: 'rootstock' },
  flow:             { api: 'https://evm.flow.com/api/v2', native: 'FLOW', nativeKey: 'coingecko:flow', llama: 'flow' },
  iotaevm:          { api: 'https://explorer.evm.iota.org/api/v2', native: 'IOTA', nativeKey: 'coingecko:iota', llama: 'iotaevm' },
  etherlink:        { api: 'https://explorer.etherlink.com/api/v2', native: 'XTZ', nativeKey: 'coingecko:tezos', llama: 'etherlink' },
  zetachain:        { api: 'https://zetascan.com/api/v2', native: 'ZETA', nativeKey: 'coingecko:zetachain', llama: 'zetachain' },
  astar:            { api: 'https://astar.blockscout.com/api/v2', native: 'ASTR', nativeKey: 'coingecko:astar', llama: 'astar' },
  megaeth:          { api: 'https://megaeth.blockscout.com/api/v2', native: 'ETH', nativeKey: 'coingecko:ethereum', llama: 'megaeth' },
  plume:            { api: 'https://explorer.plume.org/api/v2', native: 'PLUME', nativeKey: 'coingecko:plume', llama: 'plume' },
};

export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

// Full browser headers: some Blockscout instances (Base, Arbitrum, Polygon) front their API
// with a bot wall that 403s a bare client but answers a browser-shaped request.
const BROWSER_HEADERS = (url: string): Record<string, string> => ({
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  referer: `${new URL(url).origin}/`,
});

async function getJson(url: string, f: typeof fetch, timeoutMs = 25_000): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await f(url, { headers: BROWSER_HEADERS(url), signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1500 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`explorer ${r.status}`);
    return r.json();
  }
  throw new Error('explorer rate limit');
}

/** One cheap request per chain: skip chains the address has never touched. */
export async function evmHasActivity(chain: EvmChainId, wallet: string, f: typeof fetch): Promise<boolean> {
  const j = await getJson(`${EVM_CHAINS[chain].api}/addresses/${wallet}`, f);
  // Missing flags on older instances are treated as activity (fail open) so no data is skipped.
  if (j.has_token_transfers === false && j.has_transactions === false && j.has_internal_transactions === false) return false;
  return true;
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

export async function fetchEvm(chain: EvmChainId, wallet: string, o: FetchOptions = {}): Promise<Movement[]> {
  const c = EVM_CHAINS[chain];
  const f = o.fetchImpl ?? fetch;
  if (!(await evmHasActivity(chain, wallet, f))) return [];
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
