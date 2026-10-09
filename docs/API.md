# API

Base URL: `https://cryptotax-ng.rumptycloud.app`

## `POST /api/report`

```json
{
  "wallets": ["TRGsjk84qAKfs6zPTgAMEaWXqpBuYCXsws", "0xc6D2..."],
  "year": 2026,
  "labels": { "ethereum:0xabc...:3": { "kind": "income", "incomeKind": "professional" } },
  "otherIncome": 2400000,
  "method": "FIFO"
}
```

- `wallets`: 1 to 5 Tron (`T…`) or EVM (`0x…`) addresses. EVM addresses are read on Ethereum, Optimism and Gnosis.
- `year`: 2025 or 2026.
- `labels` (optional): row id → label. Kinds: `income` (with `incomeKind`: professional, employment, business, staking, mining, defi, airdrop, other), `own_wallet`, `bought` (with `naira`), `sold` (with `naira`), `payment`, `gift_in`, `gift_out`, `ignore`.
- `otherIncome` (optional): other chargeable income in naira, so the estimate uses the right band.
- `method` (optional): `FIFO` (default) or `WAC`.

**200** returns the report: `totals`, `estimate`, `rows` (every movement with its guess, label and reason), `income`, `disposals`, `warnings`, `needsReview`, `unpriced`, `spam`, `rateNotes`, `sources`.

**202** `{"pending": true, "id": "…"}` when the wallet is still being read after 20 seconds. Poll:

## `GET /api/report/:id`

202 while running, then the same 200 body. Jobs are kept for 30 minutes. A repeat POST with the same wallets, year and labels returns the same job.

## `GET /healthz`

`{"ok": true}`

## Limits

20 requests a minute per IP, 200 KB body. Errors come back as `{"error": "plain-English message"}`.
