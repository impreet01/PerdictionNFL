// trainer/tests/run-tests.js
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_DIR = path.resolve(process.cwd(), 'trainer', 'tests');
const ORDER_HINT = [
  'smoke.js',
  'bootstrapResolver.test.js',
  'model_ann.test.js',
  'boundsOnMarkersOnSkip.test.js',
  'strictBatch.test.js',
  'seasonalCV.test.js',
  'train_end_to_end.test.js',
  'predict_api.test.js',
  'dataLeak.test.js',
  'backtest.js',
];

function listTestFiles() {
  const all = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'run-tests.js' && !f.endsWith('.vitest.js'));

  // Prefer explicit order when files exist; append any others alphabetically.
  const priority = [];
  const remaining = new Set(all);
  for (const name of ORDER_HINT) {
    if (remaining.has(name)) {
      priority.push(name);
      remaining.delete(name);
    }
  }
  const rest = Array.from(remaining).sort();
  return [...priority, ...rest];
}

async function runOne(file) {
  const full = path.join(TEST_DIR, file);
  const url = pathToFileURL(full).href;
  try {
    await import(url);
  } catch (err) {
    console.error(`❌ Failed: ${file}`);
    console.error(err.stack || err);
    process.exitCode = 1;
  }
}

(async () => {
  console.log(`➤ Test directory: ${TEST_DIR}`);
  const files = listTestFiles();
  if (files.length === 0) {
    console.warn('⚠️  No tests found. Exiting 0 to avoid blocking CI.');
    process.exit(0);
  }

  for (const f of files) {
    console.log(`\n—— Running: ${f}`);
    await runOne(f);
  }

  // lightweight artifact for CI debugging
  try {
    const outDir = path.resolve(process.cwd(), 'artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    const data = {
      commit: process.env.GITHUB_SHA || null,
      node: process.version,
      filesExecuted: files,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(outDir, 'test-summary.json'), JSON.stringify(data, null, 2));
  } catch (_) {
    // ignore artifact errors
  }

  if (process.exitCode === 0 || process.exitCode === undefined) {
    console.log('\n✅ All test files executed (see logs above for any assertion errors).');
  } else {
    console.log('\n❌ One or more test files failed.');
  }
})();
