import express from 'express';

import { errorHandler, notFoundHandler, requestLogger } from './lib/errors.js';
import { createRegistryRouter } from './routes/registry.routes.js';

/**
 * Construye la app Express. Se exporta como factory para poder instanciarla
 * en tests con un store y un logger controlados.
 */
export function createApp({ store, logger, config }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '16kb', strict: true }));
  app.use(requestLogger(logger));

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'service-registry',
      version: process.env.npm_package_version ?? '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      registeredServices: store.listAll().size,
      registeredInstances: store.totalInstances(),
      healthCheck: {
        intervalMs: config.healthCheckIntervalMs,
        instanceTtlMs: config.instanceTtlMs,
        timeoutMs: config.healthCheckTimeoutMs,
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.use(createRegistryRouter({ store, logger }));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
