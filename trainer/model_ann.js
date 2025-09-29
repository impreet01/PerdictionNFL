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

function forward(network, x) {
  const { W1, b1, W2, b2, W3, b3 } = network;
  const z1 = addVec(matVec(W1, x), b1);
  const a1 = applyFunc(z1, tanh);
  const z2 = addVec(matVec(W2, a1), b2);
  const a2 = applyFunc(z2, tanh);
  const z3 = dotVec(W3[0], a2) + b3[0];
  const out = sigmoid(z3);
  return { z1, a1, z2, a2, z3, out };
}

function backward(network, cache, x, target) {
  const { W2, W3 } = network;
  const { z1, a1, z2, a2, out } = cache;
  const delta3 = out - target;
  const gradW3 = [a2.map((v) => delta3 * v)];
  const gradb3 = [delta3];
  const delta2 = new Array(a2.length).fill(0);
  for (let j = 0; j < a2.length; j++) {
    delta2[j] = delta3 * W3[0][j] * dtanh(z2[j]);
  }
  const gradW2 = zeroLike(W2);
  const gradb2 = new Array(a2.length).fill(0);
  for (let j = 0; j < a2.length; j++) {
    for (let k = 0; k < a1.length; k++) {
      gradW2[j][k] += delta2[j] * a1[k];
    }
    gradb2[j] += delta2[j];
  }
  const delta1 = new Array(a1.length).fill(0);
  for (let j = 0; j < a1.length; j++) {
    let sum = 0;
    for (let k = 0; k < a2.length; k++) sum += delta2[k] * network.W2[k][j];
    delta1[j] = sum * dtanh(z1[j]);
  }
  const gradW1 = zeroLike(network.W1);
  const gradb1 = new Array(a1.length).fill(0);
  for (let j = 0; j < a1.length; j++) {
    for (let k = 0; k < x.length; k++) gradW1[j][k] += delta1[j] * x[k];
    gradb1[j] += delta1[j];
  }
  return { gradW3, gradb3, gradW2, gradb2, gradW1, gradb1 };
}

function updateNetwork(network, grads, lr) {
  const { gradW3, gradb3, gradW2, gradb2, gradW1, gradb1 } = grads;
  for (let j = 0; j < network.W3.length; j++) {
    for (let k = 0; k < network.W3[j].length; k++) {
      network.W3[j][k] -= lr * gradW3[j][k];
    }
  }
  network.b3[0] -= lr * gradb3[0];
  for (let j = 0; j < network.W2.length; j++) {
    for (let k = 0; k < network.W2[j].length; k++) {
      network.W2[j][k] -= lr * gradW2[j][k];
    }
    network.b2[j] -= lr * gradb2[j];
  }
  for (let j = 0; j < network.W1.length; j++) {
    for (let k = 0; k < network.W1[j].length; k++) {
      network.W1[j][k] -= lr * gradW1[j][k];
    }
    network.b1[j] -= lr * gradb1[j];
  }
}

function copyNetwork(network) {
  return {
    W1: network.W1.map((row) => row.slice()),
    b1: network.b1.slice(),
    W2: network.W2.map((row) => row.slice()),
    b2: network.b2.slice(),
    W3: network.W3.map((row) => row.slice()),
    b3: network.b3.slice()
  };
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

function trainSingleNetwork(X, y, { seed = 1, maxEpochs = 200, lr = 1e-3, patience = 10 }) {
  const rng = makeLCG(seed);
  const inputDim = X[0]?.length || 0;
  const hidden1 = 32;
  const hidden2 = 16;
  const net = {
    W1: initMatrix(hidden1, inputDim, rng, 0.25 / Math.sqrt(Math.max(1, inputDim))),
    b1: initVector(hidden1),
    W2: initMatrix(hidden2, hidden1, rng, 0.25 / Math.sqrt(Math.max(1, hidden1))),
    b2: initVector(hidden2),
    W3: initMatrix(1, hidden2, rng, 0.25 / Math.sqrt(Math.max(1, hidden2))),
    b3: initVector(1)
  };

  if (X.length <= 1) {
    return { network: net, epochs: 0, bestLoss: Infinity };
  }

  const { trainIdx, valIdx } = splitTrainVal(X, y, Math.min(0.2, Math.max(0.1, 1 / Math.max(2, X.length))));
  const Xtrain = selectRows(X, trainIdx);
  const ytrain = selectVals(y, trainIdx);
  const Xval = selectRows(X, valIdx.length ? valIdx : trainIdx);
  const yval = selectVals(y, valIdx.length ? valIdx : trainIdx);

  let best = copyNetwork(net);
  let bestLoss = Infinity;
  let badRounds = 0;

  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    const grads = {
      gradW3: zeroLike(net.W3),
      gradb3: [0],
      gradW2: zeroLike(net.W2),
      gradb2: new Array(net.W2.length).fill(0),
      gradW1: zeroLike(net.W1),
      gradb1: new Array(net.W1.length).fill(0)
    };
    for (let i = 0; i < Xtrain.length; i++) {
      const cache = forward(net, Xtrain[i]);
      const g = backward(net, cache, Xtrain[i], ytrain[i]);
      for (let j = 0; j < net.W3.length; j++) {
        for (let k = 0; k < net.W3[j].length; k++) grads.gradW3[j][k] += g.gradW3[j][k];
      }
      grads.gradb3[0] += g.gradb3[0];
      for (let j = 0; j < net.W2.length; j++) {
        for (let k = 0; k < net.W2[j].length; k++) grads.gradW2[j][k] += g.gradW2[j][k];
        grads.gradb2[j] += g.gradb2[j];
      }
      for (let j = 0; j < net.W1.length; j++) {
        for (let k = 0; k < net.W1[j].length; k++) grads.gradW1[j][k] += g.gradW1[j][k];
        grads.gradb1[j] += g.gradb1[j];
      }
    }
    const denom = Math.max(1, Xtrain.length);
    for (let j = 0; j < net.W3.length; j++) {
      for (let k = 0; k < net.W3[j].length; k++) grads.gradW3[j][k] /= denom;
    }
    grads.gradb3[0] /= denom;
    for (let j = 0; j < net.W2.length; j++) {
      for (let k = 0; k < net.W2[j].length; k++) grads.gradW2[j][k] /= denom;
      grads.gradb2[j] /= denom;
    }
    for (let j = 0; j < net.W1.length; j++) {
      for (let k = 0; k < net.W1[j].length; k++) grads.gradW1[j][k] /= denom;
      grads.gradb1[j] /= denom;
    }
    updateNetwork(net, grads, lr);

    // validation
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

export function trainANNCommittee(X, y, {
  seeds = 15,
  maxEpochs = Number(process.env.ANN_MAX_EPOCHS ?? 200),
  lr = 1e-3,
  patience = 10,
  timeLimitMs = 60000
} = {}) {
  if (!X?.length) {
    return { models: [], seeds: [], architecture: [0, 32, 16, 1] };
  }
  const start = Date.now();
  const models = [];
  const usedSeeds = [];
  const maxSeeds = Math.max(1, Math.round(seeds));
  for (let i = 0; i < maxSeeds; i++) {
    const seed = i + 1;
    const result = trainSingleNetwork(X, y, { seed, maxEpochs, lr, patience });
    models.push(result.network);
    usedSeeds.push(seed);
    if (Date.now() - start > timeLimitMs) break;
  }
  return {
    models,
    seeds: usedSeeds,
    architecture: [X[0]?.length || 0, 32, 16, 1]
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

function gradientSingle(net, x) {
  const { z1, a1, z2, a2, out } = forward(net, x);
  const delta3 = out * (1 - out);
  const grad = new Array(x.length).fill(0);
  for (let j = 0; j < a2.length; j++) {
    const delta2 = delta3 * net.W3[0][j] * dtanh(z2[j]);
    for (let k = 0; k < a1.length; k++) {
      const delta1 = delta2 * net.W2[j][k] * dtanh(z1[k]);
      for (let m = 0; m < x.length; m++) {
        grad[m] += delta1 * net.W1[k][m];
      }
    }
  }
  return grad;
}

export function gradientANNCommittee(model, x) {
  if (!model?.models?.length) return new Array(x.length).fill(0);
  const grad = new Array(x.length).fill(0);
  for (const net of model.models) {
    const g = gradientSingle(net, x);
    for (let i = 0; i < grad.length; i++) grad[i] += g[i];
  }
  for (let i = 0; i < grad.length; i++) grad[i] /= model.models.length;
  return grad;
}
