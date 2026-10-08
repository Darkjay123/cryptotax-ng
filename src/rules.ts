/**
 * Tax rules for virtual assets in Nigeria.
 *
 * Source of truth: NRS Information Circular 2026/21, "Guidelines on the
 * Taxation of Virtual Assets", published 31 July 2026 (ref/nrs_va.pdf).
 * Paragraph numbers in comments point at that document.
 */

/** Para 5.0: the six NRS categories. */
export type Category = 1 | 2 | 3 | 4 | 5 | 6;

/** Para 8.1 rates. */
export const STAMP_DUTY_RATE = 0.015;      // item 33, Ninth Schedule NTA: TOKEN<->FIAT, borne by the transferee
export const WHT_DISPOSAL_RATE = 0.01;     // 1% of gross disposal proceeds, Categories 1, 3 and 5, via a VASP
export const WHT_PASSIVE_RATE = 0.10;      // staking, mining, airdrops, DeFi yield
export const VAT_RATE = 0.075;             // on VASP service fees

/** Para 8.1 / 9.5(1): no WHT on stablecoin disposals. */
export function whtAppliesOnDisposal(cat: Category): boolean {
  return cat === 1 || cat === 3 || cat === 5;
}

/**
 * Personal income tax bands under the Nigeria Tax Act 2025 (from 1 Jan 2026),
 * cumulative on annual chargeable income. Upper bound in naira, rate.
 */
export const PIT_BANDS: ReadonlyArray<readonly [number, number]> = [
  [800_000, 0],
  [3_000_000, 0.15],
  [12_000_000, 0.18],
  [25_000_000, 0.21],
  [50_000_000, 0.23],
  [Infinity, 0.25],
];

export function personalIncomeTax(chargeable: number): number {
  let tax = 0, lower = 0;
  for (const [upper, rate] of PIT_BANDS) {
    if (chargeable <= lower) break;
    tax += (Math.min(chargeable, upper) - lower) * rate;
    lower = upper;
  }
  return round2(tax);
}

/** Known stablecoins (Category 2) and their peg. Anything else must be classified by the user or the token list. */
export const STABLECOINS: Record<string, { peg: 'USD' }> = {
  USDT: { peg: 'USD' }, USDC: { peg: 'USD' }, BUSD: { peg: 'USD' }, DAI: { peg: 'USD' },
  PYUSD: { peg: 'USD' }, FDUSD: { peg: 'USD' }, TUSD: { peg: 'USD' }, USDE: { peg: 'USD' },
};

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
