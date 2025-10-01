// trainer/model_ann.js
// Lightweight ANN committee for win probability estimation

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const tanh = (z) => Math.tanh(z);
const dtanh = (z) => 1 - Math.tanh(z) ** 2;

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
    const scale = 0.25 / Math.sqrt(Math.max(1, prev));
    weights.push(initMatrix(size, prev, rng, scale));
    biases.push(initVector(size));
    prev = size;
  }
  const outScale = 0.25 / Math.sqrt(Math.max(1, prev));
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

function splitTrainVal(X, y, valFraction = 0.2) {
  const n = X.length;
  const valSize = Math.min(Math.max(1, Math.floor(n * valFraction)), Math.max(1, n - 1));
  const trainSize = Math.max(1, n - valSize);
  const idx = Array.from({ length: n }, (_, i) => i);
  return {
    trainIdx: idx.slice(0, trainSize),
    valIdx: idx.slice(trainSize)
  };
}

function selectRows(X, idx) {
  return idx.map((i) => X[i]);
}

function selectVals(arr, idx) {
  return idx.map((i) => arr[i]);
}

function trainSingleNetwork(
  X,
  y,
  { seed = 1, maxEpochs = 200, lr = 1e-3, patience = 10, architecture = [64, 32, 16] }
) {
  const rng = makeLCG(seed);
  const inputDim = X[0]?.length || 0;
  const net = initNetwork(inputDim, architecture, rng);

  if (X.length <= 1 || !inputDim) {
    return { network: net, epochs: 0, bestLoss: Infinity };
  }

  const { trainIdx, valIdx } = splitTrainVal(
    X,
    y,
    Math.min(0.2, Math.max(0.1, 1 / Math.max(2, X.length)))
  );
  const Xtrain = selectRows(X, trainIdx);
  const ytrain = selectVals(y, trainIdx);
  const Xval = selectRows(X, valIdx.length ? valIdx : trainIdx);
  const yval = selectVals(y, valIdx.length ? valIdx : trainIdx);

  let best = copyNetwork(net);
  let bestLoss = Infinity;
  let badRounds = 0;

  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    const grads = {
      gradW: net.weights.map((W) => zeroLike(W)),
      gradB: net.biases.map((b) => initVector(b.length))
    };
    for (let i = 0; i < Xtrain.length; i++) {
      const cache = forward(net, Xtrain[i]);
      const g = backward(net, cache, ytrain[i]);
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
    const denom = Math.max(1, Xtrain.length);
    for (let l = 0; l < grads.gradW.length; l++) {
      for (let r = 0; r < grads.gradW[l].length; r++) {
        for (let c = 0; c < grads.gradW[l][r].length; c++) {
          grads.gradW[l][r][c] /= denom;
        }
      }
      for (let r = 0; r < grads.gradB[l].length; r++) {
        grads.gradB[l][r] /= denom;
      }
    }
    updateNetwork(net, grads, lr);

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

  return { network: best, epochs: 0, bestLoss };
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
    architecture
  } = {}
) {
  if (!X?.length) {
    return { models: [], seeds: [], architecture: [0, 1] };
  }
  const start = Date.now();
  const models = [];
  const usedSeeds = [];
  const maxSeeds = Math.max(1, Math.round(seeds));
  const arch = Array.isArray(architecture) && architecture.length ? architecture : [64, 32, 16];
  for (let i = 0; i < maxSeeds; i++) {
    const seed = i + 1;
    const result = trainSingleNetwork(X, y, { seed, maxEpochs, lr, patience, architecture: arch });
    models.push(result.network);
    usedSeeds.push(seed);
    if (Date.now() - start > timeLimitMs) break;
  }
  return {
    models,
    seeds: usedSeeds,
    architecture: [X[0]?.length || 0, ...arch, 1]
  };
}

export function predictANNCommittee(model, X) {
  if (!model?.models?.length) return X.map(() => 0.5);
  const probs = new Array(X.length).fill(0);
  for (const net of model.models) {
    for (let i = 0; i < X.length; i++) {
      probs[i] += forward(net, X[i]).out;
    }
  }
  return probs.map((p) => p / model.models.length);
}

function gradientInput(network, x) {
  const cache = forward(network, x);
  const weights = network.weights;
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
    const z = cache.zs[layer];
    const current = new Array(weights[layer].length).fill(0);
    for (let j = 0; j < weights[layer].length; j++) {
      current[j] = downstream[j] * dtanh(z[j]);
    }
    if (layer === 0) {
      const gradIn = new Array(x.length).fill(0);
      for (let j = 0; j < weights[layer].length; j++) {
        for (let k = 0; k < weights[layer][j].length; k++) {
          gradIn[k] += current[j] * weights[layer][j][k];
        }
      }
      return gradIn;
    }
    const newDownstream = new Array(weights[layer][0].length).fill(0);
    for (let j = 0; j < weights[layer].length; j++) {
      for (let k = 0; k < weights[layer][j].length; k++) {
        newDownstream[k] += current[j] * weights[layer][j][k];
      }
    }
    downstream = newDownstream;
  }
  return new Array(x.length).fill(0);
}

export function gradientANNCommittee(model, x) {
  if (!model?.models?.length) return new Array(x.length).fill(0);
  const grad = new Array(x.length).fill(0);
  for (const net of model.models) {
    const g = gradientInput(net, x);
    for (let i = 0; i < grad.length; i++) grad[i] += g[i];
  }
  for (let i = 0; i < grad.length; i++) grad[i] /= model.models.length;
  return grad;
}

export default trainANNCommittee;
