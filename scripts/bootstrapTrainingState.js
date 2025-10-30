import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const REQUIRED_DIRECTORIES = ["state", "outputs", "models", "logs", ".cache"];

const DEFAULT_STATE = {
  version: 1,
  trainedSeasons: [],
  lastSeason: null,
  lastWeek: null,
  modelSummary: {}
};

function ensureDirectories() {
  for (const dir of REQUIRED_DIRECTORIES) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Failed to read legacy state at ${filePath}:`, error.message ?? error);
    }
    return null;
  }
}

function ensureStateFile() {
  const destination = path.join(ROOT, "state", "model_state.json");
  if (fs.existsSync(destination)) {
    return;
  }

  const candidates = [
    path.join(ROOT, "state", "model_state.json"),
    path.join(ROOT, "state.json"),
    path.join(ROOT, "trainer", "state.json"),
    path.join(ROOT, "outputs", "state.json")
  ];

  let mergedState = { ...DEFAULT_STATE };
  for (const candidate of candidates) {
    const legacyState = readJson(candidate);
    if (legacyState && typeof legacyState === "object") {
      mergedState = { ...mergedState, ...legacyState };
      break;
    }
  }

  fs.writeFileSync(destination, `${JSON.stringify(mergedState, null, 2)}\n`, "utf8");
}

ensureDirectories();
ensureStateFile();
