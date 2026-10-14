/**
 * Reads the Bybit "Account Change Details" transaction-log export.
 * Columns are mapped loosely (the header wording changes between Bybit versions):
 * time = utc_time/created_time/uts/time/date, type = transaction_type/type,
 * coin = currency/coin/asset, amount = change/amount. Ops we cannot read go to
 * review items and are never counted.
 */
import type { IncomeKind, TaxEvent } from '../engine.js';
import { STABLECOINS } from '../rules.js';
import type { Movement } from '../wallet/types.js';
import type { PriceFn } from '../prices.js';
import { parseCsv, num } from './csv.js';
import { priceKeyFor, type ExchangeImport, type ExchangeItem, type Leg, type Transfer } from './binance.js';

const pick = (h: Record<string, string>, keys: string[]): string => { for (const k of keys) if (h[k] !== undefined) return h[k]; return ''; };

export function detectBybit(text: string): boolean {
  const head = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].toLowerCase();
  if (/utc_time/.test(head) && /operation/.test(head)) return false; // Binance
  return (/transaction_type/.test(head)) || (/uts/.test(head) && /currency/.test(head)) || (/account/.test(head) && /change/.test(head) && /coin/.test(head));
}

function classifyType(t: string): { cls: 'trade' | 'deposit' | 'withdraw' | 'reward' | 'internal' | 'p2p' | 'unknown'; incomeKind?: IncomeKind } {
  const o = t.toLowerCase().trim();
  if (/deposit/.test(o)) return { cls: 'deposit' };
  if (/withdraw/.test(o)) return { cls: 'withdraw' };
  if (/transfer/.test(o)) return { cls: 'internal' };
  if (/airdrop/.test(o)) return { cls: 'reward', incomeKind: 'airdrop' };
  if (/interest|staking|earn.*pay|yield|rebate/.test(o)) return { cls: 'reward', incomeKind: 'staking' };
  if (/bonus|reward|cashback|gift/.test(o)) return { cls: 'reward', incomeKind: 'other' };
  if (/p2p/.test(o)) return { cls: 'p2p' };
  if (/^(buy|sell|trade|swap|convert|settle|settlement|fee|funding)/.test(o) || /buy|sell|trade|swap|convert/.test(o)) return { cls: 'trade' };
  return { cls: 'unknown' };
}

export interface BybitRead { legs: Leg[]; files: ExchangeImport['files']; notes: string[]; name?: string; sourceName?: string }
export function readBybit(text: string): BybitRead | null {
  const rows = parseCsv(text);
  if (!rows.length) return null;
  const first = rows[0];
  const legs: Leg[] = [], notes: string[] = [];
  let bad = 0;
  for (const r of rows) {
    const t = parseBybitTime(pick(r, ['utc_time', 'created_time', 'time', 'uts', 'date']));
    const ch = num(pick(r, ['change', 'amount', 'flow']));
    const coin = pick(r, ['currency', 'coin', 'asset']).toUpperCase();
    if (!t || !Number.isFinite(ch) || !coin) { bad++; continue; }
    legs.push({ ...t, op: pick(r, ['transaction_type', 'type', 'operation']), coin, change: ch, account: pick(r, ['account']), remark: pick(r, ['remark', 'comment', 'note']) });
  }
  if (!legs.length) return null;
  if (bad) notes.push(`${bad} Bybit line(s) had no readable date, coin or amount and were skipped.`);
  legs.sort((a, b) => a.ts - b.ts);
  return { legs, files: [{ name: '', kind: 'bybit_transactions', rows: legs.length }], notes, name: '' };
}

function parseBybitTime(s: string): { ts: number; date: string } | null {
  const t = s.trim();
  const m2 = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m2) {
    const ts = Date.UTC(Number(m2[3]), Number(m2[2]) - 1, Number(m2[1]), Number(m2[4] ?? 0), Number(m2[5] ?? 0), Number(m2[6] ?? 0)) / 1000;
    if (Number.isFinite(ts)) return { ts, date: new Date(ts * 1000).toISOString().slice(0, 10) };
  }
  const m = t.match(/^(\d{2,4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    let y = Number(m[1]); if (y < 100) y += 2000;
    const ts = Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) / 1000;
    if (Number.isFinite(ts)) return { ts, date: new Date(ts * 1000).toISOString().slice(0, 10) };
  }
  const n = Date.parse(t);
  if (Number.isFinite(n)) { const ts = Math.floor(n / 1000); return { ts, date: new Date(ts * 1000).toISOString().slice(0, 10) }; }
  return null;
}

export function buildBybit(read: NonNullable<ReturnType<typeof readBybit>>, price: PriceFn, fileName: string, sourceName0 = 'Bybit'): ExchangeImport {
  const sourceName = read.sourceName ?? sourceName0;
  const files = read.files.map(f => ({ ...f, name: f.name || fileName }));
  const events: TaxEvent[] = [], items: ExchangeItem[] = [], withdrawals: Transfer[] = [], deposits: Transfer[] = [];
  const notes = [...read.notes];
  const isStable = (s: string) => !!STABLECOINS[s];
  const usdOf = (coin: string, units: number, ts: number, date: string): number | null => {
    if (isStable(coin)) return units;
    const k = priceKeyFor(coin); if (!k) return null;
    const p = price({ symbol: coin, priceKey: k, timestamp: ts, date } as Movement);
    return p == null ? null : p * units;
  };
  let n = 0; const id = () => `bybit:${++n}`;
  const groups = new Map<string, Leg[]>();
  for (const l of read.legs) {
    const c = classifyType(l.op);
    const units = Math.abs(l.change);
    const i = id();
    switch (c.cls) {
      case 'trade': { groups.set(`${l.ts}|${l.account}`, [...(groups.get(`${l.ts}|${l.account}`) ?? []), l]); continue; }
      case 'deposit':
        deposits.push({ date: l.date, ts: l.ts, symbol: l.coin, units });
        items.push({ id: i, date: l.date, source: sourceName, kind: 'deposit', text: `Deposited ${fmt(units)} ${l.coin} to Bybit. Treated as a move between your own accounts (not taxable, para 7.2.2).` });
        break;
      case 'withdraw':
        withdrawals.push({ date: l.date, ts: l.ts, symbol: l.coin, units });
        items.push({ id: i, date: l.date, source: sourceName, kind: 'withdraw', text: `Withdrew ${fmt(units)} ${l.coin} from Bybit. Treated as a move to your own wallet (not taxable, para 7.2.2).` });
        break;
      case 'reward': {
        if (l.change <= 0) break;
        const u = usdOf(l.coin, units, l.ts, l.date);
        if (u == null) { items.push({ id: i, date: l.date, source: sourceName, kind: 'reward', text: `${l.op}: ${fmt(units)} ${l.coin}`, review: 'No market price for this coin on that day, so it is not counted.' }); break; }
        events.push({ type: 'income', id: i, kind: c.incomeKind ?? 'other', date: l.date, asset: l.coin, units, usdFmv: u });
        items.push({ id: i, date: l.date, source: sourceName, kind: 'reward', text: `${l.op}: ${fmt(units)} ${l.coin}, taxed as income on the day received (para 7.1).` });
        break;
      }
      case 'p2p':
        items.push({ id: i, date: l.date, source: sourceName, kind: l.change > 0 ? 'p2p_buy' : 'p2p_sell', text: `${l.op}: ${l.change > 0 ? '+' : ''}${fmt(l.change)} ${l.coin}`, review: 'The naira side of this P2P trade is not in a Bybit export. If you were paid in naira, add it under "Sold for naira (P2P)" or tell us the naira value.' });
        break;
      case 'internal': break;
      default:
        items.push({ id: i, date: l.date, source: sourceName, kind: 'unknown', text: `${l.op || 'Unlabelled'}: ${l.change > 0 ? '+' : ''}${fmt(l.change)} ${l.coin}`, review: 'We do not recognise this Bybit operation yet, so it is not counted. Tell us what it was.' });
    }
  }
  for (const g of groups.values()) {
    const net = new Map<string, number>();
    for (const l of g) net.set(l.coin, (net.get(l.coin) ?? 0) + l.change);
    const outs = [...net].filter(([, v]) => v < -1e-12), ins = [...net].filter(([, v]) => v > 1e-12);
    const { ts, date } = g[0];
    const i = id();
    if (outs.length !== 1 || ins.length !== 1) {
      items.push({ id: i, date, source: sourceName, kind: 'trade', text: `Trade with ${g.length} lines: ${[...net].map(([c, v]) => `${v > 0 ? '+' : ''}${fmt(v)} ${c}`).join(', ')}`, review: 'We could not tell what was given and what was received here, so it is not counted.' });
      continue;
    }
    const [outC, outV] = outs[0], [inC, inV] = ins[0];
    const unitsOut = -outV, unitsIn = inV;
    if (outC === 'NGN') { events.push({ type: 'buy_fiat', id: i, date, asset: inC, unitsNet: unitsIn, naira: unitsOut }); items.push({ id: i, date, source: sourceName, kind: 'trade', text: `Bought ${fmt(unitsIn)} ${inC} for naira ${fmt(unitsOut)}` }); continue; }
    if (inC === 'NGN') { events.push({ type: 'sell_fiat', id: i, date, asset: outC, units: unitsOut, naira: unitsIn }); items.push({ id: i, date, source: sourceName, kind: 'trade', text: `Sold ${fmt(unitsOut)} ${outC} for naira ${fmt(unitsIn)}` }); continue; }
    const fmv = usdOf(outC, unitsOut, ts, date) ?? usdOf(inC, unitsIn, ts, date);
    if (fmv == null) { items.push({ id: i, date, source: sourceName, kind: 'trade', text: `Swapped ${fmt(unitsOut)} ${outC} for ${fmt(unitsIn)} ${inC}`, review: 'Neither coin had a market price that day, so this is not counted.' }); continue; }
    events.push({ type: 'swap', id: i, date, assetOut: outC, unitsOut, assetIn: inC, unitsIn, usdFmvOut: fmv });
    items.push({ id: i, date, source: sourceName, kind: 'trade', text: `Swapped ${fmt(unitsOut)} ${outC} for ${fmt(unitsIn)} ${inC} (worth $${fmv.toFixed(2)}), a disposal of ${outC} (para 9.3.2).` });
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { events, items, withdrawals, deposits, notes, files };
}
const fmt = (n: number) => Number(n.toFixed(8)).toLocaleString('en-US', { maximumFractionDigits: 8 });
