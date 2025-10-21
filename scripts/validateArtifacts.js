#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { validateArtifact } from "../trainer/schemaValidator.js";
import { artifactsRoot } from "../trainer/utils/paths.js";

const ARTIFACT_DIR = path.resolve(process.cwd(), artifactsRoot());

const SCHEMA_PATTERNS = {
  predictions: /^predictions_.*\.json$/,
  model: /^model_.*\.json$/,
  diagnostics: /^diagnostics_.*\.json$/,
  outcomes: /^outcomes_.*\.json$/,
  metrics: /^metrics_\d{4}_W\d{2}\.json$/,
  season_summary: /^season_summary_.*\.json$/,
  season_index: /^season_index_.*\.json$/,
  bt_features: /^bt_features_.*\.json$/
};

async function listFiles(dir, pattern) {
  const entries = await fs.readdir(dir).catch(() => []);
  return entries.filter((name) => pattern.test(name)).map((name) => path.join(dir, name));
}

async function validateFile(schemaName, file) {
  const raw = await fs.readFile(file, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
  validateArtifact(schemaName, data);
  console.log(`✔ ${schemaName} ${path.basename(file)}`);
}

async function main() {
  let failures = 0;
  for (const [schemaName, pattern] of Object.entries(SCHEMA_PATTERNS)) {
    const matches = await listFiles(ARTIFACT_DIR, pattern);
    for (const file of matches) {
      try {
        await validateFile(schemaName, file);
      } catch (err) {
        failures += 1;
        console.error(`✖ ${schemaName} ${path.basename(file)} -> ${err.message}`);
      }
    }
  }
  if (failures > 0) {
    console.error(`Schema validation failed for ${failures} artifact(s).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
