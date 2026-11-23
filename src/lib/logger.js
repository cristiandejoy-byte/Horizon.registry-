/**
 * Logger minimo en JSON (una linea por evento), sin dependencias.
 * Ideal para CloudWatch: cada linea es un objeto parseable.
 */

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(levelName, message, meta) {
    if (LEVELS[levelName] < threshold) {
      return;
    }

    const entry = {
      level: levelName,
      time: new Date().toISOString(),
      service: 'service-registry',
      message,
      ...(meta ?? {}),
    };

    const line = JSON.stringify(entry);
    if (levelName === 'error' || levelName === 'warn') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    level,
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}
