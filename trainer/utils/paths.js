import path from "node:path";

import config from "../config.js";

const DEFAULT_ARTIFACTS_DIR = "artifacts";
const TEST_ARTIFACTS_DIR = ".test_artifacts";

function getConfigArtifactsDir() {
  const artifacts = config?.trainSettings?.paths?.artifacts;
  if (typeof artifacts === "string") {
    const trimmed = artifacts.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function resolveArtifactsRoot() {
  const configValue = getConfigArtifactsDir();
  const envValue = typeof process.env.ARTIFACTS_DIR === "string"
    ? process.env.ARTIFACTS_DIR.trim()
    : "";
  const base = configValue
    ? configValue
    : envValue
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
