/** Passive income WHT (para 8.1): 10% withheld in token by the VASP that paid it, credited on the return. */
import { describe, expect, it } from 'vitest';
import { computeReport } from '../src/engine.js';

const rate = () => 1500;

const staking = {
  type: 'income' as const, date: '2026-04-01', kind: 'staking' as const,
  asset: 'SOL', units: 10, usdFmv: 1000, viaVasp: true,
};

describe('passive income withholding', () => {
  it('credits 10% of the naira value when a VASP paid the income', () => {
    const r = computeReport([staking], { rate });
    expect(r.income[0].naira).toBe(1_500_000);
    expect(r.income[0].whtNaira).toBe(150_000);
    expect(r.totals.whtCreditNaira).toBe(150_000);
  });

  it('credits nothing when the income came to a self-custody wallet', () => {
    const r = computeReport([{ ...staking, viaVasp: undefined }], { rate });
    expect(r.income[0].whtNaira).toBe(0);
  });

  it('does not treat pay for work as passive income', () => {
    const r = computeReport([{ ...staking, kind: 'professional' as const }], { rate });
    expect(r.income[0].whtNaira).toBe(0);
  });

  it('an explicit deduction the user knows wins over the estimate', () => {
    const r = computeReport([{ ...staking, whtNairaDeducted: 90_000 }], { rate });
    expect(r.income[0].whtNaira).toBe(90_000);
  });
});
