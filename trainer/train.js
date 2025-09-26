// trainer/train.js
// Train Logistic + Decision Tree + Hybrid; emit per-game JSON + English.

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

const FEATS = [
  "off_1st_down_s2d","off_total_yds_s2d","off_rush_yds_s2d","off_pass_yds_s2d","off_turnovers_s2d",
  "def_1st_down_s2d","def_total_yds_s2d","def_rush_yds_s2d","def_pass_yds_s2d","def_turnovers_s2d",
  "wins_s2d","losses_s2d","home"
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
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function dot(a, b) { let s=0; for (let i=0;i<a.length;i++) s += (a[i]||0)*(b[i]||0); return s; }
function toArrayMaybe(v) {
  // Normalize Matrix/Array-like to plain array
  if (!v) return [];
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v.to1DArray === "function") return v.to1DArray().map(Number);
  if (typeof v.toJSON === "function") return v.toJSON().map(Number);
  return Array.from(v).map(Number);
}
function probsFromWeights(weights, X) {
  // weights can be Matrix or array
  const w = Array.isArray(weights) ? weights : (typeof weights.to1DArray === "function" ? weights.to1DArray() : toArrayMaybe(weights));
  return X.map(x => sigmoid(dot(w, x)));
}
function logLoss(y, p){ let s=0,eps=1e-12; for(let i=0;i<y.length;i++){s+=-(y[i]*Math.log(p[i]+eps)+(1-y[i])*Math.log(1-p[i]+eps));} return s/y.length; }
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
  if (!train.length || !test.length) throw new Error("No train or test rows—adjust SEASON/WEEK.");

  // Data matrices for logistic regression (ml-logistic-regression v2 expects Matrix inputs)
  const { X: XL_raw, y: yL_raw } = Xy(train);
  const XL = new Matrix(XL_raw);
  const yL = Matrix.columnVector(yL_raw);

  // --- Logistic ---
  const logit = new LogisticRegression({ numSteps: 2500, learningRate: 5e-3 });
  logit.train(XL, yL);

  // Get logistic probabilities robustly (prefer model.predict if available)
  const { X: Xtest_raw, y: ytest } = Xy(test);
  const XtestM = new Matrix(Xtest_raw);

  let pL_test;
  if (typeof logit.predict === "function") {
    pL_test = toArrayMaybe(logit.predict(XtestM));
  } else if (logit.theta || logit.weights) {
    pL_test = probsFromWeights(logit.theta || logit.weights, Xtest_raw);
  } else {
    throw new Error("Cannot get logistic probabilities: no predict() or weights found.");
  }

  // Also get logistic probabilities on train (for hybrid weight search)
  let pL_train;
  if (typeof logit.predict === "function") {
    pL_train = toArrayMaybe(logit.predict(XL));
  } else if (logit.theta || logit.weights) {
    pL_train = probsFromWeights(logit.theta || logit.weights, XL_raw);
  } else {
    throw new Error("Cannot get logistic train probabilities: no predict() or weights found.");
  }

  // --- Decision Tree (CART) ---
  const cart = new CART({ maxDepth: 4, minNumSamples: 30, gainFunction: "gini" });
  const { X: XT_raw, y: yT } = Xy(train);
  cart.train(XT_raw, yT);

  const getProb1 = (pred) => Array.isArray(pred) ? pred[1] : Number(pred);
  const pT_test = cart.predict(Xtest_raw).map(getProb1);
  const pT_train = cart.predict(XT_raw).map(getProb1);

  // --- Hybrid weight chosen on train
  const wHybrid = chooseHybridWeight(yL_raw, pL_train, pT_train);
  const pH_test = pL_test.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_test[i]);

  // League means for explanations
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

  // Write artifacts
  writeFileSync(`${ART_DIR}/predictions_${TARGET_SEASON}_W${String(TARGET_WEEK).padStart(2,"0")}.json`, JSON.stringify(results, null, 2));
  writeFileSync(`${ART_DIR}/model_${TARGET_SEASON}_W${String(TARGET_WEEK).padStart(2,"0")}.json`, JSON.stringify({
    season: TARGET_SEASON, week: TARGET_WEEK, features: FEATS,
    logistic: (logit.theta && toArrayMaybe(logit.theta)) || (logit.weights && toArrayMaybe(logit.weights)) || null,
    hybrid_weight: wHybrid
  }, null, 2));

  console.log("Artifacts written in /artifacts");
})().catch(e=>{ console.error(e); process.exit(1); });

function explain(r, means, probs){
  const lines = [];
  const delta = (k, betterLow=false, name=k)=>{
    const v = Number(r[k]), m = Number(means[k]); const d = v - m;
    const dir = d>=0 ? "higher" : "lower"; const good = betterLow ? d<0 : d>0;
    lines.push(`${name} is ${dir} than league average by ${Math.abs(d).toFixed(1)} (${good ? "good" : "needs attention"}).`);
  };
  delta("def_turnovers_s2d", false, "Defensive takeaways");
  delta("off_turnovers_s2d", true,  "Offensive giveaways");
  delta("off_total_yds_s2d", false, "Offensive total yards");
  delta("def_total_yds_s2d", true,  "Yards allowed");
  if (r.home) lines.push("Home-field advantage applies.");
  return `Logistic: ${(probs.logit*100).toFixed(1)}%. Tree: ${(probs.tree*100).toFixed(1)}%. Hybrid: ${(probs.hybrid*100).toFixed(1)}%. ` + lines.join(" ");
}
