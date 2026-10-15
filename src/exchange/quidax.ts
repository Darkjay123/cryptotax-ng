/**
 * Reads Quidax account statements (the Naira Account Statement and the Crypto
 * Account Statement they generate from the app). Columns are mapped loosely:
 * date/date/time, description/narration/details/type, debit, credit, and an
 * optional currency/coin/asset column. Rows we cannot read go to review items.
 */
import type { IncomeKind, TaxEvent } from '../engine.js';
import { STABLECOINS } from '../rules.js';
import type { Movement } from '../wallet/types.js';
import type { PriceFn } from '../prices.js';
import { parseCsv, num } from './csv.js';
import { priceKeyFor, type ExchangeImport, type ExchangeItem, type Leg, type Transfer } from './binance.js';

const pick = (h: Record<string, string>, keys: string[]): string => { for (const k of keys) if (h[k] !== undefined) return h[k]; return ''; };

export function detectQuidax(text: string): boolean {
  const head = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].toLowerCase();
  if (/utc_time/.test(head) && /operation/.test(head)) return false; // Binance
  return /debit/.test(head) && /credit/.test(head) && (/description|narration|details/.test(head) || /quidax/.test(head));
}

export interface QuidaxRead { legs: Leg[]; nairaLegs: { ts: number; date: string; amount: number; desc: string }[]; files: ExchangeImport['files']; notes: string[]; name?: string }

export function readQuidax(text: string): QuidaxRead | null {
  const rows = parseCsv(text);
  if (!rows.length) return null;
  const legs: Leg[] = [], nairaLegs: QuidaxRead['nairaLegs'] = [], notes: string[] = [];
  let bad = 0;
  for (const r of rows) {
    const t = parseTime(pick(r, ['date', 'transaction_date', 'created_at', 'time', 'utc_time']));
    if (!t) { bad++; continue; }
    const debit = num(pick(r, ['debit', 'debit_amount', 'amount_out'])), credit = num(pick(r, ['credit', 'credit_amount', 'amount_in']));
    const desc = pick(r, ['description', 'narration', 'details', 'type', 'activity']);
    const cur = pick(r, ['currency', 'coin', 'asset']).toUpperCase();
    const hasCoinCol = Object.keys(r).some(k => /currency|coin|asset/.test(k));
    const isNaira = cur === 'NGN' || /naira|ngn/i.test(desc) || /ngn/.test(pick(r, ['pair', 'symbol']).toUpperCase()) || (!cur && !hasCoinCol);
    const ch = credit ? credit : debit ? -debit : NaN;
    if (!Number.isFinite(ch)) { bad++; continue; }
    if (isNaira) nairaLegs.push({ ...t, amount: ch, desc });
    else {
      if (!cur) { bad++; continue; }
      legs.push({ ...t, op: desc, coin: cur, change: ch, account: '', remark: desc });
    }
  }
  if (!legs.length && !nairaLegs.length) return null;
  if (bad) notes.push(`${bad} Quidax line(s) had no readable date or amount and were skipped.`);
  legs.sort((a, b) => a.ts - b.ts); nairaLegs.sort((a, b) => a.ts - b.ts);
  return { legs, nairaLegs, files: [{ name: '', kind: 'quidax_statement', rows: legs.length + nairaLegs.length }], notes, name: '' };
}

function parseTime(s: string): { ts: number; date: string } | null {
  const t = s.trim();
  // dd/mm/yyyy (and friends) must be tried before the loose year-first pattern,
  // or "14/01/2026" reads as year 14.
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

function classifyDesc(d: string): { cls: 'buy' | 'sell' | 'swap' | 'deposit' | 'withdraw' | 'reward' | 'internal' | 'unknown'; incomeKind?: IncomeKind } {
  const o = d.toLowerCase();
  if (/deposit|funding/.test(o)) return { cls: 'deposit' };
  if (/withdraw/.test(o)) return { cls: 'withdraw' };
  if (/airdrop/.test(o)) return { cls: 'reward', incomeKind: 'airdrop' };
  if (/interest|staking|reward|bonus|cashback|referral|commission/.test(o)) return { cls: 'reward', incomeKind: 'staking' };
  if (/internal|transfer/.test(o)) return { cls: 'internal' };
  if (/swap|convert/.test(o)) return { cls: 'swap' };
  if (/buy|purchase|instant buy/.test(o)) return { cls: 'buy' };
  if (/sell/.test(o)) return { cls: 'sell' };
  return { cls: 'unknown' };
}

const fmt = (n: number) => Number(n.toFixed(8)).toLocaleString('en-US', { maximumFractionDigits: 8 });
const naira = (n: number) => '₦' + Math.round(n).toLocaleString('en-NG');

export function buildQuidax(read: QuidaxRead, price: PriceFn, fileName: string): ExchangeImport {
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
  let n = 0; const id = () => `quidax:${++n}`;
  const usedNaira = new Set<number>();
  const nearestNaira = (ts: number, wantPositive: boolean): { amount: number; k: number } | null => {
    let best = -1, bestGap = Infinity;
    read.nairaLegs.forEach((l, k) => {
      if (usedNaira.has(k) || (l.amount > 0) !== wantPositive) return;
      const gap = Math.abs(l.ts - ts);
      if (gap <= 10 * 60 && gap < bestGap) { best = k; bestGap = gap; }
    });
    return best >= 0 ? { amount: read.nairaLegs[best].amount, k: best } : null;
  };

  for (const l of read.legs) {
    const c = classifyDesc(l.op);
    const units = Math.abs(l.change);
    const i = id();
    switch (c.cls) {
      case 'deposit':
        deposits.push({ date: l.date, ts: l.ts, symbol: l.coin, units });
        items.push({ id: i, date: l.date, source: 'Quidax', kind: 'deposit', text: `Deposited ${fmt(units)} ${l.coin} to Quidax. Treated as a move between your own accounts (not taxable, para 7.2.2).` });
        break;
      case 'withdraw':
        withdrawals.push({ date: l.date, ts: l.ts, symbol: l.coin, units });
        items.push({ id: i, date: l.date, source: 'Quidax', kind: 'withdraw', text: `Withdrew ${fmt(units)} ${l.coin} from Quidax. Treated as a move to your own wallet (not taxable, para 7.2.2).` });
        break;
      case 'reward': {
        if (l.change <= 0) break;
        const u = usdOf(l.coin, units, l.ts, l.date);
        if (u == null) { items.push({ id: i, date: l.date, source: 'Quidax', kind: 'reward', text: `${l.op}: ${fmt(units)} ${l.coin}`, review: 'No market price for this coin on that day, so it is not counted.' }); break; }
        events.push({ type: 'income', id: i, kind: c.incomeKind ?? 'other', date: l.date, asset: l.coin, units, usdFmv: u, viaVasp: true });
        items.push({ id: i, date: l.date, source: 'Quidax', kind: 'reward', text: `${l.op}: ${fmt(units)} ${l.coin}, taxed as income on the day received (para 7.1).` });
        break;
      }
      case 'buy': {
        const nairaHit = nearestNaira(l.ts, false); // buying crypto moves naira out
        if (nairaHit) {
          usedNaira.add(nairaHit.k);
          events.push({ type: 'buy_fiat', id: i, date: l.date, asset: l.coin, unitsNet: units, naira: -nairaHit.amount });
          items.push({ id: i, date: l.date, source: 'Quidax', kind: 'trade', text: `Bought ${fmt(units)} ${l.coin} for ${naira(-nairaHit.amount)}` });
        } else {
          const u = usdOf(l.coin, units, l.ts, l.date);
          if (u == null) { items.push({ id: i, date: l.date, source: 'Quidax', kind: 'trade', text: `${l.op}: ${fmt(units)} ${l.coin}`, review: 'The naira you paid is not in the files we read. Tell us what you paid so the cost base is right.' }); break; }
          events.push({ type: 'opening', id: i, date: l.date, asset: l.coin, units, usdCost: u });
          items.push({ id: i, date: l.date, source: 'Quidax', kind: 'trade', text: `Bought ${fmt(units)} ${l.coin} (valued at $${u.toFixed(2)} until you tell us the naira you paid).` });
        }
        break;
      }
      case 'sell': {
        const nairaHit = nearestNaira(l.ts, true); // selling brings naira in
        if (nairaHit) {
          usedNaira.add(nairaHit.k);
          events.push({ type: 'sell_fiat', id: i, date: l.date, asset: l.coin, units, naira: nairaHit.amount });
          items.push({ id: i, date: l.date, source: 'Quidax', kind: 'trade', text: `Sold ${fmt(units)} ${l.coin} for ${naira(nairaHit.amount)}` });
        } else {
          items.push({ id: i, date: l.date, source: 'Quidax', kind: 'trade', text: `${l.op}: ${fmt(units)} ${l.coin}`, review: 'The naira you received is not in the files we read. Tell us what you received so the sale is priced right.' });
        }
        break;
      }
      case 'swap': {
        const u = usdOf(l.coin, units, l.ts, l.date);
        if (l.change > 0) { items.push({ id: i, date: l.date, source: 'Quidax', kind: 'trade', text: `Received ${fmt(units)} ${l.coin} from a swap. Counted with the coin given up on the same day.` }); break; }
        if (u == null) { items.push({ id: i, date: l.date, source: 'Quidax', kind: 'trade', text: `Swapped ${fmt(units)} ${l.coin}`, review: 'No market price for this coin that day, so it is not counted.' }); break; }
        events.push({ type: 'swap', id: i, date: l.date, assetOut: l.coin, unitsOut: units, assetIn: '__SPENT__', unitsIn: 0, usdFmvOut: u });
        items.push({ id: i, date: l.date, source: 'Quidax', kind: 'trade', text: `Swapped ${fmt(units)} ${l.coin} (worth $${u.toFixed(2)}), a disposal of ${l.coin} (para 9.3.2).` });
        break;
      }
      case 'internal': break;
      default:
        items.push({ id: i, date: l.date, source: 'Quidax', kind: 'unknown', text: `${l.op || 'Unlabelled'}: ${l.change > 0 ? '+' : ''}${fmt(l.change)} ${l.coin}`, review: 'We do not recognise this Quidax entry yet, so it is not counted. Tell us what it was.' });
    }
  }
  const leftNaira = read.nairaLegs.filter((_, k) => !usedNaira.has(k) && classifyDesc(read.nairaLegs[k].desc).cls === 'unknown' && Math.abs(read.nairaLegs[k].amount) > 0);
  if (leftNaira.length) notes.push(`${leftNaira.length} naira line(s) on the Quidax statement were not tied to a crypto trade; they look like plain naira in or out and are not counted as crypto events.`);
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { events, items, withdrawals, deposits, notes, files };
}
