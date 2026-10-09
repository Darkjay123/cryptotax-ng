/**
 * Our own small model: reads a short note about a transaction ("Fhenix refunded my
 * flight", "na my binance i send am from") in English or Pidgin and suggests the tax
 * label. It is a linear classifier over hashed word and character features, trained
 * by us (model/train.py) and stored as plain weights (models/notes_v1.*). It never
 * decides tax: it only suggests a label, the person confirms it, and the rules engine
 * does the maths. Featurizer must match model/feat.py exactly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Label } from '../classify.js';

interface Meta { name: string; classes: string[]; dim: number; intercept: number[]; test_accuracy: number }

let model: { meta: Meta; W: Float32Array } | null = null;
function load() {
  if (model) return model;
  const dir = process.env.MODEL_DIR ?? join(process.cwd(), 'models');
  const meta = JSON.parse(readFileSync(join(dir, 'notes_v1.json'), 'utf8')) as Meta;
  const buf = readFileSync(join(dir, 'notes_v1.bin'));
  const W = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (W.length !== meta.classes.length * meta.dim) throw new Error('notes model size mismatch');
  model = { meta, W };
  return model;
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function norm(text: string): string {
  let t = text.normalize('NFKC').toLowerCase();
  t = t.replace(/₦/g, ' naira ').replace(/\$/g, ' dollar ');
  t = t.replace(/[’'`]/g, '');
  t = t.replace(/\d+/g, '0');
  t = t.replace(/[^a-z0 ]+/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function features(text: string, dim: number): Map<number, number> {
  const t = norm(text);
  const words = t ? t.split(' ') : [];
  const f = new Map<number, number>();
  const add = (k: string) => { const i = fnv1a(k) % dim; f.set(i, (f.get(i) ?? 0) + 1); };
  for (const w of words) add('w:' + w);
  for (let i = 0; i + 1 < words.length; i++) add('b:' + words[i] + '_' + words[i + 1]);
  for (const w of words) {
    const p = '<' + w + '>';
    for (const n of [3, 4]) for (let i = 0; i + n <= p.length; i++) add('c:' + p.slice(i, i + n));
  }
  let z = 0;
  for (const [k, v] of f) { const s = 1 + Math.log(v); f.set(k, s); z += s * s; }
  z = Math.sqrt(z) || 1;
  for (const [k, v] of f) f.set(k, v / z);
  return f;
}

export function probs(text: string): Record<string, number> {
  const { meta, W } = load();
  const x = features(text, meta.dim);
  const logits = meta.classes.map((_, c) => {
    let s = meta.intercept[c];
    for (const [k, v] of x) s += W[c * meta.dim + k] * v;
    return s;
  });
  const mx = Math.max(...logits);
  const e = logits.map(l => Math.exp(l - mx));
  const z = e.reduce((a, b) => a + b, 0);
  return Object.fromEntries(meta.classes.map((c, i) => [c, e[i] / z]));
}

const ALLOWED: Record<'in' | 'out', string[]> = {
  in: ['work', 'salary', 'staking', 'airdrop', 'defi', 'p2p', 'own', 'refund', 'gift', 'loan', 'spam'],
  out: ['p2p', 'own', 'gift', 'payment', 'loan', 'refund', 'spam'],
};

const MEANING: Record<string, { label: (d: 'in' | 'out', naira?: number) => Label; name: (d: 'in' | 'out') => string; why: (d: 'in' | 'out') => string }> = {
  work: { label: () => ({ kind: 'income', incomeKind: 'professional' }), name: () => 'Payment for work', why: () => 'Pay for work is income on the day you receive it (para 6.1.1).' },
  salary: { label: () => ({ kind: 'income', incomeKind: 'employment' }), name: () => 'Salary', why: () => 'Salary paid in crypto is employment income on the day received (para 6.1.1).' },
  staking: { label: () => ({ kind: 'income', incomeKind: 'staking' }), name: () => 'Staking reward', why: () => 'Staking and interest rewards are income when received (para 7.1).' },
  airdrop: { label: () => ({ kind: 'income', incomeKind: 'airdrop' }), name: () => 'Airdrop', why: () => 'Airdrops are income at market value when received (para 7.1).' },
  defi: { label: () => ({ kind: 'income', incomeKind: 'defi' }), name: () => 'DeFi yield', why: () => 'DeFi yield is income when received (para 7.1).' },
  p2p: {
    label: (d, naira) => ({ kind: d === 'in' ? 'bought' : 'sold', naira: naira ?? 0 }),
    name: d => d === 'in' ? 'Bought with naira' : 'Sold for naira (P2P)',
    why: d => d === 'in' ? 'Buying with naira is not taxed; it sets what the coins cost you (para 9.3).' : 'Selling for naira is a disposal: the dollar gain is taxed (para 9.1).',
  },
  own: { label: () => ({ kind: 'own_wallet' }), name: d => d === 'in' ? 'From my own wallet or exchange' : 'To my own wallet or exchange', why: () => 'Moving between your own wallets is not taxable (para 7.2.2).' },
  refund: {
    label: d => d === 'in' ? { kind: 'reimbursement' } : { kind: 'payment' },
    name: d => d === 'in' ? 'Refund of money I spent' : 'Paid for something',
    why: d => d === 'in' ? 'Being paid back for money you spent is not income. The coins still count as yours at their value that day.' : 'Sending crypto to someone is a disposal at market value; on stablecoins that is normally nil.',
  },
  gift: { label: d => ({ kind: d === 'in' ? 'gift_in' : 'gift_out' }), name: () => 'Gift', why: d => d === 'in' ? 'A gift is not income for you; its value that day becomes your cost (para 7.1 item 15).' : 'The giver pays no tax on a gift (para 7.1 item 15).' },
  payment: { label: () => ({ kind: 'payment' }), name: () => 'Paid for something', why: () => 'Paying with crypto is a disposal at market value (para 7.1 item 5).' },
  loan: {
    label: d => d === 'in' ? { kind: 'reimbursement' } : { kind: 'payment' },
    name: d => d === 'in' ? 'Loan received' : 'Loan repaid',
    why: d => d === 'in' ? 'Borrowed money is not income. The coins count as yours at their value that day.' : 'Repaying in crypto is a disposal at market value; on stablecoins that is normally nil.',
  },
  spam: { label: () => ({ kind: 'ignore' }), name: () => 'Spam, ignore', why: () => 'Left out: it has no value to you.' },
};

/** "150k", "₦300,000", "N1.2m", "300000 naira" -> naira amount, only when the note is clearly about naira. */
export function nairaIn(text: string): number | undefined {
  const t = text.toLowerCase().replace(/,/g, '');
  const m = t.match(/(?:₦|\bn|ngn\s*)?(\d+(?:\.\d+)?)\s*(k|m|million|thousand)?\s*(naira|ngn)?/g);
  if (!m) return undefined;
  for (const raw of m) {
    const g = raw.match(/(₦|\bn|ngn)?\s*(\d+(?:\.\d+)?)\s*(k|m|million|thousand)?\s*(naira|ngn)?/);
    if (!g) continue;
    const isNaira = !!g[1] || !!g[4] || !!g[3] || /naira|p2p/.test(t);
    if (!isNaira) continue;
    let v = Number(g[2]);
    if (g[3] === 'k' || g[3] === 'thousand') v *= 1e3;
    if (g[3] === 'm' || g[3] === 'million') v *= 1e6;
    if (v >= 500) return v; // ignore small numbers like "2nd place"
  }
  return undefined;
}

export interface Understood {
  id: string; label: Label | null; key: string | null; name: string; confidence: number; sure: boolean;
  why: string; naira?: number; model: string;
}

export function understand(id: string, text: string, direction: 'in' | 'out'): Understood {
  const { meta } = load();
  const p = probs(text);
  const allowed = ALLOWED[direction];
  const z = allowed.reduce((s, c) => s + p[c], 0) || 1;
  const best = allowed.map(c => [c, p[c] / z] as const).sort((a, b) => b[1] - a[1])[0];
  const [cls, conf] = best;
  const naira = cls === 'p2p' ? nairaIn(text) : undefined;
  const sure = conf >= 0.55;
  const mean = MEANING[cls];
  const label = sure ? mean.label(direction, naira) : null;
  const key = label ? (label.kind === 'income' ? `income:${label.incomeKind}` : label.kind) : null;
  return { id, label, key, name: mean.name(direction), confidence: Math.round(conf * 100) / 100, sure, why: sure ? mean.why(direction) : 'Not sure what this was. Pick it yourself.', naira, model: meta.name };
}
