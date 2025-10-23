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
export function clampSeasonsToStrictBounds(seasons) {
  const bounds = getStrictBounds();
  if (!bounds) return seasons;
  return seasons.filter((season) => season >= bounds.start && season <= bounds.end);
}
