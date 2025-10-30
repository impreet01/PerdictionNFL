afterAll(() => {
  if (globalThis.__TEST_RANDOM__) {
    Math.random = globalThis.__TEST_RANDOM__._origRandom;
  }
});

// Attempt to close logger streams to avoid open handles
afterAll(async () => {
  try {
    const m = await import('../utils/logger.js');
    const logger = m.default || m.logger || m;
    if (logger && typeof logger.close === 'function') logger.close();
  } catch {}
});
