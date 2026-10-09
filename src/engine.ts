/**
 * Computes a Nigerian virtual-asset tax position from a list of events,
 * following the dollar-referenced method in para 9 of the NRS Guidelines.
 *
 * All gains are first measured in USD, then converted to naira at the
 * CBN/NAFEM rate on the date of each disposal (para 9.1.1, 9.4(2)).
 */
import {
  Category, STABLECOINS, WHT_DISPOSAL_RATE, round2, whtAppliesOnDisposal,
} from './rules.js';

export type IncomeKind =
  | 'professional' | 'employment' | 'business'
  | 'staking' | 'mining' | 'defi' | 'airdrop' | 'other';

interface Base { date: string; id?: string; note?: string }

/** Bought tokens with naira. unitsNet = units actually credited, after stamp duty. */
export interface BuyFiat extends Base { type: 'buy_fiat'; asset: string; unitsNet: number; naira: number }
/** Sold tokens for naira. */
export interface SellFiat extends Base { type: 'sell_fiat'; asset: string; units: number; naira: number; viaVasp?: boolean }
/** Swapped one token for another. usdFmvOut = dollar FMV of what was given up (para 9.1.2 step 2b). */
export interface Swap extends Base {
  type: 'swap'; assetOut: string; unitsOut: number; assetIn: string; unitsIn: number;
  usdFmvOut: number; viaVasp?: boolean;
}
/** Tokens received as income (fees, salary, staking, airdrop...). usdFmv = total dollar FMV at receipt. */
export interface Income extends Base { type: 'income'; kind: IncomeKind; asset: string; units: number; usdFmv: number; whtNairaDeducted?: number }
/** Acquired with a known dollar cost that is not a taxable event for this taxpayer (e.g. opening balance). */
export interface Opening extends Base { type: 'opening'; asset: string; units: number; usdCost: number }
/** Moved between wallets you own (para 7.2.2) or wrapped/unwrapped (para 10.1). Not a disposal. */
export interface SelfTransfer extends Base { type: 'self_transfer'; asset: string; units: number; toAsset?: string }

export type TaxEvent = BuyFiat | SellFiat | Swap | Income | Opening | SelfTransfer;

export interface Options {
  /** CBN/NAFEM naira per USD on an ISO date (YYYY-MM-DD). */
  rate: (date: string) => number;
  /** Para 9.3.3(3): FIFO by default; weighted average if elected consistently. */
  method?: 'FIFO' | 'WAC';
  /** Category override per asset symbol; default: stablecoin list -> 2, everything else -> 1. */
  categoryOf?: (asset: string) => Category;
  /** Capital losses brought forward from earlier years, in naira (para 9.4(7)). */
  lossesBroughtForwardNaira?: number;
  /** Only warn about missing purchase records for disposals on or after this ISO date (the tax year). */
  warnFrom?: string;
}

interface Lot { units: number; usdPerUnit: number; date: string }

export interface DisposalLine {
  date: string; asset: string; units: number; category: Category;
  usdProceeds: number; usdCost: number; usdGain: number;
  rate: number; nairaGain: number;
  whtUnits: number; whtNaira: number;
  shortfallUnits: number; // units sold that had no recorded acquisition (cost treated as nil)
  sourceId?: string;
}

export interface IncomeLine {
  date: string; asset: string; units: number; kind: IncomeKind;
  usdFmv: number; rate: number; naira: number; whtNaira: number; sourceId?: string;
}

export interface Report {
  disposals: DisposalLine[];
  income: IncomeLine[];
  totals: {
    gainsNaira: number; lossesNaira: number; netDisposalNaira: number;
    lossesUsedNaira: number; lossCarriedForwardNaira: number;
    chargeableGainsNaira: number; incomeNaira: number;
    vaChargeableNaira: number; whtCreditNaira: number;
  };
  holdings: Record<string, { units: number; usdCost: number }>;
  warnings: string[];
}

const EPS = 1e-12;

export function defaultCategory(asset: string): Category {
  return STABLECOINS[asset.toUpperCase()] ? 2 : 1;
}

export function computeReport(events: TaxEvent[], opts: Options): Report {
  const method = opts.method ?? 'FIFO';
  const catOf = opts.categoryOf ?? defaultCategory;
  const lots = new Map<string, Lot[]>();
  const disposals: DisposalLine[] = [];
  const income: IncomeLine[] = [];
  const warnings: string[] = [];
  const shortfalls = new Map<string, { units: number; first: string; count: number }>();

  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));

  const addLot = (asset: string, units: number, usdTotal: number, date: string) => {
    if (units <= EPS) return;
    const k = asset.toUpperCase();
    const arr = lots.get(k) ?? [];
    if (method === 'WAC' && arr.length) {
      const u = arr.reduce((s, l) => s + l.units, 0) + units;
      const c = arr.reduce((s, l) => s + l.units * l.usdPerUnit, 0) + usdTotal;
      lots.set(k, [{ units: u, usdPerUnit: c / u, date }]);
    } else {
      arr.push({ units, usdPerUnit: usdTotal / units, date });
      lots.set(k, arr);
    }
  };

  /** Removes units from the pool; returns their dollar cost and any unmatched units. */
  const takeLots = (asset: string, units: number): { usdCost: number; shortfall: number } => {
    const arr = lots.get(asset.toUpperCase()) ?? [];
    let left = units, cost = 0;
    while (left > EPS && arr.length) {
      const lot = arr[0];
      const used = Math.min(lot.units, left);
      cost += used * lot.usdPerUnit;
      lot.units -= used; left -= used;
      if (lot.units <= EPS) arr.shift();
    }
    return { usdCost: cost, shortfall: left > EPS ? left : 0 };
  };

  const dispose = (
    e: Base, asset: string, units: number, usdProceeds: number, viaVasp: boolean,
  ) => {
    const category = catOf(asset);
    const rate = opts.rate(e.date);
    const taken = takeLots(asset, units);
    let usdCost = taken.usdCost;
    if (category === 2) {
      // Para 9.1.1(2) / 9.5(1): stablecoin gains are measured against the peg.
      usdCost = units; // 1 unit = 1 USD of peg
      if (taken.shortfall) usdCost = units;
    }
    if (taken.shortfall && category !== 2 && (!opts.warnFrom || e.date >= opts.warnFrom)) {
      const k = asset.toUpperCase();
      const s0 = shortfalls.get(k) ?? { units: 0, first: e.date, count: 0 };
      s0.units += taken.shortfall; s0.count += 1; shortfalls.set(k, s0);
    }
    const usdGain = usdProceeds - usdCost;
    const wht = viaVasp && whtAppliesOnDisposal(category);
    const whtUnits = wht ? units * WHT_DISPOSAL_RATE : 0;
    disposals.push({
      date: e.date, asset: asset.toUpperCase(), units, category,
      usdProceeds: round6(usdProceeds), usdCost: round6(usdCost), usdGain: round6(usdGain),
      rate, nairaGain: round2(usdGain * rate),
      whtUnits: round8(whtUnits),
      // Para 9.1.2 step 5(c): naira value of the withheld token on the withholding date.
      whtNaira: round2(wht ? usdProceeds * WHT_DISPOSAL_RATE * rate : 0),
      shortfallUnits: category === 2 ? 0 : taken.shortfall,
      sourceId: e.id,
    });
  };

  for (const e of sorted) {
    switch (e.type) {
      case 'opening':
        addLot(e.asset, e.units, e.usdCost, e.date);
        break;
      case 'buy_fiat': {
        // Para 9.3.1: cost base = naira paid / net units, converted at the acquisition-date rate.
        const usd = e.naira / opts.rate(e.date);
        addLot(e.asset, e.unitsNet, usd, e.date);
        break;
      }
      case 'sell_fiat': {
        // Para 9.1.2 step 2a: naira proceeds / rate on the disposal date.
        const usd = e.naira / opts.rate(e.date);
        dispose(e, e.asset, e.units, usd, e.viaVasp ?? false);
        break;
      }
      case 'swap': {
        // Para 9.1.2 step 2b + 9.3.2: proceeds = FMV of what was given up; new token's cost base = same.
        dispose(e, e.assetOut, e.unitsOut, e.usdFmvOut, e.viaVasp ?? false);
        addLot(e.assetIn, e.unitsIn, e.usdFmvOut, e.date);
        break;
      }
      case 'income': {
        // Para 6.1.1(3), 9.5(3)-(4), 9.6: income at dollar FMV on receipt x rate; cost base stepped up.
        const rate = opts.rate(e.date);
        income.push({
          date: e.date, asset: e.asset.toUpperCase(), units: e.units, kind: e.kind,
          usdFmv: round6(e.usdFmv), rate, naira: round2(e.usdFmv * rate),
          whtNaira: round2(e.whtNairaDeducted ?? 0), sourceId: e.id,
        });
        addLot(e.asset, e.units, e.usdFmv, e.date);
        break;
      }
      case 'self_transfer': {
        // Para 7.2.2 and 10.1: not a disposal. A wrap carries cost and holding period across.
        if (e.toAsset && e.toAsset.toUpperCase() !== e.asset.toUpperCase()) {
          const t = takeLots(e.asset, e.units);
          addLot(e.toAsset, e.units, t.usdCost, e.date);
        }
        break;
      }
    }
  }

  for (const [asset, sf] of shortfalls) {
    warnings.push(`${fmt(sf.units)} ${asset} left your wallet (${sf.count} time${sf.count > 1 ? 's' : ''}, first on ${sf.first}) with no record of how you got it, so its cost is treated as nil. Add the wallet you bought it from, or label the purchase, to lower the tax.`);
  }

  // Para 9.4: net all disposals for the year in naira; losses only against VA gains, carried forward indefinitely.
  const gains = disposals.filter(d => d.nairaGain > 0).reduce((s, d) => s + d.nairaGain, 0);
  const losses = -disposals.filter(d => d.nairaGain < 0).reduce((s, d) => s + d.nairaGain, 0);
  const net = gains - losses;
  const bf = opts.lossesBroughtForwardNaira ?? 0;
  const used = net > 0 ? Math.min(net, bf) : 0;
  const chargeable = Math.max(0, net - used);
  const carried = (net < 0 ? -net : 0) + (bf - used);
  const incomeNaira = income.reduce((s, i) => s + i.naira, 0);
  const wht = disposals.reduce((s, d) => s + d.whtNaira, 0) + income.reduce((s, i) => s + i.whtNaira, 0);

  const holdings: Report['holdings'] = {};
  for (const [k, arr] of lots) {
    const units = arr.reduce((s, l) => s + l.units, 0);
    if (units > EPS) holdings[k] = { units: round8(units), usdCost: round6(arr.reduce((s, l) => s + l.units * l.usdPerUnit, 0)) };
  }

  return {
    disposals, income,
    totals: {
      gainsNaira: round2(gains), lossesNaira: round2(losses), netDisposalNaira: round2(net),
      lossesUsedNaira: round2(used), lossCarriedForwardNaira: round2(carried),
      chargeableGainsNaira: round2(chargeable), incomeNaira: round2(incomeNaira),
      vaChargeableNaira: round2(chargeable + incomeNaira), whtCreditNaira: round2(wht),
    },
    holdings, warnings,
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const round8 = (n: number) => Math.round(n * 1e8) / 1e8;
const fmt = (n: number) => String(round8(n));
