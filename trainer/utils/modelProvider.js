import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE = {
  version: 1,
  featureOrder: [],
  labelKey: null,
  weights: [],
  featureStats: {},
  classHistogram: { '0': 0, '1': 0 },
  trainedSamples: 0,
  recentLogLoss: null,
  calibration: { slope: null, intercept: null },
  updatedAt: null,
};

const DEFAULT_OPTIONS = {
  learningRate: 0.05,
  iterations: 250,
  modelFileName: 'incremental-logreg.json',
};

const EPS = 1e-9;

function sigmoid(value) {
  if (value > 35) return 1;
  if (value < -35) return 0;
  return 1 / (1 + Math.exp(-value));
}

function coerceNumber(value) {
  if (value == null) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function coerceLabel(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '') return null;
  if (['win', 'w', 'true', 't', 'y', 'yes', '1'].includes(normalized)) return 1;
  if (['loss', 'lose', 'l', 'false', 'f', 'n', 'no', '0'].includes(normalized)) return 0;
  const num = Number(normalized);
  if (Number.isFinite(num)) {
    if (num <= 0) return 0;
    if (num >= 1) return 1;
    return num;
  }
  return null;
}

export class ModelProvider {
  constructor(options = {}) {
    const { modelsDir, seed = 42, log = console } = options;
    const config = { ...DEFAULT_OPTIONS, ...options };
    this.learningRate = Number.isFinite(config.learningRate)
      ? config.learningRate
      : DEFAULT_OPTIONS.learningRate;
    this.iterations = Number.isFinite(config.iterations)
      ? Math.max(1, Math.floor(config.iterations))
      : DEFAULT_OPTIONS.iterations;
    this.log = log || console;
    this.seed = seed;

    this.modelsDir = modelsDir ? path.resolve(modelsDir) : path.resolve('models');
    fs.mkdirSync(this.modelsDir, { recursive: true });
    this.modelPath = path.join(this.modelsDir, config.modelFileName || DEFAULT_OPTIONS.modelFileName);

    this.state = this.#loadState();
  }

  async fitIncremental(frame = [], meta = {}) {
    if (!Array.isArray(frame) || frame.length === 0) {
      this.log?.warn?.('ModelProvider.fitIncremental called with empty frame');
      return;
    }

    const schema = this.#resolveSchema(meta, frame);
    if (!schema.labelKey) {
      throw new Error('ModelProvider.fitIncremental: could not resolve label column');
    }
    if (!schema.featureKeys.length) {
      throw new Error('ModelProvider.fitIncremental: no feature columns resolved');
    }

    if (!this.state.labelKey) {
      this.state.labelKey = schema.labelKey;
    } else if (this.state.labelKey !== schema.labelKey) {
      throw new Error(
        `ModelProvider.fitIncremental: label mismatch (${schema.labelKey} != ${this.state.labelKey})`,
      );
    }

    this.#ensureFeatureOrder(schema.featureKeys);

    const samples = [];
    const labels = [];

    for (const row of frame) {
      if (!row || typeof row !== 'object') continue;
      const label = coerceLabel(row[this.state.labelKey]);
      if (label == null) continue;
      const features = this.#vectorizeRow(row, { updateStats: true });
      samples.push(features);
      labels.push(label);
    }

    if (!samples.length) {
      this.log?.warn?.('ModelProvider.fitIncremental: no labeled rows in batch');
      return;
    }

    if (!Array.isArray(this.state.weights) || this.state.weights.length !== this.state.featureOrder.length + 1) {
      this.state.weights = new Array(this.state.featureOrder.length + 1).fill(0);
    }

    const loss = this.#trainBatch(samples, labels);
    this.state.recentLogLoss = loss;
    this.state.trainedSamples += samples.length;
    this.state.updatedAt = new Date().toISOString();
    this.#updateHistogram(labels);
    this.#persistState();
  }

  async predict(frame = [], meta = {}) {
    if (!Array.isArray(frame) || frame.length === 0) {
      return [];
    }

    if (!this.state.featureOrder.length || !this.state.weights.length) {
      return this.#baselinePredictions(frame);
    }

    const schema = this.#resolveSchema(meta, frame);
    if (!this.state.labelKey && schema.labelKey) {
      this.state.labelKey = schema.labelKey;
    }
    this.#ensureFeatureOrder(schema.featureKeys, { extend: false });

    const games = new Map();

    for (const row of frame) {
      if (!row || typeof row !== 'object') continue;
      const features = this.#vectorizeRow(row, { updateStats: false });
      const probability = this.#predictProba(features);

      const homeTeam = this.#extractHomeTeam(row);
      const awayTeam = this.#extractAwayTeam(row);
      const season = row?.season ?? row?.Season ?? null;
      const week = row?.week ?? row?.Week ?? row?.game_week ?? row?.week_number ?? null;
      const key = `${season ?? 'na'}-${week ?? 'na'}-${homeTeam ?? 'home'}-${awayTeam ?? 'away'}`;

      if (!games.has(key)) {
        games.set(key, {
          season: season ?? null,
          week: week ?? null,
          homeTeam: homeTeam ?? null,
          awayTeam: awayTeam ?? null,
          homeProba: null,
          awayProba: null,
        });
      }

      const entry = games.get(key);
      if (this.#isHomeRow(row)) {
        entry.homeProba = probability;
      } else if (this.#isAwayRow(row)) {
        entry.awayProba = probability;
      } else if (entry.homeProba == null) {
        entry.homeProba = probability;
      } else if (entry.awayProba == null) {
        entry.awayProba = probability;
      }
    }

    const outputs = [];
    for (const game of games.values()) {
      const probaHomeWin = this.#resolveHomeProbability(game.homeProba, game.awayProba);
      const probaAwayWin = this.#resolveAwayProbability(game.homeProba, game.awayProba);
      outputs.push({
        season: game.season,
        week: game.week,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        probaHomeWin,
        probaAwayWin,
        edge: probaHomeWin != null && probaAwayWin != null ? probaHomeWin - probaAwayWin : null,
      });
    }

    return outputs;
  }

  async summarize() {
    return {
      featureCount: this.state.featureOrder.length,
      classes: Object.entries(this.state.classHistogram).map(([label, count]) => ({
        label,
        count,
      })),
      recentLogLoss: this.state.recentLogLoss,
      calibrationSlope: this.state.calibration?.slope ?? null,
      calibrationIntercept: this.state.calibration?.intercept ?? null,
      trainedSamples: this.state.trainedSamples,
      updatedAt: this.state.updatedAt,
    };
  }

  #resolveSchema(meta, frame) {
    const featureKeys = new Set();
    const labelCandidates = [];

    const metaFeatures = this.#extractFeatureKeysFromMeta(meta);
    for (const key of metaFeatures) featureKeys.add(key);

    const metaLabel = this.#extractLabelKeyFromMeta(meta);
    if (metaLabel) labelCandidates.push(metaLabel);

    const firstRow = frame.find((row) => row && typeof row === 'object');
    if (firstRow) {
      if (!labelCandidates.length) {
        const labelGuess = this.#guessLabelFromRow(firstRow);
        if (labelGuess) labelCandidates.push(labelGuess);
      }

      if (!featureKeys.size) {
        for (const key of Object.keys(firstRow)) {
          if (key === labelCandidates[0]) continue;
          if (this.#isMetaColumn(key)) continue;
          const value = firstRow[key];
          if (value == null) continue;
          if (typeof value === 'object') continue;
          if (!Number.isFinite(coerceNumber(value))) continue;
          featureKeys.add(key);
        }
      }
    }

    const resolvedLabel = labelCandidates.find((key) => firstRow && Object.hasOwn(firstRow, key));
    const resolvedFeatures = [...featureKeys];

    return { featureKeys: resolvedFeatures, labelKey: resolvedLabel ?? null };
  }

  #extractFeatureKeysFromMeta(meta) {
    if (!meta || typeof meta !== 'object') return [];
    const keys = new Set();
    if (Array.isArray(meta.features)) {
      for (const entry of meta.features) {
        if (typeof entry === 'string') keys.add(entry);
        else if (entry && typeof entry === 'object' && entry.key) keys.add(entry.key);
        else if (entry && typeof entry === 'object' && entry.name) keys.add(entry.name);
      }
    }
    if (Array.isArray(meta.columns)) {
      for (const column of meta.columns) {
        if (!column || typeof column !== 'object') continue;
        const role = String(column.role ?? column.purpose ?? '').toLowerCase();
        if (role && ['id', 'meta', 'label', 'target', 'skip'].includes(role)) continue;
        if (column.type && String(column.type).toLowerCase() === 'string') continue;
        const name = column.name ?? column.key ?? column.id;
        if (name) keys.add(name);
      }
    }
    if (Array.isArray(meta.featureColumns)) {
      for (const name of meta.featureColumns) {
        if (typeof name === 'string') keys.add(name);
      }
    }
    if (meta && typeof meta === 'object' && typeof meta.featureKeys === 'object') {
      for (const key of Object.values(meta.featureKeys)) {
        if (typeof key === 'string') keys.add(key);
      }
    }
    return [...keys];
  }

  #extractLabelKeyFromMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const candidates = [
      meta.labelKey,
      meta.targetKey,
      meta.target,
      meta.label,
      meta.labelColumn,
      meta.targetColumn,
      meta.outcomeKey,
      meta.response,
      meta.responseKey,
    ];
    if (meta.label && typeof meta.label === 'object') {
      candidates.push(meta.label.key, meta.label.name, meta.label.id);
    }
    if (Array.isArray(meta.labels)) {
      for (const l of meta.labels) {
        if (typeof l === 'string') candidates.push(l);
        else if (l && typeof l === 'object') candidates.push(l.key, l.name, l.id);
      }
    }
    if (Array.isArray(meta.targets)) {
      for (const t of meta.targets) {
        if (typeof t === 'string') candidates.push(t);
        else if (t && typeof t === 'object') candidates.push(t.key, t.name, t.id);
      }
    }
    return candidates.find((c) => typeof c === 'string' && c.length);
  }

  #guessLabelFromRow(row) {
    if (!row) return null;
    const explicit = ['win', 'wins', 'home_win', 'target', 'label'];
    for (const key of explicit) {
      if (Object.hasOwn(row, key)) return key;
    }
    for (const key of Object.keys(row)) {
      if (/win$/i.test(key)) return key;
      if (/result/i.test(key)) return key;
    }
    return null;
  }

  #isMetaColumn(key) {
    const normalized = String(key).toLowerCase();
    return (
      normalized === 'season' ||
      normalized === 'week' ||
      normalized === 'team' ||
      normalized === 'opponent' ||
      normalized === 'home' ||
      normalized === 'away' ||
      normalized === 'game_date' ||
      normalized.endsWith('_team') ||
      normalized.endsWith('_opponent')
    );
  }

  #ensureFeatureOrder(featureKeys, options = {}) {
    const { extend = true } = options;
    if (!Array.isArray(this.state.featureOrder)) {
      this.state.featureOrder = [];
    }
    if (!Array.isArray(this.state.weights) || this.state.weights.length !== this.state.featureOrder.length + 1) {
      this.state.weights = new Array(this.state.featureOrder.length + 1).fill(0);
    }

    for (const key of featureKeys) {
      if (this.state.featureOrder.includes(key)) continue;
      if (!extend) {
        continue;
      }
      this.state.featureOrder.push(key);
      this.state.weights.push(0);
    }

    for (const key of this.state.featureOrder) {
      if (!this.state.featureStats[key]) {
        this.state.featureStats[key] = { maxAbs: 1 };
      }
    }
  }

  #vectorizeRow(row, { updateStats }) {
    const vector = new Array(this.state.featureOrder.length);
    for (let i = 0; i < this.state.featureOrder.length; i += 1) {
      const key = this.state.featureOrder[i];
      const stats = this.state.featureStats[key] || { maxAbs: 1 };
      const rawValue = coerceNumber(row?.[key]);
      if (updateStats) {
        const absVal = Math.abs(rawValue);
        if (Number.isFinite(absVal) && absVal > (stats.maxAbs || 1)) {
          stats.maxAbs = absVal;
        }
        if (!stats.maxAbs || stats.maxAbs < 1) stats.maxAbs = 1;
        this.state.featureStats[key] = stats;
      }
      const scale = stats.maxAbs && Number.isFinite(stats.maxAbs) && stats.maxAbs > 0 ? stats.maxAbs : 1;
      vector[i] = Number.isFinite(rawValue) ? rawValue / scale : 0;
    }
    return vector;
  }

  #trainBatch(samples, labels) {
    const weights = this.state.weights.slice();
    const featureLength = this.state.featureOrder.length;
    let loss = null;

    for (let iter = 0; iter < this.iterations; iter += 1) {
      const gradients = new Array(featureLength + 1).fill(0);
      let batchLoss = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const features = samples[i];
        const label = labels[i];
        let linear = weights[0];
        for (let j = 0; j < featureLength; j += 1) {
          linear += weights[j + 1] * features[j];
        }
        const prediction = sigmoid(linear);
        const error = prediction - label;
        gradients[0] += error;
        for (let j = 0; j < featureLength; j += 1) {
          gradients[j + 1] += error * features[j];
        }
        batchLoss += -(label * Math.log(prediction + EPS) + (1 - label) * Math.log(1 - prediction + EPS));
      }
      const scale = this.learningRate / samples.length;
      for (let j = 0; j < gradients.length; j += 1) {
        weights[j] -= scale * gradients[j];
      }
      loss = batchLoss / samples.length;
    }

    this.state.weights = weights;
    return loss;
  }

  #updateHistogram(labels) {
    for (const label of labels) {
      const bucket = label <= 0.5 ? '0' : '1';
      this.state.classHistogram[bucket] = (this.state.classHistogram[bucket] || 0) + 1;
    }
  }

  #predictProba(features) {
    let linear = this.state.weights[0];
    for (let j = 0; j < features.length; j += 1) {
      linear += this.state.weights[j + 1] * features[j];
    }
    return sigmoid(linear);
  }

  #resolveHomeProbability(home, away) {
    if (home != null) return home;
    if (away != null) return 1 - away;
    return 0.5;
  }

  #resolveAwayProbability(home, away) {
    if (away != null) return away;
    if (home != null) return 1 - home;
    return 0.5;
  }

  #isHomeRow(row) {
    if (row == null) return false;
    if (Object.hasOwn(row, 'home')) return Number(row.home) === 1;
    if (Object.hasOwn(row, 'is_home')) return Number(row.is_home) === 1;
    if (Object.hasOwn(row, 'home_flag')) return Number(row.home_flag) === 1;
    return false;
  }

  #isAwayRow(row) {
    if (row == null) return false;
    if (Object.hasOwn(row, 'home')) return Number(row.home) === 0;
    if (Object.hasOwn(row, 'is_home')) return Number(row.is_home) === 0;
    if (Object.hasOwn(row, 'home_flag')) return Number(row.home_flag) === 0;
    return false;
  }

  #extractHomeTeam(row) {
    if (!row || typeof row !== 'object') return null;
    if (this.#isHomeRow(row)) return row.team ?? row.home_team ?? row.Team ?? null;
    if (this.#isAwayRow(row)) return row.opponent ?? row.opponent_team ?? row.Opponent ?? null;
    return row.home_team ?? row.team ?? null;
  }

  #extractAwayTeam(row) {
    if (!row || typeof row !== 'object') return null;
    if (this.#isHomeRow(row)) return row.opponent ?? row.away_team ?? row.Opponent ?? null;
    if (this.#isAwayRow(row)) return row.team ?? row.away_team ?? row.Team ?? null;
    return row.away_team ?? row.opponent ?? null;
  }

  #baselinePredictions(frame) {
    const games = new Map();
    for (const row of frame) {
      if (!row || typeof row !== 'object') continue;
      const homeTeam = this.#extractHomeTeam(row);
      const awayTeam = this.#extractAwayTeam(row);
      const season = row?.season ?? row?.Season ?? null;
      const week = row?.week ?? row?.Week ?? row?.game_week ?? row?.week_number ?? null;
      const key = `${season ?? 'na'}-${week ?? 'na'}-${homeTeam ?? 'home'}-${awayTeam ?? 'away'}`;
      if (!games.has(key)) {
        games.set(key, {
          season: season ?? null,
          week: week ?? null,
          homeTeam: homeTeam ?? null,
          awayTeam: awayTeam ?? null,
        });
      }
    }
    return [...games.values()].map((game) => ({
      season: game.season,
      week: game.week,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      probaHomeWin: 0.5,
      probaAwayWin: 0.5,
      edge: 0,
    }));
  }

  #loadState() {
    try {
      if (fs.existsSync(this.modelPath)) {
        const raw = JSON.parse(fs.readFileSync(this.modelPath, 'utf-8'));
        return {
          ...structuredClone(DEFAULT_STATE),
          ...raw,
          featureOrder: Array.isArray(raw.featureOrder) ? raw.featureOrder.slice() : [],
          weights: Array.isArray(raw.weights) ? raw.weights.slice() : [],
          featureStats: raw.featureStats && typeof raw.featureStats === 'object' ? { ...raw.featureStats } : {},
          classHistogram:
            raw.classHistogram && typeof raw.classHistogram === 'object'
              ? { ...DEFAULT_STATE.classHistogram, ...raw.classHistogram }
              : { ...DEFAULT_STATE.classHistogram },
        };
      }
    } catch (err) {
      this.log?.error?.('ModelProvider: failed to load model state', err);
    }
    return structuredClone(DEFAULT_STATE);
  }

  #persistState() {
    const payload = {
      ...this.state,
      weights: Array.isArray(this.state.weights) ? this.state.weights.map((v) => (Number.isFinite(v) ? v : 0)) : [],
    };
    fs.writeFileSync(this.modelPath, JSON.stringify(payload, null, 2));
  }
}

