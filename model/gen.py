"""Generates training notes for the "what was this money for" model.
Every example is written from templates by us (no user data). The test set in
test_notes.tsv is hand-written separately, in different words, to measure honestly."""
import random, itertools
random.seed(7)
CLASSES = ['work','salary','staking','airdrop','defi','p2p','own','refund','gift','payment','loan','spam']

ORGS = ['fhenix','zo','a client','my client','one startup','the dao','superteam','starknet','celo','base','solana foundation','an agency','my boss','the company','upwork client','a dev shop','one american guy','the project','lisk','stellar','polygon','web3 company','the founder','ethglobal','devcenter','my employer']
PEOPLE = ['my brother','my sister','my mum','my mom','my dad','papa','mama','my uncle','my aunty','my guy','my padi','my friend','my babe','my girlfriend','my boyfriend','my cousin','my pastor','tunde','emeka','chioma','david','blessing','ade','my oga','my coworker','bros','sis']
JOBS = ['ambassador work','design work','content','writing articles','smart contract audit','frontend work','backend gig','community management','moderation','video editing','the bounty','the grant milestone','consulting','tutoring','the website i built','translation','graphics','a logo','dev work','the hackathon prize','social media management','the bug bounty','my freelance job','the tweets','a thread','marketing']
EVENTS = ['flight','hotel','transport','uber','the event','ticket to lagos','conference','visa fee','data','food at the event','printing','the venue','accommodation','bolt rides','logistics','internet','travel']
EXCH = ['binance','bybit','quidax','kucoin','okx','bitget','roqqu','busha','yellow card','luno','trust wallet','metamask','my ledger','my other wallet','my phantom','coinbase','exchange']
GOODS = ['laptop','phone','rent','food','a course','subscription','netflix','school fees','data','hosting','domain','chatgpt plus','groceries','clothes','shoes','an nft','gift card','airtime','my bills','fuel','generator repair']
COINS = ['usdt','usdc','eth','btc','sol','bnb','trx','ton','dollar','money','coin','crypto']
AMTS = ['50k','150k','200,000 naira','₦300k','N1.2m','500 dollars','$1500','100 usdt','2000','1.5m','₦75,000','20 dollars','']

T = {
 'work': [
  '{org} paid me for {job}', 'payment for {job}', 'pay for {job} from {org}', '{org} pay me for {job}', 'na {org} pay me for {job}',
  'money for {job}', 'invoice payment from {org}', 'freelance payment', 'gig payment for {job}', 'client paid {amt} for {job}',
  'dem pay me for {job}', 'my pay for {job}', 'this one na payment for {job}', 'i was paid for {job}', 'bounty reward for {job}',
  'hackathon prize money', 'won the hackathon', 'grant from {org} for my project', 'milestone payment from {org}', 'contract payment {org}',
  'commission for selling', 'payment for service i rendered', 'na work money', 'work money from {org}', 'balance payment for {job}',
  'upfront payment for {job}', '50% upfront for the {job}', 'fee for {job}', 'they paid me {amt} for {job}', 'compensation for {job}',
  'my monthly ambassador stipend', 'ambassador reward from {org}', 'stipend from {org}', 'paid for writing a thread', 'payment for my tweets',
 ],
 'salary': [
  'my salary', 'salary from {org}', 'monthly salary', 'na my salary', 'salary for {month}', 'my pay as employee of {org}',
  'wages from my job', 'my work salary', 'payroll from {org}', 'full time job salary', 'salary wey {org} pay', 'monthly pay from my employer',
  'my {month} salary', 'they pay my salary in usdt', 'my job pays me in crypto every month', 'employee salary', 'staff salary {org}',
 ],
 'staking': [
  'staking reward', 'staking rewards from {exch}', 'interest from binance earn', 'earn interest', 'simple earn interest', 'validator rewards',
  'eth staking reward', 'sol staking', 'na staking reward', 'reward from staking {coin}', 'savings interest on {exch}', 'apy interest',
  'my stake don pay', 'delegation rewards', 'launchpool reward', 'mining reward', 'i mined it', 'interest wey {exch} pay me',
 ],
 'airdrop': [
  'airdrop', 'i got an airdrop', 'airdrop from {org}', 'free tokens airdrop', 'na airdrop', 'claimed airdrop', 'testnet airdrop reward',
  'retroactive airdrop', 'airdrop claim {coin}', 'free coin wey dem drop', 'token drop from {org}', 'hamster airdrop', 'notcoin airdrop', 'dogs airdrop',
  'quest rewards', 'galxe reward', 'zealy reward', 'points converted to tokens', 'tap to earn airdrop',
 ],
 'defi': [
  'yield farming', 'lp rewards', 'liquidity pool fees', 'defi yield', 'farm rewards', 'liquidity mining', 'uniswap fees', 'aave interest',
  'pendle yield', 'lending interest from aave', 'na defi yield', 'yield from my vault', 'curve rewards', 'harvest from farm',
 ],
 'p2p': [
  'bought with naira on p2p', 'i bought it with naira', 'p2p buy', 'bought usdt with {amt}', 'i buy am with naira', 'na p2p i buy am',
  'bought from p2p merchant', 'converted naira to usdt', 'funded with naira', 'i sold it for naira', 'sold on p2p', 'p2p sell', 'sold to a merchant for {amt}',
  'i change am to naira', 'cashed out to my bank', 'withdrew to naira', 'sold usdt for naira', 'converted to naira', 'sell to p2p', 'na p2p i sell am',
  'i paid {amt} naira for it', 'bought {coin} with my naira', 'naira to usdt', 'usdt to naira', 'cash out', 'i cash out', 'sold for {amt}', 'bought for {amt}',
 ],
 'own': [
  'from my {exch}', 'moved from {exch}', 'my own wallet', 'transfer to my {exch}', 'to my {exch} account', 'my other wallet',
  'withdrew from {exch} to my wallet', 'from my binance', 'na my own money', 'na me send am to myself', 'moving my funds', 'sent to myself',
  'my wallet to my wallet', 'self transfer', 'deposit to {exch}', 'from my exchange account', 'my second wallet', 'na my own wallet', 'my cold wallet',
  'moved to {exch} to sell', 'bridge to my wallet on base', 'bridged my funds', 'from my phantom to metamask', 'na my trust wallet', 'transfer between my accounts',
 ],
 'refund': [
  'refund for my {event}', 'reimbursement for {event}', 'they refunded my {event}', '{org} refunded my {event}', 'refund', 'na refund',
  'refund for {event} money', 'reimbursed for {event}', 'payback for {event} i paid', 'they paid back my {event}', 'event expenses reimbursement',
  'travel reimbursement', 'refund of money i spent on {event}', 'dem refund my {event}', 'money i spent for the event they returned', 'expense refund',
  'returned my money for {event}', 'reimburse {event}', 'refund from {org} for {event}', 'they cover my {event} cost',
 ],
 'gift': [
  'gift from {person}', '{person} gave me', '{person} dash me', 'na gift', 'birthday gift', 'gift', '{person} sent me money', 'present from {person}',
  'support from {person}', 'giveaway', 'i won a giveaway', 'tip from {person}', 'christmas gift', 'na {person} dash me', 'gift to {person}',
  'i sent {person} money as gift', 'i gave {person}', 'i dash {person}', 'support for {person}', 'helping {person}', 'birthday gift for {person}',
  'donation', 'i donated', 'church offering', 'tithe', 'sent money to {person} for upkeep', 'upkeep for {person}', 'pocket money for {person}',
 ],
 'payment': [
  'paid for {goods}', 'bought {goods}', 'payment for {goods}', 'i pay for {goods}', 'na {goods} i buy', 'paid my {goods}', 'subscription payment',
  'paid a freelancer', 'paid the designer', 'paid my developer', 'paid for {goods} with usdt', 'spent on {goods}', 'bought {goods} with crypto',
  'paid for the {event}', 'paid {person} for work', 'paid vendor', 'payment to merchant for goods', 'i buy {goods}', 'bought an nft', 'minted an nft',
  'paid gas', 'paid for hosting', 'paid my rent', 'school fees payment', 'paid the plug',
 ],
 'loan': [
  'loan from {person}', '{person} borrowed me', '{person} lend me', 'borrowed money', 'i borrowed from {person}', 'na loan', 'loan',
  'paying back {person}', 'repaid my loan', 'i paid back {person}', 'loan repayment', 'returned money i borrowed', 'paid back the loan',
  '{person} lend me money i go pay back', 'debt repayment to {person}', 'i lend {person}', 'lent to {person}', 'borrowed from {exch} margin',
 ],
 'spam': [
  'spam', 'scam token', 'fake token', 'i dont know this token', 'random token i didnt ask for', 'na scam', 'unknown airdrop link', 'phishing',
  'scam', 'i did not receive this', 'dust', 'dust attack', 'address poisoning', 'fake usdt', 'ignore', 'no idea', 'junk token', 'na spam',
  'i dont know who sent it', 'strange token with website name', 'scammer sent it',
 ],
}
MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december','last month','this month']

def fill(t):
    return t.format(org=random.choice(ORGS), job=random.choice(JOBS), amt=random.choice(AMTS), month=random.choice(MONTHS),
                    exch=random.choice(EXCH), coin=random.choice(COINS), event=random.choice(EVENTS), person=random.choice(PEOPLE),
                    goods=random.choice(GOODS))

PREFIX = ['', '', '', 'this is ', 'it was ', 'na ', 'e be ', 'abeg na ', 'this one ', 'that one na ', 'its ', 'basically ']
SUFFIX = ['', '', '', ' oh', ' abeg', ' sha', ' o', ' bro', '.', '!!', ' lol', ' thanks', ' in {coin}', ' last week', ' for {month}']

def typo(s):
    if len(s) < 6 or random.random() > 0.25: return s
    i = random.randrange(1, len(s) - 1)
    op = random.random()
    if op < 0.33: return s[:i] + s[i+1:]
    if op < 0.66: return s[:i] + s[i] + s[i:]
    return s[:i-1] + s[i] + s[i-1] + s[i+1:]

def sample(n_per=900):
    X, y = [], []
    for c in CLASSES:
        for _ in range(n_per):
            t = random.choice(T[c])
            s = random.choice(PREFIX) + fill(t) + fill(random.choice(SUFFIX))
            if random.random() < 0.3: s = s.upper() if random.random() < 0.2 else s.capitalize()
            X.append(typo(s)); y.append(c)
    return X, y
