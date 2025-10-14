# Ensemble Training & Hybrid Calibration Workflow

This guide describes the repeatable runbook for keeping the ensemble trainer and
hybrid recalibration outputs up to date without replaying every historical
season. The workflow is safe to script inside CI (for example, a scheduled
GitHub Action) and relies on the cached state stored in
`artifacts/training_state.json`.

## 1. Environment contracts

1. **Node runtime** – execute the workflow with Node 18 or later and run every
   command from the repository root so the trainer can read and write
   `artifacts/training_state.json`.
2. **State file** – treat `artifacts/training_state.json` as the source of truth
   for cached history. Never delete it unless you intentionally want to rebuild
   every season.
3. **Historical override flags** – reserve the following environment variables
   for manual rebuilds only: `REWRITE_HISTORICAL`, `OVERWRITE_HISTORICAL`,
   `REBUILD_HISTORICAL`, `REGENERATE_HISTORICAL`, `REGEN_HISTORICAL`, and
   `FORCE_HISTORICAL_BOOTSTRAP`. Leave them unset during routine automation so
   cached bootstraps remain valid.
4. **CI guardrails** – the scheduled GitHub Action fails fast if
   `artifacts/training_state.json` is missing or any historical override flag is
   detected. Restore the cached file or clear the flag before retrying so the
   run does not replay 2020–2025 unnecessarily.
5. **Season/week overrides** – only supply `SEASON` and `WEEK` when you need to
   pin a specific target. Omitting them allows the workflow to resume from the
   cached checkpoint automatically.

## 2. Recommended execution order

| Step | Action | Command(s) | Purpose |
| --- | --- | --- | --- |
| 1 | Refresh Rotowire artifacts *(optional but recommended before a new week)* | `npm run fetch:injuries`, `npm run fetch:markets`, `npm run fetch:weather` | Aligns context packs with the latest injury, market, and weather feeds. |
| 2 | Train or resume the ensemble | `npm run train:multi` *(default)* | Downloads missing nflverse data, loads cached bootstraps, and advances from the next untrained week. |
| 3 | Apply hybrid recalibration | `node trainer/hybrid_v2.js` | Reuses the cached bootstrap and calibrates the next outstanding week. |
| 4 | Validate and publish artifacts *(optional)* | `npm run validate:artifacts` | Confirms schema compliance before committing or uploading artifacts. |

Steps 2 and 3 can be repeated safely. Historical work only replays when the
bootstrap revision changes or you explicitly set one of the historical override
flags.

The helper defaults to the multi-week ensemble trainer. Pass
`--trainer=train` when you only need the legacy single-week logistic/tree
hybrid. Because that script does not touch `training_state.json`, the workflow
will automatically skip the hybrid recalibration phase after it finishes.

## 3. Pre-flight checks for automation

Before triggering the trainer:

1. **Verify the cached bootstrap** – read `artifacts/training_state.json` and
   confirm `bootstraps.model_training.revision === "2025-historical-bootstrap-v1"`.
   If the revision differs, the next run will rebuild 2020–2025 from scratch.
2. **Confirm the artifacts directory** – ensure `artifacts/` exists and is
   writable. The scripts create it automatically, but CI environments sometimes
   need explicit directory provisioning.
3. **Identify pending weeks** – after training, inspect
   `latest_runs.model_training` to discover the most recent `(season, week)`
   pair. Pass that information to the hybrid recalibrator so it can focus on the
   next week.
4. **Watch for bootstrap bumps** – when you intentionally update
   `CURRENT_BOOTSTRAP_REVISION` in `trainer/trainingState.js`, schedule a manual
   workflow run with `FORCE_HISTORICAL_BOOTSTRAP=true` and monitor completion
   before re-enabling your cron job.
5. **Check the bootstrap banner** – the trainer now prints an explicit message
   indicating whether it detected the cached bootstrap or is replaying
   historical seasons. Seeing the "historical bootstrap required" banner for a
   routine run means the cache or revision changed and needs attention.

## 4. Pseudocode reference

```pseudo
load state = artifacts/training_state.json (or initialise default)
if state.bootstraps.model_training.revision != "2025-historical-bootstrap-v1":
    log("Historical rebuild will run – expect longer duration")

run("npm run train:multi")

reload state
last_model_run = state.latest_runs.model_training
if last_model_run exists:
    target_season = last_model_run.season
    target_week = last_model_run.week + 1
else:
    target_season = current season
    target_week = null  // let script auto-select

run("node trainer/hybrid_v2.js", env={SEASON: target_season, WEEK: target_week})

reload state
log("Hybrid calibration advanced to", state.latest_runs.hybrid_v2)
```

Keep the pseudocode aligned with the real scripts. Both the trainer and the
calibrator persist progress after each successful step, so always reload
`training_state.json` before making the next decision.

## 5. Manual recovery scenarios

| Scenario | Recovery steps |
| --- | --- |
| `training_state.json` deleted accidentally | Stop automation, restore the file from version control or a backup, rerun `npm run train:multi` (it will bootstrap everything once), then resume the schedule. |
| Need to rebuild historical seasons | Bump `CURRENT_BOOTSTRAP_REVISION` in `trainer/trainingState.js`, commit, and run the workflow once with `FORCE_HISTORICAL_BOOTSTRAP=true`. Remove the flag afterward. |
| Hybrid calibration stuck on an old week | Delete `state.latest_runs.hybrid_v2` from the state file (or set `FORCE_HISTORICAL_BOOTSTRAP=true` for one run) so the script replays history and resynchronises. |
| Workflow crashed mid-run | Simply rerun it. Progress is committed to `training_state.json` after each successful step, so the next invocation resumes from the last completed week. |

## 6. Hand-off expectations

1. Commit the updated `artifacts/training_state.json` and the latest weekly
   artifacts after every successful run so future executions (local or CI)
   inherit the cached state.
2. Share `calibration_history_<season>.csv` alongside the weekly prediction
   exports if downstream consumers monitor calibration drift.
3. Document any bootstrap revision changes or recovery procedures in your
   changelog so future operators understand why a rebuild occurred.
