// trainer/train.js
// Train Logistic + Decision Tree + Hybrid with advanced features.
// Gracefully no-op if there's not enough data (e.g., Week 1).

import { loadSchedules, loadTeamWeekly } from "./dataSources.js";
import { buildFeatures } from "./featureBuild.js";
import { writeFileSync, mkdirSync } from "fs";
import LogisticRegression from "ml-logistic-regression";
import { DecisionTreeClassifier as CART } from "ml-cart";
import { Matrix } from "ml-matrix";

const ART_DIR = "artifacts";
mkdirSync(ART_DIR, { recursive: true });

const TARGET_SEASON = Number(process.env.SEASON || new Date().getFullYear());
const TARGET_WEEK = Number(process.env.WEEK || 6);

// Feature list (same as previous enhanced version)
const FEATS = [
  "off_1st_down_s2d","off_total_yds_s2d","off_rush_yds_s2d","off_pass_yds_s2d","off_turnovers_s2d",
  "def_1st_down_s2d","def_total_yds_s2d","def_rush_yds_s2d","def_pass_yds_s2d","def_turnovers_s2d",
  "wins_s2d","losses_s2d","home",
  "sim_winrate_same_loc_s2d","sim_pointdiff_same_loc_s2d","sim_count_same_loc_s2d",
  "off_total_yds_s2d_minus_opp","def_total_yds_s2d_minus_opp",
  "off_turnovers_s2d_minus_opp","def_turnovers_s2d_minus_opp",
  "elo_pre","elo_diff","rest_days","rest_diff"
];

function Xy(rows) {
  const X = rows.map(r => FEATS.map(k => Number(r[k] ?? 0)));
  const y = rows.map(r => Number(r.win));
  return { X, y };
}
function splitTrainTest(all, season, week) {
  const train = all.filter(r => r.season === season && r.week < week);
  const test  = all.filter(r => r.season === season && r.week === week);
  return { train, test };
}

// logistic helpers
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
function round3(x){ return Math.round(Number(x)*1000)/1000; }

(async function main(){
  console.log(`Training season ${TARGET_SEASON}, week ${TARGET_WEEK}`);

  const schedules = await loadSchedules();
  const teamWeekly = await loadTeamWeekly(TARGET_SEASON);
  const featRows = buildFeatures({ teamWeekly, schedules, season: TARGET_SEASON });

  const { train, test } = splitTrainTest(featRows, TARGET_SEASON, TARGET_WEEK);

  if (!train.length || !test.length) {
    console.log("No train/test rows (likely Week 1 or offseason). Skipping training gracefully.");
    process.exit(0); // succeed without artifacts
  }

  const pos = train.filter(r => r.win === 1).length;
  const neg = train.length - pos;
  console.log(`Train size: ${train.length} (wins=${pos}, losses=${neg})`);

  // Logistic
  const { X: XL_raw, y: yL_raw } = Xy(train);
  const XL = new Matrix(XL_raw);
  const yL = Matrix.columnVector(yL_raw);
  const logit = new LogisticRegression({ numSteps: 2500, learningRate: 5e-3 });
  logit.train(XL, yL);

  const { X: Xtest_raw } = Xy(test);
  const pL_train = vectorizeProba(logit.theta || logit.weights, XL_raw);
  const pL_test  = vectorizeProba(logit.theta || logit.weights, Xtest_raw);

  // Decision Tree
  const cart = new CART({ maxDepth: 4, minNumSamples: 30, gainFunction: "gini" });
  cart.train(XL_raw, yL_raw);
  const getProb1 = (pred) => Array.isArray(pred) ? pred[1] : Number(pred);
  const pT_train = cart.predict(XL_raw).map(getProb1);
  const pT_test  = cart.predict(Xtest_raw).map(getProb1);

  // Hybrid
  const wHybrid = chooseHybridWeight(yL_raw, pL_train, pT_train);
  const pH_test = pL_test.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_test[i]);

  // Means for explanations
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

  writeFileSync(`${ART_DIR}/predictions_${TARGET_SEASON}_W${String(TARGET_WEEK).padStart(2,"0")}.json`, JSON.stringify(results, null, 2));
  writeFileSync(`${ART_DIR}/model_${TARGET_SEASON}_W${String(TARGET_WEEK).padStart(2,"0")}.json`, JSON.stringify({
    season: TARGET_SEASON,
    week: TARGET_WEEK,
    features: FEATS,
    logistic: (logit.theta && toArray1D(logit.theta)) || (logit.weights && toArray1D(logit.weights)) || null,
    hybrid_weight: wHybrid
  }, null, 2));

  console.log("Artifacts written in /artifacts");
})().catch(e=>{ console.error(e); process.exit(1); });

function explain(r, means, probs){
  const lines = [];

  addDelta(lines, r, means, "def_turnovers_s2d", false, "Defensive takeaways");
  addDelta(lines, r, means, "off_turnovers_s2d", true,  "Offensive giveaways");
  addDelta(lines, r, means, "off_total_yds_s2d", false, "Offensive total yards");
  addDelta(lines, r, means, "def_total_yds_s2d", true,  "Yards allowed");
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
  if (Number.isFinite(eloDiff) && Math.abs(eloDiff) >= 25) {
    lines.push(`Elo edge: ${eloDiff >= 0 ? "favorable" : "unfavorable"} by ${Math.abs(eloDiff).toFixed(0)} pts.`);
  }
  const restDiff = Number(r.rest_diff);
  if (Number.isFinite(restDiff) && Math.abs(restDiff) >= 2) {
    lines.push(`Rest edge: ${restDiff >= 0 ? "+" : ""}${restDiff} day(s) vs opponent.`);
  }

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
