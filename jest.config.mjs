export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: [
    '<rootDir>/trainer/tests/**/*.test.js',
    '<rootDir>/trainer/tests/**/*.spec.js',
    '<rootDir>/trainer/tests/**/?(*.)+(test).js'
  ],
  setupFiles: ['<rootDir>/trainer/tests/setup-env.mjs'],
  setupFilesAfterEnv: ['<rootDir>/trainer/tests/setup-after.mjs'],
  verbose: false,
  maxWorkers: 1
};
