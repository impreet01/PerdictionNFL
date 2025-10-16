// trainer/metrics.js
// Lightweight metric helpers for binary classification.

/**
 * Convert an arbitrary value to a finite number, returning a fallback when conversion fails.
 * @param {unknown} value
 * @param {number|null} [fallback=null]
 * @returns {number|null}
 */
export const toFiniteNumber = (value, fallback = null) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (Number.isNaN(num)) return fallback;
  return num;
};

/**
 * Compute binary log loss while ignoring invalid entries.
 * @param {ArrayLike<number>} yTrue
 * @param {ArrayLike<number>} probs
 * @returns {number|null}
 */
export function logLoss(yTrue = [], probs = []) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return null;
  const eps = 1e-12;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const y = toFiniteNumber(yTrue[i]);
    const p = toFiniteNumber(probs[i]);
    if (y == null || p == null) continue;
    const clipped = Math.min(Math.max(p, eps), 1 - eps);
    sum += -(y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped));
    count += 1;
  }
  return count ? sum / count : null;
}

/**
 * Compute Brier score (mean squared error between probabilities and labels).
 * @param {ArrayLike<number>} yTrue
 * @param {ArrayLike<number>} probs
 * @returns {number|null}
 */
export function brier(yTrue = [], probs = []) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const y = toFiniteNumber(yTrue[i]);
    const p = toFiniteNumber(probs[i]);
    if (y == null || p == null) continue;
    const diff = p - y;
    sum += diff * diff;
    count += 1;
  }
  return count ? sum / count : null;
}

/**
 * Classification accuracy at a chosen threshold.
 * @param {ArrayLike<number>} yTrue
 * @param {ArrayLike<number>} probs
 * @param {number} threshold
 * @returns {number|null}
 */
export function accuracy(yTrue = [], probs = [], threshold = 0.5) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return null;
  const cut = toFiniteNumber(threshold, 0.5);
  let correct = 0;
  let count = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const y = toFiniteNumber(yTrue[i]);
    const p = toFiniteNumber(probs[i]);
    if (y == null || p == null) continue;
    const pred = p >= cut ? 1 : 0;
    if (pred === y) correct += 1;
    count += 1;
  }
  return count ? correct / count : null;
}

/**
 * Area under the ROC curve using a rank-sum formulation.
 * @param {ArrayLike<number>} yTrue
 * @param {ArrayLike<number>} probs
 * @returns {number|null}
 */
export function aucRoc(yTrue = [], probs = []) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return null;
  const pairs = [];
  for (let i = 0; i < yTrue.length; i++) {
    const y = toFiniteNumber(yTrue[i]);
    const p = toFiniteNumber(probs[i]);
    if (y == null || p == null) continue;
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

/**
 * Reliability curve bins for calibration diagnostics.
 * @param {ArrayLike<number>} yTrue
 * @param {ArrayLike<number>} probs
 * @param {number} bins
 * @returns {Array<{bin:number,lower:number,upper:number,p_mean:number,y_rate:number,n:number}>}
 */
export function calibrationBins(yTrue = [], probs = [], bins = 10) {
  if (!Array.isArray(yTrue) || yTrue.length === 0) return [];
  const usableBins = Math.max(1, Math.round(bins));
  const records = Array.from({ length: usableBins }, (_, idx) => ({
    bin: idx,
    lower: idx / usableBins,
    upper: (idx + 1) / usableBins,
    sumP: 0,
    sumY: 0,
    n: 0
  }));

  for (let i = 0; i < yTrue.length; i++) {
    const y = toFiniteNumber(yTrue[i]);
    const p = toFiniteNumber(probs[i]);
    if (y == null || p == null) continue;
    const clipped = Math.min(Math.max(p, 0), 1);
    const idx = Math.min(usableBins - 1, Math.floor(clipped * usableBins));
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
  toFiniteNumber,
  logLoss,
  brier,
  accuracy,
  aucRoc,
  calibrationBins
};
