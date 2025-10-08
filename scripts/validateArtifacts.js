#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { validateArtifact } from "../trainer/schemaValidator.js";

const ARTIFACT_DIR = path.resolve(process.cwd(), "artifacts");

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

function listFiles(dir, pattern) {
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name));
}

function main() {
  let failures = 0;
  for (const [schemaName, pattern] of Object.entries(SCHEMA_PATTERNS)) {
    const matches = listFiles(ARTIFACT_DIR, pattern);
    for (const file of matches) {
      try {
        const raw = fs.readFileSync(file, "utf8");
        const data = JSON.parse(raw);
        validateArtifact(schemaName, data);
        console.log(`✔ ${schemaName} ${path.basename(file)}`);
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

main();
