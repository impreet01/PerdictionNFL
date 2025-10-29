import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['trainer/tests/**/*.test.js', 'trainer/tests/smoke.js'],
    pool: 'forks',
    maxThreads: 1,
    minThreads: 1,
    reporters: process.env.CI ? ['dot'] : ['default']
  }
});
