const path = require('path');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const CURRENT_LEVEL = process.env.LOG_LEVEL || 'info';

function getCaller() {
  const stack = new Error().stack || '';
  const lines = stack.split('\n').map((line) => line.trim());
  const frame = lines.find((line) => line.includes(process.cwd()) && !line.includes('logger.js'));
  if (!frame) {
    return { file: 'unknown', line: 0 };
  }

  const match = frame.match(/\(?(.+):(\d+):(\d+)\)?$/);
  if (!match) {
    return { file: 'unknown', line: 0 };
  }

  return {
    file: path.relative(process.cwd(), match[1]),
    line: Number(match[2])
  };
}

function log(level, message, meta = {}) {
  if (LEVELS[level] < LEVELS[CURRENT_LEVEL]) {
    return;
  }

  const caller = getCaller();
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    file: caller.file,
    line: caller.line,
    message,
    ...meta
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

module.exports = {
  debug: (message, meta) => log('debug', message, meta),
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta)
};
