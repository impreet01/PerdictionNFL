import path from 'node:path';

export function artifactsRoot() {
  const root = process.env.ARTIFACTS_DIR || 'artifacts';
  return path.resolve(root);
}

export function artp(...parts) {
  return path.join(artifactsRoot(), ...parts);
}
