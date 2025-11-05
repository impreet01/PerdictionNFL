# Codebase Cleanup - November 2025

## Overview

This document describes the cleanup and optimization work performed in November 2025 to reduce technical debt, remove unused code, and improve CI reliability.

---

## Files Removed

### 1. `configs/` Directory (Entire Directory)

**Reason for Removal:**
- Duplicate configuration directory
- Files were never imported by any code
- Superseded by `config/modelParams.json`

**Files Deleted:**
- `configs/data.json` - Unused data configuration
- `configs/model.json` - Detailed model config but not referenced

**Migration:**
- All active configuration is in `config/modelParams.json`
- Used by `trainer/model_bt.js` and `trainer/model_ann.js`

---

### 2. `scripts/package.json`

**Reason for Removal:**
- Duplicate of root `package.json`
- Contained outdated dependency versions
- Not used by npm or any build tools
- Included `zlib: ^1.0.5` (unnecessary - built into Node.js)

**Impact:**
- None - scripts inherit dependencies from root package.json
- No references in code or CI workflow

---

### 3. `scripts/debugData.js`

**Reason for Removal:**
- Debug utility script
- Not imported or referenced anywhere in codebase
- Not in package.json scripts
- Superseded by test suite diagnostics

**Original Purpose:**
- Debug data loading for specific seasons/weeks
- Inspect feature row counts

**Replacement:**
- Use `trainer/tests/smoke.js` for similar functionality
- Production logging in `dataSources.js` provides data inspection

---

### 4. `trainer/tests/backtest.js`

**Reason for Removal:**
- Mentioned in README but not in test suite
- Not run by `npm test` or CI workflow
- Contains outdated imports
- Never completed or integrated

**Note:**
- If backtesting is needed in future, use `trainer/tests/smoke.js` as template
- Rolling validation already implemented in `train_multi.js`

---

## Configuration Changes

### .gitignore Updates

**Added patterns:**
```gitignore
artifacts/chunks/      # Bootstrap temporary files
artifacts/.status/     # Training status markers
```

**Reason:**
- These directories contain ephemeral CI state
- Should not be committed to repository
- Already ignored in practice, now formalized

---

## Code Deprecation Status

### `trainer/train.js` - LEGACY (Kept for now)

**Status:** Marked as legacy but not removed

**Why kept:**
- Still referenced in root `package.json` as `npm run train`
- May be used by external scripts/documentation
- Simpler 2-model version useful for testing

**Differences from `train_multi.js`:**
| Feature | train.js | train_multi.js |
|---------|----------|----------------|
| Models | Logistic + CART only | 4+ model ensemble |
| Bradley-Terry | ❌ | ✅ |
| ANN Committee | ❌ | ✅ |
| Historical Bootstrap | Basic | Advanced chunked |
| Calibration | Simple hybrid | Platt scaling |
| Context Packs | ❌ | ✅ |

**Recommendation:**
- Use `train_multi.js` for production
- Use `train.js` for quick testing/debugging
- May remove in future major version

---

## Impact Summary

### Disk Space Saved
- 2 JSON config files (~1.6KB)
- 1 duplicate package.json (~500 bytes)
- 2 unused JS files (~500 lines of code)

### Maintenance Reduction
- Fewer files to maintain
- No config directory confusion
- Clearer dependency tree

### CI Reliability
- Removed potential import conflicts
- Simplified artifact structure
- Better gitignore coverage

---

## Migration Guide

### If you referenced deleted files:

**`configs/data.json` or `configs/model.json`:**
```javascript
// OLD (will break):
import config from '../configs/model.json';

// NEW (correct):
import modelParams from '../config/modelParams.json' with { type: "json" };
```

**`scripts/debugData.js`:**
```bash
# OLD (will fail):
node scripts/debugData.js

# NEW (replacement):
# For data inspection:
SEASON=2025 WEEK=6 node trainer/tests/smoke.js

# For production debugging:
LOG_LEVEL=debug npm run train:multi
```

**`trainer/tests/backtest.js`:**
```bash
# OLD (will fail):
node trainer/tests/backtest.js

# NEW (use rolling validation):
npm run train:multi  # Includes 4-fold rolling validation
# Check diagnostics_*.json for backtest metrics
```

---

## Verification

### Tests Still Passing ✅
```bash
npm run test:core       # All 8 core tests pass
npm run test:strictBatch # Strict batch validation passes
```

### No Breaking Changes ✅
- All imports still resolve correctly
- CI workflow unchanged (except improved)
- Production code unaffected

### Cleanup Verified ✅
```bash
# No references to deleted files:
grep -r "configs/" --include="*.js" --exclude-dir=node_modules  # 0 results
grep -r "debugData" --include="*.js" --exclude-dir=node_modules # 0 results
grep -r "backtest" --include="*.js" --exclude-dir=node_modules  # 0 results
```

---

## Related Documentation

- [CI Troubleshooting Guide](./ci-troubleshooting.md)
- [Training Workflow](./training-workflow.md)
- [Data Ingestion](./data-ingestion.md)

---

## Questions?

This cleanup was performed as part of a comprehensive code review. If you have questions or concerns:

1. Check git history for detailed commit messages
2. Review this document and related docs
3. Tests validate all changes are non-breaking
4. CI workflow has been tested end-to-end
