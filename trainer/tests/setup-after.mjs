afterAll(() => {
  if (globalThis.__TEST_RANDOM__) {
    Math.random = globalThis.__TEST_RANDOM__._origRandom;
  }
});
