# Enhanced API Endpoints

This document describes the new API endpoints added to expose advanced analysis features and A/B testing capabilities.

## Overview

The Cloudflare Worker API has been enhanced with **11 new endpoints** that provide access to:
- **A/B test variant predictions** (1 endpoint)
- **Advanced analysis metrics** (5 endpoints)
- **Interactive visualizations** (3 endpoints)

All new endpoints are **100% backward compatible** - existing endpoints continue to work unchanged.

---

## New Endpoints Summary

| Endpoint | Purpose | Returns |
|----------|---------|---------|
| `/predictions/variant` | A/B test variant predictions | JSON |
| `/analysis/roi` | Betting ROI metrics | JSON |
| `/analysis/segments` | Performance by segment | JSON |
| `/analysis/errors` | Error analysis | JSON |
| `/analysis/calibration` | Calibration metrics (ECE, MCE) | JSON |
| `/analysis/importance` | Feature importance rankings | JSON |
| `/visualizations/calibration` | Calibration plot | HTML |
| `/visualizations/confusion` | Confusion matrix | HTML |
| `/visualizations/importance` | Feature importance chart | HTML |

---

## 1. A/B Testing Variant Predictions

### `GET /predictions/variant`

Get predictions from a specific model variant for A/B testing.

**Parameters:**
- `variant` (required): One of `baseline`, `variant_a`, `variant_b`, `variant_c`
- `season` (required): Season year (e.g., 2024)
- `week` (required): Week number (e.g., 8)

**Example Request:**
```bash
curl "https://your-worker.workers.dev/predictions/variant?variant=variant_a&season=2024&week=8"
```

**Example Response:**
```json
{
  "season": 2024,
  "week": 8,
  "variant": "variant_a",
  "data": [
    {
      "game_id": "2024-W08-BUF-TB",
      "home_team": "BUF",
      "away_team": "TB",
      "forecast": 0.964,
      ...
    }
  ]
}
```

**Use Cases:**
- Compare different model configurations
- Evaluate feature improvements
- Test new modeling approaches

---

## 2. ROI Analysis

### `GET /analysis/roi`

Get Return on Investment metrics for betting scenarios at multiple confidence thresholds.

**Parameters:**
- `season` (optional): Season year
- `week` (optional): Week number

**Example Request:**
```bash
curl "https://your-worker.workers.dev/analysis/roi?season=2024&week=8"
```

**Example Response:**
```json
{
  "season": 2024,
  "week": 8,
  "data": {
    "threshold_55": {
      "totalBets": 120,
      "totalWins": 72,
      "winRate": 0.60,
      "totalUnits": 120,
      "profitUnits": 8.4,
      "roi": 7.0,
      "breakEvenRate": 0.524
    },
    "threshold_60": { ... },
    "threshold_65": { ... }
  }
}
```

**Metrics Explained:**
- `totalBets`: Number of bets placed at this threshold
- `winRate`: Percentage of winning bets
- `profitUnits`: Net profit/loss (assuming -110 odds)
- `roi`: Return on investment percentage
- `breakEvenRate`: Win rate needed to break even (52.4% at -110 odds)

---

## 3. Segmented Performance

### `GET /analysis/segments`

Get performance metrics broken down by various segments.

**Parameters:**
- `season` (optional): Season year
- `week` (optional): Week number

**Example Request:**
```bash
curl "https://your-worker.workers.dev/analysis/segments?season=2024&week=8"
```

**Example Response:**
```json
{
  "season": 2024,
  "week": 8,
  "data": {
    "all": {
      "count": 256,
      "logLoss": 0.543,
      "brier": 0.215,
      "accuracy": 0.672,
      "auc": 0.745
    },
    "favorites": {
      "count": 150,
      "logLoss": 0.489,
      "accuracy": 0.743,
      ...
    },
    "underdogs": { ... },
    "homeTeams": { ... },
    "awayTeams": { ... },
    "divisionalGames": { ... },
    "nonDivisionalGames": { ... },
    "earlyWeeks": { ... },
    "midWeeks": { ... },
    "lateWeeks": { ... }
  }
}
```

**Segments Available:**
- `all`: All predictions
- `favorites`: Home team favored (>50% probability)
- `underdogs`: Home team underdog (<50% probability)
- `homeTeams`: All home team predictions
- `awayTeams`: All away team predictions
- `divisionalGames`: Division rivals
- `nonDivisionalGames`: Non-division matchups
- `earlyWeeks`: Weeks 1-6
- `midWeeks`: Weeks 7-13
- `lateWeeks`: Weeks 14+

---

## 4. Error Analysis

### `GET /analysis/errors`

Get detailed error analysis including top mispredictions and error patterns.

**Parameters:**
- `season` (optional): Season year
- `week` (optional): Week number

**Example Request:**
```bash
curl "https://your-worker.workers.dev/analysis/errors?season=2024&week=8"
```

**Example Response:**
```json
{
  "season": 2024,
  "week": 8,
  "data": {
    "topErrors": [
      {
        "game_id": "2024-W08-BUF-TB",
        "forecast": 0.964,
        "actual": 0,
        "error": 0.964,
        "home_team": "BUF",
        "away_team": "TB",
        "week": 8
      },
      ...
    ],
    "errorPatterns": {
      "overconfidentWins": 12,
      "overconfidentLosses": 8,
      "tossupMisses": 45,
      "favoriteUpsets": 18,
      "underdogWins": 15
    },
    "totalErrors": 84,
    "errorRate": 0.3281
  }
}
```

**Error Patterns:**
- `overconfidentWins`: High confidence (>65%) but incorrect
- `overconfidentLosses`: Low confidence (<35%) but incorrect
- `tossupMisses`: Close games (45-55%) that were wrong
- `favoriteUpsets`: Favorites (>60%) that lost
- `underdogWins`: Underdogs (<40%) that won

---

## 5. Calibration Metrics

### `GET /analysis/calibration`

Get calibration analysis including Expected Calibration Error and reliability bins.

**Parameters:**
- `season` (optional): Season year
- `week` (optional): Week number

**Example Request:**
```bash
curl "https://your-worker.workers.dev/analysis/calibration?season=2024&week=8"
```

**Example Response:**
```json
{
  "season": 2024,
  "week": 8,
  "data": {
    "ece": 0.0234,
    "mce": 0.0876,
    "bins": [
      {
        "lower": 0.0,
        "upper": 0.1,
        "count": 15,
        "avgPredicted": 0.065,
        "avgActual": 0.067,
        "error": 0.002
      },
      ...
    ]
  }
}
```

**Metrics:**
- `ece`: Expected Calibration Error (lower is better)
- `mce`: Maximum Calibration Error (lower is better)
- `bins`: Reliability diagram bins showing predicted vs. actual rates

---

## 6. Feature Importance

### `GET /analysis/importance`

Get feature importance rankings showing which features contribute most to predictions.

**Parameters:**
- `season` (optional): Season year
- `week` (optional): Week number

**Example Request:**
```bash
curl "https://your-worker.workers.dev/analysis/importance?season=2024&week=8"
```

**Example Response:**
```json
{
  "season": 2024,
  "week": 8,
  "data": {
    "top20": [
      {
        "feature": "elo_diff",
        "importance": 0.234,
        "coefficient": 0.234
      },
      {
        "feature": "off_epa_per_play_s2d",
        "importance": 0.187,
        "coefficient": 0.187
      },
      ...
    ],
    "all": [ ... ]
  }
}
```

---

## 7. Calibration Plot Visualization

### `GET /visualizations/calibration`

Get an interactive HTML calibration plot (reliability diagram).

**Parameters:**
- `season` (required): Season year
- `week` (required): Week number

**Example Request:**
```bash
curl "https://your-worker.workers.dev/visualizations/calibration?season=2024&week=8"
```

**Returns:** HTML page with interactive SVG calibration plot

**Features:**
- Predicted vs. actual probability curves
- Perfect calibration reference line
- ECE/MCE metrics displayed
- Grid lines and annotations
- Standalone HTML (no dependencies)

---

## 8. Confusion Matrix Visualization

### `GET /visualizations/confusion`

Get an interactive HTML confusion matrix visualization.

**Parameters:**
- `season` (required): Season year
- `week` (required): Week number

**Example Request:**
```bash
curl "https://your-worker.workers.dev/visualizations/confusion?season=2024&week=8"
```

**Returns:** HTML page with interactive confusion matrix

**Features:**
- True Positives, False Positives, True Negatives, False Negatives
- Accuracy, Precision, Recall, F1 Score
- Color-coded cells
- Percentage breakdowns

---

## 9. Feature Importance Visualization

### `GET /visualizations/importance`

Get an interactive HTML feature importance bar chart.

**Parameters:**
- `season` (required): Season year
- `week` (required): Week number

**Example Request:**
```bash
curl "https://your-worker.workers.dev/visualizations/importance?season=2024&week=8"
```

**Returns:** HTML page with interactive bar chart showing top 20 features

---

## Implementation Details

### File Locations

The worker looks for these artifact files in the `artifacts/` directory:

```
artifacts/
├── roi_analysis_YYYY_WWW.json
├── segmented_report_YYYY_WWW.json
├── error_analysis_YYYY_WWW.json
├── calibration_metrics_YYYY_WWW.json
├── feature_importance_YYYY_WWW.json
├── predictions_YYYY_WWW_baseline.json
├── predictions_YYYY_WWW_variant_a.json
├── predictions_YYYY_WWW_variant_b.json
├── predictions_YYYY_WWW_variant_c.json
└── visualizations/
    ├── calibration_YYYY_WWW.html
    ├── confusion_matrix_YYYY_WWW.html
    └── feature_importance_YYYY_WWW.html
```

### Caching

- **JSON endpoints**: Cached with 15-minute TTL (configurable via `CACHE_TTL`)
- **HTML visualizations**: Cached in Cloudflare KV (if available) + CDN cache
- **ETag/Last-Modified**: Supported for efficient caching

### CORS

All endpoints support CORS:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, OPTIONS`
- OPTIONS preflight requests handled

### Rate Limiting

All endpoints respect the worker's rate limiting:
- Default: 120 requests/minute per IP
- Configurable via `RATE_LIMIT_PER_MINUTE` environment variable

---

## Generating Artifacts

To generate these artifacts, use the trainer with analysis flags enabled:

```bash
# Generate analysis artifacts
ANALYSIS_ROI_METRICS=true \
ANALYSIS_SEGMENTED_REPORTS=true \
ANALYSIS_FEATURE_IMPORTANCE=true \
npm run train:multi

# Generate visualizations
ANALYSIS_CALIBRATION_PLOTS=true \
ANALYSIS_CONFUSION_MATRIX=true \
npm run train:multi

# Generate A/B test variants
AB_TESTING_ENABLED=true \
AB_TESTING_VARIANT=variant_a \
npm run train:multi
```

---

## Error Handling

All endpoints return consistent error responses:

```json
{
  "error": "Error message here"
}
```

**Common Status Codes:**
- `200`: Success
- `400`: Bad request (invalid parameters)
- `404`: Resource not found (artifact doesn't exist)
- `429`: Rate limit exceeded
- `500`: Internal server error

---

## Use Cases

### 1. External Betting Tool

```javascript
// Get predictions with ROI analysis
const predictions = await fetch('/predictions?season=2024&week=8');
const roi = await fetch('/analysis/roi?season=2024&week=8');

// Show user which bets have best expected value
const goodBets = predictions.data.filter(p => p.forecast > 0.60);
console.log(`ROI at 60% threshold: ${roi.data.threshold_60.roi}%`);
```

### 2. Performance Dashboard

```html
<!-- Embed calibration plot -->
<iframe src="https://your-worker.workers.dev/visualizations/calibration?season=2024&week=8"></iframe>

<!-- Fetch segmented metrics for charts -->
<script>
  const segments = await fetch('/analysis/segments?season=2024&week=8').then(r => r.json());
  drawPerformanceChart(segments.data);
</script>
```

### 3. A/B Test Comparison

```javascript
// Compare baseline vs variant
const baseline = await fetch('/predictions/variant?variant=baseline&season=2024&week=8');
const variantA = await fetch('/predictions/variant?variant=variant_a&season=2024&week=8');

// Calculate which performed better
compareAccuracy(baseline.data, variantA.data);
```

---

## OpenAPI Specification

All endpoints are fully documented in `openapi.yaml` with:
- Complete parameter specifications
- Request/response schemas
- Example values
- Error responses

Use the OpenAPI spec to:
- Generate client SDKs
- Create API documentation
- Integrate with tools (Postman, Insomnia, etc.)

---

## Backward Compatibility

✅ **All existing endpoints unchanged**
✅ **No breaking changes**
✅ **New endpoints are additions only**
✅ **Existing API consumers unaffected**

---

## Future Enhancements

Potential future endpoints:
- `/analysis/compare` - Compare two variants
- `/analysis/trends` - Historical performance trends
- `/predictions/explain` - Detailed prediction explanations
- `/analysis/confidence` - Confidence interval analysis

---

## Support

For questions or issues:
- **Worker code**: `worker/worker.js`
- **OpenAPI spec**: `openapi.yaml`
- **Documentation**: `docs/api-enhanced-endpoints.md`
- **GitHub issues**: https://github.com/impreet01/PerdictionNFL/issues
