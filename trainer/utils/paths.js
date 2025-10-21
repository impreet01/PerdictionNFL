import path from 'node:path';

export function artifactsRoot() {
  return process.env.ARTIFACTS_DIR || 'artifacts';
}

export function artp(...parts) {
  return path.join(artifactsRoot(), ...parts);
}
