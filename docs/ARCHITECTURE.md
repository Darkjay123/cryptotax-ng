# Architecture

One small TypeScript service. No database, no accounts, no keys: everything it reads is public, and nothing a user pastes is stored.

```
wallet addresses
      │
      ▼
src/wallet/tron.ts ─┐   TronGrid: TRC-20 transfers + TRX
src/wallet/evm.ts  ─┤   Blockscout: Ethereum, Optimism, Gnosis (native + tokens)
                    ▼
            Movement[]  (src/wallet/types.ts: chain, hash, date, direction, symbol, units, counterparty)
                    │
src/prices.ts ──────┤   DefiLlama historical USD price per token per day (stablecoins at peg)
                    ▼
src/classify.ts     guesses what each movement was, with a plain-English reason and a paragraph
                    reference; spots swaps, own-wallet moves, spam/fake tokens; user labels override
                    │
                    ▼
            TaxEvent[]  (income, buy_fiat, sell_fiat, swap, opening, self_transfer)
                    │
src/rates.ts ───────┤   CBN official USD central rate per date (last published rate on weekends)
                    ▼
src/engine.ts       FIFO / WAC lots in dollars, dollar gains, × CBN rate on disposal date,
                    income at dollar FMV × rate on receipt, annual netting, loss carry-forward, WHT credit
                    │
src/estimate.ts     adds crypto to other income, applies 2026 PIT bands, returns the extra tax
                    │
src/server.ts       Hono HTTP API + static page (public/index.html)
```

## Why it is built this way

- **The engine is pure.** `engine.ts`, `rules.ts` and `estimate.ts` take plain data and a rate function, and do no I/O. That is what lets the tests reproduce the NRS worked examples exactly.
- **Every guess explains itself.** Each classified row carries a `reason` that names the rule it relied on, so a user (or accountant) can see why something was taxed and correct it.
- **Cautious by default.** Unknown cost is nil, not guessed; unknown receipts of non-stablecoins are asked about, not assumed. The page says plainly when this may overstate or understate the bill.
- **Fits a small host.** Wallet history and prices are cached for 20 minutes, so relabelling and recalculating is instant. Reports for big wallets run as background jobs because the hosting gateway cuts requests at about 60 seconds: the API waits 20 seconds, then returns a job id the page polls.
- **Abuse limits.** 20 requests a minute per IP, at most 5 wallets, 200 KB body, strict Content-Security-Policy.

## Files

| File | Job |
|---|---|
| `src/rules.ts` | Rates, categories, stablecoin list, PIT bands, with paragraph references |
| `src/engine.ts` | Lots, disposals, income, netting, carry-forward |
| `src/estimate.ts` | Extra personal income tax caused by crypto |
| `src/classify.ts` | Movement → tax event, spam detection, label handling |
| `src/prices.ts`, `src/rates.ts` | DefiLlama prices, CBN rates |
| `src/wallet/*.ts` | Chain readers |
| `src/pipeline.ts` | Glue + 20-minute cache |
| `src/server.ts` | API, job queue, rate limiting, static page |
| `public/index.html` | The whole front end, no build step |
| `test/` | NRS illustrations, wallet parsing, spam handling (26 tests) |
| `ref/` | The NRS Guidelines PDF and extracted text |
