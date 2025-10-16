// trainer/model_ann.js
// Lightweight ANN committee for win probability estimation

import modelParams from "../config/modelParams.json" with { type: "json" };

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const tanh = (z) => Math.tanh(z);
const dtanh = (z) => 1 - Math.tanh(z) ** 2;
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
    biases: network.biases.map((b) => b.slice())
  };
}

function initNetwork(inputDim, architecture, rng) {
  const arch = Array.isArray(architecture) && architecture.length ? architecture : [64, 32, 16];
  const weights = [];
  const biases = [];
  let prev = inputDim;
  for (const size of arch) {
    const scale = Math.sqrt(2 / Math.max(1, prev + size));
    weights.push(initMatrix(size, prev, rng, scale));
    biases.push(initVector(size));
    prev = size;
  }
  const outScale = Math.sqrt(1 / Math.max(1, prev));
  weights.push(initMatrix(1, prev, rng, outScale));
  biases.push(initVector(1));
  return { weights, biases };
}

function forward(network, x) {
  const { weights, biases } = network;
  const activations = [x];
  const zs = [];
  let a = x;
  const lastIdx = weights.length - 1;
  for (let l = 0; l < lastIdx; l++) {
    const z = addVec(matVec(weights[l], a), biases[l]);
    zs.push(z);
    a = applyFunc(z, tanh);
    activations.push(a);
  }
  const outLinear = addVec(matVec(weights[lastIdx], a), biases[lastIdx]);
  const zOut = outLinear[0];
  const out = sigmoid(zOut);
  return { activations, zs, zOut, out };
}

function backward(network, cache, target) {
  const { weights, biases } = network;
  const gradW = weights.map((W) => zeroLike(W));
  const gradB = biases.map((b) => initVector(b.length));
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
    for (let j = 0; j < weights[layer].length; j++) {
      const delta = downstream[j] * dtanh(z[j]);
      gradB[layer][j] += delta;
      current[j] = delta;
      for (let k = 0; k < weights[layer][j].length; k++) {
        gradW[layer][j][k] += delta * prevActivation[k];
      }
    }
    const prevSize = weights[layer][0]?.length ?? prevActivation.length;
    const newDownstream = new Array(prevSize).fill(0);
    for (let j = 0; j < weights[layer].length; j++) {
      for (let k = 0; k < weights[layer][j].length; k++) {
        newDownstream[k] += current[j] * weights[layer][j][k];
      }
    }
    downstream = newDownstream;
  }

  return { gradW, gradB };
}

function updateNetwork(network, grads, lr) {
  for (let l = 0; l < network.weights.length; l++) {
    const W = network.weights[l];
    const gW = grads.gradW[l];
    for (let i = 0; i < W.length; i++) {
      for (let j = 0; j < W[i].length; j++) {
        W[i][j] -= lr * gW[i][j];
      }
    }
    const b = network.biases[l];
    const gB = grads.gradB[l];
    for (let i = 0; i < b.length; i++) {
      b[i] -= lr * gB[i];
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
    architecture = [64, 32, 16],
    batchSize = modelParams?.ann?.batchSize ?? 32,
    l2 = 1e-4
  }
) {
  const rng = makeLCG(seed);
  const splitRng = makeLCG((seed ^ 0xa5a5a5a5) >>> 0);
  const inputDim = ensureConsistentDimensions(X);
  const net = initNetwork(inputDim, architecture, rng);

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
        gradB: net.biases.map((b) => initVector(b.length))
      };
      for (let idx = start; idx < end; idx++) {
        const rowIdx = indices[idx];
        const cache = forward(net, Xtrain[rowIdx]);
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
      }
      updateNetwork(net, grads, lr);
    }

    let valLoss = 0;
    for (let i = 0; i < Xval.length; i++) {
      const pred = forward(net, Xval[i]).out;
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
    l2
  } = {}
) {
  if (!X?.length) {
    return { models: [], committees: [], seeds: [], architecture: [0, 1], validationLosses: [] };
  }
  const start = Date.now();
  const results = [];
  const maxSeeds = Math.max(1, Math.round(seeds));
  const arch = Array.isArray(architecture) && architecture.length ? architecture : [64, 32, 16];
  const committeeSize = Math.max(1, Math.round(committeeSizeOption ?? Math.min(3, maxSeeds)));
  const maxCommitteesDefault = Math.max(1, Math.ceil(maxSeeds / committeeSize));
  const committeeCount = Math.max(1, Math.round(committeesOption ?? Math.min(3, maxCommitteesDefault)));
  for (let i = 0; i < maxSeeds; i++) {
    const seed = i + 1;
    const result = trainSingleNetwork(X, y, { seed, maxEpochs, lr, patience, architecture: arch, batchSize, l2 });
    results.push({ ...result, seed });
    const lossMsg = Number.isFinite(result.bestLoss) ? result.bestLoss.toFixed(4) : 'inf';
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
    : (model?.models?.length ? [{ networks: model.models }] : []);
  if (!committees.length) return X.map(() => 0.5);
  const scores = new Array(X.length).fill(0);
  let activeCount = 0;
  for (const committee of committees) {
    if (!committee.networks?.length) continue;
    activeCount += 1;
    const committeeScores = new Array(X.length).fill(0);
    for (const net of committee.networks) {
      for (let i = 0; i < X.length; i++) {
        committeeScores[i] += forward(net, X[i]).out;
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
  const cache = forward(network, x);
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
    const current = new Array(neurons).fill(0);
    for (let j = 0; j < neurons; j++) {
      const activation = z[j] ?? 0;
      const downVal = downstream[j] ?? 0;
      current[j] = downVal * dtanh(activation);
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
    : (model?.models?.length ? [{ networks: model.models }] : []);
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
      grad[i] += committeeGrad[i] / committee.networks.length;
    }
  }
  if (!activeCount) return new Array(x.length).fill(0);
  for (let i = 0; i < grad.length; i++) grad[i] /= activeCount;
  return grad;
}

export default trainANNCommittee;
