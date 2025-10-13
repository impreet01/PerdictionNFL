#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTrainingState,
  CURRENT_BOOTSTRAP_REVISION,
  envFlag,
  BOOTSTRAP_KEYS,
  getStatePath
} from '../trainer/trainingState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FETCH_COMMANDS = [
  { command: 'npm', args: ['run', 'fetch:injuries'], label: 'rotowire injuries' },
  { command: 'npm', args: ['run', 'fetch:markets'], label: 'rotowire markets' },
  { command: 'npm', args: ['run', 'fetch:weather'], label: 'rotowire weather' }
];

const FORCE_FLAGS = [
  'REWRITE_HISTORICAL',
  'OVERWRITE_HISTORICAL',
  'REBUILD_HISTORICAL',
  'REGENERATE_HISTORICAL',
  'REGEN_HISTORICAL',
  'FORCE_HISTORICAL_BOOTSTRAP'
];

const TRAINERS = {
  'train:multi': {
    name: 'train:multi',
    npmScript: 'train:multi',
    label: 'ensemble trainer',
    supportsHybrid: true
  },
  train: {
    name: 'train',
    npmScript: 'train',
    label: 'single-week trainer',
    supportsHybrid: false
  }
};

function printHelp() {
  console.log(`\nUsage: node scripts/runTrainingWorkflow.js [options]\n\n` +
    `Options:\n` +
    `  --skip-fetch, --no-fetch   Skip the Rotowire refresh commands.\n` +
    `  --fetch-only              Only run the Rotowire refresh commands.\n` +
    `  --trainer=<script>        Trainer npm script to run (train:multi | train).\n` +
    `  --dry-run                 Log planned actions without executing them.\n` +
    `  --help                    Show this message.\n`);
}

function parseArgs(argv) {
  const options = {
    skipFetch: false,
    fetchOnly: false,
    dryRun: false,
    trainer: 'train:multi'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--skip-fetch':
      case '--no-fetch':
        options.skipFetch = true;
        break;
      case '--fetch-only':
        options.fetchOnly = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--trainer':
        if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
          options.trainer = argv[i + 1];
          i += 1;
        } else {
          console.warn('[workflow] --trainer flag provided without a value.');
        }
        break;
      default:
        if (arg.startsWith('--trainer=')) {
          options.trainer = arg.split('=', 2)[1];
        } else {
          console.warn(`[workflow] Unrecognised option "${arg}" – ignoring.`);
        }
    }
  }

  if (options.fetchOnly) {
    options.skipFetch = false;
  }

  return options;
}

function resolveTrainer(name) {
  const key = String(name ?? '').trim();
  if (TRAINERS[key]) {
    return TRAINERS[key];
  }

  console.warn(`[workflow] Unknown trainer "${name}" – defaulting to npm run train:multi.`);
  return TRAINERS['train:multi'];
}

function runCommand(command, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd, env });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function loadState() {
  try {
    return loadTrainingState();
  } catch (err) {
    console.warn(`[workflow] Failed to load training state: ${err?.message || err}`);
    return { bootstraps: {}, latest_runs: {} };
  }
}

function readWeek(value) {
  const num = Number.parseInt(value ?? '', 10);
  return Number.isFinite(num) ? num : null;
}

function computeHybridTarget(state) {
  const latestModel = state?.latest_runs?.[BOOTSTRAP_KEYS.MODEL];
  const latestHybrid = state?.latest_runs?.[BOOTSTRAP_KEYS.HYBRID];

  const season = Number.parseInt(latestModel?.season ?? '', 10);
  const modelWeek = readWeek(latestModel?.week);

  if (!Number.isFinite(season) || !Number.isFinite(modelWeek)) {
    return { season: null, week: null };
  }

  let targetWeek = modelWeek;

  if (latestHybrid && Number.parseInt(latestHybrid.season ?? '', 10) === season) {
    const hybridWeek = readWeek(latestHybrid.week);
    if (Number.isFinite(hybridWeek)) {
      if (hybridWeek >= modelWeek) {
        targetWeek = hybridWeek;
      } else {
        targetWeek = Math.min(modelWeek, hybridWeek + 1);
      }
    }
  }

  return { season, week: targetWeek };
}

function buildEnv(overrides = {}) {
  const nextEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) {
      delete nextEnv[key];
    } else {
      nextEnv[key] = value;
    }
  }
  return nextEnv;
}

async function maybeRunFetches(options) {
  if (options.skipFetch) {
    console.log('[workflow] Skipping Rotowire refresh step.');
    return;
  }

  if (process.env.ROTOWIRE_ENABLED !== 'true') {
    console.warn('[workflow] ROTOWIRE_ENABLED is not "true" – Rotowire fetchers will no-op.');
  }

  for (const { command, args, label } of FETCH_COMMANDS) {
    console.log(`[workflow] Refreshing ${label}...`);
    if (options.dryRun) continue;
    await runCommand(command, args);
  }
}

function logBootstrapStatus(state) {
  const revision = state?.bootstraps?.[BOOTSTRAP_KEYS.MODEL]?.revision;
  if (!revision) {
    console.log('[workflow] No historical bootstrap recorded yet – first run will populate artifacts.');
    return;
  }

  if (revision !== CURRENT_BOOTSTRAP_REVISION) {
    console.warn(
      `[workflow] Cached bootstrap revision is ${revision}; expected ${CURRENT_BOOTSTRAP_REVISION}. ` +
        'The next trainer run will rebuild historical seasons.'
    );
  } else {
    console.log(`[workflow] Historical bootstrap revision OK (${revision}).`);
  }
}

function warnForceFlags() {
  const active = FORCE_FLAGS.filter((flag) => envFlag(flag));
  if (active.length) {
    console.warn(`[workflow] Force flags detected: ${active.join(', ')} – historical rebuild will be triggered.`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  console.log('[workflow] Repository root:', REPO_ROOT);
  console.log('[workflow] Training state path:', getStatePath());

  let state = loadState();
  logBootstrapStatus(state);
  warnForceFlags();

  if (options.fetchOnly) {
    await maybeRunFetches(options);
    return;
  }

  await maybeRunFetches(options);

  const trainer = resolveTrainer(options.trainer);
  console.log(`[workflow] Starting ${trainer.label} (npm run ${trainer.npmScript})...`);
  if (!options.dryRun) {
    await runCommand('npm', ['run', trainer.npmScript]);
    state = loadState();
  }

  if (options.dryRun) {
    console.log('[workflow] Dry run complete – trainer and hybrid steps were not executed.');
    return;
  }

  if (!trainer.supportsHybrid) {
    console.log(`[workflow] Trainer "${trainer.npmScript}" does not update cached state – skipping hybrid recalibration.`);
    return;
  }

  const target = computeHybridTarget(state);
  if (!Number.isFinite(target.season)) {
    console.log('[workflow] Unable to determine target season/week for hybrid calibration – skipping.');
    return;
  }

  const hybridEnv = buildEnv({
    SEASON: Number.isFinite(target.season) ? String(target.season) : undefined,
    WEEK: Number.isFinite(target.week) ? String(target.week) : undefined
  });

  console.log(
    `[workflow] Running hybrid recalibration for season ${target.season}` +
      (Number.isFinite(target.week) ? ` week ${target.week}` : '')
  );

  if (!options.dryRun) {
    await runCommand('node', ['trainer/hybrid_v2.js'], { env: hybridEnv });
  }

  const updatedState = loadState();
  const hybridRun = updatedState?.latest_runs?.[BOOTSTRAP_KEYS.HYBRID];
  if (hybridRun) {
    console.log(
      `[workflow] Hybrid calibration completed for season ${hybridRun.season} week ${hybridRun.week} at ${hybridRun.timestamp}`
    );
  } else {
    console.log('[workflow] Hybrid calibration did not record a latest run entry.');
  }
}

main().catch((err) => {
  console.error('[workflow] Fatal error:', err);
  process.exit(1);
});
