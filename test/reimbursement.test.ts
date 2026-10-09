import { describe, it, expect } from 'vitest';
import { classify } from '../src/classify.js';

const W = '0x46daec8fe29132eee301636100c9b5f7af0f058e';
const move = (id: string, units: number) => ({ id, chain: 'ethereum', hash: id, date: '2026-05-06', direction: 'in', symbol: 'USDC', units, token: '0xa0b8', counterparty: '0x1198', from: '0x1198', to: W } as any);

describe('reimbursement label', () => {
  it('is not income, but the coins enter the cost base at market value', () => {
    const moves = [move('a', 1500), move('b', 690)];
    const out: any = classify(moves, () => 1, [W], {
      'ethereum:a:0': { kind: 'income', incomeKind: 'professional' },
      'ethereum:b:1': { kind: 'reimbursement' },
    });
    const ev = out.events;
    expect(ev.filter((e: any) => e.type === 'income').map((e: any) => e.usdFmv)).toEqual([1500]);
    expect(ev.find((e: any) => e.id === 'ethereum:b:1')).toMatchObject({ type: 'opening', usdCost: 690, units: 690 });
  });
});
