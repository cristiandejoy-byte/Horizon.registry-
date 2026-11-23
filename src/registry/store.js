import { randomUUID } from 'node:crypto';

import { buildUrl } from '../lib/validate.js';

export const STATUS = Object.freeze({
  HEALTHY: 'healthy',
  UNHEALTHY: 'unhealthy',
});

/**
 * Registro de instancias en memoria.
 *
 * Clave de unicidad: name|host|port (normalizados). Volver a registrar la
 * misma combinacion actualiza la instancia existente y conserva su id.
 */
export class RegistryStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, object>} */
    this.instances = new Map();
  }

  static keyOf({ name, host, port }) {
    return `${name}|${host.toLowerCase()}|${port}`;
  }

  toIso(timestamp = this.now()) {
    return new Date(timestamp).toISOString();
  }

  register({ name, host, port, healthPath }) {
    const key = RegistryStore.keyOf({ name, host, port });
    const timestamp = this.toIso();
    const existing = this.instances.get(key);

    if (existing) {
      existing.healthPath = healthPath;
      existing.url = buildUrl(host, port);
      existing.status = STATUS.HEALTHY;
      existing.lastHeartbeat = timestamp;
      existing.updatedAt = timestamp;

      return { instance: { ...existing }, created: false };
    }

    const instance = {
      id: randomUUID(),
      name,
      host,
      port,
      url: buildUrl(host, port),
      healthPath,
      status: STATUS.HEALTHY,
      registeredAt: timestamp,
      updatedAt: timestamp,
      lastHeartbeat: timestamp,
      lastCheck: null,
      lastCheckStatusCode: null,
      lastCheckError: null,
    };

    this.instances.set(key, instance);

    return { instance: { ...instance }, created: true };
  }

  heartbeat({ name, host, port }) {
    const instance = this.instances.get(RegistryStore.keyOf({ name, host, port }));

    if (!instance) {
      return null;
    }

    const timestamp = this.toIso();
    instance.status = STATUS.HEALTHY;
    instance.lastHeartbeat = timestamp;
    instance.updatedAt = timestamp;

    return { ...instance };
  }

  unregister({ name, host, port }) {
    const key = RegistryStore.keyOf({ name, host, port });
    const instance = this.instances.get(key);

    if (!instance) {
      return null;
    }

    this.instances.delete(key);

    return { ...instance };
  }

  get({ name, host, port }) {
    const instance = this.instances.get(RegistryStore.keyOf({ name, host, port }));
    return instance ? { ...instance } : null;
  }

  hasId(id) {
    for (const instance of this.instances.values()) {
      if (instance.id === id) {
        return true;
      }
    }

    return false;
  }

  /** Actualiza el resultado de un health check HTTP. */
  markChecked(id, { ok, statusCode = null, error = null }) {
    const instance = this.findById(id);

    if (!instance) {
      return null;
    }

    const timestamp = this.toIso();
    instance.lastCheck = timestamp;
    instance.lastCheckStatusCode = statusCode;
    instance.lastCheckError = error;
    instance.status = ok ? STATUS.HEALTHY : STATUS.UNHEALTHY;

    // Un health check exitoso demuestra que la instancia sigue viva, asi que
    // tambien renueva el TTL. Esto permite usar el registro sin heartbeat
    // explicito cuando el healthPath es accesible.
    if (ok) {
      instance.lastHeartbeat = timestamp;
    }

    return { ...instance };
  }

  findById(id) {
    for (const instance of this.instances.values()) {
      if (instance.id === id) {
        return instance;
      }
    }

    return null;
  }

  /** Elimina las instancias cuyo ultimo latido supere el TTL indicado. */
  removeExpired(ttlMs, nowMs = this.now()) {
    const removed = [];

    for (const [key, instance] of this.instances) {
      const lastHeartbeat = Date.parse(instance.lastHeartbeat);
      const age = nowMs - (Number.isNaN(lastHeartbeat) ? 0 : lastHeartbeat);

      if (age > ttlMs) {
        this.instances.delete(key);
        removed.push({
          instance: { ...instance },
          ageMs: age,
        });
      }
    }

    return removed;
  }

  snapshot() {
    return [...this.instances.values()].map((instance) => ({ ...instance }));
  }

  totalInstances() {
    return this.instances.size;
  }

  hasService(name) {
    for (const instance of this.instances.values()) {
      if (instance.name === name) {
        return true;
      }
    }

    return false;
  }

  listAll() {
    /** @type {Map<string, object[]>} */
    const grouped = new Map();

    for (const instance of this.instances.values()) {
      const bucket = grouped.get(instance.name);

      if (bucket) {
        bucket.push({ ...instance });
      } else {
        grouped.set(instance.name, [{ ...instance }]);
      }
    }

    return grouped;
  }

  listByName(name) {
    return this.snapshot().filter((instance) => instance.name === name);
  }

  /** Solo instancias healthy, listas para descubrimiento. */
  listHealthy(name) {
    return this.snapshot().filter(
      (instance) => instance.name === name && instance.status === STATUS.HEALTHY,
    );
  }

  describeAll() {
    const grouped = this.listAll();
    const names = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
    const services = {};

    for (const name of names) {
      services[name] = {
        name,
        instances: grouped.get(name),
        totalInstances: grouped.get(name).length,
      };
    }

    return {
      services,
      totalServices: names.length,
      totalInstances: this.instances.size,
      timestamp: this.toIso(),
    };
  }

  clear() {
    this.instances.clear();
  }
}
