import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockDataLayers } from './mocks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..', '..');

const stateFile = path.join(root, 'state', 'model_state.json');
const predFile = path.join(root, 'outputs', '2023', 'week_01_predictions.json');

beforeAll(() => {
  for (const d of ['state', 'outputs', 'models', 'logs']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  try {
    fs.rmSync(stateFile, { force: true });
  } catch {}
  try {
    fs.rmSync(predFile, { force: true });
  } catch {}
});

await mockDataLayers();

const originalArgv = process.argv.slice();
let entry;

beforeAll(async () => {
  process.argv.splice(2, process.argv.length);
  process.argv.push('--');

  const mod = await import('../train_multi.js');
  entry = mod.main || mod.runTrain || mod.default;
  if (!entry) {
    throw new Error('train_multi.js missing callable entry point');
  }
});

afterAll(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
});

test('cumulative train + rolling week prediction (fast)', async () => {
  await entry({ mode: 'debug', dataRoot: path.join(root, 'data'), season: 2023, week: 1 });

  expect(fs.existsSync(stateFile)).toBe(true);
  expect(fs.existsSync(predFile)).toBe(true);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  expect(Array.isArray(state.trainedSeasons)).toBe(true);

  const out = JSON.parse(fs.readFileSync(predFile, 'utf-8'));
  expect(out.season).toBe(2023);
  expect(out.week).toBe(1);
  expect(Array.isArray(out.predictions?.preds)).toBe(true);

  const p = out.predictions.preds[0];
  expect(p).toHaveProperty('homeTeam');
  expect(p).toHaveProperty('awayTeam');
  expect(p.probaHomeWin).toBeGreaterThanOrEqual(0);
  expect(p.probaHomeWin).toBeLessThanOrEqual(1);
}, 20000);
