import path from "node:path";
import { promises as fsp } from "node:fs";
import crypto from "node:crypto";

const MODELS_ROOT = path.resolve("artifacts", "models");

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function safeProb(value) {
  const num = toNumber(value, 0.5);
  if (!Number.isFinite(num)) return 0.5;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function plattCalibrate(probs, labels) {
  if (!Array.isArray(probs) || !Array.isArray(labels) || !labels.length) {
    return { type: "identity", beta: 0 };
  }
  const logits = probs.map((p) => {
    const eps = 1e-12;
    const v = Math.min(Math.max(p, eps), 1 - eps);
    return Math.log(v / (1 - v));
  });
  let beta = 0;
  for (let iter = 0; iter < 200; iter += 1) {
    let grad = 0;
    let hess = 0;
    for (let i = 0; i < labels.length; i += 1) {
      const z = logits[i] + beta;
      const p = 1 / (1 + Math.exp(-z));
      grad += p - labels[i];
      hess += p * (1 - p);
    }
    if (Math.abs(grad) < 1e-6) break;
    beta -= grad / Math.max(1e-6, hess);
  }
  if (!Number.isFinite(beta)) beta = 0;
  return { type: "platt", beta };
}

function applyPlatt(prob, beta) {
  const eps = 1e-12;
  const v = Math.min(Math.max(prob, eps), 1 - eps);
  const logit = Math.log(v / (1 - v));
  const z = logit + beta;
  return 1 / (1 + Math.exp(-z));
}

function detectDegenerate(labels, probs) {
  if (!Array.isArray(labels) || labels.length < 3) return true;
  let pos = 0;
  for (const label of labels) {
    if (Number(label) === 1) pos += 1;
  }
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return true;
  const mean = labels.reduce((acc, v) => acc + Number(v || 0), 0) / labels.length;
  const variance = labels.reduce((acc, v) => {
    const diff = Number(v || 0) - mean;
    return acc + diff * diff;
  }, 0) / labels.length;
  if (variance < 1e-6) return true;
  if (Array.isArray(probs) && probs.length === labels.length) {
    const meanProb = probs.reduce((acc, v) => acc + Number(v || 0), 0) / probs.length;
    const probVar = probs.reduce((acc, v) => {
      const diff = Number(v || 0) - meanProb;
      return acc + diff * diff;
    }, 0) / probs.length;
    if (probVar < 1e-6) return true;
  }
  return false;
}

function isotonicFit(probs, labels) {
  if (!Array.isArray(probs) || probs.length !== labels.length || !probs.length) {
    return null;
  }
  const pairs = probs.map((p, idx) => ({ prob: safeProb(p), label: Number(labels[idx] || 0) }));
  pairs.sort((a, b) => a.prob - b.prob);
  const blocks = pairs.map((pair, idx) => ({ start: idx, end: idx, sum: pair.label, weight: 1, avg: pair.label }));
  for (let i = 0; i < blocks.length; i += 1) {
    if (i === 0) continue;
    if (blocks[i - 1].avg <= blocks[i].avg + 1e-9) continue;
    const merged = {
      start: blocks[i - 1].start,
      end: blocks[i].end,
      sum: blocks[i - 1].sum + blocks[i].sum,
      weight: blocks[i - 1].weight + blocks[i].weight
    };
    merged.avg = merged.sum / merged.weight;
    blocks.splice(i - 1, 2, merged);
    i = Math.max(0, i - 2);
  }
  const fitted = new Array(pairs.length).fill(0.5);
  for (const block of blocks) {
    const value = Math.min(0.999, Math.max(0.001, block.avg));
    for (let idx = block.start; idx <= block.end; idx += 1) {
      fitted[idx] = value;
    }
  }
  const mapped = pairs.map((pair, idx) => ({ prob: pair.prob, calibrated: fitted[idx] }));
  const xs = mapped.map((m) => m.prob);
  const ys = mapped.map((m) => m.calibrated);
  return {
    type: "isotonic",
    points: mapped,
    xs,
    ys
  };
}

function applyIsotonic(prob, calibrator) {
  if (!calibrator?.xs?.length) return safeProb(prob);
  const xs = calibrator.xs;
  const ys = calibrator.ys;
  const value = safeProb(prob);
  if (value <= xs[0]) return ys[0];
  if (value >= xs[xs.length - 1]) return ys[ys.length - 1];
  let low = 0;
  let high = xs.length - 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (xs[mid] <= value) low = mid;
    else high = mid;
  }
  const span = xs[high] - xs[low] || 1;
  const weight = (value - xs[low]) / span;
  return ys[low] * (1 - weight) + ys[high] * weight;
}

async function loadPriorCalibration(season) {
  if (!Number.isFinite(season) || season < 1999) return null;
  const candidates = [
    path.join(MODELS_ROOT, String(season), "week-00", "ensemble.json"),
    path.join(MODELS_ROOT, String(season), "final", "ensemble.json")
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fsp.readFile(candidate, "utf8");
      const parsed = JSON.parse(raw);
      const calibration =
        parsed?.calibration ??
        parsed?.ensemble?.calibration ??
        parsed?.meta?.calibration ??
        parsed?.summary?.calibration ??
        null;
      if (!calibration) continue;
      if (typeof calibration.beta === "number") {
        return {
          type: "platt",
          beta: calibration.beta,
          source: "prior",
          season
        };
      }
      if (Array.isArray(calibration.points)) {
        return {
          type: "isotonic",
          points: calibration.points,
          xs: calibration.points.map((p) => safeProb(p.prob ?? p.x ?? 0.5)),
          ys: calibration.points.map((p) => safeProb(p.calibrated ?? p.y ?? 0.5)),
          source: "prior",
          season
        };
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`[calibrate] Unable to load prior calibration from ${candidate}: ${err?.message ?? err}`);
      }
    }
  }
  return null;
}

function leaguePriorCalibrator({ lambda = 0.85, mean = 0.56 } = {}) {
  return {
    type: "league_prior",
    lambda: safeProb(lambda),
    mean: safeProb(mean)
  };
}

function applyLeaguePrior(prob, calibrator) {
  const lambda = Number.isFinite(calibrator?.lambda) ? calibrator.lambda : 0.85;
  const mean = Number.isFinite(calibrator?.mean) ? calibrator.mean : 0.56;
  const p = safeProb(prob);
  return safeProb(lambda * p + (1 - lambda) * mean);
}

export async function resolveCalibration({ probs, labels, season, week }) {
  const degenerate = detectDegenerate(labels, probs);
  if (!degenerate) {
    const cal = plattCalibrate(probs, labels);
    return {
      type: cal.type,
      meta: { type: cal.type, beta: cal.beta, source: "platt" },
      apply(prob) {
        return safeProb(applyPlatt(prob, cal.beta));
      }
    };
  }

  const prior = await loadPriorCalibration(season - 1);
  if (prior) {
    if (prior.type === "platt") {
      return {
        type: "platt",
        meta: { type: "platt", beta: prior.beta, source: "prior", season: prior.season },
        apply(prob) {
          return safeProb(applyPlatt(prob, prior.beta));
        }
      };
    }
    if (prior.type === "isotonic") {
      return {
        type: "isotonic",
        meta: { type: "isotonic", source: "prior", season: prior.season },
        apply(prob) {
          return safeProb(applyIsotonic(prob, prior));
        }
      };
    }
  }

  const iso = isotonicFit(probs, labels);
  if (iso) {
    return {
      type: "isotonic",
      meta: { type: "isotonic", source: "isotonic" },
      apply(prob) {
        return safeProb(applyIsotonic(prob, iso));
      }
    };
  }

  const league = leaguePriorCalibrator({ lambda: 0.85, mean: 0.56 });
  return {
    type: league.type,
    meta: { type: league.type, lambda: league.lambda, mean: league.mean, source: "league_prior" },
    apply(prob) {
      return safeProb(applyLeaguePrior(prob, league));
    }
  };
}

export function hashCalibrationMeta(meta) {
  if (!meta) return null;
  try {
    return crypto.createHash("sha256").update(JSON.stringify(meta)).digest("hex");
  } catch (err) {
    console.warn(`[calibrate] Failed to hash calibration meta: ${err?.message ?? err}`);
    return null;
  }
}
