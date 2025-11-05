/**
 * Artifact path and status management utilities
 * Extracted from train_multi.js to reduce complexity
 */

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { artifactsRoot } from "./paths.js";

const ART_DIR = artifactsRoot();
const STATUS_DIR = path.join(ART_DIR, ".status");

/**
 * Format season and week as stamp (e.g., "2025_W06")
 */
export function weekStamp(season, week) {
  return `${season}_W${String(week).padStart(2, "0")}`;
}

/**
 * Get artifact file path for a given prefix, season, and week
 */
export function artifactPath(prefix, season, week) {
  return path.join(ART_DIR, `${prefix}_${weekStamp(season, week)}.json`);
}

/**
 * Check if all expected artifacts exist for a given week
 */
export function weekArtifactsExist(season, week, prefixes = []) {
  return prefixes.every((prefix) =>
    fs.existsSync(artifactPath(prefix, season, week))
  );
}

/**
 * Check if model artifacts exist for a season
 */
export async function modelsForSeasonExist(season) {
  const seasonDir = path.join(ART_DIR, "models", String(season));
  try {
    const entries = await fsp.readdir(seasonDir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() || entry.isDirectory());
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Ensure status directory exists
 */
export function ensureStatusDir() {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
}

/**
 * Get path to week status marker
 */
export function weekStatusPath(season, week) {
  return path.join(STATUS_DIR, `${season}-W${String(week).padStart(2, "0")}.done`);
}

/**
 * Check if week status marker exists
 */
export function weekStatusExists(season, week) {
  return fs.existsSync(weekStatusPath(season, week));
}

/**
 * Mark week as completed
 */
export function markWeekStatus(season, week) {
  ensureStatusDir();
  fs.writeFileSync(weekStatusPath(season, week), new Date().toISOString());
}

/**
 * Get path to season status marker
 */
export function seasonStatusPath(season) {
  return path.join(STATUS_DIR, `${season}.done`);
}

/**
 * Check if season status marker exists
 */
export function seasonStatusExists(season) {
  return fs.existsSync(seasonStatusPath(season));
}

/**
 * Mark season as completed
 */
export function markSeasonStatus(season) {
  ensureStatusDir();
  fs.writeFileSync(seasonStatusPath(season), new Date().toISOString());
}

/**
 * Write artifact to disk with optional validation
 */
export async function writeArtifact(filePath, data, { validate = null, pretty = true } = {}) {
  if (validate && typeof validate === "function") {
    await validate(data);
  }
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await fsp.writeFile(filePath, content, "utf8");
}

/**
 * Read artifact from disk
 */
export async function readArtifact(filePath) {
  const content = await fsp.readFile(filePath, "utf8");
  return JSON.parse(content);
}
