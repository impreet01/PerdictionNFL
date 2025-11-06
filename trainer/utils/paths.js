import fs from 'node:fs';
import path from 'node:path';

export function artifactsRoot() {
  const rawRoot = process.env.ARTIFACTS_DIR || 'artifacts';
  let resolved = path.resolve(rawRoot);

  console.log('[artifactsRoot] process.env.ARTIFACTS_DIR:', process.env.ARTIFACTS_DIR);
  console.log('[artifactsRoot] rawRoot:', rawRoot);
  console.log('[artifactsRoot] resolved (before nested check):', resolved);

  const nested = path.join(resolved, 'artifacts');
  console.log('[artifactsRoot] Checking for nested artifacts at:', nested);

  try {
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
      const rootHasMarkers = hasBootstrapMarkers(resolved);
      const nestedHasMarkers = hasBootstrapMarkers(nested);

      console.log('[artifactsRoot] Nested artifacts directory exists');
      console.log('[artifactsRoot] rootHasMarkers:', rootHasMarkers);
      console.log('[artifactsRoot] nestedHasMarkers:', nestedHasMarkers);

      if (!rootHasMarkers && nestedHasMarkers) {
        console.log('[artifactsRoot] Using nested artifacts directory');
        resolved = nested;
      }
    }
  } catch (err) {
    console.log('[artifactsRoot] Error during nested directory detection:', err.message);
    // Ignore detection errors and fall back to the provided root.
  }

  console.log('[artifactsRoot] Final resolved path:', resolved);
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
