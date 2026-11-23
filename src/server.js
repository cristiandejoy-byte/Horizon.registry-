import 'dotenv/config';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { createHealthChecker } from './registry/health-checker.js';
import { RegistryStore } from './registry/store.js';

let config;

try {
  config = loadConfig();
} catch (error) {
  console.error(`[config] ${error.message}`);
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const store = new RegistryStore();
const healthChecker = createHealthChecker({
  store,
  logger,
  intervalMs: config.healthCheckIntervalMs,
  ttlMs: config.instanceTtlMs,
  timeoutMs: config.healthCheckTimeoutMs,
});

const app = createApp({ store, logger, config });

const server = app.listen(config.port, config.host, () => {
  logger.info('Service Registry escuchando', {
    host: config.host,
    port: config.port,
    healthCheckIntervalMs: config.healthCheckIntervalMs,
    instanceTtlMs: config.instanceTtlMs,
    healthCheckTimeoutMs: config.healthCheckTimeoutMs,
    nodeVersion: process.version,
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`El puerto ${config.port} ya esta en uso`);
  } else {
    logger.error('Error del servidor HTTP', {
      error: error.message,
      stack: error.stack,
    });
  }

  process.exit(1);
});

healthChecker.start();

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info('Apagando Service Registry', { signal });

  healthChecker.stop();

  const forceExit = setTimeout(() => {
    logger.error('Cierre forzado: el servidor no respondio a tiempo');
    process.exit(1);
  }, 10_000);

  forceExit.unref();

  server.close((error) => {
    clearTimeout(forceExit);

    if (error) {
      logger.error('Error al cerrar el servidor HTTP', { error: error.message });
      process.exit(1);
    }

    logger.info('Service Registry detenido correctamente');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Promesa rechazada sin manejar', {
    error: reason instanceof Error ? reason.stack : String(reason),
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Excepcion no controlada', {
    error: error.message,
    stack: error.stack,
  });
  shutdown('uncaughtException');
});
