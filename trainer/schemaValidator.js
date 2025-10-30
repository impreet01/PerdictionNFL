// trainer/schemaValidator.js
// Lightweight JSON validation helpers that keep CI flexible while still
// catching obviously malformed artifacts.

import fs from "node:fs";
import path from "node:path";

const SCHEMA_ROOT = path.resolve("./docs/schemas");
const schemaCache = new Map();
const SAMPLE_LIMIT = 5;
const MAX_DEPTH = 2;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadSchema(name) {
  const file = path.join(SCHEMA_ROOT, `${name}.schema.json`);
  if (schemaCache.has(file)) {
    return schemaCache.get(file);
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const schema = JSON.parse(raw);
    schemaCache.set(file, schema);
    return schema;
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`Missing schema for ${name}`);
    }
    throw err;
  }
}

function normaliseTypes(type) {
  if (Array.isArray(type)) return type;
  if (typeof type === "string") return [type];
  return [];
}

function valueMatchesType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function checkEnum(schema, value, context) {
  if (!Array.isArray(schema?.enum)) return;
  ensure(schema.enum.includes(value), `${context}: value not in enum`);
}

function validateProperties(schema, value, context, depth) {
  if (!isPlainObject(schema?.properties)) return;
  for (const [key, childSchema] of Object.entries(schema.properties)) {
    if (!(key in value)) continue;
    if (depth >= MAX_DEPTH) continue;
    validateAgainstSchema(childSchema, value[key], `${context}.${key}`, depth + 1);
  }
}

function validateAdditionalProperties(schema, value, context, depth) {
  if (!schema || !schema.additionalProperties) return;
  if (!isPlainObject(value)) return;
  if (schema.additionalProperties === true) return;
  if (!isPlainObject(schema.additionalProperties)) return;
  if (depth >= MAX_DEPTH) return;
  for (const [key, childValue] of Object.entries(value)) {
    if (schema.properties && key in schema.properties) continue;
    validateAgainstSchema(schema.additionalProperties, childValue, `${context}.${key}`, depth + 1);
  }
}

function validateObject(schema, value, context, depth) {
  ensure(isPlainObject(value), `${context}: expected object, received ${describeType(value)}`);
  if (Array.isArray(schema?.required)) {
    for (const key of schema.required) {
      ensure(key in value && value[key] !== undefined, `${context}.${key}: missing required value`);
    }
  }
  validateProperties(schema, value, context, depth);
  validateAdditionalProperties(schema, value, context, depth);
}

function normaliseItems(schema) {
  if (!schema) return null;
  if (Array.isArray(schema)) return schema;
  return [schema];
}

function validateArray(schema, value, context, depth) {
  ensure(Array.isArray(value), `${context}: expected array, received ${describeType(value)}`);
  if (typeof schema?.minItems === "number") {
    ensure(value.length >= schema.minItems, `${context}: expected at least ${schema.minItems} items`);
  }
  if (!schema?.items || depth >= MAX_DEPTH) return;
  const samples = value.slice(0, SAMPLE_LIMIT);
  const itemSchemas = normaliseItems(schema.items);
  samples.forEach((item, idx) => {
    const targetSchema = itemSchemas[Math.min(idx, itemSchemas.length - 1)] || itemSchemas[0];
    if (!targetSchema) return;
    validateAgainstSchema(targetSchema, item, `${context}[${idx}]`, depth + 1);
  });
}

function validateCombined(schemaList, value, context, depth, combiner) {
  if (!Array.isArray(schemaList) || schemaList.length === 0) return false;
  if (combiner === "anyOf" || combiner === "oneOf") {
    return schemaList.some((entry) => {
      try {
        validateAgainstSchema(entry, value, context, depth + 1);
        return true;
      } catch (err) {
        return false;
      }
    });
  }
  if (combiner === "allOf") {
    schemaList.forEach((entry) => validateAgainstSchema(entry, value, context, depth + 1));
    return true;
  }
  return false;
}

function validateAgainstSchema(schema, value, context, depth = 0) {
  if (!schema) return;

  if (schema.anyOf) {
    ensure(
      validateCombined(schema.anyOf, value, context, depth, "anyOf"),
      `${context}: did not satisfy any allowed shape`
    );
    return;
  }
  if (schema.oneOf) {
    ensure(
      validateCombined(schema.oneOf, value, context, depth, "oneOf"),
      `${context}: did not satisfy any allowed shape`
    );
    return;
  }
  if (schema.allOf) {
    validateCombined(schema.allOf, value, context, depth, "allOf");
  }

  if (schema.enum) {
    checkEnum(schema, value, context);
  }

  const types = normaliseTypes(schema.type);
  if (types.length) {
    const matches = types.some((type) => valueMatchesType(value, type));
    ensure(matches, `${context}: expected ${types.join(" or ")}, received ${describeType(value)}`);

    if (types.includes("array")) {
      validateArray(schema, value, context, depth);
    }
    if (types.includes("object")) {
      validateObject(schema, value, context, depth);
    }
    return;
  }

  // Schemas without an explicit type may still define nested constraints.
  if (isPlainObject(value)) {
    validateProperties(schema, value, context, depth);
    validateAdditionalProperties(schema, value, context, depth);
  }
}

const CUSTOM_VALIDATORS = new Map([
  [
    "featuresFrame",
    (value) => {
      ensure(Array.isArray(value), "featuresFrame: expected array of rows");
    }
  ]
]);

export function validateArtifact(name, data) {
  ensure(data !== undefined, `${name}: missing payload`);
  const validator = CUSTOM_VALIDATORS.get(name);
  if (validator) {
    validator(data);
    return data;
  }

  const schema = loadSchema(name);
  validateAgainstSchema(schema, data, name);
  return data;
}

export function assertSchema(data, name) {
  return validateArtifact(name, data);
}

export default {
  validateArtifact,
  assertSchema
};
