'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatMessageArgs } from 'node:util';

export const levels = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
});

function normalizeLevel(levelName) {
  const name = typeof levelName === 'string' ? levelName.toLowerCase() : '';
  if (Object.prototype.hasOwnProperty.call(levels, name)) {
    return name;
  }
  return 'info';
}

const defaultLevelName = normalizeLevel(process.env.LOG_LEVEL || 'info');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logsDir = path.resolve(__dirname, 'logs');

const baseConsole = /** @type {Record<string, (...args: unknown[]) => void>} */ ({});
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  if (typeof console[method] === 'function') {
    baseConsole[method] = console[method].bind(console);
  }
}
if (!baseConsole.log) {
  baseConsole.log = (...args) => process.stdout.write(`${args.join(' ')}\n`);
}

let logsDirEnsured = false;

function ensureLogsDir() {
  try {
    if (!logsDirEnsured) {
      fs.mkdirSync(logsDir, { recursive: true });
      logsDirEnsured = true;
    }
    return true;
  } catch (err) {
    logsDirEnsured = false;
    console.error('logger: unable to create logs directory', err);
    return false;
  }
}

function getLogFilePath(date = new Date()) {
  const iso = date.toISOString();
  const day = iso.slice(0, 10);
  return path.join(logsDir, `nfl-train-${day}.log`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const consoleMethodToLevel = Object.freeze({
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
  trace: 'trace',
});

function buildConsolePayload(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return { message: '' };
  }

  const [first] = args;
  if (first instanceof Error) {
    const extras = args.slice(1);
    const payload = {
      message: extras.length ? formatMessageArgs(...extras) : first.message,
      error: first,
    };
    if (extras.length) {
      payload.context = { args: extras };
    }
    return payload;
  }

  let formatArgs = args.slice();
  let context;
  if (formatArgs.length > 1) {
    const last = formatArgs[formatArgs.length - 1];
    if (isObject(last) && !(last instanceof Error)) {
      context = last;
      formatArgs = formatArgs.slice(0, -1);
    }
  }

  if (formatArgs.length === 0) {
    formatArgs = [''];
  }

  const message = formatMessageArgs(...formatArgs);
  if (!context && formatArgs.length > 1) {
    context = { args: formatArgs.slice(1) };
  }

  return context ? { message, context } : { message };
}

class Logger {
  constructor({ level = defaultLevelName, bindings = {} } = {}) {
    this.levelName = normalizeLevel(level);
    this.levelValue = levels[this.levelName];
    this.bindings = isObject(bindings) ? { ...bindings } : {};
  }

  child(bindings = {}) {
    const mergedBindings = { ...this.bindings };
    if (isObject(bindings)) {
      Object.assign(mergedBindings, bindings);
    }
    return new Logger({ level: this.levelName, bindings: mergedBindings });
  }

  setLevel(levelName) {
    const normalized = normalizeLevel(levelName);
    this.levelName = normalized;
    this.levelValue = levels[normalized];
  }

  trace(message, ctx) {
    this._log('trace', message, ctx);
  }

  debug(message, ctx) {
    this._log('debug', message, ctx);
  }

  info(message, ctx) {
    this._log('info', message, ctx);
  }

  warn(message, ctx) {
    this._log('warn', message, ctx);
  }

  error(message, ctx) {
    this._log('error', message, ctx);
  }

  _log(levelName, message, ctx) {
    if (levels[levelName] < this.levelValue) {
      return;
    }

    const time = new Date();
    const isoTime = time.toISOString();
    const isError = message instanceof Error;
    const msgText = isError ? message.message : formatMessage(message);
    const context = this._buildContext(ctx);

    const consoleLine = this._formatConsoleLine(isoTime, levelName, msgText, context, isError ? message : null);
    this._writeConsole(levelName, consoleLine);

    this._writeFile(time, levelName, msgText, context, isError ? message : null);
  }

  _buildContext(ctx) {
    const base = { ...this.bindings };
    if (isObject(ctx)) {
      return Object.keys(ctx).length === 0 ? base : { ...base, ...ctx };
    }
    if (ctx !== undefined) {
      base.value = ctx;
    }
    return base;
  }

  _formatConsoleLine(isoTime, levelName, message, context, error) {
    const parts = [isoTime, levelName.toUpperCase(), message];
    const contextForConsole = { ...context };
    if (error) {
      contextForConsole.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    if (Object.keys(contextForConsole).length > 0) {
      parts.push(JSON.stringify(contextForConsole));
    }
    return parts.join(' ');
  }

  _writeConsole(levelName, line) {
    const consoleMethod = {
      trace: 'log',
      debug: 'debug',
      info: 'info',
      warn: 'warn',
      error: 'error',
    }[levelName] || 'log';

    const writer = baseConsole[consoleMethod] || baseConsole.log;
    writer(line);
  }

  _writeFile(date, levelName, message, context, error) {
    const entry = {
      time: date.toISOString(),
      level: levelName,
      message,
      ctx: context,
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    let filePath;
    try {
      if (!ensureLogsDir()) {
        return;
      }
      filePath = getLogFilePath(date);
    } catch (err) {
      console.error('logger: unable to resolve log file path', err);
      return;
    }

    const line = `${JSON.stringify(entry)}\n`;
    fs.promises.appendFile(filePath, line).catch((err) => {
      console.error('logger: failed to append log entry', err);
    });
  }
}

function formatMessage(value) {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

export function createLogger(options = {}) {
  return new Logger(options);
}

const rootLogger = createLogger();

let consoleLoggerInstalled = false;

export function installLogger({ logger = rootLogger, bindings, interceptConsole = true } = {}) {
  const targetLogger = bindings ? logger.child(bindings) : logger;

  if (!consoleLoggerInstalled && interceptConsole) {
    consoleLoggerInstalled = true;

    const consoleTarget = targetLogger.child({ source: 'console' });
    consoleTarget.setLevel('trace');

    for (const [method, levelName] of Object.entries(consoleMethodToLevel)) {
      console[method] = (...args) => {
        const payload = buildConsolePayload(args);
        if (method === 'trace') {
          const stack = new Error().stack;
          const context = payload.context ? { ...payload.context, stack } : { stack };
          consoleTarget.trace(payload.message || 'Trace', context);
          return;
        }

        if (payload.error) {
          consoleTarget[levelName](payload.error, payload.context);
        } else {
          consoleTarget[levelName](payload.message, payload.context);
        }
      };
    }

    process.on('uncaughtException', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      targetLogger.error(error, { event: 'uncaughtException' });
    });

    process.on('unhandledRejection', (reason) => {
      if (reason instanceof Error) {
        targetLogger.error(reason, { event: 'unhandledRejection' });
      } else {
        targetLogger.error('Unhandled rejection', {
          event: 'unhandledRejection',
          reason,
        });
      }
    });
  }

  return targetLogger;
}

export default rootLogger;
