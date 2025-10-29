/**
 * Helpers for strict batch mode, which confines training to a closed season range
 * whenever BATCH_START/BATCH_END environment variables are provided.
 */
export function isStrictBatch() {
  return Boolean(process.env.BATCH_START || process.env.BATCH_END);
}

/**
 * Returns the strict season bounds when strict batch mode is active.
 * @returns {{start: number, end: number} | null}
 * @throws {Error} When strict batch is requested but the bounds are invalid.
 */
export function getStrictBounds() {
  if (!isStrictBatch()) return null;
  const start = Number(process.env.BATCH_START);
  const end = Number(process.env.BATCH_END);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error('Strict batch requested but BATCH_START/BATCH_END are not both set to numbers.');
  }
  if (end < start) throw new Error('BATCH_END must be >= BATCH_START');
  return { start, end };
}

/**
 * Filters the provided seasons to the strict bounds when active.
 * @param {number[]} seasons
 * @returns {number[]}
 */
export function clampSeasonsToStrictBounds(seasons, { minSeason = null, maxSeason = null } = {}) {
  const normalized = Array.isArray(seasons)
    ? seasons
        .map((season) => Number.parseInt(season, 10))
        .filter((season) => Number.isFinite(season))
    : [];
  const bounds = getStrictBounds();
  let lowerBound = Number.NEGATIVE_INFINITY;
  let upperBound = Number.POSITIVE_INFINITY;
  if (bounds) {
    lowerBound = Math.max(lowerBound, bounds.start);
    upperBound = Math.min(upperBound, bounds.end);
  }
  if (Number.isFinite(minSeason)) lowerBound = Math.max(lowerBound, Math.floor(minSeason));
  if (Number.isFinite(maxSeason)) upperBound = Math.min(upperBound, Math.floor(maxSeason));
  if (lowerBound === Number.NEGATIVE_INFINITY && upperBound === Number.POSITIVE_INFINITY) {
    return normalized;
  }
  return normalized.filter((season) => season >= lowerBound && season <= upperBound);
}

/**
 * Resolves the training split for a given target season/week.
 * Returns the seasons that are fully eligible for training along with
 * week-specific limits for seasons that are only partially eligible (e.g. the target season).
 *
 * @param {Object} params
 * @param {number} params.targetSeason
 * @param {number} params.targetWeek
 * @param {number[]} [params.availableSeasons=[]]
 * @param {number|null} [params.minSeason=null]
 * @param {number|null} [params.maxSeason=null]
 * @returns {{trainSeasons: number[], trainWeeksBySeason: Map<number, number[]>}}
 */
export function deriveTrainingSplitForTarget({
  targetSeason,
  targetWeek,
  availableSeasons = [],
  minSeason = null,
  maxSeason = null
} = {}) {
  const seasonNumber = Number.parseInt(targetSeason, 10);
  const weekNumber = Number.parseInt(targetWeek, 10);
  if (!Number.isFinite(seasonNumber)) {
    throw new Error("deriveTrainingSplitForTarget requires a numeric targetSeason");
  }
  if (!Number.isFinite(weekNumber)) {
    throw new Error("deriveTrainingSplitForTarget requires a numeric targetWeek");
  }

  const uniqueAvailable = Array.from(
    new Set(
      Array.isArray(availableSeasons)
        ? availableSeasons
            .map((season) => Number.parseInt(season, 10))
            .filter((season) => Number.isFinite(season))
        : []
    )
  ).sort((a, b) => a - b);

  const bounds = getStrictBounds();
  let lowerBound = Number.NEGATIVE_INFINITY;
  let upperBound = Number.POSITIVE_INFINITY;
  if (bounds) {
    lowerBound = Math.max(lowerBound, bounds.start);
    upperBound = Math.min(upperBound, bounds.end);
  }
  if (Number.isFinite(minSeason)) {
    lowerBound = Math.max(lowerBound, Math.floor(minSeason));
  }
  if (Number.isFinite(maxSeason)) {
    upperBound = Math.min(upperBound, Math.floor(maxSeason));
  }
  // Never allow seasons beyond the current target season.
  upperBound = Math.min(upperBound, seasonNumber - 1);

  const trainSeasons = uniqueAvailable.filter(
    (season) => season >= lowerBound && season <= upperBound && season < seasonNumber
  );

  const trainWeeksBySeason = new Map();
  const weekLimit = Math.max(1, weekNumber);
  const allowedWeeks = [];
  for (let week = 1; week < weekLimit; week += 1) {
    allowedWeeks.push(week);
  }
  trainWeeksBySeason.set(seasonNumber, allowedWeeks);

  return { trainSeasons, trainWeeksBySeason };
}
