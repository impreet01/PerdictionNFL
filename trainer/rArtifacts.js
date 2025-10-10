import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import parquet from "parquetjs-lite";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_AGE_MS = Number.isFinite(Number(process.env.R_ARTIFACT_MAX_AGE_MS))
  ? Number(process.env.R_ARTIFACT_MAX_AGE_MS)
  : undefined;

const DATASET_CONFIG_ENTRIES = [
  {
    keys: ["pbp"],
    slug: "pbp",
    scriptName: "fetch_pbp.R"
  },
  {
    keys: ["playerWeekly", "player_weekly", "player-weekly"],
    slug: "player_weekly",
    scriptName: "fetch_player_weekly.R"
  },
  {
    keys: ["fourth-down", "fourth_down", "fourthDown"],
    slug: "fourth_down",
    scriptName: "fetch_fourth_down.R"
  },
  {
    keys: ["seed-sim", "seed_sim", "seedSim"],
    slug: "seed_sim",
    scriptName: "run_seed_sim.R"
  }
];

const DATASET_CONFIG_INDEX = new Map();

function normaliseKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

for (const entry of DATASET_CONFIG_ENTRIES) {
  for (const key of entry.keys) {
    DATASET_CONFIG_INDEX.set(normaliseKey(key), entry);
  }
}

function resolveDatasetConfig(dataset) {
  if (!dataset) throw new Error("dataset is required");
  const rawKey = String(dataset);
  const normalised = normaliseKey(rawKey);
  const entry = DATASET_CONFIG_INDEX.get(normalised);
  if (entry) {
    return {
      slug: entry.slug,
      scriptName: entry.scriptName,
      label: entry.keys[0]
    };
  }
  const safeSlug = rawKey;
  return {
    slug: safeSlug,
    scriptName: `fetch_${safeSlug}.R`,
    label: rawKey
  };
}

function resolveRoot(rootDir) {
  if (rootDir) return path.resolve(rootDir);
  const envRoot = process.env.R_ARTIFACTS_ROOT;
  if (envRoot) return path.resolve(process.cwd(), envRoot);
  return path.resolve(process.cwd(), "artifacts", "r-data");
}

export function artifactPaths(dataset, season, options = {}) {
  if (!dataset) throw new Error("artifactPaths requires dataset");
  const config = resolveDatasetConfig(dataset);
  const seasonLabel = season != null ? String(season) : "latest";
  const root = resolveRoot(options.rootDir);
  const datasetDir = path.join(root, config.slug);
  const parquetPath = path.join(datasetDir, `${seasonLabel}.parquet`);
  const manifestPath = path.join(datasetDir, "manifest.json");
  return { root, datasetDir, parquetPath, manifestPath, config };
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
  const { datasetDir, parquetPath, manifestPath, config } = artifactPaths(dataset, season, { rootDir });
  const fresh = await isFresh(parquetPath, { maxAgeMs });
  if (fresh) {
    return { parquetPath, manifestPath };
  }

  if (shouldSkipIngest()) {
    throw new Error(
      `[rArtifacts] ${dataset} ${season} missing or stale but SKIP_R_INGEST=1. Falling back to legacy sources.`
    );
  }

  const scriptName = script || path.resolve("scripts", "r", config.scriptName);
  const seasonArg = season != null ? ["--season", String(season)] : [];
  await ensureDir(datasetDir);

  try {
    await execFileAsync("Rscript", [scriptName, ...seasonArg, ...args], {
      cwd: process.cwd(),
      env: process.env
    });
  } catch (err) {
    throw formatSpawnError(config.label, season, err);
  }

  const finalFresh = await isFresh(parquetPath, { maxAgeMs });
  if (!finalFresh) {
    throw new Error(`[rArtifacts] ${config.label} ${season} parquet not created at ${parquetPath}`);
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

export async function ensureSeedSimulation(season, options = {}) {
  const seasonNum = Number(season);
  if (!Number.isFinite(seasonNum)) {
    throw new Error("ensureSeedSimulation requires a numeric season");
  }
  const weekNum = options.week == null ? null : Number(options.week);
  if (options.week != null && !Number.isFinite(weekNum)) {
    throw new Error("ensureSeedSimulation week must be numeric when provided");
  }
  const sims = options.sims == null ? null : Number(options.sims);
  const suffix = weekNum != null
    ? `${seasonNum}_W${String(weekNum).padStart(2, "0")}`
    : `${seasonNum}`;

  const root = resolveRoot(options.rootDir);
  const datasetDir = path.join(root, "seed_sim");
  const parquetPath = path.join(datasetDir, `seed_sim_${suffix}.parquet`);
  const manifestPath = path.join(datasetDir, `manifest_${suffix}.json`);

  const fresh = await isFresh(parquetPath, { maxAgeMs: options.maxAgeMs });
  if (fresh) {
    return { parquetPath, manifestPath, suffix };
  }

  if (shouldSkipIngest()) {
    throw new Error(
      `[rArtifacts] seed_sim ${suffix} missing or stale but SKIP_R_INGEST=1. Falling back to legacy sources.`
    );
  }

  await ensureDir(datasetDir);
  const rScript = options.script || path.resolve("scripts", "r", "run_seed_sim.R");
  const args = ["--season", String(seasonNum)];
  if (weekNum != null) {
    args.push("--week", String(weekNum));
  }
  if (Number.isFinite(sims) && sims > 0) {
    args.push("--sims", String(Math.floor(sims)));
  }

  try {
    await execFileAsync("Rscript", [rScript, ...args], {
      cwd: process.cwd(),
      env: process.env
    });
  } catch (err) {
    throw formatSpawnError("seed_sim", suffix, err);
  }

  const finalFresh = await isFresh(parquetPath, { maxAgeMs: options.maxAgeMs });
  if (!finalFresh) {
    throw new Error(`[rArtifacts] seed_sim ${suffix} parquet not created at ${parquetPath}`);
  }

  return { parquetPath, manifestPath, suffix };
}

export default {
  artifactPaths,
  ensure,
  isFresh,
  readManifest,
  loadParquetRecords,
  ensureSeedSimulation
};
