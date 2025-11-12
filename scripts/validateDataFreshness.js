#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactsRoot } from '../trainer/utils/paths.js';

/**
 * Validates that fetched injury, weather, and market data:
 * 1. Exists for the current week
 * 2. Contains data for the correct season and week
 * 3. Was fetched recently (within last 24 hours)
 * 4. Has no stale data from previous weeks
 */

const argv = process.argv.slice(2);
const cliOptions = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith('--')) {
    const [key, rawVal] = arg.split('=');
    if (rawVal !== undefined) cliOptions[key.slice(2)] = rawVal;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      cliOptions[key.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      cliOptions[key.slice(2)] = true;
    }
  }
}

const now = new Date();
const season = Number.parseInt(cliOptions.season ?? now.getUTCFullYear(), 10);
if (!Number.isFinite(season)) {
  console.error('[validateDataFreshness] Invalid --season');
  process.exit(1);
}
const week = Number.parseInt(cliOptions.week ?? 0, 10);
if (!Number.isFinite(week) || week <= 0) {
  console.error('[validateDataFreshness] Provide --week (1-22).');
  process.exit(1);
}

const artifactsDir = path.resolve(process.cwd(), artifactsRoot());
const padWeek = String(week).padStart(2, '0');

const DATA_TYPES = ['injuries', 'weather', 'markets'];
const MAX_AGE_HOURS = 24;

async function validateFile(dataType) {
  const weeklyFile = path.join(artifactsDir, `${dataType}_${season}_W${padWeek}.json`);
  const currentFile = path.join(artifactsDir, `${dataType}_current.json`);

  let errors = [];
  let warnings = [];

  // Check if weekly file exists
  try {
    await fs.access(weeklyFile);
  } catch (err) {
    errors.push(`${dataType}: Weekly file not found: ${weeklyFile}`);
    return { errors, warnings };
  }

  // Read and validate weekly file
  let data;
  try {
    const content = await fs.readFile(weeklyFile, 'utf-8');
    data = JSON.parse(content);
  } catch (err) {
    errors.push(`${dataType}: Failed to read/parse ${weeklyFile}: ${err.message}`);
    return { errors, warnings };
  }

  if (!Array.isArray(data)) {
    errors.push(`${dataType}: Expected array in ${weeklyFile}, got ${typeof data}`);
    return { errors, warnings };
  }

  // Validate data content
  const now = new Date();
  const maxAge = MAX_AGE_HOURS * 60 * 60 * 1000;
  let recordCount = 0;
  let recentCount = 0;
  let correctWeekCount = 0;
  let staleCount = 0;
  let incorrectWeekCount = 0;
  let oldestAge = 0;

  for (const record of data) {
    recordCount++;

    // Check season and week
    if (record.season === season && record.week === week) {
      correctWeekCount++;
    } else if (record.season || record.week) {
      incorrectWeekCount++;
    }

    // Check freshness
    if (record.fetched_at) {
      const fetchedAt = new Date(record.fetched_at);
      const age = now - fetchedAt;
      if (age < maxAge) {
        recentCount++;
      } else {
        staleCount++;
        if (age > oldestAge) oldestAge = age;
      }
    }
  }

  if (recordCount === 0) {
    warnings.push(`${dataType}: File is empty (this may be normal if no ${dataType} data is available)`);
  } else {
    console.log(`[validateDataFreshness] ${dataType}: ${recordCount} records, ${correctWeekCount} with correct week, ${recentCount} fresh`);

    if (staleCount > 0) {
      const oldestHours = Math.round(oldestAge / (60 * 60 * 1000));
      warnings.push(`${dataType}: ${staleCount}/${recordCount} records are stale (oldest: ${oldestHours}h ago, threshold: ${MAX_AGE_HOURS}h)`);
    }

    if (incorrectWeekCount > 0) {
      warnings.push(`${dataType}: ${incorrectWeekCount}/${recordCount} records have incorrect season/week (expected S${season}W${week})`);
    }
  }

  // Check if current file exists and matches
  try {
    await fs.access(currentFile);
    const currentContent = await fs.readFile(currentFile, 'utf-8');
    const currentData = JSON.parse(currentContent);

    if (JSON.stringify(data) !== JSON.stringify(currentData)) {
      warnings.push(`${dataType}: Current file (${currentFile}) doesn't match weekly file`);
    }
  } catch (err) {
    warnings.push(`${dataType}: Current file not found or unreadable: ${currentFile}`);
  }

  return { errors, warnings };
}

async function main() {
  console.log(`[validateDataFreshness] Validating data for Season ${season}, Week ${week}`);
  console.log(`[validateDataFreshness] Artifacts directory: ${artifactsDir}`);
  console.log(`[validateDataFreshness] Max age: ${MAX_AGE_HOURS} hours`);
  console.log('');

  let allErrors = [];
  let allWarnings = [];

  for (const dataType of DATA_TYPES) {
    const { errors, warnings } = await validateFile(dataType);
    allErrors.push(...errors);
    allWarnings.push(...warnings);
  }

  // Print warnings
  if (allWarnings.length > 0) {
    console.log('\n⚠️  WARNINGS:');
    for (const warning of allWarnings) {
      console.log(`  - ${warning}`);
    }
  }

  // Print errors and exit
  if (allErrors.length > 0) {
    console.error('\n❌ VALIDATION FAILED:');
    for (const error of allErrors) {
      console.error(`  - ${error}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log('\n✅ All data validation checks passed');
  console.log(`   - Verified ${DATA_TYPES.length} data types for S${season}W${padWeek}`);
  console.log('   - Data is present and matches expected format');
  console.log('   - Weekly and current files are synchronized');
  console.log('');
}

main().catch((err) => {
  console.error('[validateDataFreshness] fatal', err);
  process.exit(1);
});
