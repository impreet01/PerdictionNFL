// trainer/train_multi.js
// Uses leaf distributions from ml-cart JSON to produce tree probabilities.
// Also: logistic weights extraction fixed; partial-week forecasting retained.

import { loadSchedules, loadTeamWeekly } from "./dataSources.js";
import { buildFeatures } from "./featureBuild.js";
import { writeFileSync, mkdirSync } from "fs";
import LogisticRegression from "ml-logistic-regression";
import { DecisionTreeClassifier as CART } from "ml-cart";
import { Matrix } from "ml-matrix";

const ART_DIR = "artifacts";
mkdirSync(ART_DIR, { recursive: true });

const SEASON = Number(process.env.SEASON || new Date().getFullYear());
const WEEK_ENV = Number(process.env.WEEK || 6); // upper bound suggestion

// Keep in sync with featureBuild.js
const FEATS = [
  "off_1st_down_s2d","off_total_yds_s2d","off_rush_yds_s2d","off_pass_yds_s2d","off_turnovers_s2d",
  "def_1st_down_s2d","def_total_yds_s2d","def_rush_yds_s2d","def_pass_yds_s2d","def_turnovers_s2d",
  "wins_s2d","losses_s2d","home",
  "sim_winrate_same_loc_s2d","sim_pointdiff_same_loc_s2d","sim_count_same_loc_s2d",
  "off_total_yds_s2d_minus_opp","def_total_yds_s2d_minus_opp",
  "off_turnovers_s2d_minus_opp","def_turnovers_s2d_minus_opp",
  "elo_pre","elo_diff","rest_days","rest_diff"
];

function isReg(v){ if (v == null) return true; const s=String(v).trim().toUpperCase(); return s==="" || s.startsWith("REG"); }

function Xy(rows){
  const X = rows.map(r => FEATS.map(k => Number(r[k] ?? 0)));
  const y = rows.map(r => Number(r.win));
  return { X, y };
}

function splitTrainTest(all, season, week){
  const train = all.filter(r => r.season===season && r.week < week);
  const test  = all.filter(r => r.season===season && r.week === week);
  return { train, test };
}

// ---- probabilities helpers ----
const sigmoid = (z)=> 1/(1+Math.exp(-z));
const dot = (a,b)=> { let s=0; for (let i=0;i<a.length;i++) s += (a[i]||0)*(b[i]||0); return s; };

function getLogitWeights(model){
  try {
    if (typeof model.toJSON === "function") {
      const j = model.toJSON();
      if (j && Array.isArray(j.theta)) return j.theta.map(Number);
      if (j && Array.isArray(j.weights)) return j.weights.map(Number);
    }
  } catch {}
  const cand = model.theta || model.weights || null;
  if (cand) {
    if (Array.isArray(cand)) return cand.map(Number);
    if (typeof cand.to1DArray === "function") return cand.to1DArray().map(Number);
    if (typeof cand.toJSON === "function") return cand.toJSON().map(Number);
    try { return Array.from(cand).map(Number); } catch {}
  }
  return null;
}

function vectorizeProbaWithWeights(w, X){
  if (!Array.isArray(w) || !w.length) return X.map(()=> 0.5);
  return X.map(x => sigmoid(dot(w, x)));
}

// ---- derive tree probabilities from ml-cart JSON ----
function treeProbas(cart, X) {
  let json;
  try { json = cart.toJSON(); } catch { json = null; }
  if (!json) {
    // fallback: hard 0.5 (should not happen)
    return X.map(() => 0.5);
  }
  // ml-cart JSON can be { root: <node>, ... } or a node directly
  const root = json.root || json;

  function probaAtNode(node, x) {
    if (!node) return 0.5;

    // Leaf detection: distribution present or no children
    const dist = node.distribution || node.classHistogram || node.probabilities;
    if (!node.left && !node.right && dist) {
      const d0 = Number(dist[0] ?? 0);
      const d1 = Number(dist[1] ?? 0);
      const tot = d0 + d1;
      return tot > 0 ? d1 / tot : 0.5;
    }
    if (node.type === "leaf" && dist) {
      const d0 = Number(dist[0] ?? 0);
      const d1 = Number(dist[1] ?? 0);
      const tot = d0 + d1;
      return tot > 0 ? d1 / tot : 0.5;
    }

    // Decision node: find column & threshold keys robustly
    const col = node.splitColumn ?? node.attribute ?? node.index ?? node.feature ?? null;
    const thr = node.splitValue  ?? node.threshold ?? node.split ?? null;

    if (col == null || thr == null) {
      // Unexpected shape: try children anyway
      const leftP = node.left ? probaAtNode(node.left, x) : null;
      const rightP = node.right ? probaAtNode(node.right, x) : null;
      if (leftP != null && rightP == null) return leftP;
      if (rightP != null && leftP == null) return rightP;
      return 0.5;
    }

    const val = Number(x[col] ?? 0);
    const goLeft = val <= Number(thr);
    return probaAtNode(goLeft ? node.left : node.right, x);
  }

  return X.map(x => probaAtNode(root, x));
}

function safeLog(x, eps=1e-12){ return Math.log(Math.max(x, eps)); }
function logLoss(y, p){
  let s=0,eps=1e-12;
  for(let i=0;i<y.length;i++) s += -(y[i]*safeLog(p[i],eps) + (1-y[i])*safeLog(1-p[i],eps));
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

const round3 = x => Math.round(Number(x)*1000)/1000;
const mean = a => a.reduce((s,v)=>s+v,0)/a.length;

// ---- natural language explainer ----
function addDelta(lines, r, means, key, betterLow, label){
  const v = Number(r[key]), m = Number(means[key]);
  if (!Number.isFinite(v) || !Number.isFinite(m)) return;
  const d = v - m;
  const dir = d>=0 ? "higher" : "lower";
  const good = betterLow ? d<0 : d>0;
  lines.push(`${label} is ${dir} than league average by ${Math.abs(d).toFixed(1)} (${good ? "good" : "needs attention"}).`);
}
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
  if (Number.isFinite(eloDiff) && Math.abs(eloDiff) >= 25) lines.push(`Elo edge: ${eloDiff >= 0 ? "favorable" : "unfavorable"} by ${Math.abs(eloDiff).toFixed(0)} pts.`);
  const restDiff = Number(r.rest_diff);
  if (Number.isFinite(restDiff) && Math.abs(restDiff) >= 2) lines.push(`Rest edge: ${restDiff >= 0 ? "+" : ""}${restDiff} day(s) vs opponent.`);
  return `Logistic: ${(probs.logit*100).toFixed(1)}%. Tree: ${(probs.tree*100).toFixed(1)}%. Hybrid: ${(probs.hybrid*100).toFixed(1)}%. ` + lines.join(" ");
}

// ---- week plumbing ----
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

/** Build synthetic rows for scheduled games in week W that are missing from teamWeekly (forecast rest of week). */
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

(async function main(){
  console.log(`Rolling train for SEASON=${SEASON} (env WEEK=${WEEK_ENV})`);
  const schedules = await loadSchedules();
  const regSched = schedules.filter(g => Number(g.season)===SEASON && isReg(g.season_type));
  const schedWeeks = [...new Set(regSched.map(g => Number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  const schedMaxWeek = schedWeeks.length ? schedWeeks[schedWeeks.length-1] : 18;

  const teamWeekly = await loadTeamWeekly(SEASON);
  const prevTeamWeekly = await (async()=>{ try { return await loadTeamWeekly(SEASON-1); } catch { return []; } })();

  // Feature table (S2D, diffs, elo, similar-opp, etc.)
  const featRows = buildFeatures({ teamWeekly, schedules, season: SEASON, prevTeamWeekly });
  const featWeeks = [...new Set(featRows.filter(r=>r.season===SEASON).map(r=>r.week))].sort((a,b)=>a-b);
  const featMaxWeek = featWeeks.length ? featWeeks[featWeeks.length-1] : 1;

  const MAX_WEEK = Math.min( Math.max(2, WEEK_ENV, featMaxWeek, computeLastCompletedWeek(schedules, SEASON)+1), schedMaxWeek );
  console.log(`schedWeeks=[${schedWeeks.join(",")}], featWeeks=[${featWeeks.join(",")}], MAX_WEEK=${MAX_WEEK}`);

  const seasonSummary = { season: SEASON, built_through_week: null, weeks: [], feature_names: FEATS };
  const seasonIndex = { season: SEASON, weeks: [] };
  let latestWeekWritten = null;

  function fitModels(train){
    const { X: XL_raw, y: yL_raw } = Xy(train);
    const XL = new Matrix(XL_raw);
    const yL = Matrix.columnVector(yL_raw);

    const logit = new LogisticRegression({ numSteps: 2500, learningRate: 5e-3 });
    logit.train(XL, yL);
    const wLogit = getLogitWeights(logit);

    const cart = new CART({ maxDepth: 4, minNumSamples: 30, gainFunction: "gini" });
    cart.train(XL_raw, yL_raw);

    const pL_train = vectorizeProbaWithWeights(wLogit, XL_raw);
    const pT_train = treeProbas(cart, XL_raw);

    const wHybrid = chooseHybridWeight(yL_raw, pL_train, pT_train);
    return { wLogit, cart, wHybrid };
  }

  for (let W=2; W<=MAX_WEEK; W++){
    const { train, test } = splitTrainTest(featRows, SEASON, W);
    if (!train.length) { console.log(`W${W}: no training rows, skipping.`); continue; }

    const { wLogit, cart, wHybrid } = fitModels(train);

    // Backtest rows present in data
    const { X: Xtest_raw } = Xy(test);
    const back_pL = vectorizeProbaWithWeights(wLogit, Xtest_raw);
    const back_pT = treeProbas(cart, Xtest_raw);
    const back_pH = back_pL.map((p,i)=> wHybrid*p + (1-wHybrid)*back_pT[i]);

    // Forecast missing fixtures in the SAME week
    const schedPairs = new Set(regSched.filter(g=>Number(g.week)===W).map(g => keyPair(g.home_team, g.away_team)));
    const presentPairs = new Set();
    for (let i=0;i<test.length;i+=2){
      const r = test[i];
      if (!r) break;
      const home = r.home ? r.team : r.opponent;
      const away = r.home ? r.opponent : r.team;
      presentPairs.add(keyPair(home, away));
    }
    const missingPairs = [...schedPairs].filter(k => !presentPairs.has(k));

    let forecastRows = [];
    if (missingPairs.length){
      const allForecastForWeek = buildMissingFixtureRows(featRows, schedules, SEASON, W);
      const isPair = (r)=>{
        const home = r.home ? r.team : r.opponent;
        const away = r.home ? r.opponent : r.team;
        return missingPairs.includes(keyPair(home, away));
      };
      forecastRows = allForecastForWeek.filter(isPair);
    }

    const { X: Xf_raw } = Xy(forecastRows);
    const fore_pL = vectorizeProbaWithWeights(wLogit, Xf_raw);
    const fore_pT = treeProbas(cart, Xf_raw);
    const fore_pH = fore_pL.map((p,i)=> wHybrid*p + (1-wHybrid)*fore_pT[i]);

    const leagueMeans = {}; for (const k of FEATS) leagueMeans[k] = mean(train.map(r=>Number(r[k])));

    const toResult = (r, probs, forecastFlag) => {
      const game_id = `${r.season}-W${String(r.week).padStart(2,"0")}-${r.team}-${r.opponent}`;
      const english = explain(r, leagueMeans, probs);
      return {
        game_id,
        home_team: r.home ? r.team : r.opponent,
        away_team: r.home ? r.opponent : r.team,
        season: r.season,
        week: r.week,
        forecast: forecastFlag,
        models: {
          logistic: { prob_win: round3(probs.logit) },
          decision_tree: { prob_win: round3(probs.tree) },
          hybrid: { prob_win: round3(probs.hybrid), weights: { logistic: wHybrid, tree: Number((1-wHybrid).toFixed(2)) } }
        },
        natural_language: english
      };
    };

    const backResults = test.map((r,i)=> toResult(r, {
      logit: back_pL[i],
      tree:  back_pT[i],
      hybrid:back_pH[i]
    }, false));

    const foreResults = forecastRows.map((r,i)=> toResult(r, {
      logit: fore_pL[i],
      tree:  fore_pT[i],
      hybrid:fore_pH[i]
    }, true));

    const results = [...backResults, ...foreResults];
    if (!results.length){
      console.log(`W${W}: nothing to write.`);
      continue;
    }

    const predPath  = `${ART_DIR}/predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    const modelPath = `${ART_DIR}/model_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    writeFileSync(predPath, JSON.stringify(results, null, 2));
    writeFileSync(modelPath, JSON.stringify({
      season: SEASON,
      week: W,
      features: FEATS,
      hybrid_weight: wHybrid,
      logistic: wLogit
    }, null, 2));

    console.log(`WROTE: ${predPath}`);
    console.log(`WROTE: ${modelPath}`);

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
      model_file: `model_${SEASON}_W${String(W).padStart(2,"0")}.json`
    });
    latestWeekWritten = W;
  }

  const summaryPath = `${ART_DIR}/season_summary_${SEASON}_to_W${String(seasonSummary.built_through_week || 0).padStart(2,"0")}.json`;
  writeFileSync(summaryPath, JSON.stringify(seasonSummary, null, 2));
  console.log(`WROTE: ${summaryPath}`);

  const indexPath = `${ART_DIR}/season_index_${SEASON}.json`;
  writeFileSync(indexPath, JSON.stringify(seasonIndex, null, 2));
  console.log(`WROTE: ${indexPath}`);

  if (latestWeekWritten != null) {
    const predCurrentPath  = `${ART_DIR}/predictions_current.json`;
    const modelCurrentPath = `${ART_DIR}/model_current.json`;
    const predLatestPath   = `${ART_DIR}/predictions_${SEASON}_W${String(latestWeekWritten).padStart(2,"0")}.json`;
    const modelLatestPath  = `${ART_DIR}/model_${SEASON}_W${String(latestWeekWritten).padStart(2,"0")}.json`;

    const fs = await import("fs/promises");
    const predBuf  = await fs.readFile(predLatestPath,  { encoding: "utf8" });
    const modelBuf = await fs.readFile(modelLatestPath, { encoding: "utf8" });
    writeFileSync(predCurrentPath,  predBuf);
    writeFileSync(modelCurrentPath, modelBuf);

    console.log(`WROTE: ${predCurrentPath} (alias of ${predLatestPath})`);
    console.log(`WROTE: ${modelCurrentPath} (alias of ${modelLatestPath})`);
  }
})().catch(e=>{ console.error(e); process.exit(1); });
