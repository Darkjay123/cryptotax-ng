/**
 * Turns a report into an estimated naira tax bill for a resident individual.
 * VA income and gains are added to other chargeable income and taxed at the
 * NTA 2025 progressive bands (Guidelines para 8.1); WHT already deducted is a credit.
 */
import { personalIncomeTax, round2 } from './rules.js';
import type { Report } from './engine.js';

export interface Estimate {
  otherChargeableNaira: number;
  reinvestedNaira: number;
  totalChargeableNaira: number;
  taxOnTotal: number;
  taxOnOtherOnly: number;
  taxFromCrypto: number;
  whtCredit: number;
  estimatedBalanceDue: number;
}

export function estimateIndividual(report: Report, otherChargeableNaira = 0, reinvestedNaira = 0): Estimate {
  // Reinvestment relief (Nigeria Tax Act 2025): the user enters what they reinvested
  // in Nigerian companies within 12 months; the estimate reduces chargeable income
  // by it and the PDF tells them to confirm the conditions. Never below zero.
  const total = Math.max(0, otherChargeableNaira + report.totals.vaChargeableNaira - reinvestedNaira);
  const taxTotal = personalIncomeTax(total);
  const taxOther = personalIncomeTax(otherChargeableNaira);
  const fromCrypto = round2(taxTotal - taxOther);
  const credit = report.totals.whtCreditNaira;
  return {
    otherChargeableNaira, reinvestedNaira: round2(reinvestedNaira), totalChargeableNaira: round2(total),
    taxOnTotal: taxTotal, taxOnOtherOnly: taxOther, taxFromCrypto: fromCrypto,
    whtCredit: credit, estimatedBalanceDue: round2(Math.max(0, fromCrypto - credit)),
  };
}
