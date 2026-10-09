"""Trains models/notes_v1.* from gen.py examples and checks it on test_notes.tsv.
Run: python3 model/train.py   (from the repo root, needs scikit-learn, numpy, scipy)"""
import sys, os, json, hashlib
import numpy as np, scipy.sparse as sp
sys.path.insert(0, os.path.dirname(__file__))
import gen, feat
from sklearn.linear_model import LogisticRegression
here = os.path.dirname(__file__)
def mat(texts):
    r, c, v = [], [], []
    for i, t in enumerate(texts):
        for k, x in feat.features(t).items(): r.append(i); c.append(k); v.append(x)
    return sp.csr_matrix((v, (r, c)), shape=(len(texts), feat.DIM))
C = gen.CLASSES
X, y = gen.sample(900)
m = LogisticRegression(C=2, max_iter=3000).fit(mat(X), np.array([C.index(c) for c in y]))
test = [l.rstrip('\n').split('\t') for l in open(os.path.join(here, 'test_notes.tsv')) if l.strip()]
P = m.predict_proba(mat([t for _, t in test]))
acc = float(np.mean([C[p.argmax()] == c for (c, _), p in zip(test, P)]))
W = m.coef_.astype(np.float32)
out = os.path.join(here, '..', 'models'); os.makedirs(out, exist_ok=True)
open(os.path.join(out, 'notes_v1.bin'), 'wb').write(W.tobytes())
json.dump({'name': 'notes_v1', 'classes': C, 'dim': feat.DIM, 'intercept': [float(v) for v in m.intercept_],
           'train_examples': len(X), 'test_examples': len(test), 'test_accuracy': round(acc, 4),
           'sha256': hashlib.sha256(W.tobytes()).hexdigest()}, open(os.path.join(out, 'notes_v1.json'), 'w'), indent=1)
print('test accuracy', round(acc, 4))
