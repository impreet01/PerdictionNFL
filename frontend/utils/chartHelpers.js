/**
 * NFL Analytics Platform - Chart Helpers
 * Utility functions for Chart.js configuration and styling
 */

// Model color palette
export const MODEL_COLORS = {
  blended: '#1f77b4',
  logistic: '#ff7f0e',
  tree: '#2ca02c',
  bt: '#d62728',
  ann: '#9467bd',
  xgboost: '#8c564b',
  ngs: '#17becf',
  qbr: '#bcbd22'
};

// Semantic colors
export const COLORS = {
  success: '#2ca58d',
  danger: '#ff6b6b',
  warning: '#ffa726',
  info: '#4dabf7',
  neutral: '#6c757d',

  // Chart-specific
  positive: '#2ca58d',
  negative: '#ff6b6b',
  reference: '#888888',
  confidence: 'rgba(31, 119, 180, 0.2)',
  grid: 'rgba(128, 128, 128, 0.1)'
};

export const ChartHelpers = {
  /**
   * Get responsive font sizes based on container width
   * @param {number} width - Container width
   * @returns {Object} Font sizes
   */
  getResponsiveFontSizes(width) {
    if (width < 400) {
      return { title: 12, label: 10, tick: 8 };
    } else if (width < 600) {
      return { title: 14, label: 11, tick: 9 };
    }
    return { title: 16, label: 12, tick: 10 };
  },

  /**
   * Create gradient fill for area charts
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {string} color - Base color
   * @param {number} alpha - Max alpha value
   * @returns {CanvasGradient} Gradient fill
   */
  createGradient(ctx, color, alpha = 0.3) {
    const gradient = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
    gradient.addColorStop(0, this.hexToRgba(color, alpha));
    gradient.addColorStop(1, this.hexToRgba(color, 0));
    return gradient;
  },

  /**
   * Convert hex color to rgba
   * @param {string} hex - Hex color
   * @param {number} alpha - Alpha value
   * @returns {string} RGBA color string
   */
  hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  },

  /**
   * Common chart options base
   * @param {Object} options - Override options
   * @returns {Object} Chart.js options
   */
  baseOptions(options = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            usePointStyle: true,
            padding: 15,
            font: { size: 11 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          titleFont: { size: 12 },
          bodyFont: { size: 11 },
          padding: 10,
          cornerRadius: 6
        }
      },
      ...options
    };
  },

  /**
   * Line chart specific options
   * @param {Object} options - Override options
   * @returns {Object} Chart.js options for line charts
   */
  lineChartOptions(options = {}) {
    return this.baseOptions({
      scales: {
        x: {
          grid: { color: COLORS.grid },
          ticks: { font: { size: 10 } }
        },
        y: {
          grid: { color: COLORS.grid },
          ticks: {
            font: { size: 10 },
            callback: (value) => `${(value * 100).toFixed(0)}%`
          },
          min: 0.3,
          max: 0.9
        }
      },
      elements: {
        line: { tension: 0.3 },
        point: { radius: 3, hoverRadius: 5 }
      },
      plugins: {
        ...this.baseOptions().plugins,
        zoom: {
          pan: { enabled: true, mode: 'xy' },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'xy'
          }
        }
      },
      ...options
    });
  },

  /**
   * Bar chart specific options
   * @param {Object} options - Override options
   * @returns {Object} Chart.js options for bar charts
   */
  barChartOptions(options = {}) {
    return this.baseOptions({
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 } }
        },
        y: {
          grid: { color: COLORS.grid },
          ticks: { font: { size: 10 } },
          beginAtZero: true
        }
      },
      ...options
    });
  },

  /**
   * Horizontal bar chart options
   * @param {Object} options - Override options
   * @returns {Object} Chart.js options
   */
  horizontalBarOptions(options = {}) {
    return this.baseOptions({
      indexAxis: 'y',
      scales: {
        x: {
          grid: { color: COLORS.grid },
          ticks: { font: { size: 10 } }
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 10 } }
        }
      },
      ...options
    });
  },

  /**
   * Doughnut/Pie chart options
   * @param {Object} options - Override options
   * @returns {Object} Chart.js options
   */
  doughnutOptions(options = {}) {
    return this.baseOptions({
      cutout: '60%',
      plugins: {
        ...this.baseOptions().plugins,
        legend: {
          position: 'right',
          labels: {
            usePointStyle: true,
            padding: 12,
            font: { size: 10 }
          }
        }
      },
      ...options
    });
  },

  /**
   * Radar chart options
   * @param {Object} options - Override options
   * @returns {Object} Chart.js options
   */
  radarOptions(options = {}) {
    return this.baseOptions({
      scales: {
        r: {
          beginAtZero: true,
          grid: { color: COLORS.grid },
          pointLabels: { font: { size: 10 } },
          ticks: { display: false }
        }
      },
      elements: {
        line: { borderWidth: 2 },
        point: { radius: 3 }
      },
      ...options
    });
  },

  /**
   * Create calibration plot options
   * @returns {Object} Chart.js options
   */
  calibrationPlotOptions() {
    return this.lineChartOptions({
      scales: {
        x: {
          title: {
            display: true,
            text: 'Predicted Probability',
            font: { size: 12 }
          },
          min: 0,
          max: 1,
          ticks: {
            callback: (value) => `${(value * 100).toFixed(0)}%`
          }
        },
        y: {
          title: {
            display: true,
            text: 'Actual Win Rate',
            font: { size: 12 }
          },
          min: 0,
          max: 1,
          ticks: {
            callback: (value) => `${(value * 100).toFixed(0)}%`
          }
        }
      },
      plugins: {
        annotation: {
          annotations: {
            perfectCalibration: {
              type: 'line',
              xMin: 0,
              xMax: 1,
              yMin: 0,
              yMax: 1,
              borderColor: COLORS.reference,
              borderWidth: 1,
              borderDash: [5, 5],
              label: {
                display: true,
                content: 'Perfect Calibration',
                position: 'end'
              }
            }
          }
        }
      }
    });
  },

  /**
   * Create heatmap color scale
   * @param {number} value - Value between 0 and 1
   * @param {string} colorScheme - Color scheme name
   * @returns {string} RGB color
   */
  heatmapColor(value, colorScheme = 'accuracy') {
    const schemes = {
      accuracy: {
        low: [255, 107, 107],   // Red
        mid: [255, 235, 59],    // Yellow
        high: [44, 165, 141]    // Green
      },
      diverging: {
        low: [214, 39, 40],     // Red
        mid: [255, 255, 255],   // White
        high: [31, 119, 180]    // Blue
      },
      sequential: {
        low: [237, 248, 251],
        mid: [102, 194, 164],
        high: [0, 68, 27]
      }
    };

    const scheme = schemes[colorScheme] || schemes.accuracy;

    let r, g, b;
    if (value <= 0.5) {
      const t = value * 2;
      r = Math.round(scheme.low[0] + t * (scheme.mid[0] - scheme.low[0]));
      g = Math.round(scheme.low[1] + t * (scheme.mid[1] - scheme.low[1]));
      b = Math.round(scheme.low[2] + t * (scheme.mid[2] - scheme.low[2]));
    } else {
      const t = (value - 0.5) * 2;
      r = Math.round(scheme.mid[0] + t * (scheme.high[0] - scheme.mid[0]));
      g = Math.round(scheme.mid[1] + t * (scheme.high[1] - scheme.mid[1]));
      b = Math.round(scheme.mid[2] + t * (scheme.high[2] - scheme.mid[2]));
    }

    return `rgb(${r}, ${g}, ${b})`;
  },

  /**
   * Format tooltip value
   * @param {number} value - Value to format
   * @param {string} type - Value type
   * @returns {string} Formatted value
   */
  formatValue(value, type = 'percentage') {
    if (value === null || value === undefined || isNaN(value)) return '—';

    switch (type) {
      case 'percentage':
        return `${(value * 100).toFixed(1)}%`;
      case 'currency':
        return `$${value.toFixed(2)}`;
      case 'decimal':
        return value.toFixed(3);
      case 'integer':
        return Math.round(value).toString();
      default:
        return value.toString();
    }
  },

  /**
   * Create dataset for line chart
   * @param {string} label - Dataset label
   * @param {Array} data - Data points
   * @param {string} color - Line color
   * @param {Object} options - Additional options
   * @returns {Object} Chart.js dataset
   */
  createLineDataset(label, data, color, options = {}) {
    return {
      label,
      data,
      borderColor: color,
      backgroundColor: `${color}20`,
      borderWidth: 2,
      tension: 0.3,
      fill: options.fill ?? false,
      pointRadius: options.pointRadius ?? 3,
      pointHoverRadius: options.pointHoverRadius ?? 5,
      ...options
    };
  },

  /**
   * Create dataset for bar chart
   * @param {string} label - Dataset label
   * @param {Array} data - Data points
   * @param {string|Array} colors - Bar color(s)
   * @param {Object} options - Additional options
   * @returns {Object} Chart.js dataset
   */
  createBarDataset(label, data, colors, options = {}) {
    return {
      label,
      data,
      backgroundColor: colors,
      borderColor: Array.isArray(colors) ? colors.map(c => c) : colors,
      borderWidth: 1,
      borderRadius: 4,
      ...options
    };
  },

  /**
   * Add annotation line to chart
   * @param {Object} chart - Chart instance
   * @param {string} type - 'horizontal' or 'vertical'
   * @param {number} value - Position value
   * @param {string} label - Annotation label
   * @param {string} color - Line color
   */
  addAnnotation(chart, type, value, label, color = COLORS.reference) {
    const annotation = {
      type: 'line',
      borderColor: color,
      borderWidth: 1,
      borderDash: [5, 5],
      label: {
        display: !!label,
        content: label,
        position: 'end'
      }
    };

    if (type === 'horizontal') {
      annotation.yMin = value;
      annotation.yMax = value;
    } else {
      annotation.xMin = value;
      annotation.xMax = value;
    }

    if (!chart.options.plugins.annotation) {
      chart.options.plugins.annotation = { annotations: {} };
    }

    const id = `annotation_${Date.now()}`;
    chart.options.plugins.annotation.annotations[id] = annotation;
    chart.update();
  },

  /**
   * Export chart as image
   * @param {Object} chart - Chart instance
   * @param {string} filename - Download filename
   * @param {string} format - Image format ('png' or 'jpg')
   */
  exportChart(chart, filename = 'chart', format = 'png') {
    const link = document.createElement('a');
    link.download = `${filename}.${format}`;
    link.href = chart.toBase64Image(`image/${format}`, 1);
    link.click();
  },

  /**
   * Create sparkline configuration
   * @param {Array} data - Data points
   * @param {string} color - Line color
   * @returns {Object} Minimal chart config for sparkline
   */
  sparklineConfig(data, color = COLORS.info) {
    return {
      type: 'line',
      data: {
        labels: data.map((_, i) => i),
        datasets: [{
          data,
          borderColor: color,
          borderWidth: 1.5,
          fill: false,
          pointRadius: 0,
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        },
        scales: {
          x: { display: false },
          y: { display: false }
        },
        elements: {
          line: { borderWidth: 1.5 }
        }
      }
    };
  },

  /**
   * Get contrasting text color for background
   * @param {string} bgColor - Background color in hex
   * @returns {string} 'white' or 'black'
   */
  getContrastColor(bgColor) {
    const hex = bgColor.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#ffffff';
  }
};

export default ChartHelpers;
