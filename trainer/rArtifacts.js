import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import parquet from "parquetjs-lite";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_AGE_MS = Number.isFinite(Number(process.env.R_ARTIFACT_MAX_AGE_MS))
  ? Number(process.env.R_ARTIFACT_MAX_AGE_MS)
  : undefined;

function resolveRoot(rootDir) {
  if (rootDir) return path.resolve(rootDir);
  const envRoot = process.env.R_ARTIFACTS_ROOT;
  if (envRoot) return path.resolve(process.cwd(), envRoot);
  return path.resolve(process.cwd(), "artifacts", "r-data");
}

export function artifactPaths(dataset, season, options = {}) {
  if (!dataset) throw new Error("artifactPaths requires dataset");
  const seasonLabel = season != null ? String(season) : "latest";
  const root = resolveRoot(options.rootDir);
  const datasetDir = path.join(root, dataset);
  const parquetPath = path.join(datasetDir, `${seasonLabel}.parquet`);
  const manifestPath = path.join(datasetDir, "manifest.json");
  return { root, datasetDir, parquetPath, manifestPath };
}

async function statSafe(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function isFresh(filePath, { maxAgeMs } = {}) {
  const stat = await statSafe(filePath);
  if (!stat) return false;
  const threshold = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : DEFAULT_MAX_AGE_MS;
  if (!Number.isFinite(threshold)) return true;
  const age = Date.now() - stat.mtimeMs;
  return age <= threshold;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function shouldSkipIngest() {
  const val = process.env.SKIP_R_INGEST;
  if (!val) return false;
  const normalized = String(val).trim().toLowerCase();
  return ["1", "true", "yes", "y"].includes(normalized);
}

function formatSpawnError(dataset, season, cause) {
  if (cause?.code === "ENOENT") {
    return new Error(
      `[rArtifacts] Rscript not found while preparing ${dataset} ${season}. Install R or set SKIP_R_INGEST=1 to use fallbacks.`
    );
  }
  const message = cause?.stderr?.trim() || cause?.message || String(cause);
  return new Error(`[rArtifacts] Failed to build ${dataset} ${season}: ${message}`);
}

export async function ensure(dataset, season, options = {}) {
  const { maxAgeMs, script, args = [], rootDir } = options;
  const { datasetDir, parquetPath, manifestPath } = artifactPaths(dataset, season, { rootDir });
  const fresh = await isFresh(parquetPath, { maxAgeMs });
  if (fresh) {
    return { parquetPath, manifestPath };
  }

  if (shouldSkipIngest()) {
    throw new Error(
      `[rArtifacts] ${dataset} ${season} missing or stale but SKIP_R_INGEST=1. Falling back to legacy sources.`
    );
  }

  const rScript = script || path.resolve("scripts", "r", `fetch_${dataset}.R`);
  const seasonArg = season != null ? ["--season", String(season)] : [];
  await ensureDir(datasetDir);

  try {
    await execFileAsync("Rscript", [rScript, ...seasonArg, ...args], {
      cwd: process.cwd(),
      env: process.env
    });
  } catch (err) {
    throw formatSpawnError(dataset, season, err);
  }

  const finalFresh = await isFresh(parquetPath, { maxAgeMs });
  if (!finalFresh) {
    throw new Error(`[rArtifacts] ${dataset} ${season} parquet not created at ${parquetPath}`);
  }
  return { parquetPath, manifestPath };
}

export async function readManifest(dataset, options = {}) {
  const { manifestPath } = artifactPaths(dataset, options.season ?? "manifest", options);
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function loadParquetRecords(filePath) {
  const reader = await parquet.ParquetReader.openFile(filePath);
  try {
    const cursor = reader.getCursor();
    const records = [];
    for (;;) {
      const row = await cursor.next();
      if (!row) break;
      records.push({ ...row });
    }
    return records;
  } finally {
    await reader.close();
  }
}

export default {
  artifactPaths,
  ensure,
  isFresh,
  readManifest,
  loadParquetRecords
};
