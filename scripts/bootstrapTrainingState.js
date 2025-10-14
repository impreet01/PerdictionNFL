import fs from "fs";
import { CURRENT_BOOTSTRAP_REVISION } from "../trainer/trainingState.js";
import {
  ensureTrainingStateCurrent,
  getArtifactsDir,
  getTrainingStatePath,
  isTrainingStateCurrent
} from "../trainer/bootstrapState.js";

const ARTIFACTS_DIR = getArtifactsDir();
const STATE_PATH = getTrainingStatePath();

function ensureArtifactsDir() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    throw new Error(
      `[bootstrap] artifacts directory missing at ${ARTIFACTS_DIR}. Run the trainer once manually or restore artifacts before bootstrapping.`
    );
  }
}

function main() {
  ensureArtifactsDir();

  const stateExists = fs.existsSync(STATE_PATH);
  const result = ensureTrainingStateCurrent();

  if (result.refreshed) {
    const logMessage = stateExists
      ? `[bootstrap] Refreshed training_state.json metadata from artifacts (revision ${CURRENT_BOOTSTRAP_REVISION}).`
      : `[bootstrap] Synthesised training_state.json (revision ${CURRENT_BOOTSTRAP_REVISION}) from existing artifacts.`;
    console.log(logMessage);
    return;
  }

  if (stateExists && isTrainingStateCurrent(result.state)) {
    console.log(
      `[bootstrap] training_state.json already present at ${STATE_PATH} (revision ${CURRENT_BOOTSTRAP_REVISION}); skipping.`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
