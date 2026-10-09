# The notes model (notes_v1)

People can type what a transaction was for, in their own words, English or Pidgin
("Fhenix refund my flight", "na my binance i send am from", "bought with 150k naira").
Our own small model reads the note and suggests one of 12 meanings: work pay, salary,
staking, airdrop, DeFi yield, P2P naira trade, own wallet, refund, gift, payment, loan, spam.

**It never decides tax.** It suggests a label and shows how sure it is; the person sees it,
and the rules engine (src/engine.ts) does all the maths from the NRS Guidelines. Below 55%
confidence it says it is not sure and leaves the choice to the person. The direction of the
transaction limits what it can pick (a payment out cannot be read as salary).

**How it is built.** A linear classifier (multinomial logistic regression) over hashed word,
word-pair and character 3/4-gram features (16,384 buckets, FNV-1a). Character pieces make it
tolerant of typos and Pidgin spelling. Weights are 786 KB of plain float32 (models/notes_v1.bin),
run in TypeScript (src/model/notes.ts) with no ML runtime, in about a millisecond on Rumpty's CPU.
For P2P notes it also pulls out the naira amount ("150k", "₦300,000", "N1.2m").

**Training data, honestly.** There is no public dataset of Nigerians describing their crypto
transactions, so we wrote it: model/gen.py builds 10,800 notes from templates in English,
Pidgin and mixed, with names, companies, events and deliberate typos. model/test_notes.tsv
is 65 notes written separately in different words; the model gets 64 right (98.5%). We wrote
both, so real-world accuracy will be lower; the notes people confirm are how it gets better.

**Reproduce.** `python3 model/train.py` rebuilds the weights. test/notes.test.ts checks the
TypeScript port matches the Python model's probabilities to 1e-4.
