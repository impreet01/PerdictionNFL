// trainer/metrics.js
// Lightweight metric helpers for binary classification.

export function logLoss(yTrue = [], probs = []) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return null;
  const eps = 1e-12;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const y = Number(yTrue[i]);
    const p = Number(probs[i]);
    if (!Number.isFinite(y) || !Number.isFinite(p)) continue;
    const clipped = Math.min(Math.max(p, eps), 1 - eps);
    sum += -(y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped));
    count += 1;
  }
  return count ? sum / count : null;
}

export function brier(yTrue = [], probs = []) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const y = Number(yTrue[i]);
    const p = Number(probs[i]);
    if (!Number.isFinite(y) || !Number.isFinite(p)) continue;
    const diff = p - y;
    sum += diff * diff;
    count += 1;
  }
  return count ? sum / count : null;
}

export function accuracy(yTrue = [], probs = [], threshold = 0.5) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return null;
  let correct = 0;
  let count = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const y = Number(yTrue[i]);
    const p = Number(probs[i]);
    if (!Number.isFinite(y) || !Number.isFinite(p)) continue;
    const pred = p >= threshold ? 1 : 0;
    if (pred === y) correct += 1;
    count += 1;
  }
  return count ? correct / count : null;
}

export function aucRoc(yTrue = [], probs = []) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return null;
  const pairs = [];
  for (let i = 0; i < yTrue.length; i++) {
    const y = Number(yTrue[i]);
    const p = Number(probs[i]);
    if (!Number.isFinite(y) || !Number.isFinite(p)) continue;
    pairs.push({ y, p });
  }
  if (!pairs.length) return null;
  const pos = pairs.filter((r) => r.y === 1).length;
  const neg = pairs.length - pos;
  if (!pos || !neg) return null;

  pairs.sort((a, b) => a.p - b.p);
  let rank = 1;
  let sumRanksPos = 0;
  for (let i = 0; i < pairs.length; ) {
    let j = i + 1;
    while (j < pairs.length && pairs[j].p === pairs[i].p) j += 1;
    const avgRank = (rank + (rank + (j - i) - 1)) / 2;
    for (let k = i; k < j; k++) {
      if (pairs[k].y === 1) sumRanksPos += avgRank;
    }
    rank += j - i;
    i = j;
  }
  return (sumRanksPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function calibrationBins(yTrue = [], probs = [], bins = 10) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return [];
  const records = Array.from({ length: bins }, (_, idx) => ({
    bin: idx,
    lower: idx / bins,
    upper: (idx + 1) / bins,
    sumP: 0,
    sumY: 0,
    n: 0
  }));

  for (let i = 0; i < yTrue.length; i++) {
    const y = Number(yTrue[i]);
    const p = Number(probs[i]);
    if (!Number.isFinite(y) || !Number.isFinite(p)) continue;
    const clipped = Math.min(Math.max(p, 0), 1);
    const idx = Math.min(bins - 1, Math.floor(clipped * bins));
    const rec = records[idx];
    rec.sumP += clipped;
    rec.sumY += y;
    rec.n += 1;
  }

  return records
    .filter((rec) => rec.n > 0)
    .map((rec) => ({
      bin: rec.bin,
      lower: rec.lower,
      upper: rec.upper,
      p_mean: rec.sumP / rec.n,
      y_rate: rec.sumY / rec.n,
      n: rec.n
    }));
}

export default {
  logLoss,
  brier,
  accuracy,
  aucRoc,
  calibrationBins
};
