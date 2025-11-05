# CI Troubleshooting Guide

## Overview

This document captures common CI failure modes and their solutions based on production incidents.

## Recent Fixes (November 2025)

### Issue #1: Module Resolution Errors (PRs #217-220)

**Symptom:**
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ml-cart'
imported from /home/user/PerdictionNFL/trainer/train_multi.js
```

**Root Cause:**
- Logger configuration attempted to use `NODE_OPTIONS` or custom import hooks
- Interfered with Node.js module resolution

**Solution (commit 3a396f1):**
- Removed custom logger bootstrap entirely
- Rely on console logging instead of complex logger setup

**Prevention:**
- Avoid `NODE_OPTIONS` environment variable in CI
- Don't use custom Node.js loaders (`--loader`, `--experimental-loader`)
- Keep CI environment simple and close to production

---

### Issue #2: Nested Artifact Directory Layout (PRs #223-224)

**Symptom:**
```
artifacts/
  artifacts/  <-- nested incorrectly
    predictions_*.json
    models/
```

**Root Cause:**
- `actions/download-artifact@v4` extracts into nested directory structure
- Bootstrap job creates `artifacts/` inside uploaded artifacts
- Training job downloads and gets `artifacts/artifacts/`

**Solution (commit a17bcec):**
- Added normalization step in workflow (lines 252-271 of train.yaml)
- Detects nested layout and flattens before training
- Uses shell pattern matching to safely move files

**Code:**
```bash
if [ -d "${NESTED}" ]; then
  shopt -s dotglob nullglob
  entries=("${NESTED}"/*)
  if [ ${#entries[@]} -gt 0 ]; then
    mv "${entries[@]}" "${ROOT}/"
  fi
  shopt -u dotglob nullglob
  rmdir "${NESTED}"
fi
```

**Prevention:**
- Always verify artifact structure after download
- Use `find` with `-maxdepth` to inspect layout
- Add debug logging in upload/download steps

---

### Issue #3: Historical Bootstrap Race Conditions

**Symptom:**
- Inconsistent bootstrap completion markers
- Some chunks succeed but don't write status files
- Training job fails with "Missing status markers"

**Root Cause:**
- Multiple bootstrap jobs running in parallel
- Concurrent writes to shared status directory
- GitHub Actions artifact upload race conditions

**Solution (lines 27-28 of train.yaml):**
```yaml
strategy:
  max-parallel: 1  # Force sequential execution
```

**Prevention:**
- Keep `max-parallel: 1` for bootstrap jobs
- Use atomic file operations (write to temp, then move)
- Always verify markers exist before proceeding

---

## Common Failure Patterns

### Pattern 1: "Missing training_state.json"

**When it happens:**
- After cache miss on first run
- After `CURRENT_BOOTSTRAP_REVISION` change

**Debug steps:**
1. Check if historical_bootstrap.tgz exists:
   ```bash
   ls -lah artifacts/historical_bootstrap.tgz
   ```

2. Extract and verify:
   ```bash
   tar -tzf artifacts/historical_bootstrap.tgz | grep training_state.json
   ```

3. Check bootstrap:state script logs

**Solution:**
- Run `npm run bootstrap:state` to regenerate
- Ensure bootstrap jobs completed successfully
- Verify all chunks uploaded artifacts

---

### Pattern 2: "Cannot find package" Errors

**When it happens:**
- After npm install
- When using custom Node.js configuration

**Debug steps:**
1. Verify package.json integrity:
   ```bash
   cat package.json
   npm ls <package-name>
   ```

2. Check for multiple package.json files:
   ```bash
   find . -name package.json ! -path "*/node_modules/*"
   ```

3. Verify NODE_OPTIONS not set:
   ```bash
   echo $NODE_OPTIONS
   ```

**Solution:**
- Remove any duplicate package.json files
- Clear NODE_OPTIONS environment variable
- Use `npm ci` instead of `npm install` in CI

---

### Pattern 3: Status Marker Verification Failures

**When it happens:**
- After bootstrap or training jobs
- When seasons are missing from .status/

**Debug steps:**
1. List actual markers:
   ```bash
   ls -la artifacts/.status/
   ```

2. Check what seasons were processed:
   ```bash
   grep "season" training_state.json
   ```

3. Compare with expected range (BATCH_START to BATCH_END)

**Solution:**
- Verify bootstrap jobs completed (check action logs)
- Ensure train_multi.js writes markers on completion
- Check for early exits or exceptions in logs

---

## CI Workflow Architecture

### Bootstrap Phase (Parallel Matrix Jobs)

```
[1999-2000] → [2001-2002] → [2003-2004] → ... → [2023-2024]
     ↓             ↓             ↓                    ↓
  artifact_out  artifact_out  artifact_out      historical_bootstrap
                                                    (final output)
```

**Key Points:**
- Each chunk depends on previous via `artifact_in`
- `max-parallel: 1` prevents race conditions
- Final chunk produces `historical_bootstrap.tgz`

### Training Phase (Single Job)

```
Restore Cache or Download historical_bootstrap
              ↓
    Flatten nested directories
              ↓
       Run core tests
              ↓
    Fetch Rotowire data
              ↓
     Build context packs
              ↓
    Promote prior season
              ↓
   Train models (train_multi.js)
              ↓
  Calibrate predictions (hybrid_v2.js)
              ↓
    Validate artifacts
              ↓
   Commit or create PR
```

---

## Environment Variables

### Required
- `ARTIFACTS_DIR` - Path to artifacts (default: `artifacts`)
- `NODE_VERSION` - Node.js version (default: `20.x`)

### Performance Tuning
- `CI_FAST=1` - Reduces ANN complexity for faster testing
- `MAX_WORKERS=2` - Parallel model training threads
- `ANN_SEEDS=5` - Number of ANN committee members (reduce for speed)
- `ANN_MAX_EPOCHS=250` - Training duration (reduce for speed)

### Bootstrap Control
- `BATCH_START` - First season in chunk (e.g., 1999)
- `BATCH_END` - Last season in chunk (e.g., 2000)

### Debugging
- `LOG_LEVEL=info` - Logging verbosity (debug|info|warn|error)

---

## Troubleshooting Commands

### Check artifact structure
```bash
find artifacts/ -maxdepth 2 -type f | sort
```

### Verify bootstrap completion
```bash
ls artifacts/chunks/*.done
ls artifacts/.status/*.done
```

### Test locally
```bash
BATCH_START=2023 BATCH_END=2024 CI_FAST=1 npm run train:multi
```

### Validate artifacts
```bash
npm run validate:artifacts
```

### Check training state
```bash
cat artifacts/training_state.json | jq .
```

---

## Contact & Support

For CI issues:
1. Check this guide first
2. Review recent commits for similar fixes
3. Check workflow run logs in GitHub Actions
4. Search closed PRs for pattern matches

Common PR patterns:
- `codex/fix-ci-*` - Automated CI fixes
- `codex/*-module-not-found-*` - Dependency issues
- `codex/*-artifact-*` - Artifact handling issues
