/**
 * Wallets in, tax report out: fetch history, price it, classify it,
 * convert at official CBN rates, apply the NRS rules.
 */
import { computeReport, Report } from './engine.js';
import { classify, Classified, Label } from './classify.js';
import { estimateIndividual, Estimate } from './estimate.js';
import { loadPrices, priceFn } from './prices.js';
import { loadRates, rateOn } from './rates.js';
import { fetchTron, isTronAddress } from './wallet/tron.js';
import { EVM_CHAINS, fetchEvm, isEvmAddress } from './wallet/evm.js';
import type { ChainId, Movement } from './wallet/types.js';

export interface PipelineInput {
  wallets: string[];
  year: number;
  chains?: ChainId[];          // EVM chains to scan for 0x addresses (default: all supported)
  labels?: Record<string, Label>;
  otherChargeableNaira?: number;
  method?: 'FIFO' | 'WAC';
  fetchImpl?: typeof fetch;
}

export interface PipelineOutput {
  year: number;
  moves: Movement[];
  classified: Classified;
  report: Report;
  estimate: Estimate;
  rateNotes: string[];
  sources: string[];
  errors: string[];
}

// Fetched history and prices are kept for 20 minutes so relabelling does not refetch.
const historyCache = new Map<string, { at: number; moves: Movement[]; errors: string[]; prices: Map<string, number | null> }>();
const HISTORY_TTL = 20 * 60_000;

export async function runPipeline(inp: PipelineInput): Promise<PipelineOutput> {
  const f = inp.fetchImpl ?? fetch;
  const cacheKey = [inp.year, ...[...inp.wallets].sort(), ...(inp.chains ?? [])].join('|');
  const hit = historyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < HISTORY_TTL) return finish(inp, hit.moves, hit.prices, [...hit.errors], f);
  // History from 1 Jan 2025 so earlier purchases give a cost base for this year's sales.
  const from = Date.UTC(inp.year - 1, 0, 1) / 1000;
  const to = Math.min(Date.UTC(inp.year, 11, 31, 23, 59, 59) / 1000, Math.floor(Date.now() / 1000));
  const errors: string[] = [];
  const moves: Movement[] = [];
  const evmChains = (inp.chains ?? (Object.keys(EVM_CHAINS) as ChainId[])).filter(c => c !== 'tron') as Exclude<ChainId, 'tron'>[];

  await Promise.all(inp.wallets.map(async w => {
    try {
      if (isTronAddress(w)) moves.push(...await fetchTron(w, { from, to, fetchImpl: f }));
      else if (isEvmAddress(w)) {
        for (const c of evmChains) {
          try { moves.push(...await fetchEvm(c, w, { from, to, fetchImpl: f })); }
          catch (e) { errors.push(`${c} history for ${short(w)} could not be read (${(e as Error).message}).`); }
        }
      } else errors.push(`${w} is not a Tron or EVM address.`);
    } catch (e) { errors.push(`History for ${short(w)} could not be read (${(e as Error).message}).`); }
  }));
  moves.sort((a, b) => a.timestamp - b.timestamp);
  const prices = await loadPrices(moves, f);
  if (historyCache.size > 300) historyCache.clear();
  historyCache.set(cacheKey, { at: Date.now(), moves, errors: [...errors], prices });
  return finish(inp, moves, prices, errors, f);
}

async function finish(
  inp: PipelineInput, moves: Movement[], prices: Map<string, number | null>, errors: string[], f: typeof fetch,
): Promise<PipelineOutput> {
  const rates = await loadRates(f);
  const price = priceFn(prices);
  const classified = classify(moves, price, inp.wallets, inp.labels);

  const rateNotes = new Set<string>();
  const rate = (d: string) => {
    const r = rateOn(rates, d);
    if (r.rateDate !== d) rateNotes.add(`${d}: no CBN rate published, used ${r.rateDate} (₦${r.rate}).`);
    return r.rate;
  };

  // Everything before the tax year only builds cost base; only this year's disposals and income count.
  const all = computeReport(classified.events, { rate, method: inp.method });
  const y = String(inp.year);
  const report: Report = {
    ...all,
    disposals: all.disposals.filter(d => d.date.startsWith(y)),
    income: all.income.filter(i => i.date.startsWith(y)),
  };
  report.totals = totalsFor(report);
  const estimate = estimateIndividual(report, inp.otherChargeableNaira ?? 0);

  return {
    year: inp.year, moves, classified, report, estimate,
    rateNotes: [...rateNotes].slice(0, 50),
    sources: [
      'Rules: NRS Information Circular 2026/21, Guidelines on the Taxation of Virtual Assets (31 July 2026)',
      'Naira rates: CBN central rate, https://www.cbn.gov.ng/api/GetAllExchangeRates',
      'Token prices: DefiLlama historical prices (NRS has not yet published its approved price sources)',
      'Wallet history: TronGrid and public Blockscout explorers',
    ],
    errors,
  };
}

function totalsFor(r: Report): Report['totals'] {
  const gains = r.disposals.filter(d => d.nairaGain > 0).reduce((s, d) => s + d.nairaGain, 0);
  const losses = -r.disposals.filter(d => d.nairaGain < 0).reduce((s, d) => s + d.nairaGain, 0);
  const net = gains - losses;
  const inc = r.income.reduce((s, i) => s + i.naira, 0);
  const wht = r.disposals.reduce((s, d) => s + d.whtNaira, 0) + r.income.reduce((s, i) => s + i.whtNaira, 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    gainsNaira: r2(gains), lossesNaira: r2(losses), netDisposalNaira: r2(net),
    lossesUsedNaira: 0, lossCarriedForwardNaira: r2(net < 0 ? -net : 0),
    chargeableGainsNaira: r2(Math.max(0, net)), incomeNaira: r2(inc),
    vaChargeableNaira: r2(Math.max(0, net) + inc), whtCreditNaira: r2(wht),
  };
}

const short = (w: string) => w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
