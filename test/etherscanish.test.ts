import { describe, expect, it } from 'vitest';
import { ES_CHAINS, fetchEs } from '../src/wallet/etherscanish.js';

const W = '0x46dAeC8FE29132Eee301636100c9B5f7Af0F058e';

function fakeFetch(routes: Record<string, any>) {
  return (async (url: string) => {
    const u = new URL(url);
    const key = `${u.searchParams.get('module')}:${u.searchParams.get('action')}:${u.searchParams.get('page')}`;
    const hit = routes[key];
    if (!hit) throw new Error('unrouted ' + key);
    return { ok: true, status: 200, json: async () => hit } as any;
  }) as typeof fetch;
}

describe('etherscanish reader', () => {
  it('ships avalanche and metis configs with verified native price keys', () => {
    expect(Object.keys(ES_CHAINS).sort()).toEqual(['avalanche', 'metis']);
    for (const c of Object.values(ES_CHAINS)) {
      expect(c.nativeKey.startsWith('coingecko:')).toBe(true);
      expect(c.nativeKey.length).toBeGreaterThan('coingecko:'.length);
    }
  });

  it('reads ERC-20 rows, skips NFT rows, and dedupes internal payouts', async () => {
    const routes = {
      'account:tokentx:1': { status: '1', result: [
        { timeStamp: '1700000001', hash: '0xt1', from: '0xaaa', to: W, contractAddress: '0xTOK', tokenSymbol: 'TOK', tokenDecimal: '18', value: '1000000000000000000' },
        { timeStamp: '1700000002', hash: '0xnft', from: '0xaaa', to: W, contractAddress: '0xNFT', tokenSymbol: 'NFT', tokenDecimal: '', value: '1' },
        { timeStamp: '1700000003', hash: '0xt2', from: W, to: '0xbbb', contractAddress: '0xTOK', tokenSymbol: 'TOK', tokenDecimal: '18', value: '500000000000000000' },
      ] },
      'account:txlist:1': { status: '1', result: [
        { timeStamp: '1700000004', hash: '0xh1', from: '0xcc', to: W, value: '2000000000000000000', isError: '0' },
      ] },
      'account:txlistinternal:1': { status: '1', result: [
        { timeStamp: '1700000004', hash: '0xh1', from: '0xdd', to: W, value: '3000000000000000000', isError: '0' },
        { timeStamp: '1700000005', hash: '0xh2', from: W, to: '0xee', value: '1000000000000000000', isError: '0' },
      ] },
    };
    const moves = await fetchEs('avalanche', W, { fetchImpl: fakeFetch(routes) });
    const tokens = moves.filter(m => m.token);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].direction).toBe('in');
    expect(tokens[1].direction).toBe('out');
    expect(tokens[1].priceKey).toBe('avalanche:0xtok');
    const natives = moves.filter(m => m.token === null);
    expect(natives).toHaveLength(2);
    expect(natives.map(m => m.direction).sort()).toEqual(['in', 'out']);
  });

  it('treats no-activity responses as empty, never as an error', async () => {
    const routes = {
      'account:tokentx:1': { status: '0', message: 'No transactions found', result: [] },
      'account:txlist:1': { status: '0', message: 'No transactions found', result: [] },
      'account:txlistinternal:1': { status: '0', message: 'No transactions found', result: [] },
    };
    expect(await fetchEs('metis', W, { fetchImpl: fakeFetch(routes) })).toHaveLength(0);
  });

  it('throws on a real api error instead of silently reading nothing', async () => {
    const routes = { 'account:tokentx:1': { status: '0', message: 'NOTOK', result: 'Max rate limit reached' } };
    await expect(fetchEs('avalanche', W, { fetchImpl: fakeFetch(routes) })).rejects.toThrow(/rate limit/i);
  });
});
