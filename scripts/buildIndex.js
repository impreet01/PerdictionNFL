// scripts/buildIndex.js
// Node ESM. Build a minimal season_index_<season>.json by scanning artifacts/.

import { CONFIG } from '../config/env.js';
import fs from 'node:fs';
import path from 'node:path';

void CONFIG;

const ART = path.join(process.cwd(), 'artifacts');
const SEASON = parseInt(process.env.SEASON || new Date().getFullYear(), 10);

function toW(w) { return String(w).padStart(2,'0'); }

const entries = [];
for (let w = 1; w <= 18; w++) {
  const pred = `predictions_${SEASON}_W${toW(w)}.json`;
  const model= `model_${SEASON}_W${toW(w)}.json`;
  const outcomes = `outcomes_${SEASON}_W${toW(w)}.json`;
  const existsPred = fs.existsSync(path.join(ART, pred));
  if (!existsPred) continue;
  entries.push({
    week: w,
    predictions: { filename: pred, path: `artifacts/${pred}`, exists: true },
    models:      fs.existsSync(path.join(ART, model)) ? { filename: model, path: `artifacts/${model}`, exists: true } : undefined,
    outcomes:    fs.existsSync(path.join(ART, outcomes)) ? { filename: outcomes, path: `artifacts/${outcomes}`, exists: true } : undefined
  });
}

const latest_completed_week = entries.length ? entries[entries.length - 1].week : null;
const out = { season: SEASON, latest_completed_week, weeks: entries };

fs.writeFileSync(path.join(ART, `season_index_${SEASON}.json`), JSON.stringify(out, null, 2));
console.log(`WROTE artifacts/season_index_${SEASON}.json`);
