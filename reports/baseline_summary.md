# Baseline Ensemble Snapshot

_Last refresh: based on checked-in artifacts through 2025 Week 5._

## Data sources
- **Schedules & outcomes**: `loadSchedules` pulls nflverse schedules releases with GitHub API fallbacks. 【F:trainer/dataSources.js†L19-L120】
- **Team weekly stats**: season-to-date rushing/passing/efficiency from nflverse `stats_team_week_<season>.csv`. 【F:trainer/dataSources.js†L121-L199】
- **Player weekly usage**: rushing/targets/air yards from `stats_player_week_<season>.csv` plus positional filters. 【F:trainer/dataSources.js†L200-L278】【F:trainer/featureBuild_players.js†L1-L200】
- **Team-game advanced**: EPA/success/situation splits from `stats_team_game_<season>.csv`. 【F:trainer/dataSources.js†L279-L359】
- **Play-by-play aggregates**: gzip play-by-play mirrors for rolling EPA & success rates. 【F:trainer/dataSources.js†L360-L460】
- **Context feeds**: rosters, snap counts, depth charts, injuries, officials, weather, ESPN QBR, and PFR advanced opponent data for per-game context. 【F:trainer/dataSources.js†L461-L700】【F:trainer/contextPack.js†L1-L200】

## Feature inventory
The core feature matrix (per team-game) includes 80+ numeric columns spanning:
- **Season-to-date totals & rates**: yardage, third-down/red-zone rates, sack rates, neutral pass rate, opponent-adjusted differentials. 【F:trainer/featureBuild.js†L8-L74】
- **Short rolling windows (3 & 5 games)**: offensive & defensive yards allowed/gained, QB efficiency, net yards. 【F:trainer/featureBuild.js†L43-L58】
- **Exponential decay aggregates** for EPA/success and usage metrics (RB/WR/TE shares, QB AYPA & sack rate). 【F:trainer/featureBuild.js†L59-L83】
- **Weather context** (roof flags, temperature, wind, precip, impact score). 【F:trainer/featureBuild.js†L84-L91】
- **Derived opponent differentials** created during feature expansion (`diff_*`). 【F:trainer/train_multi.js†L562-L575】

Play-by-play (`aggregatePBP`) and player usage (`aggregatePlayerUsage`) builders provide weighted season/rolling metrics before merging with team features. 【F:trainer/featureBuild_pbp.js†L1-L220】【F:trainer/featureBuild_players.js†L1-L200】

## Model lineup & configuration
- **Logistic regression**: gradient descent with 3k steps, learning rate `5e-3`, L2 `2e-4`; per-fold training trims to 2.5k steps & `4e-3` learning rate. Features standardized via z-scoring. 【F:trainer/train_multi.js†L121-L210】【F:trainer/train_multi.js†L736-L756】
- **CART decision tree**: `ml-cart` classifier with depth ≈3–6 and minimum samples 8–32 depending on sample size; Laplace-smoothed leaf probabilities. 【F:trainer/train_multi.js†L240-L280】【F:trainer/train_multi.js†L768-L786】
- **Bradley–Terry**: matchup model trained on per-game feature pairs (see `trainBTModel/predictBT`). 【F:trainer/featureBuild_bt.js†L1-L200】【F:trainer/model_bt.js†L1-L200】
- **ANN committee**: fully-connected tanh network `[64,32,16]` → sigmoid output, trained with BCE, patience-based early stopping, multiple seeds (default 5). 【F:trainer/model_ann.js†L1-L200】【F:trainer/train_multi.js†L795-L824】
- **Ensemble calibration**: weight grid-search on out-of-fold predictions with Platt-style bias adjustment (`calibration_beta`). Default prior weights are equal but clamped for early-season data. 【F:trainer/train_multi.js†L246-L273】【F:trainer/train_multi.js†L813-L849】【F:trainer/train_multi.js†L274-L317】

## Blend weights (latest diagnostics)
2025 Week 5 diagnostics show cross-validated blend weights:
- Logistic: **0.20**
- Decision tree: **0.60**
- Bradley–Terry: **0.20**
- ANN: effectively **0.00** (disabled after search)
with Platt beta **−0.008**. 【F:artifacts/diagnostics_2025_W05.json†L6-L36】

## Baseline metrics
Cumulative season-to-date (Weeks 1–5) from `metrics_2025.json`:
- Logistic: logloss **0.783**, Brier **0.221**, AUC **0.747**, accuracy **67.5%**.
- Decision tree: logloss **0.625**, Brier **0.213**, AUC **0.698**, accuracy **67.5%**.
- Bradley–Terry: logloss **4.79**, Brier **0.391**, AUC **0.537**, accuracy **50.6%**.
- ANN: logloss **0.693**, Brier **0.250**, AUC **0.398**, accuracy **55.8%**.
- Blended: logloss **0.913**, Brier **0.284**, AUC **0.627**, accuracy **58.4%**. 【F:artifacts/metrics_2025.json†L1-L59】

Week 5 snapshot shows the ensemble at logloss **0.920**, Brier **0.321**, AUC **0.700**, accuracy **57.1%**, with calibration bins revealing under-confidence in the 0.8–0.9 bucket. 【F:artifacts/metrics_2025_W05.json†L1-L47】

## Known issues & gaps
- **Blend drag**: season-wide, the blended model underperforms the decision tree due to heavy Bradley–Terry and ANN penalties in early weeks. 【F:artifacts/metrics_2025.json†L19-L59】
- **Bradley–Terry volatility**: extremely high log loss suggests instability in matchup features requiring regularization or better priors. 【F:artifacts/metrics_2025.json†L31-L44】
- **ANN underfitting**: committee AUC below 0.41; gradients may require architecture tuning or stronger regularization. 【F:artifacts/diagnostics_2025_W05.json†L18-L33】
- **Calibration bins**: latest diagnostics show 0% win rate in 0.2–0.4 buckets vs predicted 26–34%, indicating overestimation of underdogs. 【F:artifacts/diagnostics_2025_W05.json†L34-L63】

This baseline establishes the reference point before pursuing the broader accuracy, calibration, and pipeline improvements outlined in the project brief.
