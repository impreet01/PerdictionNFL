/**
 * Bootstrap chunk management utilities
 * Extracted from train_multi.js to reduce complexity
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { artifactsRoot } from "./paths.js";

const ART_DIR = artifactsRoot();
const CHUNK_CACHE_DIR = path.join(ART_DIR, "chunks");
const CHUNK_FILE_PREFIX = "model";

/**
 * Ensure chunk cache directory exists
 */
export async function ensureChunkCacheDir() {
  await fsp.mkdir(CHUNK_CACHE_DIR, { recursive: true });
}

/**
 * Create chunk label from start and end seasons
 */
export function chunkLabel(start, end) {
  return `${start}-${end}`;
}

/**
 * Get path to chunk metadata file
 */
export function chunkMetadataPath(label) {
  return path.join(CHUNK_CACHE_DIR, `${CHUNK_FILE_PREFIX}_${label}.json`);
}

/**
 * Get path to chunk done marker
 */
export function chunkDonePath(label) {
  return path.join(CHUNK_CACHE_DIR, `${CHUNK_FILE_PREFIX}_${label}.done`);
}

/**
 * Load chunk cache metadata
 */
export async function loadChunkCache(label, requiredRevision = null) {
  try {
    const raw = await fsp.readFile(chunkMetadataPath(label), "utf8");
    const parsed = JSON.parse(raw);

    if (requiredRevision && parsed?.revision !== requiredRevision) {
      return null;
    }

    return parsed;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write chunk cache metadata and marker
 */
export async function writeChunkCache(label, payload = {}, revision = null, jsonSpace = 2) {
  await ensureChunkCacheDir();

  const record = {
    label,
    ...(revision ? { revision } : {}),
    completed_at: new Date().toISOString(),
    ...payload
  };

  const metaPath = chunkMetadataPath(label);
  const donePath = chunkDonePath(label);

  console.log(`[writeChunkCache] Writing chunk cache for label="${label}"`);
  console.log(`[writeChunkCache] Metadata path: ${metaPath}`);
  console.log(`[writeChunkCache] Done marker path: ${donePath}`);
  console.log(`[writeChunkCache] CHUNK_CACHE_DIR: ${CHUNK_CACHE_DIR}`);
  console.log(`[writeChunkCache] ART_DIR: ${ART_DIR}`);

  await fsp.writeFile(
    metaPath,
    JSON.stringify(record, null, jsonSpace)
  );
  await fsp.writeFile(donePath, `${record.completed_at}\n`);

  console.log(`[writeChunkCache] Successfully wrote chunk marker: ${donePath}`);

  return record;
}

/**
 * Get path to season metadata file
 */
export function seasonMetadataPath(season) {
  return path.join(CHUNK_CACHE_DIR, `season-${season}.json`);
}

/**
 * Get path to season done marker
 */
export function seasonDonePath(season) {
  return path.join(CHUNK_CACHE_DIR, `season-${season}.done`);
}

/**
 * Load season cache metadata
 */
export async function loadSeasonCache(season, requiredRevision = null) {
  try {
    const raw = await fsp.readFile(seasonMetadataPath(season), "utf8");
    const parsed = JSON.parse(raw);

    if (requiredRevision && parsed?.revision !== requiredRevision) {
      return null;
    }

    return parsed;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write season cache metadata and marker
 */
export async function writeSeasonCache({ season, weeks }, revision = null, jsonSpace = 2) {
  if (!Number.isFinite(season) || !Array.isArray(weeks) || !weeks.length) {
    return null;
  }

  await ensureChunkCacheDir();

  const record = {
    season,
    weeks: Array.from(new Set(weeks)).sort((a, b) => a - b),
    ...(revision ? { revision } : {}),
    updated_at: new Date().toISOString()
  };

  await fsp.writeFile(
    seasonMetadataPath(season),
    JSON.stringify(record, null, jsonSpace)
  );
  await fsp.writeFile(seasonDonePath(season), `${record.updated_at}\n`);

  return record;
}

/**
 * Normalize season value to number
 */
export function normaliseSeason(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Chunk a list of seasons into groups
 */
export function chunkSeasonList(seasons, size = 2, maxChunkSize = 3) {
  if (!Array.isArray(seasons) || !seasons.length) return [];

  const chunkSize = Math.max(1, Math.min(maxChunkSize, Math.floor(size)));
  const sorted = seasons
    .map(normaliseSeason)
    .filter((season) => season !== null)
    .sort((a, b) => a - b);

  const chunks = [];
  for (let i = 0; i < sorted.length; i += chunkSize) {
    const slice = sorted.slice(i, i + chunkSize);
    if (slice.length) {
      chunks.push({
        seasons: slice,
        start: slice[0],
        end: slice[slice.length - 1]
      });
    }
  }

  return chunks;
}

/**
 * Expand season selection into array of seasons
 */
export function expandSeasonsFromSelection(selection) {
  if (!selection || !Number.isFinite(selection.start) || !Number.isFinite(selection.end)) {
    return [];
  }

  const out = [];
  for (let s = selection.start; s <= selection.end; s += 1) {
    out.push(s);
  }

  return out;
}
