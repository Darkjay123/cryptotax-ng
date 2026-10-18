import { describe, expect, it } from 'vitest';
import { fetchAnkr } from '../src/wallet/ankr.js';

const W = '0x' + 'aa'.repeat(20);
const CP = '0x' + 'bb'.repeat(20);
const CAKE = '0x' + 'cd'.repeat(20);

process.env.ANKR_API_KEY = 'test-key';

const tx = (o: Record<string, unknown>) => ({ blockchain: 'bsc', timestamp: 1700000000, from: CP, to: W, transactionHash: '0xhash1', value: '1000000000000000000', ...o });

const page1 = {
  transactions: [
    tx({}),                                                                                                    // native in
    tx({ transactionHash: '0xhash2', from: W, to: CP, contractAddress: CAKE, decimals: 18, symbol: 'CAKE', value: '5000000000000000000' }), // token out
    tx({}),                                                                                                    // duplicate native in -> deduped
    tx({ contractAddress: CAKE, symbol: 'NODATA', value: '1000000000000000000' }),                             // unknown decimals -> skipped
  ],
  nextPageToken: 'tok-2',
};
const page2 = {
  transactions: [
    tx({ transactionHash: '0xhash3', timestamp: 1600000000 }), // older native in on page 2
  ],
};

function mock(calls: any[]) {
  return (async (_url: string, init?: any) => {
    const params = JSON.parse(init.body).params;
    calls.push(params);
    return new Response(JSON.stringify(params.pageToken ? page2 : page1), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('fetchAnkr', () => {
  it('reads native and token moves, dedupes natives, follows the page cursor and skips unknown-decimals tokens', async () => {
    const calls: any[] = [];
    const truncated: string[] = [];
    const rows = await fetchAnkr('bsc', W, { fetchImpl: mock(calls), onTruncated: w => truncated.push(w) });
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ address: [W], blockchain: ['bsc'], descOrder: true, pageSize: 1000 });
    expect(calls[1].pageToken).toBe('tok-2');
    const natives = rows.filter(r => r.token === null);
    const tokens = rows.filter(r => r.token);
    expect(natives.length).toBe(2); // hash1 and hash3, hash1 duplicate removed
    expect(tokens.length).toBe(1);
    expect(tokens[0]).toMatchObject({ direction: 'out', symbol: 'CAKE', units: 5, decimals: 18, priceKey: `bsc:${CAKE}` });
    expect(natives[0]).toMatchObject({ direction: 'in', symbol: 'BNB', units: 1, priceKey: 'coingecko:binancecoin' });
    expect(truncated.join(' ')).toContain('unknown token precision');
  });

  it('stops cleanly at maxPages and says history was cut off', async () => {
    const calls: any[] = [];
    const truncated: string[] = [];
    let n = 0;
    const always = (async (_url: string, init?: any) => {
      JSON.parse(init.body).params;
      n++;
      return new Response(JSON.stringify({ transactions: [tx({ transactionHash: `0xhash${n}` })], nextPageToken: 'tok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const rows = await fetchAnkr('bsc', W, { fetchImpl: always, onTruncated: w => truncated.push(w), maxPages: 2 });
    expect(calls).toEqual([]); // mock above recorded nothing; calls kept for shape only
    expect(rows.length).toBe(2);
    expect(truncated.join(' ')).toContain('very long');
  });

  it('refuses to run without a key', async () => {
    const saved = process.env.ANKR_API_KEY;
    process.env.ANKR_API_KEY = '';
    await expect(fetchAnkr('bsc', W, { fetchImpl: mock([]) })).rejects.toThrow(/ANKR_API_KEY/);
    process.env.ANKR_API_KEY = saved;
  });
});
