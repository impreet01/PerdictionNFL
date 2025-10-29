import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const TRAIN_CONFIG_PATH = path.resolve("./configs/train.yaml");

function readYamlSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return {};
    }
    return YAML.parse(raw) ?? {};
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

function pickTrainSettings(config = {}) {
  const {
    seed,
    paths,
    train_window,
    evaluation,
    outputs,
    runtime
  } = config;

  const result = {};
  if (seed !== undefined) {
    result.seed = seed;
  }
  if (paths !== undefined) {
    result.paths = paths;
  }
  if (train_window !== undefined) {
    result.train_window = train_window;
  }
  if (evaluation !== undefined) {
    result.evaluation = evaluation;
  }
  if (outputs !== undefined) {
    result.outputs = outputs;
  }
  if (runtime !== undefined) {
    result.runtime = runtime;
  }
  return result;
}

export function loadTrainConfig() {
  const config = readYamlSafe(TRAIN_CONFIG_PATH);
  return pickTrainSettings(config);
}

export default loadTrainConfig;
