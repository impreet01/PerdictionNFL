import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  BOOTSTRAP_KEYS,
  CURRENT_BOOTSTRAP_REVISION,
  loadTrainingState,
  saveTrainingState
} from "./trainingState.js";
import { mapModelRevision } from "./modelRevision.js";

const MODELS_ROOT = path.resolve("artifacts", "models");
const JSON_SPACE = process.env.CI ? undefined : 2;

function toRelativeModelPath(targetPath) {
  const relative = path.relative(MODELS_ROOT, targetPath);
  return relative.split(path.sep).join("/");
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

async function listDirectory(targetPath) {
  try {
    return await fsp.readdir(targetPath, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

function normaliseSeason(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureDir(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true });
}

async function copyRecursive({ sourceDir, destDir, prevRevision, currentRevision, files }) {
  const entries = await listDirectory(sourceDir);
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await ensureDir(destPath);
      await copyRecursive({
        sourceDir: sourcePath,
        destDir: destPath,
        prevRevision,
        currentRevision,
        files
      });
      continue;
    }
    if (entry.isFile()) {
      await ensureDir(path.dirname(destPath));
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".json") {
        let parsed;
        let raw;
        try {
          raw = await fsp.readFile(sourcePath, "utf8");
          parsed = JSON.parse(raw);
        } catch (err) {
          if (err?.name === "SyntaxError") {
            console.warn(
              `[promote] Unable to parse JSON in ${sourcePath}; copying raw bytes.`
            );
            await fsp.copyFile(sourcePath, destPath);
            files.push(toRelativeModelPath(destPath));
            continue;
          }
          throw err;
        }
        const mapped = mapModelRevision(parsed, {
          fromRevision: prevRevision,
          toRevision: currentRevision,
          filePath: sourcePath
        });
        const payload = mapped ?? parsed;
        await fsp.writeFile(destPath, JSON.stringify(payload, null, JSON_SPACE));
        files.push(toRelativeModelPath(destPath));
        continue;
      }
      await fsp.copyFile(sourcePath, destPath);
      files.push(toRelativeModelPath(destPath));
    }
  }
}

async function directoryHasFiles(targetPath) {
  const entries = await listDirectory(targetPath);
  return entries.some((entry) => {
    if (entry.isFile()) return true;
    if (entry.isDirectory()) return true;
    return false;
  });
}

export async function promote({ prevSeason, nextSeason, destDir, allowRevMap = true } = {}) {
  const previous = normaliseSeason(prevSeason);
  const next = normaliseSeason(nextSeason);
  if (!Number.isFinite(previous) || !Number.isFinite(next)) {
    throw new Error("[promote] prevSeason and nextSeason must be valid integers.");
  }
  if (next <= previous) {
    throw new Error("[promote] nextSeason must be greater than prevSeason.");
  }
  const targetDir = destDir ? path.resolve(destDir) : path.join(MODELS_ROOT, String(next), "week-00");
  const sourceDir = path.join(MODELS_ROOT, String(previous), "final");
  const sourceExists = await pathExists(sourceDir);
  if (!sourceExists) {
    return false;
  }
  const destHasContent = await directoryHasFiles(targetDir);
  if (destHasContent) {
    console.log(`[promote] Destination ${targetDir} already contains files – skipping promotion.`);
    return true;
  }
  await ensureDir(targetDir);

  const state = loadTrainingState();
  const prevRevision = state?.bootstraps?.[BOOTSTRAP_KEYS.MODEL]?.revision ?? null;
  const currentRevision = CURRENT_BOOTSTRAP_REVISION;
  const files = [];
  await copyRecursive({
    sourceDir,
    destDir: targetDir,
    prevRevision: allowRevMap ? prevRevision : null,
    currentRevision,
    files
  });

  if (!files.length) {
    console.warn(`[promote] No files discovered under ${sourceDir}; nothing to promote.`);
    return false;
  }

  const bootstrapRecord = state.bootstraps?.[BOOTSTRAP_KEYS.MODEL] ?? {};
  state.bootstraps = state.bootstraps || {};
  state.bootstraps[BOOTSTRAP_KEYS.MODEL] = {
    ...bootstrapRecord,
    seededFrom: previous,
    seedRevision: prevRevision ?? null,
    seedFiles: files.sort(),
    seedPromotedAt: new Date().toISOString(),
    revision: bootstrapRecord?.revision ?? CURRENT_BOOTSTRAP_REVISION
  };
  saveTrainingState(state);
  return true;
}
