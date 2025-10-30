const originalArgv = process.argv.slice();
let mod;

beforeAll(async () => {
  const { mockDataLayers } = await import('./mocks.mjs');
  await mockDataLayers();
  process.argv.splice(2, process.argv.length);
  process.argv.push('--');
  mod = await import('../train_multi.js');
});

afterAll(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
});

test('train_multi public contract preserved', () => {
  expect(typeof (mod.main || mod.runTrain || mod.default)).toBe('function');
});
