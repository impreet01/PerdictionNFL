import assert from "assert/strict";
import { resolveHistoricalChunkSelection, formatBatchWindowLog } from "../train_multi.js";

(function runTests() {
  const seasons = [1999, 2000, 2001, 2002];
  const recordedChunks = [{ start_season: 1999, end_season: 2000 }];

  const explicit = resolveHistoricalChunkSelection({
    uniqueSeasons: seasons,
    chunkSize: 2,
    recordedChunks,
    explicitStart: 2001,
    explicitEnd: 2002,
    strictBatch: true,
    minSeason: 1999,
    maxSeason: 2023
  });

  assert(explicit.explicit, "Explicit resolution should be flagged");
  assert(explicit.chunkSelection, "Explicit chunk selection missing");
  assert.strictEqual(explicit.chunkSelection.start, 2001, "Explicit start mismatch");
  assert.strictEqual(explicit.chunkSelection.end, 2002, "Explicit end mismatch");
  assert.deepEqual(
    explicit.chunkSelection.seasons,
    [2001, 2002],
    "Explicit chunk seasons should match requested window"
  );

  const explicitLog = formatBatchWindowLog({
    chunkSelection: explicit.chunkSelection,
    explicit: explicit.explicit
  });
  assert.strictEqual(
    explicitLog,
    "[train] Using explicit batch window: 2001–2002",
    "Explicit batch log mismatch"
  );

  const auto = resolveHistoricalChunkSelection({
    uniqueSeasons: seasons,
    chunkSize: 2,
    recordedChunks: [],
    strictBatch: true,
    minSeason: 1999,
    maxSeason: 2023
  });

  assert(!auto.explicit, "Auto resolution should not be flagged explicit");
  assert(auto.chunkSelection, "Auto chunk selection missing");
  assert.strictEqual(auto.chunkSelection.start, 1999, "Auto start should default to earliest chunk");
  assert.strictEqual(auto.chunkSelection.end, 2000, "Auto end should default to earliest chunk");
  assert.deepEqual(auto.chunkSelection.seasons, [1999, 2000], "Auto seasons mismatch");

  const autoAfterRecord = resolveHistoricalChunkSelection({
    uniqueSeasons: seasons,
    chunkSize: 2,
    recordedChunks,
    strictBatch: true,
    minSeason: 1999,
    maxSeason: 2023
  });

  assert(autoAfterRecord.chunkSelection, "Auto selection should still resolve");
  assert.strictEqual(
    autoAfterRecord.chunkSelection.start,
    2001,
    "Auto selection should advance to the next pending chunk"
  );
  assert.strictEqual(autoAfterRecord.chunkSelection.end, 2002, "Auto selection end mismatch");

  const autoWhenAllComplete = resolveHistoricalChunkSelection({
    uniqueSeasons: seasons,
    chunkSize: 2,
    recordedChunks: [
      { start_season: 1999, end_season: 2000 },
      { start_season: 2001, end_season: 2002 }
    ],
    strictBatch: true,
    minSeason: 1999,
    maxSeason: 2023
  });

  assert(autoWhenAllComplete.chunkSelection, "Auto selection should still return a chunk when all complete");
  assert.strictEqual(
    autoWhenAllComplete.chunkSelection.start,
    2001,
    "Auto selection should fall back to the most recent chunk when all complete"
  );
  assert.strictEqual(autoWhenAllComplete.chunkSelection.end, 2002, "Auto fallback end mismatch");

  const autoLog = formatBatchWindowLog({
    chunkSelection: auto.chunkSelection,
    explicit: auto.explicit
  });
  assert.strictEqual(
    autoLog,
    "[train] Using auto-resolved bootstrap window: 1999–2000",
    "Auto batch log mismatch"
  );

  console.log("bootstrap resolver tests passed");
})();
