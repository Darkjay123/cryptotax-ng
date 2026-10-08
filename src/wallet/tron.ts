/**
 * Tron wallet history from TronGrid (public, no key). Covers TRC-20 tokens
 * (USDT-TRC20 is the main P2P rail in Nigeria) and plain TRX transfers.
 */
import { createHash } from 'node:crypto';
import { FetchOptions, Movement, isoDate } from './types.js';

const API = 'https://api.trongrid.io';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function isTronAddress(a: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
}

/** 41-prefixed hex address -> base58check "T..." address. */
export function tronHexToBase58(hex: string): string {
  const h = hex.toLowerCase().replace(/^0x/, '');
  const body = Buffer.from(h.startsWith('41') ? h : '41' + h.slice(-40), 'hex');
  const sum = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([body, sum]);
  let n = BigInt('0x' + bytes.toString('hex'));
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

async function getJson(url: string, f: typeof fetch): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1200 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`TronGrid ${r.status}`);
    return r.json();
  }
  throw new Error('TronGrid rate limit');
}

function range(o: FetchOptions): string {
  let q = '&only_confirmed=true&limit=200&order_by=block_timestamp,asc';
  if (o.from) q += `&min_timestamp=${o.from * 1000}`;
  if (o.to) q += `&max_timestamp=${o.to * 1000 + 999}`;
  return q;
}

export async function fetchTron(wallet: string, o: FetchOptions = {}): Promise<Movement[]> {
  const f = o.fetchImpl ?? fetch;
  const maxPages = o.maxPages ?? 12;
  const out: Movement[] = [];

  // TRC-20 transfers
  let url: string | undefined = `${API}/v1/accounts/${wallet}/transactions/trc20?${range(o).slice(1)}`;
  for (let p = 0; url && p < maxPages; p++) {
    const j = await getJson(url, f);
    for (const t of j.data ?? []) {
      if (t.type !== 'Transfer') continue;
      const dec = Number(t.token_info?.decimals ?? 0);
      const units = Number(t.value) / 10 ** dec;
      if (!(units > 0)) continue;
      const dir = t.to === wallet ? 'in' : t.from === wallet ? 'out' : null;
      if (!dir || t.from === t.to) continue;
      const ts = Math.floor(t.block_timestamp / 1000);
      out.push({
        chain: 'tron', hash: t.transaction_id, timestamp: ts, date: isoDate(ts), wallet, direction: dir,
        counterparty: dir === 'in' ? t.from : t.to,
        symbol: String(t.token_info?.symbol ?? '?').toUpperCase(), token: t.token_info?.address ?? null,
        decimals: dec, units, priceKey: `tron:${t.token_info?.address}`,
      });
    }
    url = j.meta?.links?.next;
  }

  // Plain TRX transfers
  url = `${API}/v1/accounts/${wallet}/transactions?${range(o).slice(1)}`;
  for (let p = 0; url && p < maxPages; p++) {
    const j = await getJson(url, f);
    for (const t of j.data ?? []) {
      if (t.ret?.[0]?.contractRet && t.ret[0].contractRet !== 'SUCCESS') continue;
      const c = t.raw_data?.contract?.[0];
      if (c?.type !== 'TransferContract') continue;
      const v = c.parameter?.value ?? {};
      const from = tronHexToBase58(v.owner_address), to = tronHexToBase58(v.to_address);
      const dir = to === wallet ? 'in' : from === wallet ? 'out' : null;
      if (!dir || from === to) continue;
      const units = Number(v.amount) / 1e6;
      if (!(units > 0)) continue;
      const ts = Math.floor(t.block_timestamp / 1000);
      out.push({
        chain: 'tron', hash: t.txID, timestamp: ts, date: isoDate(ts), wallet, direction: dir,
        counterparty: dir === 'in' ? from : to, symbol: 'TRX', token: null, decimals: 6, units,
        priceKey: 'coingecko:tron',
      });
    }
    url = j.meta?.links?.next;
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
