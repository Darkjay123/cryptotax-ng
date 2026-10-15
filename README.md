# CryptoTax NG

Paste a wallet, get your Nigerian crypto and stablecoin tax worked out under the NRS **Guidelines on the Taxation of Virtual Assets** (Information Circular 2026/21, 31 July 2026), in naira, at official CBN rates.

**Live:** https://cryptotax-ng.rumptycloud.app · Built for Devcenter Hacktober 2026 on Rumpty Cloud.

Docs: [Architecture](docs/ARCHITECTURE.md) · [Tax rules, paragraph by paragraph](docs/TAX-RULES.md) · [API](docs/API.md)

## Any exchange statement, CSV or PDF

Upload a wallet plus up to six statements. CSVs from Binance (Transaction History
and P2P Order History), Bybit and Quidax are read exactly as before. Statements
from the exchanges and on/off-ramps Nigerians actually use (Busha, Luno, Bitnob,
Yellow Card, Breet, Roqqu, NairaEx, Remitano, Spenda, Azza, Monica, Dantown,
Getkoyn, Sekiapp, Gexipay and others) are read best-effort from their common
statement shapes, with the vendor's name shown on each line. PDFs work too: a PDF
statement from any exchange or on/off-ramp (Binance's app statement and the list
above) is reconstructed into the same table the matching reader already
understands, so every tax rule stays in the tested readers and nothing about the
PDF is trusted.

- Known layouts (Binance Transaction History, Binance P2P orders, Bybit transaction
  logs, Quidax debit/credit statements) are read exactly, like their CSVs.
- Nigerian exchange and off-ramp statements (Breet, Busha, Yellow Card, Bitnob,
  Luno, Roqqu, NairaEx, Remitano, Spenda, Azza, Monica, Dantown, Getkoyn, Sekiapp,
  Gexipay and others) are read best-effort: direct rows with a naira value are
  used as they state, rows without one are paired with a naira line within ten
  minutes, and anything unclear goes to review, never guessed.
- Unknown layouts are read as a generic statement under the exchange's own name
  (detected from the document or file name), with unclear rows listed for review.
- Rows that fail to read are reported, never guessed. Cancelled, failed and
  reversed rows are skipped. Scanned-image PDFs (no text layer) are refused with a
  plain note to export a CSV instead.
- Files are read for the report only and never stored.


## Why

From 1 January 2026 every Nigerian earning income must register, file and keep records, and on 31 July 2026 the Nigeria Revenue Service published how crypto is taxed. Nigeria received $92.1 billion in crypto between July 2024 and June 2025 (Chainalysis), much of it freelancers paid in USDT. The first returns under the new rules are due **31 March 2027**. The free calculators we tested still apply the old 10% capital gains tax that the Nigeria Tax Act 2025 abolished.

## What it does

1. Reads your wallet history back to 2020 (so older purchases give a cost base): Tron (TRC-20 and TRX), Bitcoin, and 63 EVM chains (61 through public Blockscout explorers, plus Avalanche and Metis through Routescan's free keyless API), including coins paid out by contracts (exchange withdrawals, bridges, DEX sales), which only show up as internal transactions. Each chain is probed once first, so only chains your address has actually touched are read deeply. Up to 2,000 records per list; the report says so if a wallet is longer.
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
| WHT 10% on passive income (staking, mining, airdrops, DeFi rewards) paid through a VASP, credited on the return | 8.1, 9.5(4) | `engine.ts` income |
| Crypto losses brought forward from earlier years offset this year's gains (form input) | 9.4 | `engine.ts` |
| 2026 personal income tax bands (0% to ₦800k, then 15% to 25%) | NTA 2025 | `rules.ts` |

`test/nrs-illustrations.test.ts` reproduces the Guidelines' own worked examples: Illustration 2 (₦470,000 taxable, not ₦970,000) and Illustration 3 (₦1,600,000 gain, 0.02 ETH withheld, $4,000 BTC cost base).

## Data sources

- Rules: NRS Information Circular 2026/21 (copy in `ref/`).
- Naira rates: CBN, `https://www.cbn.gov.ng/api/GetAllExchangeRates` (US dollar central rate, daily since 2001).
- Prices: DefiLlama historical prices. The NRS says it will publish approved price sources; until then the report names this one.
- History: TronGrid, mempool.space (Bitcoin) and public Blockscout explorers (61 EVM chains) and Routescan (Avalanche, Metis). No keys, nothing stored.

## Limits (honest)

- Reinvestment relief: enter what you reinvested in Nigerian companies within 12 months of your disposals and the estimate reduces chargeable income by that amount. The relief's exact conditions sit in the Nigeria Tax Act 2025, so confirm with a tax adviser before filing.
- Street rate: P2P USDT in Nigeria usually trades a few percent above the CBN rate used here, so naira totals read conservative.

- An estimate to help you file, not tax advice.
- P2P naira legs happen off-chain: label a send as "Sold for naira" and enter the naira you received.
- BSC, Base, Arbitrum and Polygon are not read yet (their free explorers block automated access).
- Unlabelled receipts of non-stablecoins are not taxed until you label them; the app says so.
- Spam and fake tokens (web-address names, emoji, look-alike letters such as "ℰ⊤ℋ" posing as ETH) are left out automatically and counted, so you only label things that matter.
- Tokens with no market price on the day are left out and counted.
- Coins that leave a wallet with no recorded purchase are costed at nil (the cautious reading) and flagged, with the fix: add the wallet you bought from, or label the purchase.

## Run it

```bash
npm install
npm test        # 26 tests
npm run build && npm start   # http://localhost:8080 (or npm run dev)
```

`POST /api/report` with `{ "wallets": ["T..."], "year": 2026, "labels": {}, "otherIncome": 0 }`. Big wallets return `202 {"pending":true,"id":"..."}`; poll `GET /api/report/:id`. Details in [docs/API.md](docs/API.md).

Deploy: the `Dockerfile` runs anywhere; on Rumpty Cloud it is a Web Service on port 8080 with health check `/healthz`, redeployed on every push to `main`.

## License

MIT
