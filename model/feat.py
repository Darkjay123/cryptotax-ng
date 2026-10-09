"""Featurizer shared (byte-for-byte) with src/model/notes.ts. Keep both in sync."""
import re, unicodedata
DIM = 1 << 14

def fnv1a(s: str) -> int:
    h = 0x811c9dc5
    for b in s.encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xffffffff
    return h

def norm(text: str) -> str:
    t = unicodedata.normalize('NFKC', text).lower()
    t = t.replace('₦', ' naira ').replace('$', ' dollar ')
    t = re.sub(r"[’'`]", '', t)
    t = re.sub(r'\d+', '0', t)
    t = re.sub(r'[^a-z0 ]+', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()

def features(text: str) -> dict:
    t = norm(text)
    words = t.split(' ') if t else []
    f = {}
    def add(k):
        i = fnv1a(k) % DIM
        f[i] = f.get(i, 0) + 1
    for w in words: add('w:' + w)
    for a, b in zip(words, words[1:]): add('b:' + a + '_' + b)
    for w in words:
        p = '<' + w + '>'
        for n in (3, 4):
            for i in range(len(p) - n + 1): add('c:' + p[i:i+n])
    # l2 normalise (sublinear tf)
    import math
    for k in f: f[k] = 1 + math.log(f[k])
    z = math.sqrt(sum(v*v for v in f.values())) or 1.0
    return {k: v / z for k, v in f.items()}
