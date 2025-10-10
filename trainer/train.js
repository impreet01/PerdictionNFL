// trainer/train.js
import {
  loadSchedules,
  loadTeamWeekly,
  loadTeamGameAdvanced,
  listDatasetSeasons,
  loadWeather,
  loadInjuries,
  loadMarkets
} from "./dataSources.js";
import { buildFeatures, FEATS } from "./featureBuild.js";
import { writeFileSync, mkdirSync } from "fs";
import LogisticRegression from "ml-logistic-regression";
import { DecisionTreeClassifier as CART } from "ml-cart";
import { Matrix } from "ml-matrix";
import { resolveSeasonList } from "./databases.js";

const ART_DIR = "artifacts";
mkdirSync(ART_DIR, { recursive: true });

const argv = process.argv.slice(2);
const cliOpts = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith('--')) continue;
  const [rawKey, rawVal] = arg.split('=', 2);
  const key = rawKey.replace(/^--/, '');
  if (rawVal !== undefined) {
    cliOpts[key] = rawVal;
  } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
    cliOpts[key] = argv[i + 1];
    i += 1;
  } else {
    cliOpts[key] = true;
  }
}

const TARGET_SEASON = Number(cliOpts.season ?? process.env.SEASON ?? new Date().getFullYear());
const TARGET_WEEK = Number(cliOpts.week ?? process.env.WEEK ?? 6);
const INCLUDE_ALL = Boolean(
  cliOpts.all === true ||
    /^(1|true|yes)$/i.test(String(cliOpts.all ?? '')) ||
    /^(1|true|yes)$/i.test(String(process.env.ALL_SEASONS ?? process.env.ALL ?? ''))
);
const SINCE_SEASON = cliOpts.since != null ? Number(cliOpts.since) : (process.env.SINCE_SEASON ? Number(process.env.SINCE_SEASON) : null);
const MAX_SEASONS = cliOpts.max != null ? Number(cliOpts.max) : (process.env.MAX_SEASONS ? Number(process.env.MAX_SEASONS) : null);

function Xy(rows) {
  const X = rows.map(r => FEATS.map(k => Number(r[k] ?? 0)));
  const y = rows.map(r => Number(r.win));
  return { X, y };
}
function splitTrainTest(all, season, week) {
  const train = all.filter(r => {
    if (r.season === season) return r.week < week;
    return r.season < season;
  });
  const test  = all.filter(r => r.season === season && r.week === week);
  return { train, test };
}
function sigmoid(z){ return 1/(1+Math.exp(-z)); }
function dot(a,b){ let s=0; for (let i=0;i<a.length;i++) s += (a[i]||0)*(b[i]||0); return s; }
function toArray1D(theta){
  if (!theta) return [];
  if (Array.isArray(theta)) return theta.map(Number);
  if (typeof theta.to1DArray === "function") return theta.to1DArray().map(Number);
  if (typeof theta.toJSON === "function") return theta.toJSON().map(Number);
  return Array.from(theta).map(Number);
}
function vectorizeProba(theta, X){
  const w = toArray1D(theta);
  return X.map(x => sigmoid(dot(w, x)));
}
function logLoss(y, p){
  let s=0,eps=1e-12;
  for(let i=0;i<y.length;i++){
    s += -(y[i]*Math.log(p[i]+eps) + (1-y[i])*Math.log(1-p[i]+eps));
  }
  return s/y.length;
}
function chooseHybridWeight(y, pL, pT){
  let bestW=0.6, bestLL=1e9;
  for(let w=0; w<=1.0001; w+=0.05){
    const ph = pL.map((p,i)=> w*p + (1-w)*pT[i]);
    const ll = logLoss(y, ph);
    if (ll < bestLL) { bestLL = ll; bestW = Number(w.toFixed(2)); }
  }
  return bestW;
}

function applyOnlineLearning(weights, rows, epochs = 2, baseLr = 2e-3) {
  if (!Array.isArray(weights) || !weights.length) return weights;
  const tuned = weights.slice();
  const ordered = rows
    .slice()
    .sort((a, b) => (a.season === b.season ? a.week - b.week : a.season - b.season));
  let lr = baseLr;
  for (let epoch = 0; epoch < Math.max(1, epochs); epoch += 1) {
    for (const row of ordered) {
      const features = FEATS.map((k) => Number(row[k] ?? 0));
      const target = Number(row.win ?? 0);
      const prediction = sigmoid(dot(tuned, features));
      const error = target - prediction;
      for (let i = 0; i < tuned.length; i += 1) {
        tuned[i] += lr * error * (features[i] || 0);
      }
    }
    lr *= 0.9;
  }
  return tuned;
}
function round3(x){ return Math.round(Number(x)*1000)/1000; }

(async function main(){
  console.log(`Training season ${TARGET_SEASON}, week ${TARGET_WEEK}`);

  const discoveredSeasons = await listDatasetSeasons('teamWeekly').catch(() => []);
  const seasonsResolved = await resolveSeasonList({
    targetSeason: TARGET_SEASON,
    includeAll: INCLUDE_ALL,
    sinceSeason: SINCE_SEASON,
    maxSeasons: MAX_SEASONS,
    availableSeasons: discoveredSeasons
  });
  const trainingSeasons = Array.from(new Set(seasonsResolved.filter((s) => Number(s) <= TARGET_SEASON).concat([TARGET_SEASON])))
    .map((s) => Number(s))
    .sort((a, b) => a - b);

  console.log(`[train] seasons in scope: ${trainingSeasons.join(', ')}`);

  const allRows = [];
  const seasonSummaries = [];
  for (const season of trainingSeasons) {
    const [schedules, teamWeekly] = await Promise.all([
      loadSchedules(season),
      loadTeamWeekly(season)
    ]);
    let teamGame = [];
    try { teamGame = await loadTeamGameAdvanced(season); } catch (_) {}
    let prevTeamWeekly = [];
    try { prevTeamWeekly = await loadTeamWeekly(season - 1); } catch (_) {}
    let weatherRows = [];
    try { weatherRows = await loadWeather(season); } catch (_) {}
    let injuryRows = [];
    try { injuryRows = await loadInjuries(season); } catch (_) {}
    let marketRows = [];
    try { marketRows = await loadMarkets(season); } catch (_) {}
    const featRows = buildFeatures({
      teamWeekly,
      teamGame,
      schedules,
      season,
      prevTeamWeekly,
      weather: weatherRows,
      injuries: injuryRows,
      markets: marketRows
    });
    allRows.push(...featRows);
    seasonSummaries.push({ season, rows: featRows.length });
  }

  const { train, test } = splitTrainTest(allRows, TARGET_SEASON, TARGET_WEEK);

  const totalRows = allRows.length;
  console.log(`DEBUG: featRows=${totalRows}, train=${train.length}, test=${test.length}`);
  for (const meta of seasonSummaries) {
    console.log(`DEBUG: season ${meta.season} rows=${meta.rows}`);
  }
  if (!train.length || !test.length) {
    console.log("No train/test rows (calendar or data timing). Skipping gracefully.");
    process.exit(0);
  }

  const pos = train.filter(r => r.win === 1).length;
  const neg = train.length - pos;
  console.log(`Train size: ${train.length} (wins=${pos}, losses=${neg})`);

  const { X: XL_raw, y: yL_raw } = Xy(train);
  const XL = new Matrix(XL_raw);
  const yL = Matrix.columnVector(yL_raw);
  const logit = new LogisticRegression({ numSteps: 2500, learningRate: 5e-3 });
  logit.train(XL, yL);

  const tunedWeights = applyOnlineLearning(toArray1D(logit.theta || logit.weights), train, 2, 1.5e-3);
  if (Array.isArray(tunedWeights) && tunedWeights.length === FEATS.length) {
    const tunedMatrix = Matrix.columnVector(tunedWeights);
    logit.theta = tunedMatrix;
    logit.weights = tunedMatrix;
  }

  const { X: Xtest_raw } = Xy(test);
  const pL_train = vectorizeProba(logit.theta || logit.weights, XL_raw);
  const pL_test  = vectorizeProba(logit.theta || logit.weights, Xtest_raw);

  const cart = new CART({ maxDepth: 4, minNumSamples: 30, gainFunction: "gini" });
  cart.train(XL_raw, yL_raw);
  const getProb1 = (pred) => Array.isArray(pred) ? pred[1] : Number(pred);
  const pT_train = cart.predict(XL_raw).map(getProb1);
  const pT_test  = cart.predict(Xtest_raw).map(getProb1);

  const wHybrid = chooseHybridWeight(yL_raw, pL_train, pT_train);
  const pH_test = pL_test.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_test[i]);

  const leagueMeans = {}; for (const k of FEATS) leagueMeans[k] = mean(train.map(r=> Number(r[k])));
  function mean(a){ return a.reduce((s,v)=>s+v,0)/a.length; }

  const results = test.map((r,i)=>{
    const game_id = `${r.season}-W${String(r.week).padStart(2,"0")}-${r.team}-${r.opponent}`;
    const probs = { logit: pL_test[i], tree: pT_test[i], hybrid: pH_test[i] };
    const english = explain(r, leagueMeans, probs);
    return {
      game_id,
      home_team: r.home ? r.team : r.opponent,
      away_team: r.home ? r.opponent : r.team,
      season: r.season,
      week: r.week,
      models: {
        logistic: { prob_win: round3(probs.logit) },
        decision_tree: { prob_win: round3(probs.tree) },
        hybrid: { prob_win: round3(probs.hybrid), weights: { logistic: wHybrid, tree: Number((1-wHybrid).toFixed(2)) } }
      },
      natural_language: english
    };
  });

  const predPath = `${ART_DIR}/predictions_${TARGET_SEASON}_W${String(TARGET_WEEK).padStart(2,"0")}.json`;
  const modelPath = `${ART_DIR}/model_${TARGET_SEASON}_W${String(TARGET_WEEK).padStart(2,"0")}.json`;
  writeFileSync(predPath, JSON.stringify(results, null, 2));
  writeFileSync(modelPath, JSON.stringify({
    season: TARGET_SEASON,
    week: TARGET_WEEK,
    features: FEATS,
    logistic: (logit.theta && toArray1D(logit.theta)) || (logit.weights && toArray1D(logit.weights)) || null,
    hybrid_weight: wHybrid
  }, null, 2));

  console.log(`WROTE: ${predPath}`);
  console.log(`WROTE: ${modelPath}`);
})().catch(e=>{ console.error(e); process.exit(1); });

function explain(r, means, probs){
  const lines = [];
  addDelta(lines, r, means, "def_turnovers_s2d", false, "Defensive takeaways");
  addDelta(lines, r, means, "off_turnovers_s2d", true,  "Offensive giveaways");
  addDelta(lines, r, means, "off_total_yds_s2d", false, "Offensive total yards");
  addDelta(lines, r, means, "def_total_yds_s2d", true,  "Yards allowed");
  addRate(lines, r, means, "off_third_down_pct_s2d", true, "3rd-down conversion", 0.03);
  addRate(lines, r, means, "off_red_zone_td_pct_s2d", true, "Red-zone TD rate", 0.03);
  addRate(lines, r, means, "off_sack_rate_s2d", false, "Sack rate", 0.015);
  addNeutralPass(lines, r, means, "off_neutral_pass_rate_s2d", 0.05);
  if (r.home) lines.push("Home-field advantage applies.");
  if (Number(r.sim_count_same_loc_s2d) > 0) {
    const wr = Number(r.sim_winrate_same_loc_s2d) * 100;
    const pd = Number(r.sim_pointdiff_same_loc_s2d);
    const cnt = Number(r.sim_count_same_loc_s2d);
    lines.push(`History vs similar opponents (same venue): win rate ${wr.toFixed(0)}% over ${cnt} games, avg point diff ${pd.toFixed(1)}.`);
  }
  addDelta(lines, r, means, "off_total_yds_s2d_minus_opp", false, "Offense vs opp (S2D differential)");
  addDelta(lines, r, means, "def_total_yds_s2d_minus_opp", true,  "Defense vs opp (S2D differential)");
  addDelta(lines, r, means, "off_turnovers_s2d_minus_opp", true,  "Giveaways vs opp (S2D differential)");
  addDelta(lines, r, means, "def_turnovers_s2d_minus_opp", false, "Takeaways vs opp (S2D differential)");
  const eloDiff = Number(r.elo_diff);
  if (Number.isFinite(eloDiff) && Math.abs(eloDiff) >= 25) lines.push(`Elo edge: ${eloDiff >= 0 ? "favorable" : "unfavorable"} by ${Math.abs(eloDiff).toFixed(0)} pts.`);
  const restDiff = Number(r.rest_diff);
  if (Number.isFinite(restDiff) && Math.abs(restDiff) >= 2) lines.push(`Rest edge: ${restDiff >= 0 ? "+" : ""}${restDiff} day(s) vs opponent.`);
  return `Logistic: ${(probs.logit*100).toFixed(1)}%. Tree: ${(probs.tree*100).toFixed(1)}%. Hybrid: ${(probs.hybrid*100).toFixed(1)}%. ` + lines.join(" ");
}
function addDelta(lines, r, means, key, betterLow, label){
  const v = Number(r[key]), m = Number(means[key]);
  if (!Number.isFinite(v) || !Number.isFinite(m)) return;
  const d = v - m;
  const dir = d>=0 ? "higher" : "lower";
  const good = betterLow ? d<0 : d>0;
  lines.push(`${label} is ${dir} than league average by ${Math.abs(d).toFixed(1)} (${good ? "good" : "needs attention"}).`);
}

function addRate(lines, r, means, key, higherIsGood, label, threshold){
  const v = Number(r[key]);
  const m = Number(means[key]);
  if (!Number.isFinite(v) || !Number.isFinite(m)) return;
  const diff = v - m;
  if (Math.abs(diff) < threshold) return;
  const direction = diff > 0 ? "higher" : "lower";
  const sentiment = diff > 0 === higherIsGood ? "good" : "needs attention";
  lines.push(`${label} is ${direction} than league average by ${(Math.abs(diff) * 100).toFixed(1)}% (${sentiment}).`);
}

function addNeutralPass(lines, r, means, key, threshold){
  const v = Number(r[key]);
  const m = Number(means[key]);
  if (!Number.isFinite(v) || !Number.isFinite(m)) return;
  const diff = v - m;
  if (Math.abs(diff) < threshold) return;
  const orientation = diff > 0 ? "pass-heavy" : "run-leaning";
  const direction = diff > 0 ? "above" : "below";
  lines.push(`Neutral pass rate is ${(Math.abs(diff) * 100).toFixed(1)}% ${direction} league average (${orientation}).`);
}
