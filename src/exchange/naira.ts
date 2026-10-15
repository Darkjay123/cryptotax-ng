/**
 * Reads account statements from the Nigerian exchanges and on/off-ramps:
 * Breet, Busha, Yellow Card, Bitnob, Luno, Roqqu, NairaEx, Remitano, Spenda,
 * Azza, Monica, Dantown, Getkoyn, Sekiapp, Gexipay and similar apps. The
 * vendors issue different statement layouts, so columns are mapped loosely and
 * rows we cannot read go to review items, never guessed. The vendor name comes
 * from the file name or the statement text.
 */
import type { IncomeKind } from '../engine.js';
import type { PriceFn } from '../prices.js';
import { parseCsv, num } from './csv.js';
import { priceKeyFor, type ExchangeImport, type ExchangeItem, type Leg, type Transfer } from './binance.js';
import { STABLECOINS } from '../rules.js';

const FIAT = new Set(['NGN', 'USD', 'EUR', 'GBP', 'GHS', 'KES', 'ZAR', 'CNGN']);
const isStable = (s: string) => !!STABLECOINS[s];

const VENDORS: [RegExp, string][] = [
  [/spenda/i, 'Spenda'],
  [/\bazza\b/i, 'Azza'],
  [/breet/i, 'Breet'],
  [/busha/i, 'Busha'],
  [/yellow\s*card/i, 'Yellow Card'],
  [/bitnob/i, 'Bitnob'],
  [/\bluno\b/i, 'Luno'],
  [/roqqu/i, 'Roqqu'],
  [/nairaex/i, 'NairaEx'],
  [/remitano/i, 'Remitano'],
  [/\bmonica\b/i, 'Monica'],
  [/dantown/i, 'Dantown'],
  [/getkoyn/i, 'Getkoyn'],
  [/sekiapp/i, 'Sekiapp'],
  [/gexipay/i, 'Gexipay'],
  [/cashin/i, 'CashIn'],
  [/\bdaya\b/i, 'Daya Coins'],
  [/cashwyre/i, 'Cashwyre'],
  [/keshpay/i, 'Keshpay'],
  [/\bfavex\b/i, 'Favex'],
  [/bitmama/i, 'Bitmama'],
  [/conge/i, 'Conge'],
];

export function detectNairaVendor(text: string, name = ''): string | null {
  const hay = `${name}\n${text.slice(0, 4000)}`;
  for (const [re, label] of VENDORS) if (re.test(hay)) return label;
  return null;
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

const pick = (h: Record<string, string>, keys: string[]): string => { for (const k of keys) if (h[k] !== undefined) return h[k]; return ''; };

const isCancelled = (s: string) => /cancel|fail|revers|reject/.test(s);

type Cls = 'buy' | 'sell' | 'swap' | 'deposit' | 'withdraw' | 'reward' | 'payment' | 'internal' | 'unknown';
export function classifyNairaDesc(d: string): { cls: Cls; incomeKind?: IncomeKind } {
  const o = d.toLowerCase();
  if (/sell|sold|cashed|off.?ramp/.test(o)) return { cls: 'sell' };
  if (/card|bill|airtime|data|cable|electricity|tv|betting|subscription|spent|payment/.test(o)) return { cls: 'payment' };
  if (/buy|bought|purchase/.test(o)) return { cls: 'buy' };
  if (/swap|convert/.test(o)) return { cls: 'swap' };
  if (/internal|transfer|between/.test(o)) return { cls: 'internal' };
  if (/deposit|received/.test(o)) return { cls: 'deposit' };
  if (/withdraw/.test(o)) return { cls: 'withdraw' };
  if (/airdrop/.test(o)) return { cls: 'reward', incomeKind: 'airdrop' };
  if (/interest|staking|reward|bonus|cashback|referral|commission/.test(o)) return { cls: 'reward', incomeKind: 'staking' };
  return { cls: 'unknown' };
}

export interface NairaRead {
  legs: Leg[];
  nairaLegs: { ts: number; date: string; amount: number; desc: string }[];
  // Rows that state the crypto amount and the naira value together ("Sold 500
  // USDT, ₦765,000"): priced directly from the statement, no pairing needed.
  direct: { ts: number; date: string; side: 'buy' | 'sell'; coin: string; units: number; naira: number; desc: string }[];
  files: ExchangeImport['files'];
  notes: string[];
  vendor: string;
  name?: string;
}

export function readNaira(text: string, vendor: string): NairaRead | null {
  const rows = parseCsv(text).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/\s+/g, '_'), v])));
  if (!rows.length) return null;
  const legs: Leg[] = [], nairaLegs: NairaRead['nairaLegs'] = [], direct: NairaRead['direct'] = [], notes: string[] = [];
  let bad = 0, skippedStatus = 0;
  for (const r of rows) {
    const status = pick(r, ['status', 'state']).toLowerCase();
    if (status && isCancelled(status)) { skippedStatus++; continue; }
    const t = parseTime(pick(r, ['date', 'transaction_date', 'created_at', 'time', 'utc_time', 'timestamp']));
    if (!t) { bad++; continue; }
    const desc = pick(r, ['description', 'narration', 'details', 'type', 'activity', 'remark', 'operation']);
    const cur = pick(r, ['currency', 'coin', 'asset', 'token', 'symbol']).toUpperCase();
    const debit = num(pick(r, ['debit', 'debit_amount', 'amount_out']));
    const credit = num(pick(r, ['credit', 'credit_amount', 'amount_in']));
    const amount = num(pick(r, ['amount', 'crypto_amount', 'quantity', 'qty', 'units', 'change']));
    const nairaVal = num(pick(r, ['naira_value', 'ngn_value', 'value_ngn', 'amount_ngn', 'value_naira', 'fiat_value', 'total_ngn', 'ngn_amount', 'ngn_received', 'naira_received', 'ngn_paid', 'naira_paid', 'fiat_amount', 'total_fiat', 'value']));
    const signed = credit ? credit : debit ? -debit : Number.isFinite(amount) ? amount : NaN;
    if (!Number.isFinite(signed)) { bad++; continue; }
    const isNaira = (!cur || FIAT.has(cur)) && !isStable(cur);
    if (isNaira) {
      nairaLegs.push({ ...t, amount: signed, desc });
    } else {
      if (!cur) { bad++; continue; }
      const c = classifyNairaDesc(desc);
      // A row that states both the crypto amount and the naira value is priced
      // from the statement itself (many ramps print "Sold 100 USDT  ₦155,000").
      if (Number.isFinite(nairaVal) && nairaVal > 0 && (c.cls === 'buy' || c.cls === 'sell') && signed !== 0) {
        direct.push({ ...t, side: c.cls as 'buy' | 'sell', coin: cur, units: Math.abs(signed), naira: nairaVal, desc });
        continue;
      }
      legs.push({ ...t, op: desc, coin: cur, change: signed, account: '', remark: desc });
    }
  }
  if (!legs.length && !nairaLegs.length && !direct.length) return null;
  if (bad) notes.push(`${bad} ${vendor} line(s) had no readable date or amount and were skipped.`);
  if (skippedStatus) notes.push(`${skippedStatus} ${vendor} line(s) marked cancelled, failed or reversed were skipped.`);
  legs.sort((a, b) => a.ts - b.ts); nairaLegs.sort((a, b) => a.ts - b.ts);
  return { legs, nairaLegs, direct, files: [{ name: '', kind: 'naira_statement', rows: legs.length + nairaLegs.length + direct.length }], notes, vendor };
}

export function detectNaira(text: string, name = ''): string | null {
  const vendor = detectNairaVendor(text, name);
  if (!vendor) return null;
  const head = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].toLowerCase();
  if (!/date|time/.test(head) || !/amount|debit|credit|value|change|quantity/.test(head)) return null;
  return readNaira(text, vendor) ? vendor : null;
}

const fmt = (n: number) => Number(n.toFixed(8)).toLocaleString('en-US', { maximumFractionDigits: 8 });
const naira = (n: number) => '₦' + Math.round(n).toLocaleString('en-NG');

export function buildNaira(read: NairaRead, price: PriceFn, fileName: string): ExchangeImport {
  const src = read.vendor;
  const files = read.files.map(f => ({ ...f, name: f.name || fileName }));
  const events: ExchangeImport['events'] = [], items: ExchangeItem[] = [], withdrawals: Transfer[] = [], deposits: Transfer[] = [];
  const notes = [...read.notes];
  const usdOf = (coin: string, units: number, ts: number, date: string): number | null => {
    if (isStable(coin)) return units;
    const k = priceKeyFor(coin); if (!k) return null;
    const p = price({ chain: 'ethereum', timestamp: ts, date, symbol: coin, priceKey: k, token: null, decimals: 18, units: 1, direction: 'in', hash: 'naira', wallet: 'naira', counterparty: 'naira' } as any);
    return p == null ? null : p * units;
  };
  let n = 0; const id = () => `naira:${src}:${++n}`;
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

  for (const d of read.direct) {
    const i = id();
    if (d.side === 'sell') {
      events.push({ type: 'sell_fiat', id: i, date: d.date, asset: d.coin, units: d.units, naira: d.naira });
      items.push({ id: i, date: d.date, source: src, kind: 'trade', text: `Sold ${fmt(d.units)} ${d.coin} for ${naira(d.naira)}` });
    } else {
      events.push({ type: 'buy_fiat', id: i, date: d.date, asset: d.coin, unitsNet: d.units, naira: d.naira });
      items.push({ id: i, date: d.date, source: src, kind: 'trade', text: `Bought ${fmt(d.units)} ${d.coin} for ${naira(d.naira)}` });
    }
  }
  for (const l of read.legs) {
    const c = classifyNairaDesc(l.op);
    const units = Math.abs(l.change);
    const i = id();
    switch (c.cls) {
      case 'deposit':
        deposits.push({ date: l.date, ts: l.ts, symbol: l.coin, units });
        items.push({ id: i, date: l.date, source: src, kind: 'deposit', text: `Deposited ${fmt(units)} ${l.coin} to ${src}. Treated as a move between your own accounts (not taxable, para 7.2.2).` });
        break;
      case 'withdraw':
        withdrawals.push({ date: l.date, ts: l.ts, symbol: l.coin, units });
        items.push({ id: i, date: l.date, source: src, kind: 'withdraw', text: `Withdrew ${fmt(units)} ${l.coin} from ${src}. Treated as a move to your own wallet (not taxable, para 7.2.2).` });
        break;
      case 'reward': {
        if (l.change <= 0) break;
        const u = usdOf(l.coin, units, l.ts, l.date);
        if (u == null) { items.push({ id: i, date: l.date, source: src, kind: 'reward', text: `${l.op}: ${fmt(units)} ${l.coin}`, review: 'No market price for this coin on that day, so it is not counted.' }); break; }
        events.push({ type: 'income', id: i, kind: c.incomeKind ?? 'other', date: l.date, asset: l.coin, units, usdFmv: u, viaVasp: true });
        items.push({ id: i, date: l.date, source: src, kind: 'reward', text: `${l.op}: ${fmt(units)} ${l.coin}, taxed as income on the day received (para 7.1).` });
        break;
      }
      case 'buy': {
        const nairaHit = nearestNaira(l.ts, false); // buying crypto moves naira out
        if (nairaHit) {
          usedNaira.add(nairaHit.k);
          events.push({ type: 'buy_fiat', id: i, date: l.date, asset: l.coin, unitsNet: units, naira: -nairaHit.amount });
          items.push({ id: i, date: l.date, source: src, kind: 'trade', text: `Bought ${fmt(units)} ${l.coin} for ${naira(-nairaHit.amount)}` });
        } else {
          const u = usdOf(l.coin, units, l.ts, l.date);
          if (u == null) { items.push({ id: i, date: l.date, source: src, kind: 'trade', text: `${l.op || 'Bought'}: ${fmt(units)} ${l.coin}`, review: 'The naira you paid is not in the files we read. Tell us what you paid so the cost base is right.' }); break; }
          events.push({ type: 'opening', id: i, date: l.date, asset: l.coin, units, usdCost: u });
          items.push({ id: i, date: l.date, source: src, kind: 'trade', text: `Bought ${fmt(units)} ${l.coin} (valued at $${u.toFixed(2)} until you tell us the naira you paid).` });
        }
        break;
      }
      case 'sell': {
        const nairaHit = nearestNaira(l.ts, true); // selling brings naira in
        if (nairaHit) {
          usedNaira.add(nairaHit.k);
          events.push({ type: 'sell_fiat', id: i, date: l.date, asset: l.coin, units, naira: nairaHit.amount });
          items.push({ id: i, date: l.date, source: src, kind: 'trade', text: `Sold ${fmt(units)} ${l.coin} for ${naira(nairaHit.amount)}` });
        } else {
          items.push({ id: i, date: l.date, source: src, kind: 'trade', text: `${l.op || 'Sold'}: ${fmt(units)} ${l.coin}`, review: 'The naira you received is not in the files we read. Tell us what you received so the sale is priced right.' });
        }
        break;
      }
      case 'payment': {
        const u = usdOf(l.coin, units, l.ts, l.date);
        if (u == null) { items.push({ id: i, date: l.date, source: src, kind: 'pay_out', text: `${l.op || 'Payment'}: ${fmt(units)} ${l.coin}`, review: 'No market price for this coin that day, so it is not counted.' }); break; }
        events.push({ type: 'swap', id: i, date: l.date, assetOut: l.coin, unitsOut: units, assetIn: '__SPENT__', unitsIn: 0, usdFmvOut: u });
        items.push({ id: i, date: l.date, source: src, kind: 'pay_out', text: `${l.op || 'Paid with crypto'}: ${fmt(units)} ${l.coin} (worth $${u.toFixed(2)}), a disposal at market value (para 9.3.2).` });
        break;
      }
      case 'swap': {
        const u = usdOf(l.coin, units, l.ts, l.date);
        if (l.change > 0) { items.push({ id: i, date: l.date, source: src, kind: 'trade', text: `Received ${fmt(units)} ${l.coin} from a swap. Counted with the coin given up on the same day.` }); break; }
        if (u == null) { items.push({ id: i, date: l.date, source: src, kind: 'trade', text: `Swapped ${fmt(units)} ${l.coin}`, review: 'No market price for this coin that day, so it is not counted.' }); break; }
        events.push({ type: 'swap', id: i, date: l.date, assetOut: l.coin, unitsOut: units, assetIn: '__SPENT__', unitsIn: 0, usdFmvOut: u });
        items.push({ id: i, date: l.date, source: src, kind: 'trade', text: `Swapped ${fmt(units)} ${l.coin} (worth $${u.toFixed(2)}), a disposal of ${l.coin} (para 9.3.2).` });
        break;
      }
      case 'internal': break;
      default:
        items.push({ id: i, date: l.date, source: src, kind: 'unknown', text: `${l.op || 'Unlabelled'}: ${l.change > 0 ? '+' : ''}${fmt(l.change)} ${l.coin}`, review: `We do not recognise this ${src} entry yet, so it is not counted. Tell us what it was.` });
    }
  }
  const leftNaira = read.nairaLegs.filter((_, k) => !usedNaira.has(k) && Math.abs(read.nairaLegs[k].amount) > 0);
  if (leftNaira.length) notes.push(`${leftNaira.length} naira line(s) on the ${src} statement were not tied to a crypto trade; they look like plain naira in or out and are not counted as crypto events.`);
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { events, items, withdrawals, deposits, notes, files };
}
