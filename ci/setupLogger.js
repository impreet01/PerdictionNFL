import logger, { installLogger } from '../logger.js';

const bindings = {
  scope: process.env.GITHUB_WORKFLOW || 'ci',
  job: process.env.GITHUB_JOB,
};

installLogger({ logger, bindings });
