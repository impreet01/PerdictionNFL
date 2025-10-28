import path from "node:path";

const DEFAULT_ARTIFACTS_DIR = "artifacts";
const TEST_ARTIFACTS_DIR = ".test_artifacts";

function resolveArtifactsRoot() {
  const envValue = typeof process.env.ARTIFACTS_DIR === "string"
    ? process.env.ARTIFACTS_DIR.trim()
    : "";
  const base = envValue
    ? envValue
    : process.env.NODE_ENV === "test"
      ? TEST_ARTIFACTS_DIR
      : DEFAULT_ARTIFACTS_DIR;
  return path.resolve(process.cwd(), base);
}

export function artifactsRoot() {
  return resolveArtifactsRoot();
}

export function artp(...parts) {
  return path.join(resolveArtifactsRoot(), ...parts);
}

export function resolveArtifactsDir() {
  return resolveArtifactsRoot();
}
