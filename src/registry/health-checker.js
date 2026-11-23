import axios from 'axios';

/**
 * Health checker periodico.
 *
 * En cada ciclo:
 *  1. Elimina las instancias que superen el TTL sin latido (ni health check OK).
 *  2. Hace GET al healthPath de cada instancia restante, en paralelo y con
 *     timeout, marcandolas como healthy/unhealthy.
 *
 * Un unico flag `running` evita solapamientos si un ciclo tarda mas de lo
 * esperado. El intervalo usa unref() para no impedir que el proceso termine.
 */
export function createHealthChecker({ store, logger, intervalMs, ttlMs, timeoutMs }) {
  let timer = null;
  let running = false;
  let stopped = false;

  async function probe(instance) {
    const startedAt = Date.now();
    const url = `${instance.url}${instance.healthPath}`;

    try {
      const response = await axios.get(url, {
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        // No lanzar por status: registramos el codigo real y decidimos abajo.
        validateStatus: () => true,
        headers: {
          'user-agent': 'horizon-service-registry/1.0',
          accept: 'application/json, text/plain, */*',
        },
      });

      const ok = response.status >= 200 && response.status < 300;

      return {
        ok,
        statusCode: response.status,
        latencyMs: Date.now() - startedAt,
        error: ok ? null : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: error.response?.status ?? null,
        latencyMs: Date.now() - startedAt,
        error: error.code || error.message || 'ERROR_DESCONOCIDO',
      };
    }
  }

  async function runOnce() {
    if (running || stopped) {
      return { skipped: true, expired: 0, checked: 0, healthy: 0, unhealthy: 0 };
    }

    running = true;

    const summary = {
      skipped: false,
      expired: 0,
      checked: 0,
      healthy: 0,
      unhealthy: 0,
    };

    try {
      const expired = store.removeExpired(ttlMs);
      summary.expired = expired.length;

      for (const { instance, ageMs } of expired) {
        logger.warn('Instancia expirada por falta de latido', {
          id: instance.id,
          name: instance.name,
          host: instance.host,
          port: instance.port,
          lastHeartbeat: instance.lastHeartbeat,
          ageMs,
          ttlMs,
        });
      }

      const targets = store.snapshot();

      await Promise.allSettled(
        targets.map(async (instance) => {
          const result = await probe(instance);

          // La instancia pudo darse de baja mientras respondia el ping.
          if (!store.hasId(instance.id)) {
            return;
          }

          store.markChecked(instance.id, result);
          summary.checked += 1;

          if (result.ok) {
            summary.healthy += 1;
          } else {
            summary.unhealthy += 1;
            logger.debug('Health check fallido', {
              id: instance.id,
              name: instance.name,
              url: `${instance.url}${instance.healthPath}`,
              statusCode: result.statusCode,
              error: result.error,
              latencyMs: result.latencyMs,
            });
          }
        }),
      );

      return summary;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer || stopped) {
      return;
    }

    timer = setInterval(() => {
      runOnce().catch((error) => {
        logger.error('Error inesperado en el health checker', {
          error: error?.message,
          stack: error?.stack,
        });
      });
    }, intervalMs);

    // No mantener vivo el proceso solo por este intervalo.
    timer.unref?.();

    logger.info('Health checker iniciado', {
      intervalMs,
      ttlMs,
      timeoutMs,
    });
  }

  function stop() {
    stopped = true;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    runOnce,
  };
}
