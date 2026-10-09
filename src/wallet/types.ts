export type ChainId = 'tron' | 'ethereum' | 'optimism' | 'gnosis';

/** One token or coin movement in or out of a wallet the user owns. */
export interface Movement {
  chain: ChainId;
  hash: string;
  timestamp: number;        // unix seconds
  date: string;             // YYYY-MM-DD (UTC)
  wallet: string;           // the user's wallet this movement belongs to
  direction: 'in' | 'out';
  counterparty: string;
  symbol: string;
  token: string | null;     // contract address, null for the native coin
  decimals: number;
  units: number;
  /** DefiLlama price key, e.g. "tron:TR7N..." or "coingecko:ethereum". */
  priceKey: string;
}

export interface FetchOptions {
  from?: number;   // unix seconds, inclusive
  to?: number;     // unix seconds, inclusive
  maxPages?: number;
  fetchImpl?: typeof fetch;
  /** Called when history was cut off at maxPages, so the report can say older records were not read. */
  onTruncated?: (what: string) => void;
}

export const isoDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
