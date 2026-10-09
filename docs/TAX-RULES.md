# Tax rules, as implemented

Source: Nigeria Revenue Service, *Guidelines on the Taxation of Virtual Assets*, Information Circular 2026/21, 31 July 2026 (copy in `ref/nrs_va.pdf`). Paragraph numbers below point at that document. This app produces an estimate to help someone file; it is not tax advice.

## Categories (para 5)
Six categories. The app treats known stablecoins (USDT, USDC, DAI, BUSD, PYUSD, FDUSD, TUSD, USDe) as Category 2 and everything else as Category 1 unless overridden.

## Income (para 6.1.1, 9.5(3)-(4), 9.6)
Crypto received as payment for work, salary, staking, mining, DeFi yield or an airdrop is income on the day it is received: dollar market value × CBN rate that day. That value becomes the cost base of those coins for later sales.

## Disposals (para 9.1, 9.1.2, 9.3.2)
Gains are measured in dollars first (proceeds minus cost, both in dollars) and only the dollar gain is converted to naira, at the CBN rate on the disposal date. Naira devaluation while holding is therefore not taxed. A swap is a disposal of what left at its dollar market value and an acquisition of what arrived at the same value. Paying for something with crypto is a disposal at market value (para 7.1 item 5).

## Stablecoins (para 9.1.1(2), 9.5(1))
Gains are measured against the dollar peg, so selling a stablecoin normally has no gain, and no withholding tax applies.

## Not taxable (para 7.2, 10.1)
Moving coins between your own wallets, wrapping and unwrapping, and holding.

## Cost matching (para 9.3.3(3))
First in, first out by default; weighted average if the taxpayer elects it and uses it consistently. Coins that leave with no recorded acquisition are costed at nil and flagged.

## Netting and losses (para 9.4)
Gains and losses for the year are netted. Net crypto losses only offset crypto gains and are carried forward; they never reduce other income.

## Withholding tax (para 8.1)
1% of gross proceeds on Category 1, 3 and 5 disposals through a VASP; 10% on passive income such as staking and airdrops. Tax already withheld is credited against the bill.

## Stamp duty (para 8.1, item 33 Ninth Schedule NTA)
1.5% on token-to-fiat transfers, borne by the transferee. Modelled in `buy_fiat` (units credited are net of duty).

## Gifts (para 7.1 item 15)
The giver has no income tax on a gift; the receiver's cost is the market value on receipt.

## Personal income tax bands (Nigeria Tax Act 2025, from 1 January 2026)
0% on the first ₦800,000; 15% to ₦3m; 18% to ₦12m; 21% to ₦25m; 23% to ₦50m; 25% above. The app reports the *extra* tax crypto adds on top of the user's other income.

## Deadlines and penalties
First returns under these rules are due 31 March 2027. Failing to file: ₦100,000, then ₦50,000 a month. Failing to register: ₦50,000, then ₦25,000 a month.

## Verified against the Guidelines' own examples
`test/nrs-illustrations.test.ts` reproduces Illustration 2 (₦470,000 taxable, not ₦970,000) and Illustration 3 (₦1,600,000 gain, 0.02 ETH withheld, $4,000 BTC cost base).

## Data sources
- CBN official USD central rate, `https://www.cbn.gov.ng/api/GetAllExchangeRates`; on days with no published rate the last published rate is used and noted.
- DefiLlama historical prices. The NRS says it will publish approved price sources; the report names the one used until then.
