import { test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

function runLegacySuite() {
  const runnerPath = path.join(repoRoot, 'trainer', 'tests', 'run-tests.js');
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `Legacy trainer tests failed with code ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
}

test('legacy trainer tests pass via run-tests.js', () => {
  runLegacySuite();
});
