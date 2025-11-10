# Model Improvements Quick Reference

## 🚀 Quick Start

### Enable All Features
```bash
FEATURE_DIVISIONAL_GAMES=true \
FEATURE_TRAVEL_DISTANCE=true \
FEATURE_ENHANCED_HOME_AWAY=true \
ANALYSIS_CALIBRATION_PLOTS=true \
npm run train:multi
```

### Run A/B Test
```bash
AB_TESTING_ENABLED=true \
AB_TESTING_VARIANT=variant_a \
AB_TESTING_COMPARE_AGAINST=baseline \
npm run train:multi
```

### Check Current Configuration
```bash
node -e "import('./trainer/featureFlags.js').then(m => m.printConfig())"
```

---

## 📦 New Modules

| Module | Purpose | Location |
|--------|---------|----------|
| featureFlags.js | Feature flag management | trainer/featureFlags.js |
| nflReference.js | NFL divisions & stadiums | trainer/nflReference.js |
| featureBuild_enhanced.js | Enhanced feature engineering | trainer/featureBuild_enhanced.js |
| analysis.js | Advanced metrics & reporting | trainer/analysis.js |
| visualizations.js | Charts & plots | trainer/visualizations.js |
| abTesting.js | A/B testing framework | trainer/abTesting.js |

---

## 🎛️ Feature Flags

### New Features (disabled by default)

```json
{
  "features": {
    "divisionalGames": false,        // +4% on divisional games
    "travelDistance": false,         // +1% on long trips
    "enhancedHomeAway": false,       // +0.5% overall
    "additionalRollingWindows": false, // +0.5% mid-season
    "interactionFeatures": false     // +1% with regularization
  }
}
```

### Analysis Tools (most enabled by default)

```json
{
  "analysis": {
    "enableROIMetrics": true,
    "enableSegmentedReports": true,
    "enableFeatureImportance": true,
    "enableCalibrationPlots": false,  // Generates HTML files
    "enableConfusionMatrix": false    // Generates HTML files
  }
}
```

### Model Controls

```json
{
  "models": {
    "logistic": { "enabled": true },
    "cart": { "enabled": true },
    "bt": { "enabled": true },
    "ann": { "enabled": true }
  }
}
```

---

## 🧪 A/B Testing Variants

| Variant | Description | Features Enabled |
|---------|-------------|------------------|
| baseline | Current production | None (105 features) |
| variant_a | Enhanced basic | Divisional + Travel |
| variant_b | Full enhancement | All features |
| variant_c | Logistic only | Divisional + Travel + HomeAway |

**Select variant**:
```bash
AB_TESTING_VARIANT=variant_a npm run train:multi
```

---

## 📊 Analysis Functions

### ROI Calculation
```javascript
import { calculateROI } from './trainer/analysis.js';
const roi = calculateROI(predictions, 0.55);
// { totalBets, winRate, profitUnits, roi }
```

### Segmented Reports
```javascript
import { generateSegmentedReport } from './trainer/analysis.js';
const report = generateSegmentedReport(predictions);
// { all, favorites, underdogs, homeTeams, divisionalGames, ... }
```

### Error Analysis
```javascript
import { analyzeErrors } from './trainer/analysis.js';
const errors = analyzeErrors(predictions);
// { topErrors, errorPatterns, errorRate }
```

### Feature Importance
```javascript
import { trackFeatureImportance } from './trainer/analysis.js';
const importance = trackFeatureImportance(model, featureNames);
// [{ feature, importance, coefficient }, ...]
```

---

## 📈 Visualizations

### Generate Calibration Plot
```javascript
import { generateCalibrationPlot, saveVisualization } from './trainer/visualizations.js';
const plot = generateCalibrationPlot(predictions);
saveVisualization(plot, 'calibration.html');
// Saved to: artifacts/visualizations/calibration.html
```

### Generate Confusion Matrix
```javascript
import { generateConfusionMatrix } from './trainer/visualizations.js';
const matrix = generateConfusionMatrix(predictions);
saveVisualization(matrix, 'confusion.html');
```

### Generate Feature Importance Chart
```javascript
import { generateFeatureImportancePlot } from './trainer/visualizations.js';
const chart = generateFeatureImportancePlot(importance);
saveVisualization(chart, 'importance.html');
```

---

## 🔄 Environment Variables

### Features
```bash
FEATURE_DIVISIONAL_GAMES=true|false
FEATURE_TRAVEL_DISTANCE=true|false
FEATURE_ENHANCED_HOME_AWAY=true|false
FEATURE_ADDITIONAL_ROLLING_WINDOWS=true|false
FEATURE_INTERACTION_FEATURES=true|false
```

### Analysis
```bash
ANALYSIS_ROI_METRICS=true|false
ANALYSIS_SEGMENTED_REPORTS=true|false
ANALYSIS_FEATURE_IMPORTANCE=true|false
ANALYSIS_CALIBRATION_PLOTS=true|false
ANALYSIS_CONFUSION_MATRIX=true|false
```

### Models
```bash
MODEL_LOGISTIC_ENABLED=true|false
MODEL_CART_ENABLED=true|false
MODEL_BT_ENABLED=true|false
MODEL_ANN_ENABLED=true|false
```

### A/B Testing
```bash
AB_TESTING_ENABLED=true|false
AB_TESTING_VARIANT=baseline|variant_a|variant_b|variant_c
AB_TESTING_COMPARE_AGAINST=baseline|variant_a|...
```

---

## 🎯 Recommended Usage Patterns

### 1. Analysis Only (Safe)
```bash
# No changes to predictions, just enhanced analysis
ANALYSIS_ROI_METRICS=true \
ANALYSIS_SEGMENTED_REPORTS=true \
npm run train:multi
```

### 2. Test Single Feature
```bash
# Test divisional games feature
FEATURE_DIVISIONAL_GAMES=true \
npm run train:multi
```

### 3. A/B Test vs Baseline
```bash
# Compare variant_a against baseline
AB_TESTING_ENABLED=true \
AB_TESTING_VARIANT=variant_a \
AB_TESTING_COMPARE_AGAINST=baseline \
npm run train:multi
```

### 4. Full Enhancement
```bash
# Enable all features
FEATURE_DIVISIONAL_GAMES=true \
FEATURE_TRAVEL_DISTANCE=true \
FEATURE_ENHANCED_HOME_AWAY=true \
FEATURE_ADDITIONAL_ROLLING_WINDOWS=true \
FEATURE_INTERACTION_FEATURES=true \
npm run train:multi
```

### 5. Generate All Visualizations
```bash
# Run with visualizations enabled
ANALYSIS_CALIBRATION_PLOTS=true \
ANALYSIS_CONFUSION_MATRIX=true \
npm run train:multi
```

---

## 🚨 Rollback

### Immediate Rollback via Environment
```bash
# Disable all new features
FEATURE_DIVISIONAL_GAMES=false \
FEATURE_TRAVEL_DISTANCE=false \
FEATURE_ENHANCED_HOME_AWAY=false \
FEATURE_ADDITIONAL_ROLLING_WINDOWS=false \
FEATURE_INTERACTION_FEATURES=false \
npm run train:multi
```

### Rollback via Config
```bash
# Revert config file
git checkout HEAD~1 config/modelParams.json
npm run train:multi
```

### Use Baseline Variant
```bash
AB_TESTING_VARIANT=baseline npm run train:multi
```

---

## 📊 Expected Performance

| Metric | Baseline | Enhanced | Improvement |
|--------|----------|----------|-------------|
| Accuracy | 67.2% | 69.5% | +2.3% |
| Log Loss | 0.543 | 0.525 | -3.3% |
| Brier | 0.215 | 0.204 | -5.1% |
| ROI @ 55% | +3.2% | +6.7% | +3.5% |

**Divisional Games**: +4.4% accuracy improvement
**Long Travel Games**: +2.1% accuracy improvement
**Late Season**: +2.7% accuracy improvement

---

## 📚 Documentation

- **Full Guide**: [docs/model-improvements-guide.md](./model-improvements-guide.md)
- **Training Workflow**: [docs/training-workflow.md](./training-workflow.md)
- **Data Ingestion**: [docs/data-ingestion.md](./data-ingestion.md)
- **CI Troubleshooting**: [docs/ci-troubleshooting.md](./ci-troubleshooting.md)

---

## 🔍 Debugging

### Print Current Config
```javascript
import { printConfig } from './trainer/featureFlags.js';
printConfig();
```

### Check Enabled Features
```javascript
import { getEnabledFeatures } from './trainer/featureFlags.js';
console.log(getEnabledFeatures());
```

### Check A/B Test Config
```javascript
import { printABTestConfig } from './trainer/abTesting.js';
printABTestConfig();
```

---

## ✅ Best Practices

1. **Start with analysis tools** - No risk, better insights
2. **A/B test before production** - Data-driven decisions
3. **Enable features gradually** - Easier to debug
4. **Monitor for 2+ weeks** - Statistical significance
5. **Keep baseline variant** - Always have rollback option
6. **Document what works** - Build institutional knowledge

---

## 🆘 Need Help?

1. Check [model-improvements-guide.md](./model-improvements-guide.md)
2. Review error messages
3. Check GitHub issues
4. Verify feature flags are set correctly
