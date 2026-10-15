/**
 * Wallets in, tax report out: fetch history, price it, classify it,
 * convert at official CBN rates, apply the NRS rules.
 */
import { computeReport, Report } from './engine.js';
import { classify, Classified, Label } from './classify.js';
import { estimateIndividual, Estimate } from './estimate.js';
import { loadPrices, priceFn } from './prices.js';
import { loadRates, rateOn } from './rates.js';
import { FALLBACK_RATE_SNAPSHOT_AT } from './rates-fallback.js';
import { fetchTron, isTronAddress } from './wallet/tron.js';
import { fetchBtc, isBtcAddress } from './wallet/btc.js';
import { EVM_CHAINS, fetchEvm, isEvmAddress } from './wallet/evm.js';
import { ES_CHAINS, fetchEs } from './wallet/etherscanish.js';
import { ANKR_CHAINS, AnkrChainId, ankrKey, fetchAnkr } from './wallet/ankr.js';
import type { ChainId, Movement } from './wallet/types.js';
import { buildBinance, ExchangeImport, matchTransfers, priceNeeds, readBinanceFiles } from './exchange/binance.js';
import { buildBybit, detectBybit, readBybit } from './exchange/bybit.js';
import { buildQuidax, detectQuidax, readQuidax } from './exchange/quidax.js';
import { buildNaira, detectNaira, readNaira } from './exchange/naira.js';
import { parseStatementPdf, PdfStatement } from './exchange/pdfimport.js';
import { createHash } from 'node:crypto';

export interface PipelineInput {
  wallets: string[];
  year: number;
  chains?: ChainId[];          // EVM chains to scan for 0x addresses (default: all supported)
  labels?: Record<string, Label>;
  /** Exchange exports the user uploaded (Binance Transaction History / P2P Order History CSV). */
  exchangeFiles?: { name: string; text: string }[];
  /** Exchange statements uploaded as PDF (base64); parsed into the same reader shapes. */
  exchangePdfs?: { name: string; b64: string }[];
  otherChargeableNaira?: number;
  /** Proceeds the user says were reinvested in Nigerian companies within 12 months (estimate-level relief). */
  reinvestedNaira?: number;
  /** Capital losses from earlier years carried forward against this year's gains (para 9.4). */
  lossesBroughtForwardNaira?: number;
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
  exchange: (ExchangeImport & { matched: number }) | null;
}

// Fetched history and prices are kept for 20 minutes so relabelling does not refetch.
const historyCache = new Map<string, { at: number; moves: Movement[]; errors: string[]; prices: Map<string, number | null> }>();
const HISTORY_TTL = 20 * 60_000;

export async function runPipeline(inp: PipelineInput): Promise<PipelineOutput> {
  const f = inp.fetchImpl ?? fetch;
  const aKey = ankrKey();
  const cacheKey = [inp.year, ...[...inp.wallets].sort(), ...(inp.chains ?? []), aKey ? 'ankr' : 'noankr'].join('|');
  const pdfParts = await readPdfs(inp.exchangePdfs ?? []);
  // A PDF that could not be read still owes the user an explanation, even when
  // it is the only upload and no exchange panel is built.
  const pdfFailNotes = [...pdfParts.info.values()].filter(st => !st.csv && st.notes.length).flatMap(st => st.notes);
  const ex = await loadExchange([...(inp.exchangeFiles ?? []), ...pdfParts.files], f, pdfParts.info);
  const hit = historyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < HISTORY_TTL) {
    const out = await finish(inp, hit.moves, hit.prices, [...hit.errors], f, ex);
    if (pdfFailNotes.length) out.errors.push(...pdfFailNotes);
    return out;
  }
  // Read back to 2020 so older purchases give a cost base for this year's sales (para 9.3).
  const from = Date.UTC(2020, 0, 1) / 1000;
  const to = Math.min(Date.UTC(inp.year, 11, 31, 23, 59, 59) / 1000, Math.floor(Date.now() / 1000));
  const errors: string[] = [];
  const moves: Movement[] = [];
  const ankrChains = aKey ? (Object.keys(ANKR_CHAINS) as AnkrChainId[]) : [];
  const evmChains = (inp.chains ?? ([...Object.keys(EVM_CHAINS), ...Object.keys(ES_CHAINS), ...ankrChains] as ChainId[])).filter(c => c !== 'tron' && c !== 'bitcoin') as Exclude<ChainId, 'tron' | 'bitcoin'>[];

  await Promise.all(inp.wallets.map(async w => {
    try {
      if (isTronAddress(w)) moves.push(...await fetchTron(w, { from, to, fetchImpl: f, maxPages: 40, onTruncated: () => errors.push(`Tron history for ${short(w)} is very long; only the most recent records were read, so some older purchases may be missing.`) }));
      else if (isBtcAddress(w)) moves.push(...await fetchBtc(w, { from, to, fetchImpl: f, onTruncated: () => errors.push(`Bitcoin history for ${short(w)} is very long; only the most recent records were read, so some older purchases may be missing.`) }));
      else if (isEvmAddress(w)) {
        for (let i = 0; i < evmChains.length; i += 6) {
          await Promise.all(evmChains.slice(i, i + 6).map(async c => {
            const es = (ES_CHAINS as Record<string, (typeof ES_CHAINS)['avalanche']>)[c];
            const a = (ANKR_CHAINS as Record<string, (typeof ANKR_CHAINS)['bsc']>)[c];
            const opts = { from, to, fetchImpl: f, onTruncated: (what: string) => errors.push(`${c} ${what} for ${short(w)} is very long; only the most recent 2,000 were read, so some older purchases may be missing.`) };
            try { moves.push(...await (a ? fetchAnkr(c as AnkrChainId, w, opts) : es ? fetchEs(c as keyof typeof ES_CHAINS, w, opts) : fetchEvm(c as Exclude<ChainId, 'tron' | 'bitcoin' | 'avalanche' | 'metis' | 'bsc' | 'opbnb' | 'fantom' | 'sonic'>, w, opts))); }
            catch (e) { errors.push(`${c} history for ${short(w)} could not be read (${(e as Error).message}).`); }
          }));
        }
      } else errors.push(`${w} is not a Tron, EVM or Bitcoin address.`);
    } catch (e) { errors.push(`History for ${short(w)} could not be read (${(e as Error).message}).`); }
  }));
  moves.sort((a, b) => a.timestamp - b.timestamp);
  const prices = await loadPrices(moves, f);
  if (historyCache.size > 300) historyCache.clear();
  historyCache.set(cacheKey, { at: Date.now(), moves, errors: [...errors], prices });
  const out = await finish(inp, moves, prices, errors, f, ex);
  if (pdfFailNotes.length) out.errors.push(...pdfFailNotes);
  return out;
}

// Parsed exchange files and their coin prices, cached by file contents for relabelling.
type ExData = { read: { binance: ReturnType<typeof readBinanceFiles>; bybit: NonNullable<ReturnType<typeof readBybit>>[]; quidax: NonNullable<ReturnType<typeof readQuidax>>[]; naira: NonNullable<ReturnType<typeof readNaira>>[] }; prices: Map<string, number | null>; pdfInfo: Map<string, PdfStatement> } | null;

/** Parses uploaded PDF statements into the CSV shape their reader already knows. */
async function readPdfs(pdfs: { name: string; b64: string }[]): Promise<{ files: { name: string; text: string }[]; info: Map<string, PdfStatement> }> {
  const files: { name: string; text: string }[] = [];
  const info = new Map<string, PdfStatement>();
  for (const p of pdfs) {
    const b64 = p.b64.replace(/^data:application\/pdf;base64,/, '');
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(Buffer.from(b64, 'base64')); } catch { continue; }
    const st = await parseStatementPdf(p.name, bytes);
    info.set(p.name, st);
    if (st.csv) files.push({ name: p.name, text: st.csv });
  }
  return { files, info };
}
const exCache = new Map<string, { at: number; data: ExData }>();
async function loadExchange(files: { name: string; text: string }[], f: typeof fetch, pdfInfo: Map<string, PdfStatement> = new Map()): Promise<ExData> {
  if (!files.length) return null;
  const key = createHash('sha256').update(JSON.stringify(files.map(x => x.text))).digest('hex');
  const hit = exCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL) return hit.data;
  const read = { binance: readBinanceFiles(files), bybit: [] as NonNullable<ReturnType<typeof readBybit>>[], quidax: [] as NonNullable<ReturnType<typeof readQuidax>>[], naira: [] as NonNullable<ReturnType<typeof readNaira>>[] };
  const names = new Map(files.map(f => [f.text, f.name]));
  const skipped = new Set(files.map(f => f.name));
  for (const f of read.binance.files) if (f.kind !== 'unknown') skipped.delete(f.name);
  for (const file of files) {
    if (!skipped.has(file.name)) continue;
    if (detectBybit(file.text)) { const r = readBybit(file.text); if (r) { r.files.forEach(f => f.name = file.name); const st = pdfInfo.get(file.name); if (st) r.sourceName = st.exchange; read.bybit.push({ ...r, name: file.name }); skipped.delete(file.name); } }
    else if (detectQuidax(file.text)) { const r = readQuidax(file.text); if (r) { r.files.forEach(f => f.name = file.name); read.quidax.push({ ...r, name: file.name }); skipped.delete(file.name); } }
    else { const vendor = detectNaira(file.text, file.name); if (vendor) { const r = readNaira(file.text, vendor); if (r) { r.files.forEach(f => f.name = file.name); read.naira.push({ ...r, name: file.name }); skipped.delete(file.name); } } }
  }
  const allLegs = [...read.binance.legs, ...read.bybit.flatMap(b => b.legs), ...read.quidax.flatMap(q => q.legs), ...read.naira.flatMap(n => n.legs)];
  const prices = await loadPrices(priceNeeds(allLegs), f);
  const data = { read, prices, pdfInfo };
  if (exCache.size > 100) exCache.clear();
  exCache.set(key, { at: Date.now(), data });
  return data;
}

async function finish(
  inp: PipelineInput, moves: Movement[], prices: Map<string, number | null>, errors: string[], f: typeof fetch, ex: ExData = null,
): Promise<PipelineOutput> {
  const rates = await loadRates(f);
  const price = priceFn(prices);
  const pf = ex ? priceFn(ex.prices) : null;
  // Quidax splits its naira and crypto statements into two files; they only make
  // sense together, so all Quidax files are merged into one read before building.
  const quidaxAll = ex && ex.read.quidax.length ? {
    legs: ex.read.quidax.flatMap(q => q.legs),
    nairaLegs: ex.read.quidax.flatMap(q => q.nairaLegs),
    files: ex.read.quidax.flatMap(q => q.files),
    notes: ex.read.quidax.flatMap(q => q.notes),
    name: ex.read.quidax[0]?.name ?? '',
  } : null;
  const built = ex && pf ? [
    buildBinance(ex.read.binance, pf),
    ...ex.read.bybit.map(b => buildBybit(b, pf, b.name ?? '', b.sourceName)),
    ...(quidaxAll ? [buildQuidax(quidaxAll, pf, quidaxAll.name ?? '')] : []),
    ...ex.read.naira.map(n => buildNaira(n, pf, n.name ?? '')),
  ] : [];
  const imports: ExchangeImport[] = built.filter(Boolean) as ExchangeImport[];
  // The Binance reader marks files it does not recognise as "unknown"; when another
  // reader handled that same upload, drop the confusing duplicate entry.
  const handled = new Set(imports.flatMap(x => x.files).filter(f => f.kind !== 'unknown').map(f => f.name));
  const merged: ExchangeImport | null = imports.length ? {
    events: imports.flatMap(x => x.events),
    items: imports.flatMap(x => x.items),
    withdrawals: imports.flatMap(x => x.withdrawals),
    deposits: imports.flatMap(x => x.deposits),
    notes: imports.flatMap(x => x.notes),
    files: imports.flatMap(x => x.files).filter(f => f.kind !== 'unknown' || !handled.has(f.name)),
  } : null;
  if (merged && ex) {
    // PDFs read through the standard readers still carry their own file label.
    for (const fe of merged.files) {
      const st = ex.pdfInfo.get(fe.name);
      if (st) fe.kind = st.detected === 'binance_transactions' ? 'binance_pdf' : st.detected === 'binance_p2p' ? 'binance_p2p_pdf'
        : st.detected === 'quidax' ? 'quidax_pdf' : st.detected === 'bybit' ? 'bybit_pdf' : 'pdf_generic';
    }
    for (const [n, st] of ex.pdfInfo) if (st.notes.length) merged.notes.push(...st.notes.map(t => `${n}: ${t}`));
  }
  const hints = merged ? matchTransfers(moves, merged) : new Map<number, string>();
  const classified = classify(moves, price, inp.wallets, inp.labels, hints);
  if (merged) classified.events.push(...merged.events);

  const rateNotes = new Set<string>();
  if (rates.fallback) rateNotes.add(`The CBN rate feed could not be reached just now, so the bundled snapshot of CBN central rates (generated ${FALLBACK_RATE_SNAPSHOT_AT}) was used.`);
  const rate = (d: string) => {
    const r = rateOn(rates, d);
    if (r.rateDate !== d) rateNotes.add(`${d}: no CBN rate published, used ${r.rateDate} (₦${r.rate}).`);
    return r.rate;
  };

  // Everything before the tax year only builds cost base; only this year's disposals and income count.
  const all = computeReport(classified.events, { rate, method: inp.method, warnFrom: `${inp.year}-01-01`, lossesBroughtForwardNaira: inp.lossesBroughtForwardNaira });
  const y = String(inp.year);
  const report: Report = {
    ...all,
    disposals: all.disposals.filter(d => d.date.startsWith(y)),
    income: all.income.filter(i => i.date.startsWith(y)),
  };
  report.totals = totalsFor(report, inp.lossesBroughtForwardNaira ?? 0);
  const estimate = estimateIndividual(report, inp.otherChargeableNaira ?? 0, inp.reinvestedNaira ?? 0);

  return {
    year: inp.year, moves, classified, report, estimate,
    rateNotes: [...rateNotes].slice(0, 50),
    sources: [
      'Rules: NRS Information Circular 2026/21, Guidelines on the Taxation of Virtual Assets (31 July 2026)',
      'Naira rates: CBN central rate, https://www.cbn.gov.ng/api/GetAllExchangeRates',
      'Token prices: DefiLlama historical prices (NRS has not yet published its approved price sources)',
      'Wallet history: TronGrid and public Blockscout explorers',
      ...(merged ? ['Exchange history: the exchange and on/off-ramp statements you uploaded (Binance, Bybit, Quidax, Busha, Luno, Bitnob, Yellow Card, Breet, Spenda, Azza and others; read in your browser session, not stored)'] : []),
    ],
    errors,
    exchange: merged ? { ...merged, matched: hints.size } : null,
  };
}

function totalsFor(r: Report, bf: number): Report['totals'] {
  const gains = r.disposals.filter(d => d.nairaGain > 0).reduce((s, d) => s + d.nairaGain, 0);
  const losses = -r.disposals.filter(d => d.nairaGain < 0).reduce((s, d) => s + d.nairaGain, 0);
  const net = gains - losses;
  const inc = r.income.reduce((s, i) => s + i.naira, 0);
  const wht = r.disposals.reduce((s, d) => s + d.whtNaira, 0) + r.income.reduce((s, i) => s + i.whtNaira, 0);
  const used = net > 0 ? Math.min(net, bf) : 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    gainsNaira: r2(gains), lossesNaira: r2(losses), netDisposalNaira: r2(net),
    lossesUsedNaira: r2(used), lossCarriedForwardNaira: r2((net < 0 ? -net : 0) + (bf - used)),
    chargeableGainsNaira: r2(Math.max(0, net - used)), incomeNaira: r2(inc),
    vaChargeableNaira: r2(Math.max(0, net - used) + inc), whtCreditNaira: r2(wht),
  };
}

const short = (w: string) => w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
