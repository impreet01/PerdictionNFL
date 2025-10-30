import fs from 'node:fs';
import path from 'node:path';

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

export function writeMetricsForSeason(outputsDir, season, metrics) {
  const p = path.join(outputsDir, 'metrics', `${season}.json`);
  writeJson(p, { season, ...metrics, generatedAt: new Date().toISOString() });
}

export function writeFeatureSet(outputsDir, featureList) {
  const p = path.join(outputsDir, 'feature_set.json');
  writeJson(p, { features: featureList, generatedAt: new Date().toISOString() });
}
