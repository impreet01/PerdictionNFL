// trainer/schemaValidator.js
// Centralized JSON schema validation for artifacts.

import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";

const DEFAULT_REQUIRED_FEATURE_COLUMNS = ["season", "week", "team", "opponent", "home"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normaliseColumnName(column) {
  if (!column || typeof column !== "object") return null;
  const candidates = [column.key, column.id, column.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length) {
      return candidate;
    }
  }
  return null;
}

function extractLabelKey(meta) {
  if (!isPlainObject(meta)) return null;
  const candidates = [
    meta.label,
    meta.labelKey,
    meta.label_column,
    meta.labelColumn,
    meta.target,
    meta.targetKey,
    meta.target_column,
    meta.targetColumn,
    meta.response,
    meta.responseKey
  ];
  if (meta.label && typeof meta.label === "object") {
    candidates.push(meta.label.key, meta.label.name, meta.label.id);
  }
  if (Array.isArray(meta.labels)) {
    for (const entry of meta.labels) {
      if (typeof entry === "string") candidates.push(entry);
      else if (isPlainObject(entry)) candidates.push(entry.key, entry.name, entry.id);
    }
  }
  if (Array.isArray(meta.targets)) {
    for (const entry of meta.targets) {
      if (typeof entry === "string") candidates.push(entry);
      else if (isPlainObject(entry)) candidates.push(entry.key, entry.name, entry.id);
    }
  }
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length);
}

let lastFeaturesMeta = null;

function validateFeaturesMeta(meta) {
  if (!isPlainObject(meta)) {
    throw new Error("featuresMeta: expected object payload");
  }

  const { columns, dtypes } = meta;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("featuresMeta.columns: expected non-empty array");
  }

  const requiredColumns = [];
  for (let idx = 0; idx < columns.length; idx += 1) {
    const column = columns[idx];
    if (!isPlainObject(column)) {
      throw new Error(`featuresMeta.columns[${idx}]: expected object`);
    }
    const name = normaliseColumnName(column);
    if (!name) {
      throw new Error(`featuresMeta.columns[${idx}]: missing name`);
    }
    const dtype = column.dtype ?? column.type;
    if (dtype !== undefined && typeof dtype !== "string") {
      throw new Error(`featuresMeta.columns[${idx}]: invalid dtype`);
    }
    const role = String(column.role ?? column.purpose ?? "").toLowerCase();
    const nullable = column.nullable === true || column.allowNull === true || column.required === false;
    if (!nullable && !["meta", "skip", "id"].includes(role)) {
      requiredColumns.push(name);
    }
  }

  if (!isPlainObject(dtypes) || Object.keys(dtypes).length === 0) {
    throw new Error("featuresMeta.dtypes: expected object map");
  }

  for (const column of columns) {
    const name = normaliseColumnName(column);
    if (!name) continue;
    if (!(name in dtypes)) {
      throw new Error(`featuresMeta.dtypes: missing entry for ${name}`);
    }
  }

  const labelKey = extractLabelKey(meta);
  if (!labelKey) {
    throw new Error("featuresMeta.label: unable to resolve label key");
  }
  if (!(labelKey in dtypes)) {
    throw new Error(`featuresMeta.dtypes: missing entry for label ${labelKey}`);
  }

  lastFeaturesMeta = {
    meta,
    labelKey,
    requiredColumns: requiredColumns.length ? requiredColumns : DEFAULT_REQUIRED_FEATURE_COLUMNS
  };
}

function validateFeaturesFrame(frame) {
  if (!Array.isArray(frame)) {
    throw new Error("featuresFrame: expected array of rows");
  }
  if (frame.length === 0) {
    return;
  }
  const requiredColumns = lastFeaturesMeta?.requiredColumns || DEFAULT_REQUIRED_FEATURE_COLUMNS;
  const labelKey = lastFeaturesMeta?.labelKey || null;

  frame.forEach((row, idx) => {
    if (!isPlainObject(row)) {
      throw new Error(`featuresFrame[${idx}]: expected object row`);
    }
    for (const column of requiredColumns) {
      if (!(column in row) || row[column] === null || row[column] === undefined) {
        throw new Error(`featuresFrame[${idx}].${column}: missing value`);
      }
    }
    if (labelKey && (row[labelKey] === null || row[labelKey] === undefined)) {
      throw new Error(`featuresFrame[${idx}].${labelKey}: missing label`);
    }
  });
}

function normaliseContextRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (isPlainObject(payload)) {
    if (Array.isArray(payload.context)) return payload.context;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.games)) return payload.games;
    if (Array.isArray(payload.data)) return payload.data;
  }
  return null;
}

function validateContextPack(payload) {
  const rows = normaliseContextRows(payload);
  if (!rows) {
    throw new Error("contextPack: expected array of game contexts");
  }
  rows.forEach((row, idx) => {
    if (!isPlainObject(row)) {
      throw new Error(`contextPack[${idx}]: expected object row`);
    }
    const requiredKeys = ["game_id", "season", "week", "home_team", "away_team"];
    for (const key of requiredKeys) {
      if (!(key in row) || row[key] === null || row[key] === undefined) {
        throw new Error(`contextPack[${idx}].${key}: missing`);
      }
    }
    if (row.context != null && !isPlainObject(row.context)) {
      throw new Error(`contextPack[${idx}].context: expected object`);
    }
  });
}

function validateDataSources(payload) {
  if (!isPlainObject(payload)) {
    throw new Error("dataSources: expected object payload");
  }

  const requiredArrayKeyGroups = [
    ["schedules"],
    ["teamWeekly"],
    ["teamGame", "teamGameAdvanced"],
    ["playerWeekly"],
    ["pbp"],
    ["weather"],
    ["markets"],
    ["injuries"]
  ];

  for (const group of requiredArrayKeyGroups) {
    const key = group.find((candidate) => Array.isArray(payload[candidate]));
    if (!key) {
      throw new Error(`dataSources.${group[0]}: missing array`);
    }
  }

  const optionalGroups = [
    ["prevTeamWeekly", "teamWeeklyPrev"],
    ["qbr", "espnQBR"],
    ["elo", "eloRows"]
  ];

  for (const group of optionalGroups) {
    const key = group.find((candidate) => payload[candidate] !== undefined);
    if (key && !Array.isArray(payload[key])) {
      throw new Error(`dataSources.${key}: expected array`);
    }
  }
}

const CUSTOM_VALIDATORS = new Map([
  ["featuresMeta", validateFeaturesMeta],
  ["featuresFrame", validateFeaturesFrame],
  ["contextPack", validateContextPack],
  ["dataSources", validateDataSources]
]);

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
  const custom = CUSTOM_VALIDATORS.get(name);
  if (custom) {
    custom(data);
    return;
  }

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

export function assertSchema(data, name) {
  validateArtifact(name, data);
  return data;
}

export default {
  validateArtifact,
  assertSchema
};
