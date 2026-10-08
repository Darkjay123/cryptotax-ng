/**
 * Turns a report into an estimated naira tax bill for a resident individual.
 * VA income and gains are added to other chargeable income and taxed at the
 * NTA 2025 progressive bands (Guidelines para 8.1); WHT already deducted is a credit.
 */
import { personalIncomeTax, round2 } from './rules.js';
import type { Report } from './engine.js';

export interface Estimate {
  otherChargeableNaira: number;
  totalChargeableNaira: number;
  taxOnTotal: number;
  taxOnOtherOnly: number;
  taxFromCrypto: number;
  whtCredit: number;
  estimatedBalanceDue: number;
}

export function estimateIndividual(report: Report, otherChargeableNaira = 0): Estimate {
  const total = otherChargeableNaira + report.totals.vaChargeableNaira;
  const taxTotal = personalIncomeTax(total);
  const taxOther = personalIncomeTax(otherChargeableNaira);
  const fromCrypto = round2(taxTotal - taxOther);
  const credit = report.totals.whtCreditNaira;
  return {
    otherChargeableNaira, totalChargeableNaira: round2(total),
    taxOnTotal: taxTotal, taxOnOtherOnly: taxOther, taxFromCrypto: fromCrypto,
    whtCredit: credit, estimatedBalanceDue: round2(Math.max(0, fromCrypto - credit)),
  };
}
