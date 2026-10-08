# CryptoTax NG

Paste a wallet, get your Nigerian crypto and stablecoin tax worked out under the NRS **Guidelines on the Taxation of Virtual Assets** (Information Circular 2026/21, 31 July 2026), in naira, at official CBN rates.

Built for Devcenter Hacktober 2026. Live on Rumpty Cloud.

## Why

From 1 January 2026 every Nigerian earning income must register, file and keep records, and on 31 July 2026 the Nigeria Revenue Service published how crypto is taxed. Nigeria received $92.1 billion in crypto between July 2024 and June 2025 (Chainalysis), much of it freelancers paid in USDT. The first returns under the new rules are due **31 March 2027**. The free calculators we tested still apply the old 10% capital gains tax that the Nigeria Tax Act 2025 abolished.

## What it does

1. Reads your wallet history: Tron (TRC-20 and TRX), Ethereum, Optimism and Gnosis.
2. Values every movement in US dollars (stablecoins at their peg, other tokens at market price on the day).
3. Converts to naira at the CBN central rate on each transaction date (last published rate on weekends and holidays).
4. Applies the NRS rules and estimates the extra personal income tax your crypto adds.

You can relabel anything (payment for work, bought with naira, own wallet, P2P sale, gift, spam) and recalculate. Export a CSV for your accountant.

## The rules, as implemented

| Rule | Guidelines | Code |
|---|---|---|
| Crypto received as pay, rewards or airdrops is income at dollar FMV × CBN rate on the day | 6.1.1, 9.5(3)-(4), 9.6 | `engine.ts` income |
| Gains measured in dollars, converted at the CBN rate on the disposal date | 9.1 | `engine.ts` dispose |
| Swaps are a disposal of what left and an acquisition of what arrived | 9.1.2, 9.3.2 | `classify.ts`, `engine.ts` |
| Stablecoin gains measured against the peg, no WHT | 9.1.1(2), 9.5(1) | `engine.ts` |
| Own-wallet transfers, wraps and staking lock-ups are not disposals | 7.2, 10.1 | `classify.ts` |
| FIFO by default, weighted average if elected | 9.3.3(3) | `engine.ts` |
| Annual netting; crypto losses only offset crypto gains and carry forward | 9.4 | `engine.ts` |
| WHT 1% of gross proceeds on Category 1, 3, 5 disposals via a VASP | 8.1 | `rules.ts` |
| 2026 personal income tax bands (0% to ₦800k, then 15% to 25%) | NTA 2025 | `rules.ts` |

`test/nrs-illustrations.test.ts` reproduces the Guidelines' own worked examples: Illustration 2 (₦470,000 taxable, not ₦970,000) and Illustration 3 (₦1,600,000 gain, 0.02 ETH withheld, $4,000 BTC cost base).

## Data sources

- Rules: NRS Information Circular 2026/21 (copy in `ref/`).
- Naira rates: CBN, `https://www.cbn.gov.ng/api/GetAllExchangeRates` (US dollar central rate, daily since 2001).
- Prices: DefiLlama historical prices. The NRS says it will publish approved price sources; until then the report names this one.
- History: TronGrid and public Blockscout explorers. No keys, nothing stored.

## Limits (honest)

- An estimate to help you file, not tax advice.
- P2P naira legs happen off-chain: label a send as "Sold for naira" and enter the naira you received.
- BSC, Base, Arbitrum and Polygon are not read yet (their free explorers block automated access).
- Unlabelled receipts of non-stablecoins are not taxed until you label them; the app says so.
- Tokens with no market price (often spam) are left out and counted.

## Run it

```bash
npm install
npm test        # 23 tests
npm start       # http://localhost:8080
```

`POST /api/report` with `{ "wallets": ["T..."], "year": 2026, "labels": {}, "otherIncome": 0 }`.

## License

MIT
