import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DIRECTORIES = ["state", "outputs", "models", ".cache"].map((dir) => path.join(ROOT_DIR, dir));
const STATE_FILE_PATH = path.join(ROOT_DIR, "state", "model_state.json");
const DEFAULT_STATE = {
  version: 1,
  trainedSeasons: [],
  lastSeason: null,
  lastWeek: null,
  modelSummary: {}
};

function ensureDirectories() {
  for (const dir of DIRECTORIES) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureStateFile() {
  if (fs.existsSync(STATE_FILE_PATH)) {
    return;
  }
  const contents = `${JSON.stringify(DEFAULT_STATE, null, 2)}\n`;
  fs.writeFileSync(STATE_FILE_PATH, contents, "utf8");
}

function main() {
  try {
    ensureDirectories();
    ensureStateFile();
  } catch (error) {
    console.error("Failed to bootstrap training state:", error);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
