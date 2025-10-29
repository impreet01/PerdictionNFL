// trainer/utils/logger.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve repo root as two levels up from utils/
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(REPO_ROOT, 'logs');

export const levels = /** @type {const} */ ({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
});

function clampLevel(name) {
  const n = String(name || '').toLowerCase();
  return n in levels ? n : 'info';
}

function isoDateOnly(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function openDailyStream(dateStr) {
  ensureLogDir();
  const filePath = path.join(LOG_DIR, `nfl-train-${dateStr}.log`);
  try {
    return fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' });
  } catch {
    return null;
  }
}

class Logger {
  /**
   * @param {object} opts
   * @param {string} opts.level
   * @param {Record<string, any>} [opts.bindings]
   */
  constructor({ level, bindings = {} } = {}) {
    this._levelName = clampLevel(level);
    this._level = levels[this._levelName];
    this._bindings = { ...bindings };

    this._currentDate = isoDateOnly();
    this._stream = openDailyStream(this._currentDate);

    // bind methods for ease of use
    this.trace = this._log.bind(this, 'trace');
    this.debug = this._log.bind(this, 'debug');
    this.info = this._log.bind(this, 'info');
    this.warn = this._log.bind(this, 'warn');
    this.error = this._log.bind(this, 'error');
  }

  setLevel(name) {
    this._levelName = clampLevel(name);
    this._level = levels[this._levelName];
  }

  getLevel() {
    return this._levelName;
  }

  /**
   * @param {Record<string, any>} bindings
   */
  child(bindings = {}) {
    return new Logger({
      level: this._levelName,
      bindings: { ...this._bindings, ...bindings },
    });
  }

  /**
   * @param {string} label
   * @param {Record<string, any>} [ctx]
   */
  withTimer(label, ctx = {}) {
    const start = process.hrtime.bigint();
    return {
      end: (extra = {}) => {
        const end = process.hrtime.bigint();
        const durationMs = Number(end - start) / 1e6;
        this.info(`${label} completed`, { ...ctx, ...extra, label, durationMs: Math.round(durationMs) });
      },
    };
  }

  wireGlobalHandlers() {
    process.on('unhandledRejection', (reason) => {
      this.error('Unhandled promise rejection', { error: serializeError(reason) });
    });
    process.on('uncaughtException', (err) => {
      this.error('Uncaught exception', { error: serializeError(err) });
    });
  }

  _rotateIfNeeded(now = new Date()) {
    const today = isoDateOnly(now);
    if (today !== this._currentDate) {
      try {
        this._stream?.end?.();
      } catch {}
      this._currentDate = today;
      this._stream = openDailyStream(today);
    }
  }

  _shouldLog(levelName) {
    return levels[levelName] >= this._level;
  }

  /**
   * Core logger
   * @param {'trace'|'debug'|'info'|'warn'|'error'} levelName
   * @param {any} msg
   * @param {Record<string, any>} [ctx]
   */
  _log(levelName, msg, ctx = {}) {
    if (!this._shouldLog(levelName)) return;

    this._rotateIfNeeded();

    const now = new Date();
    const time = now.toISOString();

    const baseCtx = { ...this._bindings, ...ctx };
    let message = '';
    /** @type {Record<string, any> | undefined} */
    let errorObj;

    if (msg instanceof Error) {
      message = msg.message;
      errorObj = serializeError(msg);
    } else if (typeof msg === 'string') {
      message = msg;
    } else {
      // non-string messages get stringified, but also preserved in ctx.payload
      message = safeToString(msg);
      if (baseCtx && typeof baseCtx === 'object') {
        baseCtx.payload = msg;
      }
    }

    // Console line
    const consoleLine =
      `${time} ${levelName.toUpperCase()} ${message}` +
      (baseCtx && Object.keys(baseCtx).length ? ` ${safeJson(baseCtx)}` : '');
    try {
      // eslint-disable-next-line no-console
      console[levelName === 'warn' ? 'warn' : levelName === 'error' ? 'error' : 'log'](consoleLine);
    } catch {
      // best-effort
      // eslint-disable-next-line no-console
      console.log(consoleLine);
    }

    // File JSON line
    const fileLineObj = {
      time,
      level: levelName,
      message,
      ctx: baseCtx && Object.keys(baseCtx).length ? baseCtx : undefined,
      ...(errorObj ? { error: errorObj } : null),
    };

    const payload = JSON.stringify(fileLineObj) + '\n';
    try {
      this._stream?.write?.(payload);
    } catch {
      // ignore file write errors to avoid crashing
    }
  }
}

function serializeError(e) {
  if (!e) return undefined;
  if (e instanceof Error) {
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
    };
  }
  if (typeof e === 'object') {
    const { name, message, stack } = /** @type {any} */ (e);
    return { name: name || 'Error', message: message || safeToString(e), stack };
  }
  return { name: 'Error', message: safeToString(e) };
}

function safeToString(v) {
  try {
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserializable]"';
  }
}

/**
 * Factory to create a logger with optional bindings & level
 * @param {{ level?: string, bindings?: Record<string, any> }} [opts]
 */
export function createLogger(opts = {}) {
  const level = clampLevel(opts.level || process.env.LOG_LEVEL || 'info');
  return new Logger({ level, bindings: opts.bindings || {} });
}

// Default singleton root logger
const logger = createLogger();
export default logger;
