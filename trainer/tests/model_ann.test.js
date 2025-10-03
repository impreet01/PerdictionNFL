import assert from "assert/strict";
import { trainANNCommittee, predictANNCommittee, splitTrainVal } from "../model_ann.js";

function makeDeterministicRng(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function makeDataset() {
  const X = [];
  const y = [];
  for (let i = 0; i < 40; i++) {
    const a = (i % 10) / 10;
    const b = ((39 - i) % 10) / 10;
    const c = (i % 5) / 5;
    X.push([a, b, c]);
    y.push(a + c > b ? 1 : 0);
  }
  return { X, y };
}

(function runTests() {
  const { X, y } = makeDataset();

  const split1 = splitTrainVal(X, y, 0.25, makeDeterministicRng(123));
  const split2 = splitTrainVal(X, y, 0.25, makeDeterministicRng(456));
  assert.notDeepEqual(split1.trainIdx, split2.trainIdx, "splitTrainVal should randomize indices with different seeds");

  const split3 = splitTrainVal(X, y, 0.25, makeDeterministicRng(789));
  const split4 = splitTrainVal(X, y, 0.25, makeDeterministicRng(789));
  assert.deepEqual(split3.trainIdx, split4.trainIdx, "splitTrainVal should be deterministic for identical RNGs");

  const model = trainANNCommittee(X, y, {
    seeds: 6,
    maxEpochs: 20,
    patience: 4,
    lr: 5e-3,
    timeLimitMs: 2000,
    committeeSize: 2,
    committees: 2
  });

  assert(model.committees.length <= 2, "committee count should respect cap");
  const totalNetworks = model.committees.reduce((sum, committee) => {
    assert(committee.networks.length <= 2 && committee.networks.length > 0, "committee size cap violated");
    return sum + committee.networks.length;
  }, 0);
  assert.strictEqual(totalNetworks, model.selected.length, "selected metadata should match retained networks");
  assert(model.validationLosses.length >= model.selected.length, "validation loss tracking should cover all seeds");

  const preds = predictANNCommittee(model, X);
  assert.strictEqual(preds.length, X.length, "prediction length mismatch");
  for (const p of preds) {
    assert(Number.isFinite(p) && p >= 0 && p <= 1, "probability out of range");
  }

  console.log("model_ann selection tests passed");
})();
