/**
 * Reads Binance exports into tax events.
 *
 * 1. Transaction History ("Export Transaction Records"):
 *    User_ID, UTC_Time, Account, Operation, Coin, Change, Remark
 * 2. P2P (C2C) Order History: Order Number, Order Type, Asset Type, Fiat Type,
 *    Total Price, Price, Quantity, Exchange rate, Maker Fee, Taker Fee, Couterparty, Status, Created Time
 *
 * P2P orders carry the naira actually paid or received, so when that file is
 * given its orders are used and the matching "P2P Trading" lines in the main
 * statement are skipped (they are the same coins moving, counted once).
 */
import type { IncomeKind, TaxEvent } from '../engine.js';
import { STABLECOINS } from '../rules.js';
import type { Movement } from '../wallet/types.js';
import type { PriceFn } from '../prices.js';
import { num, parseCsv } from './csv.js';

export interface ExchangeItem {
  id: string; date: string; source: 'Binance'; kind: ExKind;
  text: string;          // plain-English description
  review?: string;       // why it needs the user, if it does
}
export type ExKind = 'trade' | 'p2p_buy' | 'p2p_sell' | 'deposit' | 'withdraw' | 'reward' | 'pay_in' | 'pay_out' | 'fee' | 'internal' | 'unknown';

export interface Transfer { date: string; ts: number; symbol: string; units: number }

export interface ExchangeImport {
  events: TaxEvent[];
  items: ExchangeItem[];
  withdrawals: Transfer[];  // left Binance (may arrive in the user's wallet)
  deposits: Transfer[];     // arrived on Binance (may have left the user's wallet)
  notes: string[];
  files: { name: string; kind: 'binance_transactions' | 'binance_p2p' | 'unknown'; rows: number }[];
}

interface Leg { ts: number; date: string; op: string; coin: string; change: number; account: string; remark: string }
interface P2P { ts: number; date: string; side: 'buy' | 'sell'; asset: string; fiat: string; total: number; qty: number; fee: number; order: string }

const COINGECKO: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', TRX: 'tron', TON: 'the-open-network',
  XRP: 'ripple', DOGE: 'dogecoin', ADA: 'cardano', MATIC: 'matic-network', POL: 'polygon-ecosystem-token',
  DOT: 'polkadot', LTC: 'litecoin', AVAX: 'avalanche-2', LINK: 'chainlink', SHIB: 'shiba-inu', PEPE: 'pepe',
  ARB: 'arbitrum', OP: 'optimism', SUI: 'sui', APT: 'aptos', NOT: 'notcoin', DOGS: 'dogs-2',
  HMSTR: 'hamster-kombat', CATI: 'catizen', BCH: 'bitcoin-cash', ATOM: 'cosmos', NEAR: 'near',
  FET: 'fetch-ai', WLD: 'worldcoin-wld', FLOKI: 'floki', WIF: 'dogwifcoin', BOME: 'book-of-meme',
  TRUMP: 'official-trump', ENA: 'ethena', ETC: 'ethereum-classic', FIL: 'filecoin', XLM: 'stellar',
  UNI: 'uniswap', AAVE: 'aave', INJ: 'injective-protocol', SEI: 'sei-network', TIA: 'celestia',
  BONK: 'bonk', JUP: 'jupiter-exchange-solana', CAKE: 'pancakeswap-token', HBAR: 'hedera-hashgraph',
  ICP: 'internet-computer', ALGO: 'algorand', VET: 'vechain', SAND: 'the-sandbox', MANA: 'decentraland',
  AXS: 'axie-infinity', GALA: 'gala', CHZ: 'chiliz', EOS: 'eos', XTZ: 'tezos', NEO: 'neo', KAS: 'kaspa',
  RENDER: 'render-token', IMX: 'immutable-x', STX: 'blockstack', LDO: 'lido-dao', MKR: 'maker', CRV: 'curve-dao-token',
};
const FIAT = new Set(['NGN', 'USD', 'EUR', 'GBP', 'GHS', 'KES', 'ZAR']);
const isStable = (s: string) => !!STABLECOINS[s];

export const priceKeyFor = (sym: string) => COINGECKO[sym] ? `coingecko:${COINGECKO[sym]}` : null;

/** Pseudo-movements so the shared price loader can value exchange coins by day. */
export function priceNeeds(legs: { ts: number; date: string; coin: string }[]): Movement[] {
  return legs.filter(l => !isStable(l.coin) && !FIAT.has(l.coin) && priceKeyFor(l.coin)).map(l => ({
    chain: 'ethereum', hash: 'binance', timestamp: l.ts, date: l.date, wallet: 'binance', direction: 'in',
    counterparty: 'binance', symbol: l.coin, token: null, decimals: 18, units: 1, priceKey: priceKeyFor(l.coin)!,
  } as Movement));
}

function parseTime(s: string): { ts: number; date: string } | null {
  const m = s.trim().match(/^(\d{2,4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  let y = Number(m[1]); if (y < 100) y += 2000;
  const ts = Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) / 1000;
  if (!Number.isFinite(ts)) return null;
  return { ts, date: new Date(ts * 1000).toISOString().slice(0, 10) };
}

type OpClass = 'trade' | 'p2p' | 'deposit' | 'withdraw' | 'reward' | 'pay' | 'internal' | 'fiat' | 'unknown';
export function classifyOp(op: string): { cls: OpClass; incomeKind?: IncomeKind } {
  const o = op.toLowerCase().trim();
  if (/p2p|c2c/.test(o)) return { cls: 'p2p' };
  if (/^fiat (deposit|withdraw)/.test(o)) return { cls: 'fiat' };
  if (/^(buy|sell|fee|transaction (buy|spend|fee|sold|revenue|related)|binance convert|large otc trading|small assets exchange bnb|auto-invest transaction|convert|trading fee)$/.test(o)) return { cls: 'trade' };
  if (/^(deposit|crypto deposit)$/.test(o)) return { cls: 'deposit' };
  if (/^(withdraw|withdrawal|crypto withdrawal)$/.test(o)) return { cls: 'withdraw' };
  if (/binance pay|^pay$|^send$|^receive$/.test(o)) return { cls: 'pay' };
  if (/subscription|redemption|purchase|transfer between|transfer funds|main and funding|transfer_in|transfer_out|transfer in|transfer out|savings principal|locked|isolated|cross margin|borrow|repay/.test(o) && !/reward|interest/.test(o)) return { cls: 'internal' };
  if (/interest|staking reward|staking rewards|earn.*reward|launchpool|vault reward|mining|eth 2\.0|bnb vault|wbeth/.test(o)) return { cls: 'reward', incomeKind: /mining/.test(o) ? 'mining' : 'staking' };
  if (/distribution|airdrop|megadrop|hodler|token swap/.test(o)) return { cls: 'reward', incomeKind: 'airdrop' };
  if (/cashback|commission|referral|kickback|rebate|bonus|voucher|reward/.test(o)) return { cls: 'reward', incomeKind: 'other' };
  return { cls: 'unknown' };
}

export function detect(text: string): 'binance_transactions' | 'binance_p2p' | 'unknown' {
  const head = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].toLowerCase();
  if (/utc_time/.test(head) && /operation/.test(head) && /change/.test(head)) return 'binance_transactions';
  if (/order number/.test(head) && /(asset type|asset)/.test(head) && /fiat/.test(head) && /total price/.test(head)) return 'binance_p2p';
  return 'unknown';
}

export function readBinanceFiles(files: { name: string; text: string }[]): { legs: Leg[]; p2p: P2P[]; files: ExchangeImport['files']; notes: string[] } {
  const legs: Leg[] = [], p2p: P2P[] = [], out: ExchangeImport['files'] = [], notes: string[] = [];
  for (const f of files) {
    if (f.text.startsWith('PK')) { out.push({ name: f.name, kind: 'unknown', rows: 0 }); notes.push(`${f.name} is a spreadsheet or zip file. Open it and save it as CSV, then upload again.`); continue; }
    const kind = detect(f.text);
    const rows = kind === 'unknown' ? [] : parseCsv(f.text);
    out.push({ name: f.name, kind, rows: rows.length });
    if (kind === 'unknown') { notes.push(`${f.name} is not a Binance Transaction History or P2P Order History export, so it was not read.`); continue; }
    if (kind === 'binance_transactions') {
      for (const r of rows) {
        const t = parseTime(r.utc_time ?? ''); const ch = num(r.change);
        if (!t || !Number.isFinite(ch) || !r.coin) continue;
        legs.push({ ...t, op: r.operation ?? '', coin: r.coin.toUpperCase(), change: ch, account: r.account ?? '', remark: r.remark ?? '' });
      }
    } else {
      for (const r of rows) {
        const status = (r.status ?? '').toLowerCase();
        if (status && status !== 'completed') continue;
        const t = parseTime(r.created_time ?? r.time ?? '');
        const side = (r.order_type ?? r.type ?? '').toLowerCase();
        const asset = (r.asset_type ?? r.asset ?? '').toUpperCase();
        const qty = num(r.quantity), total = num(r.total_price);
        if (!t || !asset || !Number.isFinite(qty) || !Number.isFinite(total) || !/buy|sell/.test(side)) continue;
        const fee = [num(r.maker_fee), num(r.taker_fee)].filter(Number.isFinite).reduce((s, x) => s + x, 0);
        p2p.push({ ...t, side: side.includes('buy') ? 'buy' : 'sell', asset, fiat: (r.fiat_type ?? r.fiat ?? '').toUpperCase(), total, qty, fee, order: r.order_number ?? '' });
      }
    }
  }
  legs.sort((a, b) => a.ts - b.ts); p2p.sort((a, b) => a.ts - b.ts);
  return { legs, p2p, files: out, notes };
}

const fmt = (n: number) => Number(n.toFixed(8)).toLocaleString('en-US', { maximumFractionDigits: 8 });
const naira = (n: number) => '₦' + Math.round(n).toLocaleString('en-NG');

export function buildBinance(read: ReturnType<typeof readBinanceFiles>, price: PriceFn): ExchangeImport {
  const { legs, p2p } = read;
  const events: TaxEvent[] = [], items: ExchangeItem[] = [], withdrawals: Transfer[] = [], deposits: Transfer[] = [];
  const notes = [...read.notes];
  const usdOf = (coin: string, units: number, ts: number, date: string): number | null => {
    if (isStable(coin)) return units;
    const k = priceKeyFor(coin); if (!k) return null;
    const p = price({ symbol: coin, priceKey: k, timestamp: ts, date } as Movement);
    return p == null ? null : p * units;
  };
  let n = 0; const id = () => `binance:${++n}`;

  // P2P orders (naira legs).
  for (const o of p2p) {
    const i = id();
    if (o.fiat !== 'NGN') {
      items.push({ id: i, date: o.date, source: 'Binance', kind: o.side === 'buy' ? 'p2p_buy' : 'p2p_sell', text: `P2P ${o.side} ${fmt(o.qty)} ${o.asset} for ${o.total} ${o.fiat}`, review: `Paid in ${o.fiat}, not naira. Not counted yet; tell us the naira value.` });
      continue;
    }
    if (o.side === 'buy') {
      events.push({ type: 'buy_fiat', id: i, date: o.date, asset: o.asset, unitsNet: Math.max(0, o.qty - o.fee), naira: o.total });
      items.push({ id: i, date: o.date, source: 'Binance', kind: 'p2p_buy', text: `Bought ${fmt(o.qty)} ${o.asset} on P2P for ${naira(o.total)} (order ${o.order})` });
    } else {
      events.push({ type: 'sell_fiat', id: i, date: o.date, asset: o.asset, units: o.qty + o.fee, naira: o.total });
      items.push({ id: i, date: o.date, source: 'Binance', kind: 'p2p_sell', text: `Sold ${fmt(o.qty)} ${o.asset} on P2P for ${naira(o.total)} (order ${o.order})` });
    }
  }
  const haveP2P = p2p.length > 0;
  let skippedP2P = 0;

  // Group trade legs that happen in the same second (one trade = spend + receive + fee lines).
  const groups = new Map<string, Leg[]>();
  for (const l of legs) {
    const c = classifyOp(l.op);
    if (c.cls === 'trade') { const k = `${l.ts}|${l.account}`; groups.set(k, [...(groups.get(k) ?? []), l]); continue; }
    const i = id();
    const units = Math.abs(l.change);
    switch (c.cls) {
      case 'p2p':
        if (haveP2P) { skippedP2P++; break; }
        items.push({ id: i, date: l.date, source: 'Binance', kind: l.change > 0 ? 'p2p_buy' : 'p2p_sell', text: `P2P ${l.change > 0 ? 'received' : 'sent'} ${fmt(units)} ${l.coin}`, review: 'The naira amount is not in this file. Upload your P2P Order History too, so we use what you actually paid or received.' });
        if (l.change > 0) { const u = usdOf(l.coin, units, l.ts, l.date); if (u != null) events.push({ type: 'opening', id: i, date: l.date, asset: l.coin, units, usdCost: u }); }
        break;
      case 'deposit':
        deposits.push({ date: l.date, ts: l.ts, symbol: l.coin, units });
        items.push({ id: i, date: l.date, source: 'Binance', kind: 'deposit', text: `Deposited ${fmt(units)} ${l.coin} to Binance. Treated as a move between your own accounts (not taxable, para 7.2.2).` });
        break;
      case 'withdraw':
        withdrawals.push({ date: l.date, ts: l.ts, symbol: l.coin, units });
        items.push({ id: i, date: l.date, source: 'Binance', kind: 'withdraw', text: `Withdrew ${fmt(units)} ${l.coin} from Binance. Treated as a move to your own wallet (not taxable, para 7.2.2).` });
        break;
      case 'reward': {
        if (l.change <= 0) break;
        const u = usdOf(l.coin, units, l.ts, l.date);
        if (u == null) { items.push({ id: i, date: l.date, source: 'Binance', kind: 'reward', text: `${l.op}: ${fmt(units)} ${l.coin}`, review: 'No market price for this coin on that day, so it is not counted.' }); break; }
        events.push({ type: 'income', id: i, kind: c.incomeKind ?? 'other', date: l.date, asset: l.coin, units, usdFmv: u });
        items.push({ id: i, date: l.date, source: 'Binance', kind: 'reward', text: `${l.op}: ${fmt(units)} ${l.coin}, taxed as income on the day received (para 7.1).` });
        break;
      }
      case 'pay': {
        const u = usdOf(l.coin, units, l.ts, l.date);
        if (u == null) { items.push({ id: i, date: l.date, source: 'Binance', kind: l.change > 0 ? 'pay_in' : 'pay_out', text: `Binance Pay ${l.change > 0 ? 'received' : 'sent'} ${fmt(units)} ${l.coin}`, review: 'No market price for this coin on that day.' }); break; }
        if (l.change > 0) {
          events.push({ type: 'income', id: i, kind: 'professional', date: l.date, asset: l.coin, units, usdFmv: u });
          items.push({ id: i, date: l.date, source: 'Binance', kind: 'pay_in', text: `Received ${fmt(units)} ${l.coin} by Binance Pay. Guessed as payment for work.`, review: 'Check this: if it was a refund, a gift or from your own account, it is not income.' });
        } else {
          events.push({ type: 'swap', id: i, date: l.date, assetOut: l.coin, unitsOut: units, assetIn: '__SPENT__', unitsIn: 0, usdFmvOut: u });
          items.push({ id: i, date: l.date, source: 'Binance', kind: 'pay_out', text: `Paid ${fmt(units)} ${l.coin} by Binance Pay, a disposal at market value (para 7.1 item 5).` });
        }
        break;
      }
      case 'internal': case 'fiat': break; // moves inside Binance or plain naira: not taxable events
      default:
        items.push({ id: i, date: l.date, source: 'Binance', kind: 'unknown', text: `${l.op}: ${l.change > 0 ? '+' : ''}${fmt(l.change)} ${l.coin}`, review: 'We do not recognise this Binance operation yet, so it is not counted. Tell us what it was.' });
    }
  }
  if (skippedP2P) notes.push(`Used your P2P Order History for naira amounts and skipped ${skippedP2P} matching P2P lines in the main statement, so nothing is counted twice.`);

  // Trades.
  for (const g of groups.values()) {
    const net = new Map<string, number>();
    for (const l of g) net.set(l.coin, (net.get(l.coin) ?? 0) + l.change);
    const outs = [...net].filter(([, v]) => v < -1e-12), ins = [...net].filter(([, v]) => v > 1e-12);
    const { ts, date } = g[0];
    const i = id();
    // A fee in a third coin (usually BNB) shows up as an extra "out".
    const feeCoins = g.filter(l => /fee/i.test(l.op)).map(l => l.coin);
    let mainOuts = outs;
    if (outs.length === 2 && ins.length === 1) {
      const fee = outs.find(([c]) => feeCoins.includes(c));
      if (fee) {
        mainOuts = outs.filter(o => o !== fee);
        const u = usdOf(fee[0], -fee[1], ts, date);
        if (u != null) events.push({ type: 'swap', id: `${i}:fee`, date, assetOut: fee[0], unitsOut: -fee[1], assetIn: '__SPENT__', unitsIn: 0, usdFmvOut: u });
      }
    }
    if (mainOuts.length !== 1 || ins.length !== 1) {
      items.push({ id: i, date, source: 'Binance', kind: 'trade', text: `Trade with ${g.length} lines: ${[...net].map(([c, v]) => `${v > 0 ? '+' : ''}${fmt(v)} ${c}`).join(', ')}`, review: 'We could not tell what was given and what was received here, so it is not counted.' });
      continue;
    }
    const [outC, outV] = mainOuts[0], [inC, inV] = ins[0];
    const unitsOut = -outV, unitsIn = inV;
    if (outC === 'NGN') {
      events.push({ type: 'buy_fiat', id: i, date, asset: inC, unitsNet: unitsIn, naira: unitsOut });
      items.push({ id: i, date, source: 'Binance', kind: 'trade', text: `Bought ${fmt(unitsIn)} ${inC} for ${naira(unitsOut)}` });
      continue;
    }
    if (inC === 'NGN') {
      events.push({ type: 'sell_fiat', id: i, date, asset: outC, units: unitsOut, naira: unitsIn });
      items.push({ id: i, date, source: 'Binance', kind: 'trade', text: `Sold ${fmt(unitsOut)} ${outC} for ${naira(unitsIn)}` });
      continue;
    }
    if (FIAT.has(outC) || FIAT.has(inC)) {
      items.push({ id: i, date, source: 'Binance', kind: 'trade', text: `Traded ${fmt(unitsOut)} ${outC} for ${fmt(unitsIn)} ${inC}`, review: 'A non-naira currency was used. Not counted yet; tell us the naira value.' });
      continue;
    }
    // Para 9.1.2: value the swap at the dollar FMV of what was given up; if that coin has no price, use what was received.
    const fmv = usdOf(outC, unitsOut, ts, date) ?? usdOf(inC, unitsIn, ts, date);
    if (fmv == null) {
      items.push({ id: i, date, source: 'Binance', kind: 'trade', text: `Swapped ${fmt(unitsOut)} ${outC} for ${fmt(unitsIn)} ${inC}`, review: 'Neither coin had a market price that day, so this is not counted.' });
      continue;
    }
    events.push({ type: 'swap', id: i, date, assetOut: outC, unitsOut, assetIn: inC, unitsIn, usdFmvOut: fmv });
    items.push({ id: i, date, source: 'Binance', kind: 'trade', text: `Swapped ${fmt(unitsOut)} ${outC} for ${fmt(unitsIn)} ${inC} (worth $${fmv.toFixed(2)}), a disposal of ${outC} (para 9.3.2).` });
  }

  items.sort((a, b) => a.date.localeCompare(b.date));
  return { events, items, withdrawals, deposits, notes, files: read.files };
}

/**
 * Link wallet movements to Binance withdrawals/deposits: the same coin and
 * amount (allowing for the withdrawal fee) within two days is the user moving
 * their own money, not income or a payment.
 */
export function matchTransfers(
  moves: Movement[], ex: Pick<ExchangeImport, 'withdrawals' | 'deposits'>,
): Map<number, string> {
  const out = new Map<number, string>();
  const usedW = new Set<number>(), usedD = new Set<number>();
  moves.forEach((m, idx) => {
    const sym = m.symbol.toUpperCase();
    const pool = m.direction === 'in' ? ex.withdrawals : ex.deposits;
    const used = m.direction === 'in' ? usedW : usedD;
    let best = -1, bestGap = Infinity;
    pool.forEach((t, k) => {
      if (used.has(k) || t.symbol !== sym) return;
      const gap = Math.abs(t.ts - m.timestamp);
      if (gap > 2 * 86_400) return;
      // Withdrawal: the wallet receives the amount less a network fee. Deposit: Binance credits what the wallet sent.
      const okAmt = m.direction === 'in'
        ? m.units <= t.units * 1.0001 + 1e-9 && m.units >= t.units * 0.97 - 2
        : Math.abs(m.units - t.units) <= Math.max(t.units * 0.001, 1e-6);
      if (okAmt && gap < bestGap) { best = k; bestGap = gap; }
    });
    if (best >= 0) {
      used.add(best);
      const t = pool[best];
      out.set(idx, m.direction === 'in'
        ? `Matches your Binance withdrawal of ${fmt(t.units)} ${t.symbol} on ${t.date}: your own money moving, not income (para 7.2.2).`
        : `Matches your Binance deposit of ${fmt(t.units)} ${t.symbol} on ${t.date}: your own money moving, not a sale (para 7.2.2).`);
    }
  });
  return out;
}
