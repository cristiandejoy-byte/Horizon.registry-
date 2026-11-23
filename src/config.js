/**
 * Configuracion del Service Registry.
 *
 * Toda la configuracion llega por variables de entorno. Si algun valor es
 * invalido el proceso falla al arrancar (fail-fast) para no dejar el servicio
 * en un estado ambiguo dentro de ECS.
 */

const DEFAULTS = {
  port: 8761,
  host: '0.0.0.0',
  healthCheckIntervalMs: 10_000,
  instanceTtlMs: 30_000,
  healthCheckTimeoutMs: 2_000,
  logLevel: 'info',
};

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);

function readInteger(env, key, fallback, { min, max }) {
  const raw = env[key];

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }

  const value = Number(String(raw).trim());

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${key} debe ser un entero entre ${min} y ${max} (valor recibido: "${raw}")`,
    );
  }

  return value;
}

export function loadConfig(env = process.env) {
  const config = {
    port: readInteger(env, 'PORT', DEFAULTS.port, { min: 1, max: 65535 }),
    host: (env.HOST || DEFAULTS.host).trim() || DEFAULTS.host,
    healthCheckIntervalMs: readInteger(
      env,
      'HEALTH_CHECK_INTERVAL_MS',
      DEFAULTS.healthCheckIntervalMs,
      { min: 100, max: 3_600_000 },
    ),
    instanceTtlMs: readInteger(env, 'INSTANCE_TTL_MS', DEFAULTS.instanceTtlMs, {
      min: 100,
      max: 86_400_000,
    }),
    healthCheckTimeoutMs: readInteger(
      env,
      'HEALTH_CHECK_TIMEOUT_MS',
      DEFAULTS.healthCheckTimeoutMs,
      { min: 50, max: 60_000 },
    ),
    logLevel: (env.LOG_LEVEL || DEFAULTS.logLevel).toLowerCase(),
  };

  if (!LOG_LEVELS.has(config.logLevel)) {
    throw new Error(
      `LOG_LEVEL invalido: "${config.logLevel}". Valores permitidos: ${[...LOG_LEVELS].join(', ')}`,
    );
  }

  if (config.instanceTtlMs <= config.healthCheckIntervalMs) {
    throw new Error(
      `INSTANCE_TTL_MS (${config.instanceTtlMs}) debe ser mayor que HEALTH_CHECK_INTERVAL_MS (${config.healthCheckIntervalMs}) para no expirar instancias entre comprobaciones`,
    );
  }

  if (config.healthCheckTimeoutMs >= config.healthCheckIntervalMs) {
    // No es un error: el health checker protege contra solapamientos, pero
    // conviene avisar porque una instancia lenta puede retrasar el ciclo.
    console.warn(
      `[config] HEALTH_CHECK_TIMEOUT_MS (${config.healthCheckTimeoutMs}) >= HEALTH_CHECK_INTERVAL_MS (${config.healthCheckIntervalMs}); considera reducirlo`,
    );
  }

  return config;
}
