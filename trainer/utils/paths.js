import fs from 'node:fs';
import path from 'node:path';

export function artifactsRoot() {
  const rawRoot = process.env.ARTIFACTS_DIR || 'artifacts';
  let resolved = path.resolve(rawRoot);

  const nested = path.join(resolved, 'artifacts');

  try {
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
      const rootHasMarkers = hasBootstrapMarkers(resolved);
      const nestedHasMarkers = hasBootstrapMarkers(nested);

      if (!rootHasMarkers && nestedHasMarkers) {
        resolved = nested;
      }
    }
  } catch (err) {
    // Ignore detection errors and fall back to the provided root.
  }

  return resolved;
}

function hasBootstrapMarkers(dir) {
  const required = [
    'training_state.json',
    'chunks',
    '.status'
  ];
  return required.some((entry) => fs.existsSync(path.join(dir, entry)));
}

export function artp(...parts) {
  return path.join(artifactsRoot(), ...parts);
}
