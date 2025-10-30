// trainer/schemaValidator.js
// Centralized JSON schema validation for artifacts.

import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";

const ajv = new Ajv({
  strict: false,
  allErrors: true,
  // Coerce primitive values (e.g. "2024" -> 2024) so that upstream
  // data sources that serialize numbers as strings still satisfy the
  // schema constraints. This prevents failures like FTN chart rows
  // providing a season as a string and keeps the behaviour consistent
  // across all artifact validations.
  coerceTypes: true
});

const SCHEMA_ROOT = path.resolve("./docs/schemas");
const cache = new Map();

function readSchema(name) {
  const file = path.join(SCHEMA_ROOT, `${name}.schema.json`);
  if (cache.has(file)) return cache.get(file);
  const raw = fs.readFileSync(file, "utf8");
  const schema = JSON.parse(raw);
  const validator = ajv.compile(schema);
  cache.set(file, validator);
  return validator;
}

export function validateArtifact(name, data) {
  try {
    const validator = readSchema(name);
    const ok = validator(data);
    if (!ok) {
      const errors = validator.errors || [];
      const detail = errors
        .map((err) => `${err.instancePath || "."} ${err.message}`)
        .slice(0, 5)
        .join("; ");
      throw new Error(`Schema ${name} failed: ${detail}`);
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`Missing schema for ${name}`);
    }
    throw err;
  }
}

export default {
  validateArtifact
};
