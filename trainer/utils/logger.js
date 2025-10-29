const LEVELS = new Map([
  ['debug', 'DEBUG'],
  ['info', 'INFO'],
  ['warn', 'WARN'],
  ['error', 'ERROR']
]);

function format(level, args) {
  const tag = LEVELS.get(level) || level.toUpperCase();
  const timestamp = new Date().toISOString();
  return [`[${timestamp}] [${tag}]`, ...args];
}

function logWith(consoleMethod, level, args) {
  const fn = typeof console[consoleMethod] === 'function' ? console[consoleMethod] : console.log;
  fn(...format(level, args));
}

export const logger = {
  debug: (...args) => {
    if (process.env.LOG_LEVEL === 'debug') {
      logWith('debug', 'debug', args);
    }
  },
  info: (...args) => logWith('log', 'info', args),
  warn: (...args) => logWith('warn', 'warn', args),
  error: (...args) => logWith('error', 'error', args)
};

export default logger;
