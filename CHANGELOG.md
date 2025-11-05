# Changelog

## [Unreleased] - 2025-11-05

### Added
- Created utility modules to reduce code duplication:
  - `trainer/utils/artifacts.js` - Artifact path and status management
  - `trainer/utils/chunks.js` - Bootstrap chunk management
  - `trainer/utils/cache.js` - Promise caching and concurrency limiting
- Added comprehensive CI troubleshooting documentation (`docs/ci-troubleshooting.md`)
- Added cleanup documentation (`docs/cleanup-november-2025.md`)
- Added `.gitignore` entries for `artifacts/chunks/` and `artifacts/.status/`

### Changed
- **CI Optimization**: Reduced bootstrap chunks from 13 to 8 (38% reduction)
  - Merged 2-season chunks into 3-4 season chunks
  - Expected CI runtime improvement: ~30-40 minutes
  - Increased timeout from 75min to 90min per chunk for safety
- Improved npm install performance with `--prefer-offline` flag
- Refactored `train_multi.js` to use new utility modules
  - Extracted ~200 lines of duplicate utility code
  - Improved maintainability and testability

### Removed
- **Deleted unused files**:
  - `configs/` directory (duplicate configuration)
  - `scripts/package.json` (duplicate with outdated deps)
  - `scripts/debugData.js` (unused debug script)
  - `trainer/tests/backtest.js` (not in test suite)

### Fixed
- Module import conflicts resolved
- All test suites passing after refactoring

### Performance
- **Estimated CI improvements**:
  - Bootstrap phase: 165min → ~120min (27% faster)
  - Reduced overhead from matrix job setup (13 jobs → 8 jobs)
  - Better npm caching strategy

### Documentation
- Updated troubleshooting guide with recent CI fixes
- Documented all cleanup changes and migration paths
- Added inline comments for refactored code

## Implementation Details

### Bootstrap Chunk Changes
**Before (13 chunks, 2 seasons each)**:
```
1999-2000 → 2001-2002 → 2003-2004 → ... → 2023-2024
```

**After (8 chunks, 3-4 seasons each)**:
```
1999-2002 → 2003-2005 → 2006-2008 → 2009-2011 → 2012-2014 → 2015-2017 → 2018-2020 → 2021-2024
```

### Test Results
✅ All core tests passing
✅ Bootstrap resolver tests updated for new chunk structure
✅ No breaking changes to production code

---

For detailed information about the cleanup, see `docs/cleanup-november-2025.md`
For CI troubleshooting, see `docs/ci-troubleshooting.md`
