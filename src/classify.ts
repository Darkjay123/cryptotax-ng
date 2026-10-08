/**
 * Turns raw wallet movements into tax events, with a plain-English reason
 * for each guess. The user can relabel anything; labels override guesses.
 */
import { STABLECOINS } from './rules.js';
import type { IncomeKind, TaxEvent } from './engine.js';
import type { PriceFn } from './prices.js';
import type { Movement } from './wallet/types.js';

export type Label =
  | { kind: 'income'; incomeKind: IncomeKind }
  | { kind: 'own_wallet' }
  | { kind: 'bought'; naira: number }       // received after paying naira (P2P buy)
  | { kind: 'sold'; naira: number }         // sent after receiving naira (P2P sell)
  | { kind: 'payment' }                     // spent on goods or services (taxable disposal at FMV)
  | { kind: 'gift_in' } | { kind: 'gift_out' }
  | { kind: 'ignore' };

export interface Row {
  id: string;                // chain:hash:index
  move: Movement;
  usd: number | null;        // dollar value of this movement
  guess: Label | null;
  label: Label | null;       // the label actually used
  reason: string;
  swapWith?: string;         // id of the other leg if this is half of a swap
}

export interface Classified { rows: Row[]; events: TaxEvent[]; unpriced: Row[]; needsReview: number }

const isStable = (s: string) => !!STABLECOINS[s];

export function classify(
  moves: Movement[], price: PriceFn, myWallets: string[], labels: Record<string, Label> = {},
): Classified {
  const mine = new Set(myWallets.map(w => w.toLowerCase()));
  const rows: Row[] = moves.map((m, i) => {
    const p = price(m);
    return { id: `${m.chain}:${m.hash}:${i}`, move: m, usd: p == null ? null : p * m.units, guess: null, label: null, reason: '' };
  });

  // Swaps: one transaction where a different asset leaves and arrives.
  const byTx = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.move.chain}:${r.move.hash}`;
    byTx.set(k, [...(byTx.get(k) ?? []), r]);
  }
  for (const group of byTx.values()) {
    const outs = group.filter(r => r.move.direction === 'out');
    const ins = group.filter(r => r.move.direction === 'in');
    if (outs.length === 1 && ins.length === 1 && outs[0].move.symbol !== ins[0].move.symbol) {
      outs[0].swapWith = ins[0].id; ins[0].swapWith = outs[0].id;
    }
  }

  for (const r of rows) {
    const m = r.move;
    if (r.swapWith) {
      r.reason = 'Swapped in one transaction: a disposal of what left and a purchase of what arrived (para 9.3.2).';
      continue;
    }
    if (mine.has(m.counterparty.toLowerCase())) {
      r.guess = { kind: 'own_wallet' };
      r.reason = 'Moved between your own wallets. Not taxable (para 7.2.2).';
    } else if (m.direction === 'in' && isStable(m.symbol)) {
      r.guess = { kind: 'income', incomeKind: 'professional' };
      r.reason = 'Stablecoin received from someone else. Guessed as payment for work, taxed as income on the day received. Change it if you bought it with naira or it came from your own exchange account.';
    } else if (m.direction === 'in') {
      r.guess = null;
      r.reason = 'Received from someone else. Tell us what it was: payment, a purchase, a reward or your own exchange account.';
    } else if (isStable(m.symbol)) {
      r.guess = { kind: 'payment' };
      r.reason = 'Stablecoin sent out. Gains on stablecoins are measured against the dollar peg, so this is normally nil (para 9.5(1)).';
    } else {
      r.guess = { kind: 'payment' };
      r.reason = 'Sent to someone else, treated as a disposal at market value. Mark it as your own wallet or a P2P sale if that is what it was.';
    }
  }

  for (const r of rows) r.label = labels[r.id] ?? r.guess;

  // Build engine events.
  const events: TaxEvent[] = [];
  const done = new Set<string>();
  const unpriced: Row[] = [];
  for (const r of rows) {
    if (done.has(r.id)) continue;
    const m = r.move;
    if (r.swapWith && !labels[r.id]) {
      const other = rows.find(x => x.id === r.swapWith)!;
      const out = m.direction === 'out' ? r : other, inn = m.direction === 'out' ? other : r;
      done.add(out.id); done.add(inn.id);
      const fmv = out.usd ?? inn.usd;
      if (fmv == null) { unpriced.push(out); continue; }
      events.push({ type: 'swap', id: out.id, date: m.date, assetOut: out.move.symbol, unitsOut: out.move.units,
        assetIn: inn.move.symbol, unitsIn: inn.move.units, usdFmvOut: fmv });
      continue;
    }
    done.add(r.id);
    const L = r.label;
    if (!L || L.kind === 'ignore') {
      // Unlabelled receipts still need a cost base so later sales are not taxed on the full amount.
      if (!L && m.direction === 'in' && r.usd != null) events.push({ type: 'opening', id: r.id, date: m.date, asset: m.symbol, units: m.units, usdCost: r.usd });
      continue;
    }
    switch (L.kind) {
      case 'own_wallet': break;
      case 'income':
        if (r.usd == null) { unpriced.push(r); break; }
        events.push({ type: 'income', id: r.id, kind: L.incomeKind, date: m.date, asset: m.symbol, units: m.units, usdFmv: r.usd });
        break;
      case 'bought':
        events.push({ type: 'buy_fiat', id: r.id, date: m.date, asset: m.symbol, unitsNet: m.units, naira: L.naira });
        break;
      case 'gift_in':
        // Para 7.1 item 15: recipient's cost is market value (s.36(2) NTA); gain deferred to disposal.
        if (r.usd == null) { unpriced.push(r); break; }
        events.push({ type: 'opening', id: r.id, date: m.date, asset: m.symbol, units: m.units, usdCost: r.usd });
        break;
      case 'sold':
        events.push({ type: 'sell_fiat', id: r.id, date: m.date, asset: m.symbol, units: m.units, naira: L.naira });
        break;
      case 'payment':
        if (r.usd == null) { unpriced.push(r); break; }
        // Para 7.1 item 5: paying with crypto is a disposal at dollar FMV. Reuse sell logic in dollars.
        events.push({ type: 'swap', id: r.id, date: m.date, assetOut: m.symbol, unitsOut: m.units, assetIn: '__SPENT__', unitsIn: 0, usdFmvOut: r.usd });
        break;
      case 'gift_out': break; // no income tax on donor (item 15)
    }
  }
  const needsReview = rows.filter(r => !r.label).length;
  return { rows, events, unpriced, needsReview };
}
