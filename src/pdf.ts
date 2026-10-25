/** Filing-ready PDF: turns a finished report job into a printable NRS-style position report. */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface PdfReport {
  year: number;
  totals: {
    gainsNaira: number; lossesNaira: number; netDisposalNaira: number;
    chargeableGainsNaira: number; incomeNaira: number; vaChargeableNaira: number; whtCreditNaira: number;
    lossesUsedNaira?: number;
  };
  estimate: {
    otherChargeableNaira: number; reinvestedNaira?: number; totalChargeableNaira: number;
    taxFromCrypto: number; whtCredit: number; estimatedBalanceDue: number;
  };
  rows: { id: string; date: string; chain: string; symbol: string; units: number; usd: number; direction: string; label: string; note?: string }[];
  disposals: { date: string; asset: string; units: number; proceedsNaira: number; costNaira: number; gainNaira: number; whtNaira: number; sourceId: string }[];
  income: { date: string; asset: string; units: number; kind: string; naira: number; whtNaira: number; sourceId: string; usdFmv?: number; rate?: number }[];
  warnings: string[];
  sources: string[];
  exchange: { files: { name: string; kind: string; rows: number }[]; matched: number } | null;
  needsReview: number;
  unpriced: number;
}

const NGN = (n: number) => 'NGN ' + (Math.round(n * 100) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const num = (n: number) => (Math.round(n * 10000) / 10000).toLocaleString('en-NG', { maximumFractionDigits: 4 });

const INK = rgb(0.09, 0.09, 0.11), MUT = rgb(0.45, 0.45, 0.48), ACC = rgb(0.13, 0.36, 0.68), LINE = rgb(0.82, 0.82, 0.86);

export async function renderPdf(r: PdfReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 48;
  let page = doc.addPage([W, H]); let y = H - M;

  const text = (s: string, x: number, size = 9, f = font, col = INK) => page.drawText(s, { x, y, size, font: f, color: col });
  const right = (s: string, xRight: number, size = 9, f = font, col = INK) => { const w = f.widthOfTextAtSize(s, size); text(s, xRight - w, size, f, col); };
  const rule = () => { page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: LINE }); y -= 12; };

  // --- Cover block
  text('CryptoTax NG', M, 20, bold, INK); y -= 14;
  text('Virtual asset tax position report (estimate)', M, 11, font, MUT); y -= 8;
  text(`Tax year: ${r.year}    Generated: ${new Date().toISOString().slice(0, 10)}    Basis: Nigeria Tax Act 2025 (virtual digital assets, effective 1 Jan 2026) + NRS Information Circular 2026/21`, M, 8.5, font, MUT);
  y -= 18; rule();

  // --- Totals
  text(`1. Virtual asset chargeable position, ${r.year}`, M, 12, bold, ACC); y -= 16;
  const tot: [string, string][] = [
    ['Capital gains on disposals', NGN(r.totals.gainsNaira)],
    ['Capital losses on disposals', NGN(r.totals.lossesNaira)],
    ['Net gain / (loss) on disposals', NGN(r.totals.netDisposalNaira)],
    ['Chargeable capital gains (losses first offset gains)', NGN(r.totals.chargeableGainsNaira)],
    ['Chargeable virtual asset income (rewards, payments, airdrops)', NGN(r.totals.incomeNaira)],
    ['Total virtual asset chargeable amount', NGN(r.totals.vaChargeableNaira)],
    ['Withholding tax already suffered (credit)', NGN(r.totals.whtCreditNaira)],
  ];
  const labelX = M, valX = W - M;
  for (const [k, v] of tot) { text(k, labelX); right(v, valX, 9, bold); y -= 13; }
  y -= 4; rule();

  // --- Estimate
  text('2. Estimated personal income tax effect (individual resident in Nigeria)', M, 12, bold, ACC); y -= 16;
  const est: [string, string][] = [
    ['Other chargeable income you entered', NGN(r.estimate.otherChargeableNaira)],
    ...(r.estimate.reinvestedNaira ? [['Reinvestment relief claimed', NGN(-r.estimate.reinvestedNaira)] as [string, string]] : []),
    ['Total chargeable income (other + virtual assets)', NGN(r.estimate.totalChargeableNaira)],
    ['Tax attributable to virtual assets (progressive NTA 2025 bands)', NGN(r.estimate.taxFromCrypto)],
    ['Less withholding tax credit', '(' + NGN(r.estimate.whtCredit) + ')'],
    ['Estimated balance due', NGN(r.estimate.estimatedBalanceDue)],
  ];
  for (const [k, v] of est) {
    const last = v.startsWith('Estimated');
    text(k, labelX, 9, last ? bold : font); right(v, valX, 9, last ? bold : font); y -= 13;
  }
  text('Estimated under the Nigeria Tax Act 2025, effective 1 January 2026: virtual asset income and gains are charged', M, 8, font, MUT); y -= 11;
  text('at the Act\u2019s progressive bands (NRS Circular 2026/21, para 8.1); tax already withheld by an exchange is credited.', M, 8, font, MUT); y -= 12;
  y -= 4; rule();

  // --- Disposals table
  const headerRow = (cells: { s: string; x: number; align?: 'r' }[], f = bold) => {
    for (const c of cells) c.align === 'r' ? right(c.s, c.x, 8, f, ACC) : text(c.s, c.x, 8, f, ACC);
    y -= 11;
  };
  const rowLine = (cells: { s: string; x: number; align?: 'r' }[], f = font) => {
    for (const c of cells) c.align === 'r' ? right(c.s, c.x, 8, f) : text(c.s, c.x, 8, f);
    y -= 11;
  };
  const clip = (s: string, w: number, size = 8, f = font) => { while (s.length > 1 && f.widthOfTextAtSize(s, size) > w) s = s.slice(0, -2) + '\u2026'; return s; };

  text(`3. Disposal lines (${r.disposals.length})`, M, 12, bold, ACC); y -= 15;
  const dx = [M, M + 52, M + 122, M + 168, M + 232, M + 296, M + 360, M + 424, M + 488];
  if (r.disposals.length) {
    headerRow([{ s: 'Date', x: dx[0] }, { s: 'Asset', x: dx[1] }, { s: 'Units', x: dx[2], align: 'r' }, { s: 'Proceeds', x: dx[4], align: 'r' }, { s: 'Cost', x: dx[5], align: 'r' }, { s: 'Gain/(loss)', x: dx[6], align: 'r' }, { s: 'WHT', x: dx[7], align: 'r' }, { s: 'Source tx', x: dx[8] }]);
    for (const d of r.disposals.slice(0, 150)) {
      if (y < M + 90) { page = doc.addPage([W, H]); y = H - M; }
      rowLine([
        { s: d.date, x: dx[0] }, { s: clip(d.asset, 66), x: dx[1] },
        { s: num(d.units), x: dx[2], align: 'r' },
        { s: NGN(d.proceedsNaira), x: dx[4], align: 'r' },
        { s: NGN(d.costNaira), x: dx[5], align: 'r' },
        { s: NGN(d.gainNaira), x: dx[6], align: 'r' },
        { s: d.whtNaira ? NGN(d.whtNaira) : '-', x: dx[7], align: 'r' },
        { s: clip(d.sourceId ? d.sourceId.slice(0, 18) + '\u2026' : '', 90), x: dx[8] },
      ]);
    }
    if (r.disposals.length > 150) { text(`\u2026 and ${r.disposals.length - 150} more lines; the full CSV export has every line.`, M, 8, font, MUT); y -= 12; }
  } else { text('No chargeable disposals were recorded in the tax year.', M, 9, font, MUT); y -= 14; }
  y -= 4; rule();

  // --- Income table
  text(`4. Virtual asset income lines (${r.income.length})`, M, 12, bold, ACC); y -= 15;
  const ix = [M, M + 52, M + 122, M + 168, M + 250, M + 330, M + 424];
  if (r.income.length) {
    headerRow([{ s: 'Date', x: ix[0] }, { s: 'Asset', x: ix[1] }, { s: 'Units', x: ix[2], align: 'r' }, { s: 'Kind', x: ix[3] }, { s: 'Naira value', x: ix[5], align: 'r' }, { s: 'WHT', x: ix[6], align: 'r' }]);
    for (const i of r.income.slice(0, 120)) {
      if (y < M + 90) { page = doc.addPage([W, H]); y = H - M; }
      rowLine([
        { s: i.date, x: ix[0] }, { s: clip(i.asset, 66), x: ix[1] },
        { s: num(i.units), x: ix[2], align: 'r' },
        { s: clip(i.kind, 140), x: ix[3] },
        { s: NGN(i.naira), x: ix[5], align: 'r' },
        { s: i.whtNaira ? NGN(i.whtNaira) : '-', x: ix[6], align: 'r' },
      ]);
    }
    if (r.income.length > 120) { text(`\u2026 and ${r.income.length - 120} more lines; the full CSV export has every line.`, M, 8, font, MUT); y -= 12; }
  } else { text('No virtual asset income was recorded in the tax year.', M, 9, font, MUT); y -= 14; }
  y -= 4; rule();

  // --- Freelancer income summary
  text('5. Income summary (freelancers and stablecoin earners)', M, 12, bold, ACC); y -= 15;
  const wrap = (s: string, size = 9, f = font, col = INK) => { let cur = ''; for (const w of s.split(' ')) { if (f.widthOfTextAtSize(cur + ' ' + w, size) > W - 2 * M) { text(cur, M, size, f, col); y -= 12; cur = w; } else cur = cur ? cur + ' ' + w : w; } if (cur) { text(cur, M, size, f, col); y -= 12; } };
  const sumInc = (a: PdfReport['income']) => a.reduce((s, i) => s + i.naira, 0);
  const payKinds = (k: string) => k === 'professional' || k === 'employment' || k === 'business';
  const pay = r.income.filter(i => payKinds(i.kind));
  const passive = r.income.filter(i => !payKinds(i.kind));
  if (!r.income.length) {
    wrap('No income at all was recorded in the tax year.');
  } else {
    wrap(`Total income received in ${r.year}: ${NGN(sumInc(r.income))} across ${r.income.length} event${r.income.length === 1 ? '' : 's'}.`);
    if (pay.length) {
      wrap(`Payments for work (the freelancer line): ${NGN(sumInc(pay))} across ${pay.length} receipt${pay.length === 1 ? '' : 's'}, charged when received at the CBN rate on each date.`);
      text('Payments for work, largest first:', M, 9, bold); y -= 12;
      for (const i of [...pay].sort((a, b) => b.naira - a.naira).slice(0, 12)) {
        if (y < M + 60) { page = doc.addPage([W, H]); y = H - M; }
        const rateTxt = i.rate ? ` (CBN rate ${Math.round(i.rate).toLocaleString('en-NG')}/USD that day)` : '';
        text(`${i.date}: you were paid ${num(i.units)} ${i.asset}, worth ${NGN(i.naira)}${rateTxt}.`, M, 8.5); y -= 11;
      }
      if (pay.length > 12) { text(`\u2026 and ${pay.length - 12} more payment lines; the full CSV export has every line.`, M, 8, font, MUT); y -= 12; }
    } else {
      wrap('No payments for work were recorded this year; every income line in section 4 is a reward, airdrop or other income.');
    }
    if (passive.length) wrap(`Rewards and passive income (staking, airdrops, DeFi, other): ${NGN(sumInc(passive))} across ${passive.length} line${passive.length === 1 ? '' : 's'}.`);
  }
  y -= 4; rule();

  // --- Basis & method
  text('6. Basis of preparation', M, 12, bold, ACC); y -= 15;
  for (const line of [
    'Cost base: acquisitions are pooled per asset and disposed on ' + 'FIFO' + ' (or WAC where chosen), with value converted to naira at the official CBN rate on the transaction date.',
    'Transfers between your own wallets and your exchange accounts are treated as not taxable (Guidelines para 7.2.2); wallet addresses you entered and exchange statements you uploaded are matched to apply this.',
    'Stablecoin-to-stablecoin swaps and non-chargeable transfers are excluded from chargeable gains; notes you typed are classified by the app\u2019s own language model but the rules engine alone computes tax.',
    'Income received in crypto or stablecoins for work is charged when you receive it (its dollar value times the CBN rate that day); section 5 lists those receipts one by one.',
    'This report is an estimate prepared from public blockchain data and the statements you uploaded. It is not tax advice and not a filing. Verify the lines marked "needs review" before relying on any figure.',
    'If you reinvested disposal proceeds in Nigerian companies within 12 months of the disposal, you may qualify for reinvestment relief under the Nigeria Tax Act 2025. Where you entered an amount, this report reduces chargeable income by it; confirm the relief conditions with your tax adviser before filing.',
    'Street USDT in Nigeria usually trades a few percent above the CBN rate used here, so the naira totals read conservative.',
    'Stamp duty of 1.5% applies to token-to-fiat and fiat-to-token transfers, and the VASP withholds it in token units (Guidelines para 6.3). If a statement shows units before that withholding, cost bases read slightly high.',
    'VAT of 7.5% applies to VASP service fees (exchange, custody), not to the transfer of the crypto itself (Guidelines para 6.2); fees shown in your statements may already include it.',
    ...(r.totals.lossesUsedNaira && r.totals.lossesUsedNaira > 0 ? [`Crypto losses brought forward from earlier years were applied against this year\u2019s gains (Guidelines para 9.4). Keep your prior-year records to support the amount claimed.`] : []),
    ...(r.year === 2025 ? ['This estimate applies the Nigeria Tax Act 2025 personal income tax bands, which only take effect on 1 January 2026; an actual 2025 return would be assessed under the previous tax rules.'] : []),
  ]) { const words = line.split(' '); let cur = ''; for (const w of words) { if (font.widthOfTextAtSize(cur + ' ' + w, 9) > W - 2 * M) { text(cur, M); y -= 12; cur = w; } else cur = cur ? cur + ' ' + w : w; } if (cur) { text(cur, M); y -= 12; } }
  y -= 4;

  // --- Warnings
  if (r.warnings.length || r.needsReview || r.unpriced) {
    rule();
    text('7. Things to check before filing', M, 12, bold, ACC); y -= 15;
    if (r.needsReview) { text(`${r.needsReview} transaction(s) could not be labelled automatically; open the web report and label them so the totals change where needed.`, M, 9, font, MUT); y -= 12; }
    if (r.unpriced) { text(`${r.unpriced} transaction(s) had no historical price available and are excluded from the totals.`, M, 9, font, MUT); y -= 12; }
    for (const w of r.warnings.slice(0, 12)) { const ws = w.split(' '); let cur = ''; for (const ww of ws) { if (font.widthOfTextAtSize(cur + ' ' + ww, 8.5) > W - 2 * M) { text(clip(cur, W - 2 * M, 8.5), M, 8.5, font, MUT); y -= 11; cur = ww; } else cur = cur ? cur + ' ' + ww : ww; } if (cur) { text(clip(cur, W - 2 * M, 8.5), M, 8.5, font, MUT); y -= 11; } }
    y -= 4;
  }

  // --- Exchange files used
  if (r.exchange && r.exchange.files.length) {
    rule();
    text('8. Exchange statements used', M, 12, bold, ACC); y -= 15;
    for (const f of r.exchange.files) { text(`${f.name} (${f.kind}, ${f.rows} rows)`, M, 9); y -= 12; }
    text(`Wallet-to-exchange transfers matched and excluded from chargeable events: ${r.exchange.matched}`, M, 9); y -= 12;
  }

  // --- Footer on every page
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, thickness: 0.6, color: LINE });
    p.drawText('CryptoTax NG is an estimating tool, not a tax adviser. Figures must be checked before filing with the Nigeria Revenue Service.', { x: M, y: 28, size: 7.5, font, color: MUT });
    p.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - font.widthOfTextAtSize(`Page ${i + 1} of ${pages.length}`, 7.5), y: 28, size: 7.5, font, color: MUT });
  });

  return await doc.save();
}
