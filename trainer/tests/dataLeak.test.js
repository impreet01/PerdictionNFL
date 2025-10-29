// trainer/tests/dataLeak.test.js
import assert from 'node:assert/strict';
import { isBefore } from '../utils/temporalWindow.js';

(function testIsBefore() {
  const tgt = { season: 2025, week: 1 };
  assert.equal(isBefore(tgt, { season: 2024, week: 18 }), true);
  assert.equal(isBefore(tgt, { season: 2025, week: 0 }), true);
  assert.equal(isBefore(tgt, { season: 2025, week: 1 }), false);
  assert.equal(isBefore(tgt, { season: 2025, week: 2 }), false);
  assert.equal(isBefore({ season: 2024, week: 10 }, { season: 2025, week: 1 }), false);
})();
