// trainer/train_multi.js
// Robust training + forecasting with diagnostics.
// - Logs teamWeekly schema keys and a sample built row
// - Standardizes features on train split
// - Logistic GD with L2 + intercept (no external libs)
// - CART probabilities via leaf frequencies
// - Forecasts missing fixtures in the same week
// - Writes per-week artifacts and season index/summary

import { loadSchedules, loadTeamWeekly } from "./dataSources.js";
import { buildFeatures, FEATS } from "./featureBuild.js";
import { writeFileSync, mkdirSync } from "fs";
import { DecisionTreeClassifier as CART } from "ml-cart";

const ART_DIR = "artifacts";
mkdirSync(ART_DIR, { recursive: true });

const SEASON = Number(process.env.SEASON || new Date().getFullYear());
const WEEK_ENV = Number(process.env.WEEK || 6);

function isReg(v){ if (v == null) return true; const s=String(v).trim().toUpperCase(); return s==="" || s.startsWith("REG"); }
const sigmoid = z => 1/(1+Math.exp(-z));
const dot = (a,b)=> { let s=0; for (let i=0;i<a.length;i++) s += (a[i]||0)*(b[i]||0); return s; };
const round3 = x => Math.round(Number(x)*1000)/1000;
const mean = a => a.reduce((s,v)=>s+v,0)/a.length;

function Xy(rows){
  const X = rows.map(r => FEATS.map(k => Number(r[k] ?? 0)));
  const y = rows.map(r => Number(r.win));
  return { X, y };
}
function splitTrainTest(all, season, week){
  const train = all.filter(r => r.season===season && r.week <  week && (r.win===0 || r.win===1));
  const test  = all.filter(r => r.season===season && r.week === week);
  return { train, test };
}

function fitScaler(X){
  const d = X[0]?.length || 0;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(1);
  const n = X.length || 1;
  for (let j=0;j<d;j++){ let s=0; for (let i=0;i<X.length;i++) s+=X[i][j]; mu[j]=s/n; }
  for (let j=0;j<d;j++){ let s=0; for (let i=0;i<X.length;i++){ const v=X[i][j]-mu[j]; s+=v*v; } sd[j]=Math.sqrt(s/n)||1; }
  return { mu, sd };
}
const applyScaler = (X,{mu,sd}) => X.map(r => r.map((v,j)=>(v-mu[j])/(sd[j]||1)));

function trainLogisticGD(X, y, { steps=3000, lr=5e-3, l2=2e-4 } = {}){
  const n = X.length, d = X[0]?.length || 0;
  let w = new Array(d).fill(0), b = 0;
  for (let t=0;t<steps;t++){
    let gb=0; const gw=new Array(d).fill(0);
    for (let i=0;i<n;i++){
      const z = dot(w,X[i])+b, p=sigmoid(z), e=p-y[i];
      gb += e; for (let j=0;j<d;j++) gw[j]+= e*X[i][j];
    }
    for (let j=0;j<d;j++) gw[j] += l2*w[j];
    b -= lr*(gb/n); for (let j=0;j<d;j++) w[j] -= lr*(gw[j]/n);
  }
  return { w, b };
}
const predictLogit = (X,{w,b}) => X.map(x => sigmoid(dot(w,x)+b));

// Tree proba via leaf frequencies
function leafPath(root, x){
  let node=root, path="";
  for (let guard=0; guard<200; guard++){
    const isLeaf = (!node.left && !node.right) || node.type==="leaf";
    if (isLeaf) return path||"ROOT";
    const col = node.splitColumn ?? node.attribute ?? node.index ?? node.feature ?? null;
    const thr = node.splitValue  ?? node.threshold ?? node.split  ?? null;
    if (col==null || thr==null) return path||"ROOT";
    const val = Number(x[col]??0); const goLeft = val <= Number(thr);
    path += goLeft ? "L" : "R"; node = goLeft ? node.left : node.right;
    if (!node) return path;
  }
  return path||"ROOT";
}
function buildLeafFreq(cart, Xtr, ytr){
  let json; try { json=cart.toJSON(); } catch { json=null; }
  const root = json?.root || json;
  const freq = new Map();
  if (!root){ const n1=ytr.reduce((s,v)=>s+(v?1:0),0); freq.set("ROOT",{n0:ytr.length-n1,n1}); return {root:null,freq}; }
  for (let i=0;i<Xtr.length;i++){ const p=leafPath(root,Xtr[i]); const f=freq.get(p)||{n0:0,n1:0}; if (ytr[i]===1) f.n1++; else f.n0++; freq.set(p,f); }
  return { root, freq };
}
function predictTree(cart, leafStats, X){
  const { root, freq } = leafStats;
  if (!root){ const f=freq.get("ROOT")||{n0:0,n1:0}; const tot=f.n0+f.n1; const p1=tot>0?f.n1/tot:0.5; return X.map(()=>p1); }
  return X.map(x=>{ const p=leafPath(root,x); const f=freq.get(p); if (!f) return 0.5; const tot=f.n0+f.n1; return tot>0?f.n1/tot:0.5; });
}

function logLoss(y,p){ let s=0,eps=1e-12; for(let i=0;i<y.length;i++){ s += -(y[i]*Math.log(Math.max(p[i],eps))+(1-y[i])*Math.log(Math.max(1-p[i],eps))); } return s/y.length; }
function chooseHybrid(y, pL, pT){ let best=0.5, bestLL=Infinity; for (let w=0; w<=1.0001; w+=0.05){ const ph=pL.map((p,i)=> w*p+(1-w)*pT[i]); const ll=logLoss(y,ph); if (ll<bestLL){bestLL=ll; best=Number(w.toFixed(2));}} return best; }

(async function main(){
  console.log(`Rolling train for SEASON=${SEASON} (env WEEK=${WEEK_ENV})`);

  // Load sources
  const schedules = await loadSchedules();
  const teamWeekly = await loadTeamWeekly(SEASON);
  const prevTeamWeekly = await (async()=>{ try { return await loadTeamWeekly(SEASON-1); } catch { return []; } })();

  // Schema keys diagnostic
  if (teamWeekly && teamWeekly.length){
    const sampleKeys = Object.keys(teamWeekly[0]).slice(0, 80);
    console.log(`teamWeekly[0] keys: ${JSON.stringify(sampleKeys)}`);
  } else {
    console.log("teamWeekly is empty or unavailable.");
  }

  // Build features
  const featRows = buildFeatures({ teamWeekly, schedules, season: SEASON, prevTeamWeekly });
  console.log(`Built feature rows: ${featRows.length}`);
  if (featRows.length){
    console.log("Sample feature row:", JSON.stringify(featRows[0], null, 2).slice(0, 400));
  }

  // Weeks metadata
  const regSched = schedules.filter(g => Number(g.season)===SEASON && isReg(g.season_type));
  const schedWeeks = [...new Set(regSched.map(g => Number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  const featWeeks = [...new Set(featRows.map(r => r.week))].sort((a,b)=>a-b);
  const schedMaxWeek = schedWeeks.length ? schedWeeks[schedWeeks.length-1] : 18;
  const featMaxWeek = featWeeks.length ? featWeeks[featWeeks.length-1] : 1;

  const lastFull = (() => {
    let lf = 0;
    for (const w of schedWeeks){
      const games = regSched.filter(g => Number(g.week)===w);
      const done = games.every(g => Number.isFinite(Number(g.home_score ?? g.home_points ?? g.home_pts)) &&
                                   Number.isFinite(Number(g.away_score ?? g.away_points ?? g.away_pts)));
      if (done) lf = w; else break;
    }
    return lf;
  })();

  const MAX_WEEK = Math.min(Math.max(2, WEEK_ENV, featMaxWeek, lastFull+1), schedMaxWeek);
  console.log(`schedWeeks=${JSON.stringify(schedWeeks)} featWeeks=${JSON.stringify(featWeeks)} MAX_WEEK=${MAX_WEEK}`);

  // Season-wide structures (declare ONCE)
  const seasonSummary = { season: SEASON, built_through_week: null, weeks: [], feature_names: FEATS };
  const seasonIndex = { season: SEASON, weeks: [] };
  let latestWeekWritten = null;

  // helpers
  function leagueMeans(rows){ const m={}; for (const k of FEATS){ m[k]=mean(rows.map(r=>Number(r[k]||0))); } return m; }

  function runWeek(W){
    const { train, test } = splitTrainTest(featRows, SEASON, W);
    const pos = train.reduce((s,r)=> s+(r.win?1:0), 0);
    const neg = train.length - pos;
    console.log(`W${W}: train rows=${train.length} pos=${pos} neg=${neg} (pos_rate=${train.length? (pos/train.length).toFixed(3):"n/a"})`);
    if (!train.length) return null;

    // Standardize on TRAIN
    const { X: XtrRaw } = Xy(train);
    const ytr = train.map(r=>r.win);
    const scaler = fitScaler(XtrRaw);
    const Xtr = applyScaler(XtrRaw, scaler);

    // Logistic
    let logit;
    if (pos===0 || neg===0){
      const prior = pos / Math.max(1, (pos+neg));
      const b = Math.log((prior+1e-9)/(1-prior+1e-9));
      logit = { w: new Array(Xtr[0].length).fill(0), b };
      console.log(`W${W}: logistic prior-only (single-class fold), prior=${prior.toFixed(3)}`);
    } else {
      logit = trainLogisticGD(Xtr, ytr, { steps: 3500, lr: 4e-3, l2: 2e-4 });
    }

    // CART on standardized features
    const cart = new CART({ maxDepth: 4, minNumSamples: 20, gainFunction: "gini" });
    cart.train(Xtr, ytr);
    const leafStats = buildLeafFreq(cart, Xtr, ytr);

    // Backtest
    const { X: XtestRaw } = Xy(test);
    const Xtest = applyScaler(XtestRaw, scaler);
    const pL_back = predictLogit(Xtest, logit);
    const pT_back = predictTree(cart, leafStats, Xtest);

    // Hybrid on TRAIN
    const wHybrid = chooseHybrid(ytr, predictLogit(Xtr, logit), predictTree(cart, leafStats, Xtr));
    const pH_back = pL_back.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_back[i]);

    // Forecast rest of week
    const regPairs = new Set(regSched.filter(g=>Number(g.week)===W).map(g => `${g.home_team}@${g.away_team}`));
    const presentPairs = new Set();
    for (let i=0;i<test.length;i+=2){
      const r = test[i]; if (!r) break;
      const home = r.home ? r.team : r.opponent;
      const away = r.home ? r.opponent : r.team;
      presentPairs.add(`${home}@${away}`);
    }
    const missingPairs = [...regPairs].filter(k => !presentPairs.has(k));
    let forecastRows = [];
    if (missingPairs.length){
      // Template from the latest <= W-1 appearances of each team (featureBuild’s backfill already helps).
      const teamsLatest = new Map();
      for (const r of [...train, ...test]){
        if (r.season===SEASON && r.week<=W-1){
          const key = `${r.season}-${r.team}`;
          const prev = teamsLatest.get(key);
          if (!prev || prev.week < r.week) teamsLatest.set(key, r);
        }
      }
      for (const k of missingPairs){
        const [home, away] = k.split("@");
        const h = teamsLatest.get(`${SEASON}-${home}`); const a = teamsLatest.get(`${SEASON}-${away}`);
        if (!h || !a) continue;

        const clone = (src, team, opp, homeFlag) => {
          const row = {};
          for (const f of FEATS){ row[f] = Number(src[f] ?? 0); }
          row.season = SEASON; row.week = W; row.team = team; row.opponent = opp; row.home = homeFlag?1:0;
          row.game_date = null; row.win = null; // forecast
          return row;
        };
        const hRow = clone(h, home, away, true);
        const aRow = clone(a, away, home, false);

        // refresh opponent diffs using each other's S2D
        hRow.off_total_yds_s2d_minus_opp = Number(hRow.off_total_yds_s2d) - Number(aRow.off_total_yds_s2d);
        hRow.def_total_yds_s2d_minus_opp = Number(hRow.def_total_yds_s2d) - Number(aRow.def_total_yds_s2d);
        hRow.off_turnovers_s2d_minus_opp = Number(hRow.off_turnovers_s2d) - Number(aRow.off_turnovers_s2d);
        hRow.def_turnovers_s2d_minus_opp = Number(hRow.def_turnovers_s2d) - Number(aRow.def_turnovers_s2d);

        aRow.off_total_yds_s2d_minus_opp = Number(aRow.off_total_yds_s2d) - Number(hRow.off_total_yds_s2d);
        aRow.def_total_yds_s2d_minus_opp = Number(aRow.def_total_yds_s2d) - Number(hRow.def_total_yds_s2d);
        aRow.off_turnovers_s2d_minus_opp = Number(aRow.off_turnovers_s2d) - Number(hRow.off_turnovers_s2d);
        aRow.def_turnovers_s2d_minus_opp = Number(aRow.def_turnovers_s2d) - Number(hRow.def_turnovers_s2d);

        forecastRows.push(hRow, aRow);
      }
    }

    // Forecast probs
    const { X: XfRaw } = Xy(forecastRows);
    const Xf = applyScaler(XfRaw, scaler);
    const pL_fore = predictLogit(Xf, logit);
    const pT_fore = predictTree(cart, leafStats, Xf);
    const pH_fore = pL_fore.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_fore[i]);

    const means = leagueMeans(train);

    const explain = (r, probs)=>{
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
      const rd = Number(r.rest_diff); if (Number.isFinite(rd) && Math.abs(rd)>=2) lines.push(`Rest edge: ${rd>=0?"+":""}${rd} day(s).`);
      return `Logistic: ${(probs.logit*100).toFixed(1)}%. Tree: ${(probs.tree*100).toFixed(1)}%. Hybrid: ${(probs.hybrid*100).toFixed(1)}%. ` + lines.join(" ");
    };

    const toResult = (r, probs, forecast) => ({
      game_id: `${r.season}-W${String(r.week).padStart(2,"0")}-${r.team}-${r.opponent}`,
      home_team: r.home ? r.team : r.opponent,
      away_team: r.home ? r.opponent : r.team,
      season: r.season,
      week: r.week,
      forecast,
      models: {
        logistic:      { prob_win: round3(probs.logit) },
        decision_tree: { prob_win: round3(probs.tree) },
        hybrid:        { prob_win: round3(probs.hybrid), weights: { logistic: wHybrid, tree: Number((1-wHybrid).toFixed(2)) } }
      },
      natural_language: explain(r, probs)
    });

    const back = test.map((r,i)=> toResult(r, { logit:pL_back[i], tree:pT_back[i], hybrid:pH_back[i] }, false));
    const fore = forecastRows.map((r,i)=> toResult(r, { logit:pL_fore[i], tree:pT_fore[i], hybrid:pH_fore[i] }, true));
    return { back, fore, scaler, wHybrid, logit, cart };
  }

  // Train/forecast loop
  for (let W=2; W<=MAX_WEEK; W++){
    const res = runWeek(W);
    if (!res) continue;

    const { back, fore, scaler, wHybrid, logit } = res;
    const results = [...back, ...fore];
    const predPath  = `${ART_DIR}/predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    const modelPath = `${ART_DIR}/model_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    writeFileSync(predPath, JSON.stringify(results, null, 2));
    writeFileSync(modelPath, JSON.stringify({
      season: SEASON, week: W, features: FEATS, hybrid_weight: wHybrid,
      logistic: { weights: logit.w, intercept: logit.b },
      scaler
    }, null, 2));
    console.log(`WROTE: ${predPath}`);
    console.log(`WROTE: ${modelPath}`);

    seasonSummary.weeks.push({
      week: W,
      train_rows: back.length ? back.length : 0, // count written rows for week (back+fore are in file)
      forecast: fore.length > 0,
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

  // Season index & summary (no re-declarations)
  writeFileSync(`${ART_DIR}/season_index_${SEASON}.json`, JSON.stringify(seasonIndex, null, 2));
  writeFileSync(`${ART_DIR}/season_summary_${SEASON}_to_W${String(seasonSummary.built_through_week || 0).padStart(2,"0")}.json`, JSON.stringify(seasonSummary, null, 2));
  console.log(`WROTE: season_index_${SEASON}.json and season_summary_*`);

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
