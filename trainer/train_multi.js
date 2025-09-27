// trainer/train_multi.js
//
// Fixes:
//  • Logistic regression: implement our own GD trainer with intercept (no more null weights).
//  • Decision tree probabilities: derive from leaf class frequencies using the training set.
//  • Partial-week handling stays: backtest existing rows and forecast missing fixtures.
//
// Outputs per week W:
//   artifacts/predictions_<season>_WXX.json
//   artifacts/model_<season>_WXX.json
// Also writes season_index_<season>.json, season_summary_<season>_to_WXX.json, and *_current.json.

import { loadSchedules, loadTeamWeekly } from "./dataSources.js";
import { buildFeatures } from "./featureBuild.js";
import { writeFileSync, mkdirSync } from "fs";
import { DecisionTreeClassifier as CART } from "ml-cart";

const ART_DIR = "artifacts";
mkdirSync(ART_DIR, { recursive: true });

const SEASON = Number(process.env.SEASON || new Date().getFullYear());
const WEEK_ENV = Number(process.env.WEEK || 6); // upper bound suggestion

// Keep this in sync with featureBuild.js
const FEATS = [
  "off_1st_down_s2d","off_total_yds_s2d","off_rush_yds_s2d","off_pass_yds_s2d","off_turnovers_s2d",
  "def_1st_down_s2d","def_total_yds_s2d","def_rush_yds_s2d","def_pass_yds_s2d","def_turnovers_s2d",
  "wins_s2d","losses_s2d","home",
  "sim_winrate_same_loc_s2d","sim_pointdiff_same_loc_s2d","sim_count_same_loc_s2d",
  "off_total_yds_s2d_minus_opp","def_total_yds_s2d_minus_opp",
  "off_turnovers_s2d_minus_opp","def_turnovers_s2d_minus_opp",
  "elo_pre","elo_diff","rest_days","rest_diff"
];

function Xy(rows){
  const X = rows.map(r => FEATS.map(k => Number(r[k] ?? 0)));
  const y = rows.map(r => Number(r.win));
  return { X, y };
}

function isReg(v){ if (v == null) return true; const s=String(v).trim().toUpperCase(); return s==="" || s.startsWith("REG"); }
function splitTrainTest(all, season, week){
  const train = all.filter(r => r.season===season && r.week <  week);
  const test  = all.filter(r => r.season===season && r.week === week);
  return { train, test };
}

const sigmoid = (z)=> 1/(1+Math.exp(-z));
const round3  = (x)=> Math.round(Number(x)*1000)/1000;
const mean    = (a)=> a.reduce((s,v)=>s+v,0)/a.length;

// ---------------------------
// LOGISTIC REGRESSION (GD)
// ---------------------------
function trainLogisticGD(X, y, { steps=3000, lr=5e-3, l2=1e-4 } = {}){
  const n = X.length;
  const d = X[0]?.length || 0;
  let w = new Array(d).fill(0);
  let b = 0;

  for (let t=0; t<steps; t++){
    let gb = 0;
    const gw = new Array(d).fill(0);
    for (let i=0;i<n;i++){
      const z = dot(w, X[i]) + b;
      const p = sigmoid(z);
      const err = p - y[i];  // derivative of log loss wrt z
      gb += err;
      for (let j=0;j<d;j++) gw[j] += err * X[i][j];
    }
    // L2
    for (let j=0;j<d;j++) gw[j] += l2 * w[j];

    // Update
    b -= lr * (gb / n);
    for (let j=0;j<d;j++) w[j] -= lr * (gw[j] / n);
  }
  return { w, b };
}
function predictLogisticProba(X, params){
  const { w, b } = params;
  return X.map(x => sigmoid(dot(w, x) + b));
}

// ---------------------------
// CART PROBABILITIES VIA LEAVES
// ---------------------------

/** Walk JSON node with robust field names and return leaf path like "L-R-L". */
function leafPathForSample(root, x){
  let node = root;
  let path = "";
  // Defensive limit
  for (let guard=0; guard<200; guard++){
    // Leaf?
    const isLeaf = (!node.left && !node.right) || node.type === "leaf";
    if (isLeaf) return path || "ROOT";

    const col = node.splitColumn ?? node.attribute ?? node.index ?? node.feature ?? null;
    const thr = node.splitValue  ?? node.threshold ?? node.split  ?? null;

    if (col == null || thr == null) {
      // If structure is odd, stop here
      return path || "ROOT";
    }
    const val = Number(x[col] ?? 0);
    const goLeft = val <= Number(thr);
    path += goLeft ? "L" : "R";
    node = goLeft ? node.left : node.right;
    if (!node) return path;
  }
  return path || "ROOT";
}

/** Build leaf frequency table by pushing TRAIN samples through the trained tree. */
function buildLeafFrequencies(cart, Xtrain, ytrain){
  let json;
  try { json = cart.toJSON(); } catch { json = null; }
  const root = json?.root || json;
  const freq = new Map(); // path -> { n0, n1 }
  if (!root) {
    // fall back: one bucket with global class freq
    let n1 = ytrain.reduce((s,v)=>s+(v?1:0),0);
    freq.set("ROOT", { n0: ytrain.length - n1, n1 });
    return { root: null, freq };
  }
  for (let i=0;i<Xtrain.length;i++){
    const p = leafPathForSample(root, Xtrain[i]);
    const cur = freq.get(p) || { n0:0, n1:0 };
    if (ytrain[i] === 1) cur.n1++; else cur.n0++;
    freq.set(p, cur);
  }
  return { root, freq };
}

function predictTreeProba(cart, leafStats, X){
  const { root, freq } = leafStats;
  if (!root) {
    // only ROOT bucket exists
    const f = freq.get("ROOT") || { n0:0, n1:0 };
    const tot = f.n0 + f.n1;
    const p1 = tot>0 ? f.n1/tot : 0.5;
    return X.map(()=> p1);
  }
  return X.map(x=>{
    const p = leafPathForSample(root, x);
    const f = freq.get(p);
    if (!f) return 0.5;
    const tot = f.n0 + f.n1;
    return tot>0 ? f.n1/tot : 0.5;
  });
}

// ---------------------------

function safeLog(x, eps=1e-12){ return Math.log(Math.max(x, eps)); }
function logLoss(y, p){
  let s=0,eps=1e-12;
  for(let i=0;i<y.length;i++) s += -(y[i]*safeLog(p[i],eps) + (1-y[i])*safeLog(1-p[i],eps));
  return s/y.length;
}
function chooseHybridWeight(y, pL, pT){
  let bestW=0.5, bestLL=Infinity;
  for (let w=0; w<=1.0001; w+=0.05){
    const ph = pL.map((p,i)=> w*p + (1-w)*pT[i]);
    const ll = logLoss(y, ph);
    if (ll < bestLL) { bestLL = ll; bestW = Number(w.toFixed(2)); }
  }
  return bestW;
}

function computeLastCompletedWeek(schedules, season){
  const reg = schedules.filter(g => Number(g.season)===season && isReg(g.season_type));
  const weeks = [...new Set(reg.map(g => Number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  let lastFull = 0;
  for (const w of weeks) {
    const games = reg.filter(g => Number(g.week)===w);
    const allDone = games.every(g => {
      const hs = Number(g.home_score ?? g.home_points ?? g.home_pts);
      const as = Number(g.away_score ?? g.away_points ?? g.away_pts);
      return Number.isFinite(hs) && Number.isFinite(as);
    });
    if (allDone) lastFull = w; else break;
  }
  return lastFull;
}

function keyPair(home, away){ return `${home}@${away}`; }

function buildMissingFixtureRows(featRows, schedules, season, W){
  const latestByTeam = new Map();
  for (const r of featRows) {
    if (r.season!==season || r.week>=W) continue;
    const prev = latestByTeam.get(r.team);
    if (!prev || prev.week < r.week) latestByTeam.set(r.team, r);
  }
  const gamesW = schedules.filter(g => Number(g.season)===season && isReg(g.season_type) && Number(g.week)===W);
  const rows = [];
  for (const g of gamesW) {
    const home = g.home_team, away = g.away_team;
    const tHome = latestByTeam.get(home);
    const tAway = latestByTeam.get(away);
    if (!tHome || !tAway) continue;

    const diff = (a,b)=> (Number(a??0) - Number(b??0)) || 0;
    const base = (me, op, isHome)=>{
      return {
        season, week: W, team: isHome ? home : away, opponent: isHome ? away : home, home: isHome ? 1 : 0,
        off_1st_down_s2d: me.off_1st_down_s2d, off_total_yds_s2d: me.off_total_yds_s2d,
        off_rush_yds_s2d: me.off_rush_yds_s2d, off_pass_yds_s2d: me.off_pass_yds_s2d,
        off_turnovers_s2d: me.off_turnovers_s2d, def_1st_down_s2d: me.def_1st_down_s2d,
        def_total_yds_s2d: me.def_total_yds_s2d, def_rush_yds_s2d: me.def_rush_yds_s2d,
        def_pass_yds_s2d: me.def_pass_yds_s2d, def_turnovers_s2d: me.def_turnovers_s2d,
        wins_s2d: me.wins_s2d, losses_s2d: me.losses_s2d,
        sim_winrate_same_loc_s2d: me.sim_winrate_same_loc_s2d ?? 0,
        sim_pointdiff_same_loc_s2d: me.sim_pointdiff_same_loc_s2d ?? 0,
        sim_count_same_loc_s2d: me.sim_count_same_loc_s2d ?? 0,
        off_total_yds_s2d_minus_opp: diff(me.off_total_yds_s2d, op.off_total_yds_s2d),
        def_total_yds_s2d_minus_opp: diff(me.def_total_yds_s2d, op.def_total_yds_s2d),
        off_turnovers_s2d_minus_opp:  diff(me.off_turnovers_s2d,  op.off_turnovers_s2d),
        def_turnovers_s2d_minus_opp:  diff(me.def_turnovers_s2d,  op.def_turnovers_s2d),
        rest_days: 0, rest_diff: 0,
        elo_pre: me.elo_pre ?? 1500,
        elo_diff: (me.elo_pre ?? 1500) - (op.elo_pre ?? 1500),
        game_date: null,
        win: 0
      };
    };
    rows.push(base(tHome, tAway, true), base(tAway, tHome, false));
  }
  return rows;
}

function dot(a,b){ let s=0; for (let i=0;i<a.length;i++) s += (a[i]||0)*(b[i]||0); return s; }

// --------------------------- MAIN ---------------------------

(async function main(){
  console.log(`Rolling train for SEASON=${SEASON} (env WEEK=${WEEK_ENV})`);
  const schedules = await loadSchedules();
  const regSched = schedules.filter(g => Number(g.season)===SEASON && isReg(g.season_type));
  const schedWeeks = [...new Set(regSched.map(g => Number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  const schedMaxWeek = schedWeeks.length ? schedWeeks[schedWeeks.length-1] : 18;

  const teamWeekly = await loadTeamWeekly(SEASON);
  const prevTeamWeekly = await (async()=>{ try { return await loadTeamWeekly(SEASON-1); } catch { return []; } })();

  const featRows = buildFeatures({ teamWeekly, schedules, season: SEASON, prevTeamWeekly });

  const featWeeks = [...new Set(featRows.filter(r=>r.season===SEASON).map(r=>r.week))].sort((a,b)=>a-b);
  const featMaxWeek = featWeeks.length ? featWeeks[featWeeks.length-1] : 1;

  const MAX_WEEK = Math.min(
    Math.max(2, WEEK_ENV, featMaxWeek, computeLastCompletedWeek(schedules, SEASON)+1),
    schedMaxWeek
  );
  console.log(`schedWeeks=[${schedWeeks.join(",")}], featWeeks=[${featWeeks.join(",")}], MAX_WEEK=${MAX_WEEK}`);

  const seasonSummary = { season: SEASON, built_through_week: null, weeks: [], feature_names: FEATS };
  const seasonIndex = { season: SEASON, weeks: [] };
  let latestWeekWritten = null;

  function fitModels(train){
    const { X: Xtr, y: ytr } = Xy(train);

    // logistic via our GD
    const logit = trainLogisticGD(Xtr, ytr, { steps: 3000, lr: 5e-3, l2: 1e-4 });
    const pL_train = predictLogisticProba(Xtr, logit);

    // CART
    const cart = new CART({ maxDepth: 4, minNumSamples: 20, gainFunction: "gini" });
    cart.train(Xtr, ytr);
    const leafStats = buildLeafFrequencies(cart, Xtr, ytr);
    const pT_train = predictTreeProba(cart, leafStats, Xtr);

    // blend weight
    const wHybrid = chooseHybridWeight(ytr, pL_train, pT_train);
    return { logit, cart, leafStats, wHybrid };
  }

  const leagueMeansByWeek = new Map(); // week -> means object for NL text

  function leagueMeans(rows){
    const m = {};
    for (const k of FEATS){
      const vals = rows.map(r => Number(r[k]));
      m[k] = mean(vals);
    }
    return m;
  }

  function explain(r, means, probs){
    const lines = [];
    const addDelta = (key, betterLow, label)=>{
      const v = Number(r[key]), m = Number(means[key]);
      if (!Number.isFinite(v) || !Number.isFinite(m)) return;
      const d = v - m;
      const dir = d>=0 ? "higher" : "lower";
      const good = betterLow ? d<0 : d>0;
      lines.push(`${label} is ${dir} than league average by ${Math.abs(d).toFixed(1)} (${good ? "good" : "needs attention"}).`);
    };
    addDelta("def_turnovers_s2d", false, "Defensive takeaways");
    addDelta("off_turnovers_s2d", true,  "Offensive giveaways");
    addDelta("off_total_yds_s2d", false, "Offensive total yards");
    addDelta("def_total_yds_s2d", true,  "Yards allowed");
    if (r.home) lines.push("Home-field advantage applies.");
    if (Number(r.sim_count_same_loc_s2d) > 0) {
      const wr = Number(r.sim_winrate_same_loc_s2d) * 100;
      const pd = Number(r.sim_pointdiff_same_loc_s2d);
      const cnt = Number(r.sim_count_same_loc_s2d);
      lines.push(`History vs similar opponents (same venue): win rate ${wr.toFixed(0)}% over ${cnt} games, avg point diff ${pd.toFixed(1)}.`);
    }
    addDelta("off_total_yds_s2d_minus_opp", false, "Offense vs opp (S2D differential)");
    addDelta("def_total_yds_s2d_minus_opp", true,  "Defense vs opp (S2D differential)");
    addDelta("off_turnovers_s2d_minus_opp", true,  "Giveaways vs opp (S2D differential)");
    addDelta("def_turnovers_s2d_minus_opp", false, "Takeaways vs opp (S2D differential)");

    const eloDiff = Number(r.elo_diff);
    if (Number.isFinite(eloDiff) && Math.abs(eloDiff) >= 25) lines.push(`Elo edge: ${eloDiff >= 0 ? "favorable" : "unfavorable"} by ${Math.abs(eloDiff).toFixed(0)} pts.`);
    const restDiff = Number(r.rest_diff);
    if (Number.isFinite(restDiff) && Math.abs(restDiff) >= 2) lines.push(`Rest edge: ${restDiff >= 0 ? "+" : ""}${restDiff} day(s) vs opponent.`);

    return `Logistic: ${(probs.logit*100).toFixed(1)}%. Tree: ${(probs.tree*100).toFixed(1)}%. Hybrid: ${(probs.hybrid*100).toFixed(1)}%. ` + lines.join(" ");
  }

  for (let W=2; W<=MAX_WEEK; W++){
    const { train, test } = splitTrainTest(featRows, SEASON, W);
    if (!train.length) { console.log(`W${W}: no training rows, skipping.`); continue; }

    // Fit
    const { logit, cart, leafStats, wHybrid } = fitModels(train);

    // Means cache for NL explanations
    leagueMeansByWeek.set(W, leagueMeans(train));

    // Backtest probs
    const { X: Xtest } = Xy(test);
    const pL_back = predictLogisticProba(Xtest, logit);
    const pT_back = predictTreeProba(cart, leafStats, Xtest);
    const pH_back = pL_back.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_back[i]);

    // Forecast missing fixtures in same week
    const regPairs = new Set(regSched.filter(g=>Number(g.week)===W).map(g => keyPair(g.home_team, g.away_team)));
    const presentPairs = new Set();
    for (let i=0;i<test.length;i+=2){
      const r = test[i];
      if (!r) break;
      const home = r.home ? r.team : r.opponent;
      const away = r.home ? r.opponent : r.team;
      presentPairs.add(keyPair(home, away));
    }
    const missingPairs = [...regPairs].filter(k => !presentPairs.has(k));

    let forecastRows = [];
    if (missingPairs.length){
      const allF = buildMissingFixtureRows(featRows, schedules, SEASON, W);
      const isPair = (r)=>{
        const home = r.home ? r.team : r.opponent;
        const away = r.home ? r.opponent : r.team;
        return missingPairs.includes(keyPair(home, away));
      };
      forecastRows = allF.filter(isPair);
    }

    const { X: Xf } = Xy(forecastRows);
    const pL_fore = predictLogisticProba(Xf, logit);
    const pT_fore = predictTreeProba(cart, leafStats, Xf);
    const pH_fore = pL_fore.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_fore[i]);

    // Build outputs
    const means = leagueMeansByWeek.get(W);
    const toResult = (r, probs, forecastFlag) => {
      const game_id = `${r.season}-W${String(r.week).padStart(2,"0")}-${r.team}-${r.opponent}`;
      const english = explain(r, means, probs);
      return {
        game_id,
        home_team: r.home ? r.team : r.opponent,
        away_team: r.home ? r.opponent : r.team,
        season: r.season,
        week: r.week,
        forecast: forecastFlag,
        models: {
          logistic:      { prob_win: round3(probs.logit) },
          decision_tree: { prob_win: round3(probs.tree) },
          hybrid:        { prob_win: round3(probs.hybrid), weights: { logistic: wHybrid, tree: Number((1-wHybrid).toFixed(2)) } }
        },
        natural_language: english
      };
    };

    const backResults = test.map((r,i)=> toResult(r, { logit: pL_back[i], tree: pT_back[i], hybrid: pH_back[i] }, false));
    const foreResults = forecastRows.map((r,i)=> toResult(r, { logit: pL_fore[i], tree: pT_fore[i], hybrid: pH_fore[i] }, true));

    const results = [...backResults, ...foreResults];
    if (!results.length){
      console.log(`W${W}: nothing to write.`);
      continue;
    }

    // Write artifacts
    const predPath  = `${ART_DIR}/predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    const modelPath = `${ART_DIR}/model_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    writeFileSync(predPath, JSON.stringify(results, null, 2));
    writeFileSync(modelPath, JSON.stringify({
      season: SEASON,
      week: W,
      features: FEATS,
      hybrid_weight: wHybrid,
      logistic: { weights: logit.w, intercept: logit.b }
    }, null, 2));

    console.log(`WROTE: ${predPath}`);
    console.log(`WROTE: ${modelPath}`);

    // Summary + index
    seasonSummary.weeks.push({
      week: W,
      train_rows: train.length,
      test_rows: results.length,
      forecast: foreResults.length > 0,
      hybrid_weight: wHybrid
    });
    seasonSummary.built_through_week = W;
    seasonIndex.weeks.push({
      week: W,
      predictions_file: `predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`,
      model_file:       `model_${SEASON}_W${String(W).padStart(2,"0")}.json`
    });
    latestWeekWritten = W;
  }

  // Season summary & index
  const summaryPath = `${ART_DIR}/season_summary_${SEASON}_to_W${String(seasonSummary.built_through_week || 0).padStart(2,"0")}.json`;
  writeFileSync(summaryPath, JSON.stringify(seasonSummary, null, 2));
  console.log(`WROTE: ${summaryPath}`);

  const indexPath = `${ART_DIR}/season_index_${SEASON}.json`;
  writeFileSync(indexPath, JSON.stringify(seasonIndex, null, 2));
  console.log(`WROTE: ${indexPath}`);

  // Current aliases
  if (latestWeekWritten != null) {
    const fs = await import("fs/promises");
    const predSrc  = `${ART_DIR}/predictions_${SEASON}_W${String(latestWeekWritten).padStart(2,"0")}.json`;
    const modelSrc = `${ART_DIR}/model_${SEASON}_W${String(latestWeekWritten).padStart(2,"0")}.json`;
    writeFileSync(`${ART_DIR}/predictions_current.json`, await fs.readFile(predSrc,  "utf8"));
    writeFileSync(`${ART_DIR}/model_current.json`,      await fs.readFile(modelSrc, "utf8"));
    console.log(`WROTE: artifacts/*_current.json aliases`);
  }
})().catch(e=>{ console.error(e); process.exit(1); });
