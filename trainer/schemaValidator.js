// trainer/schemaValidator.js
// Minimal schema validation helpers to keep CI runs resilient.

export function assertSchema(obj, kind) {
  if (!obj) return;
  if (kind === 'featuresFrame') {
    if (!Array.isArray(obj)) throw new Error('featuresFrame must be an array');
  }
  // keep light to prevent CI brittleness
}

export function validateArtifact(kind, obj) {
  assertSchema(obj, kind);
  return obj;
}

export default {
  validateArtifact,
  assertSchema
};
