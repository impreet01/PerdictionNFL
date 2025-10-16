// trainer/model_ann.js
// Lightweight ANN committee for win probability estimation

import modelParams from "../config/modelParams.json" with { type: "json" };

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const tanh = (z) => Math.tanh(z);
const dtanh = (z) => 1 - Math.tanh(z) ** 2;
const EPS = 1e-6;

const toFinite = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

function makeLCG(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function initMatrix(rows, cols, rng, scale = 0.1) {
  const m = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) {
      row[c] = (rng() * 2 - 1) * scale;
    }
    m[r] = row;
  }
  return m;
}

function initVector(size, val = 0) {
  return new Array(size).fill(val);
}

function dotVec(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function matVec(W, v) {
  return W.map((row) => dotVec(row, v));
}

function addVec(a, b) {
  return a.map((v, i) => v + (b[i] ?? 0));
}

function applyFunc(v, fn) {
  return v.map(fn);
}

function zeroLike(mat) {
  return mat.map((row) => row.map(() => 0));
}

function copyNetwork(network) {
  return {
    weights: network.weights.map((matrix) => matrix.map((row) => row.slice())),
    biases: network.biases.map((b) => b.slice()),
    batchNorm: network.batchNorm?.map((bn) => ({
      gamma: bn.gamma.slice(),
      beta: bn.beta.slice(),
      runningMean: bn.runningMean.slice(),
      runningVar: bn.runningVar.slice(),
      momentum: bn.momentum
    })) ?? [],
    dropoutRates: Array.isArray(network.dropoutRates)
      ? network.dropoutRates.slice()
      : network.dropoutRates
  };
}

function initNetwork(inputDim, architecture, rng, dropoutRates = []) {
  const arch = Array.isArray(architecture) && architecture.length ? architecture : [128, 64, 32];
  const weights = [];
  const biases = [];
  const batchNorm = [];
  let prev = inputDim;
  for (let layerIdx = 0; layerIdx < arch.length; layerIdx++) {
    const size = arch[layerIdx];
    const scale = 0.1 / Math.sqrt(Math.max(1, prev));
    weights.push(initMatrix(size, prev, rng, scale));
    biases.push(initVector(size));
    batchNorm.push({
      gamma: initVector(size, 1),
      beta: initVector(size, 0),
      runningMean: initVector(size, 0),
      runningVar: initVector(size, 1),
      momentum: 0.1
    });
    prev = size;
  }
  const outScale = Math.sqrt(1 / Math.max(1, prev));
  weights.push(initMatrix(1, prev, rng, outScale));
  biases.push(initVector(1));
  return { weights, biases, batchNorm, dropoutRates };
}

function applyBatchNorm(values, params, training) {
  const normed = new Array(values.length);
  const output = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (training) {
      const mean = (1 - params.momentum) * params.runningMean[i] + params.momentum * values[i];
      const centered = values[i] - mean;
      const variance =
        (1 - params.momentum) * params.runningVar[i] + params.momentum * Math.max(centered * centered, EPS);
      params.runningMean[i] = mean;
      params.runningVar[i] = Math.max(variance, EPS);
    }
    const meanEval = params.runningMean[i];
    const invStd = 1 / Math.sqrt((params.runningVar[i] ?? 1) + EPS);
    const normalized = (values[i] - meanEval) * invStd;
    normed[i] = normalized;
    output[i] = params.gamma[i] * normalized + params.beta[i];
  }
  return { output, normed };
}

function batchNormBackward(grad, cache, params) {
  const gradInput = new Array(grad.length).fill(0);
  const gradGamma = new Array(grad.length).fill(0);
  const gradBeta = new Array(grad.length).fill(0);
  for (let i = 0; i < grad.length; i++) {
    gradGamma[i] += grad[i] * cache.normed[i];
    gradBeta[i] += grad[i];
    const invStd = 1 / Math.sqrt((params.runningVar[i] ?? 1) + EPS);
    gradInput[i] = grad[i] * params.gamma[i] * invStd;
  }
  return { gradInput, gradGamma, gradBeta };
}

function resolveDropout(rate, idx, fallback) {
  if (Array.isArray(rate)) {
    if (Number.isFinite(rate[idx])) return rate[idx];
    if (Number.isFinite(rate[0])) return rate[0];
    return fallback;
  }
  return Number.isFinite(rate) ? rate : fallback;
}

function forward(network, x, { training = false } = {}) {
  const { weights, biases } = network;
  const activations = [x];
  const zs = [];
  const bnCaches = [];
  const dropoutMasks = [];
  let a = x;
  const lastIdx = weights.length - 1;
  for (let l = 0; l < lastIdx; l++) {
    const linear = addVec(matVec(weights[l], a), biases[l]);
    let z = linear;
    if (network.batchNorm?.[l]) {
      const bnResult = applyBatchNorm(linear, network.batchNorm[l], training);
      z = bnResult.output;
      bnCaches.push({ normed: bnResult.normed });
    } else {
      bnCaches.push(null);
    }
    zs.push(z);
    a = applyFunc(z, tanh);
    const dropoutRate = resolveDropout(network.dropoutRates, l, 0);
    if (training && Number.isFinite(dropoutRate) && dropoutRate > 0 && dropoutRate < 1) {
      const keepProb = 1 - dropoutRate;
      const mask = a.map(() => (Math.random() < keepProb ? 1 / keepProb : 0));
      a = a.map((val, idx) => val * mask[idx]);
      dropoutMasks.push(mask);
    } else {
      dropoutMasks.push(null);
    }
    activations.push(a);
  }
  const outLinear = addVec(matVec(weights[lastIdx], a), biases[lastIdx]);
  const zOut = outLinear[0];
  const out = sigmoid(zOut);
  return { activations, zs, zOut, out, bnCaches, dropoutMasks };
}

function backward(network, cache, target) {
  const { weights, biases } = network;
  const gradW = weights.map((W) => zeroLike(W));
  const gradB = biases.map((b) => initVector(b.length));
  const gradGamma = network.batchNorm?.map((bn) => initVector(bn.gamma.length)) ?? [];
  const gradBeta = network.batchNorm?.map((bn) => initVector(bn.beta.length)) ?? [];

  const lastIdx = weights.length - 1;
  const deltaOut = cache.out - target;
  const lastActivation = cache.activations[lastIdx] || cache.activations.at(-1) || [];
  for (let j = 0; j < weights[lastIdx][0].length; j++) {
    gradW[lastIdx][0][j] += deltaOut * lastActivation[j];
  }
  gradB[lastIdx][0] += deltaOut;

  let downstream = new Array(weights[lastIdx][0].length).fill(0);
  for (let j = 0; j < downstream.length; j++) {
    downstream[j] = deltaOut * weights[lastIdx][0][j];
  }

  for (let layer = lastIdx - 1; layer >= 0; layer--) {
    const z = cache.zs[layer];
    const prevActivation = cache.activations[layer];
    const current = new Array(weights[layer].length).fill(0);
    const dropoutMask = cache.dropoutMasks?.[layer];
    for (let j = 0; j < weights[layer].length; j++) {
      let delta = downstream[j] * dtanh(z[j]);
      if (dropoutMask && dropoutMask[j] === 0) delta = 0;
      gradB[layer][j] += delta;
      current[j] = delta;
    }
    let postBN = current;
    if (cache.bnCaches?.[layer] && network.batchNorm?.[layer]) {
      const bnGrads = batchNormBackward(current, cache.bnCaches[layer], network.batchNorm[layer]);
      postBN = bnGrads.gradInput;
      for (let j = 0; j < bnGrads.gradGamma.length; j++) {
        gradGamma[layer][j] += bnGrads.gradGamma[j];
        gradBeta[layer][j] += bnGrads.gradBeta[j];
      }
    }
    for (let j = 0; j < weights[layer].length; j++) {
      for (let k = 0; k < weights[layer][j].length; k++) {
        gradW[layer][j][k] += postBN[j] * prevActivation[k];
      }
    }
    const prevSize = weights[layer][0]?.length ?? prevActivation.length;
    const newDownstream = new Array(prevSize).fill(0);
    for (let j = 0; j < weights[layer].length; j++) {
      for (let k = 0; k < weights[layer][j].length; k++) {
        newDownstream[k] += postBN[j] * weights[layer][j][k];
      }
    }
    downstream = newDownstream;
  }

  return { gradW, gradB, gradGamma, gradBeta };
}

function updateNetwork(network, grads, lr, l2 = 0) {
  for (let l = 0; l < network.weights.length; l++) {
    const W = network.weights[l];
    const gW = grads.gradW[l];
    for (let i = 0; i < W.length; i++) {
      for (let j = 0; j < W[i].length; j++) {
        const penalty = l2 ? l2 * W[i][j] : 0;
        W[i][j] -= lr * (gW[i][j] + penalty);
      }
    }
    const b = network.biases[l];
    const gB = grads.gradB[l];
    for (let i = 0; i < b.length; i++) {
      b[i] -= lr * gB[i];
    }
    if (l < network.batchNorm.length) {
      const bn = network.batchNorm[l];
      const gGamma = grads.gradGamma?.[l];
      const gBeta = grads.gradBeta?.[l];
      if (gGamma) {
        for (let i = 0; i < bn.gamma.length; i++) {
          bn.gamma[i] -= lr * gGamma[i];
        }
      }
      if (gBeta) {
        for (let i = 0; i < bn.beta.length; i++) {
          bn.beta[i] -= lr * gBeta[i];
        }
      }
    }
  }
}

function lossBCE(pred, target) {
  const eps = 1e-12;
  return -(target * Math.log(Math.max(pred, eps)) + (1 - target) * Math.log(Math.max(1 - pred, eps)));
}

export function splitTrainVal(X, y, valFraction = 0.2, rng = Math.random) {
  const n = X.length;
  if (n <= 1) {
    return { trainIdx: n ? [0] : [], valIdx: [] };
  }
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor((rng() ?? Math.random()) * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const valSize = Math.min(Math.max(1, Math.floor(n * valFraction)), Math.max(1, n - 1));
  let trainIdx = idx.slice(valSize);
  let valIdx = idx.slice(0, valSize);
  if (!trainIdx.length) {
    trainIdx = [valIdx[0]];
    valIdx = valIdx.slice(1);
  }
  return { trainIdx, valIdx };
}

function selectRows(X, idx) {
  return idx.map((i) => X[i]);
}

function selectVals(arr, idx) {
  return idx.map((i) => arr[i]);
}

function ensureConsistentDimensions(X = []) {
  if (!Array.isArray(X) || !X.length) return 0;
  const dim = X[0]?.length || 0;
  for (const row of X) {
    if (!Array.isArray(row) || row.length !== dim) {
      throw new Error("Inconsistent feature dimensions for ANN training");
    }
  }
  return dim;
}

function trainSingleNetwork(
  X,
  y,
  {
    seed = 1,
    maxEpochs = 200,
    lr = 1e-3,
    patience = 10,
    architecture = [128, 64, 32],
    batchSize = modelParams?.ann?.batchSize ?? 32,
    l2 = 1e-4,
    dropout = modelParams?.ann?.dropout ?? 0.3
  }
) {
  const rng = makeLCG(seed);
  const splitRng = makeLCG((seed ^ 0xa5a5a5a5) >>> 0);
  const inputDim = ensureConsistentDimensions(X);
  const dropoutArr = Array.isArray(dropout) ? dropout : [dropout];
  const net = initNetwork(inputDim, architecture, rng, dropoutArr);

  if (X.length <= 1 || !inputDim) {
    return { network: net, epochs: 0, bestLoss: Infinity };
  }

  const { trainIdx, valIdx } = splitTrainVal(
    X,
    y,
    Math.min(0.2, Math.max(0.1, 1 / Math.max(2, X.length))),
    splitRng
  );
  const Xtrain = selectRows(X, trainIdx);
  const ytrain = selectVals(y, trainIdx);
  const Xval = selectRows(X, valIdx.length ? valIdx : trainIdx);
  const yval = selectVals(y, valIdx.length ? valIdx : trainIdx);

  let best = copyNetwork(net);
  let bestLoss = Infinity;
  let badRounds = 0;
  let epochs = 0;

  const batch = Math.max(1, Math.min(Math.round(batchSize) || 1, Xtrain.length));
  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    epochs = epoch + 1;
    const indices = Array.from({ length: Xtrain.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    for (let start = 0; start < indices.length; start += batch) {
      const end = Math.min(indices.length, start + batch);
      const grads = {
        gradW: net.weights.map((W) => zeroLike(W)),
        gradB: net.biases.map((b) => initVector(b.length)),
        gradGamma: net.batchNorm.map((bn) => initVector(bn.gamma.length)),
        gradBeta: net.batchNorm.map((bn) => initVector(bn.beta.length))
      };
      for (let idx = start; idx < end; idx++) {
        const rowIdx = indices[idx];
        const cache = forward(net, Xtrain[rowIdx], { training: true });
        const g = backward(net, cache, ytrain[rowIdx]);
        for (let l = 0; l < grads.gradW.length; l++) {
          for (let r = 0; r < grads.gradW[l].length; r++) {
            for (let c = 0; c < grads.gradW[l][r].length; c++) {
              grads.gradW[l][r][c] += g.gradW[l][r][c];
            }
          }
          for (let r = 0; r < grads.gradB[l].length; r++) {
            grads.gradB[l][r] += g.gradB[l][r];
          }
          if (l < grads.gradGamma.length && g.gradGamma?.[l]) {
            for (let r = 0; r < grads.gradGamma[l].length; r++) {
              grads.gradGamma[l][r] += g.gradGamma[l][r];
              grads.gradBeta[l][r] += g.gradBeta[l][r];
            }
          }
        }
      }
      const denom = Math.max(1, end - start);
      for (let l = 0; l < grads.gradW.length; l++) {
        for (let r = 0; r < grads.gradW[l].length; r++) {
          for (let c = 0; c < grads.gradW[l][r].length; c++) {
            const penalty = l2 * net.weights[l][r][c];
            grads.gradW[l][r][c] = grads.gradW[l][r][c] / denom + penalty;
          }
        }
        for (let r = 0; r < grads.gradB[l].length; r++) {
          grads.gradB[l][r] /= denom;
        }
        if (l < grads.gradGamma.length) {
          for (let r = 0; r < grads.gradGamma[l].length; r++) {
            grads.gradGamma[l][r] /= denom;
            grads.gradBeta[l][r] /= denom;
          }
        }
      }
      updateNetwork(net, grads, lr, l2);
    }

    let valLoss = 0;
    for (let i = 0; i < Xval.length; i++) {
      const pred = forward(net, Xval[i], { training: false }).out;
      valLoss += lossBCE(pred, yval[i]);
    }
    valLoss /= Math.max(1, Xval.length);
    if (valLoss + 1e-6 < bestLoss) {
      bestLoss = valLoss;
      best = copyNetwork(net);
      badRounds = 0;
    } else {
      badRounds += 1;
      if (badRounds >= patience) break;
    }
  }

  return { network: best, epochs, bestLoss };
}

export function trainANNCommittee(
  X,
  y,
  {
    seeds = 5,
    maxEpochs = Number(process.env.ANN_MAX_EPOCHS ?? 300),
    lr = 1e-3,
    patience = 12,
    timeLimitMs = 70000,
    architecture,
    committeeSize: committeeSizeOption,
    committees: committeesOption,
    batchSize,
    l2,
    dropout
  } = {}
) {
  if (!X?.length) {
    return { models: [], committees: [], seeds: [], architecture: [0, 1], validationLosses: [] };
  }
  const start = Date.now();
  const results = [];
  const maxSeeds = Math.max(1, Math.round(seeds));
  const arch = Array.isArray(architecture) && architecture.length ? architecture : [128, 64, 32];
  const committeeSize = Math.max(1, Math.round(committeeSizeOption ?? Math.min(5, maxSeeds, 5)));
  const maxCommitteesDefault = Math.max(1, Math.ceil(maxSeeds / committeeSize));
  const committeeCount = Math.max(1, Math.round(committeesOption ?? Math.min(3, maxCommitteesDefault)));
  for (let i = 0; i < maxSeeds; i++) {
    const seed = i + 1;
    const result = trainSingleNetwork(X, y, {
      seed,
      maxEpochs,
      lr,
      patience,
      architecture: arch,
      batchSize,
      l2,
      dropout
    });
    results.push({ ...result, seed });
    const lossMsg = Number.isFinite(result.bestLoss) ? result.bestLoss.toFixed(4) : "inf";
    console.log(`[ANN] seed=${seed} valLoss=${lossMsg}`);
    if (Date.now() - start > timeLimitMs) break;
  }
  results.sort((a, b) => (a.bestLoss ?? Infinity) - (b.bestLoss ?? Infinity));
  const selectionCount = Math.min(results.length, committeeSize * committeeCount);
  const selected = results.slice(0, selectionCount);
  const committees = [];
  for (let c = 0; c < committeeCount; c++) {
    const slice = selected.slice(c * committeeSize, (c + 1) * committeeSize);
    if (!slice.length) break;
    committees.push({
      networks: slice.map((r) => r.network),
      seeds: slice.map((r) => r.seed),
      losses: slice.map((r) => r.bestLoss)
    });
  }
  if (!committees.length && results.length) {
    const best = results[0];
    committees.push({ networks: [best.network], seeds: [best.seed], losses: [best.bestLoss] });
  }
  const flatModels = committees.flatMap((c) => c.networks);
  const flatSeeds = committees.flatMap((c) => c.seeds);
  return {
    committees,
    models: flatModels,
    seeds: flatSeeds,
    architecture: [X[0]?.length || 0, ...arch, 1],
    validationLosses: results.map(({ seed, bestLoss }) => ({ seed, bestLoss })),
    selected: selected.map(({ seed, bestLoss }) => ({ seed, bestLoss }))
  };
}

export function predictANNCommittee(model, X) {
  const committees = model?.committees?.length
    ? model.committees
    : model?.models?.length
      ? [{ networks: model.models }]
      : [];
  if (!committees.length) return X.map(() => 0.5);
  const scores = new Array(X.length).fill(0);
  let activeCount = 0;
  for (const committee of committees) {
    if (!committee.networks?.length) continue;
    activeCount += 1;
    const committeeScores = new Array(X.length).fill(0);
    for (const net of committee.networks) {
      for (let i = 0; i < X.length; i++) {
        committeeScores[i] += forward(net, X[i], { training: false }).out;
      }
    }
    for (let i = 0; i < X.length; i++) {
      committeeScores[i] /= committee.networks.length;
      scores[i] += committeeScores[i];
    }
  }
  if (!activeCount) return X.map(() => 0.5);
  return scores.map((p) => p / activeCount);
}

function gradientInput(network, x) {
  const cache = forward(network, x, { training: false });
  const { weights } = network;
  const lastIdx = weights.length - 1;
  const deltaOut = cache.out * (1 - cache.out);
  if (weights.length === 1) {
    return weights[0][0].map((w) => deltaOut * w);
  }
  let downstream = new Array(weights[lastIdx][0].length).fill(0);
  for (let j = 0; j < downstream.length; j++) {
    downstream[j] = deltaOut * weights[lastIdx][0][j];
  }
  for (let layer = lastIdx - 1; layer >= 0; layer--) {
    const z = cache.zs[layer] || [];
    const neurons = weights[layer].length;
    const dropoutMask = cache.dropoutMasks?.[layer];
    const current = new Array(neurons).fill(0);
    for (let j = 0; j < neurons; j++) {
      let activation = dtanh(z[j]);
      if (dropoutMask && dropoutMask[j] === 0) activation = 0;
      current[j] = downstream[j] * activation;
    }
    if (cache.bnCaches?.[layer] && network.batchNorm?.[layer]) {
      const bnGrads = batchNormBackward(current, cache.bnCaches[layer], network.batchNorm[layer]);
      for (let j = 0; j < neurons; j++) {
        current[j] = bnGrads.gradInput[j];
      }
    }
    const prevSize = weights[layer][0]?.length ?? x.length;
    const newDownstream = new Array(prevSize).fill(0);
    for (let j = 0; j < neurons; j++) {
      const row = weights[layer][j];
      for (let k = 0; k < prevSize; k++) {
        newDownstream[k] += current[j] * toFinite(row?.[k], 0);
      }
    }
    if (layer === 0) {
      return newDownstream.map((v) => toFinite(v, 0));
    }
    downstream = newDownstream;
  }
  return new Array(x.length).fill(0);
}

export function gradientANNCommittee(model, x) {
  const committees = model?.committees?.length
    ? model.committees
    : model?.models?.length
      ? [{ networks: model.models }]
      : [];
  if (!committees.length) return new Array(x.length).fill(0);
  const grad = new Array(x.length).fill(0);
  let activeCount = 0;
  for (const committee of committees) {
    if (!committee.networks?.length) continue;
    activeCount += 1;
    const committeeGrad = new Array(x.length).fill(0);
    for (const net of committee.networks) {
      const g = gradientInput(net, x);
      for (let i = 0; i < grad.length; i++) committeeGrad[i] += g[i];
    }
    for (let i = 0; i < grad.length; i++) {
      committeeGrad[i] /= committee.networks.length;
      grad[i] += committeeGrad[i];
    }
  }
  if (!activeCount) return new Array(x.length).fill(0);
  for (let i = 0; i < grad.length; i++) grad[i] /= activeCount;
  return grad;
}

export default trainANNCommittee;
