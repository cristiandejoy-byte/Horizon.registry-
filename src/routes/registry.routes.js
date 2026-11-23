import { Router } from 'express';

import { HttpError, notFound } from '../lib/errors.js';
import {
  normalizeServiceName,
  parseRegistration,
  parseTarget,
} from '../lib/validate.js';

function hasJsonBody(req) {
  return (
    req.body &&
    typeof req.body === 'object' &&
    !Array.isArray(req.body) &&
    Object.keys(req.body).length > 0
  );
}

/**
 * Rutas publicas del registro. No contienen logica de estado: todo vive en
 * RegistryStore y el health checker.
 */
export function createRegistryRouter({ store, logger }) {
  const router = Router();

  // Respuestas de descubrimiento siempre frescas.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/register', (req, res) => {
    const registration = parseRegistration(req.body);
    const { instance, created } = store.register(registration);

    logger.info(created ? 'Instancia registrada' : 'Registro actualizado', {
      id: instance.id,
      name: instance.name,
      host: instance.host,
      port: instance.port,
      healthPath: instance.healthPath,
      status: instance.status,
    });

    res.status(created ? 201 : 200).json(instance);
  });

  const heartbeatHandler = (req, res) => {
    const target = parseTarget(req.body);
    const instance = store.heartbeat(target);

    if (!instance) {
      throw notFound(
        'La instancia no esta registrada. Registrala primero con POST /register',
        { name: target.name, host: target.host, port: target.port },
      );
    }

    logger.debug('Latido renovado', {
      id: instance.id,
      name: instance.name,
      host: instance.host,
      port: instance.port,
    });

    res.status(200).json(instance);
  };

  router.post('/heartbeat', heartbeatHandler);
  router.put('/heartbeat', heartbeatHandler);

  router.delete('/unregister', (req, res) => {
    // Algunos proxies eliminan el body de un DELETE; aceptamos query string
    // (?name=&host=&port=) como alternativa.
    const target = parseTarget(hasJsonBody(req) ? req.body : req.query);
    const removed = store.unregister(target);

    if (!removed) {
      throw notFound('La instancia no esta registrada', {
        name: target.name,
        host: target.host,
        port: target.port,
      });
    }

    logger.info('Instancia dada de baja', {
      id: removed.id,
      name: removed.name,
      host: removed.host,
      port: removed.port,
    });

    res.status(200).json({
      removed: true,
      instance: removed,
      remainingInstances: store.listByName(removed.name).length,
    });
  });

  router.get('/services', (req, res) => {
    res.status(200).json(store.describeAll());
  });

  router.get('/services/:serviceName', (req, res) => {
    let name;

    try {
      name = normalizeServiceName(req.params.serviceName);
    } catch (error) {
      // Un nombre mal formado no puede existir en el registro.
      throw new HttpError(
        404,
        'SERVICE_NOT_FOUND',
        `No hay instancias registradas para el servicio "${req.params.serviceName}"`,
      );
    }

    if (!store.hasService(name)) {
      throw new HttpError(
        404,
        'SERVICE_NOT_FOUND',
        `No hay instancias registradas para el servicio "${name}"`,
      );
    }

    const instances = store.listHealthy(name);

    res.status(200).json({
      name,
      instances,
      count: instances.length,
      // 200 con lista vacia: el servicio existe pero no tiene instancias
      // saludables en este momento; el cliente puede reintentar.
      ...(instances.length === 0
        ? { message: 'El servicio esta registrado pero no tiene instancias saludables' }
        : {}),
    });
  });

  return router;
}
