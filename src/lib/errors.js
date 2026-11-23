/**
 * Errores HTTP y manejadores de Express.
 *
 * Todas las respuestas de error tienen la misma forma:
 *   { "error": { "code": "...", "message": "...", "details": { ... } } }
 */

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, details) {
  return new HttpError(400, 'BAD_REQUEST', message, details);
}

export function notFound(message, details) {
  return new HttpError(404, 'NOT_FOUND', message, details);
}

export function requestLogger(logger) {
  return function logRequest(req, res, next) {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const meta = {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
      };

      if (res.statusCode >= 500) {
        logger.error('Solicitud completada con error', meta);
      } else if (res.statusCode >= 400) {
        logger.warn('Solicitud rechazada', meta);
      } else if (req.path === '/health') {
        logger.debug('Health check', meta);
      } else {
        logger.info('Solicitud completada', meta);
      }
    });

    next();
  };
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
    },
  });
}

export function errorHandler(logger) {
  // Express identifica al manejador de errores por tener 4 argumentos.
  // eslint-disable-next-line no-unused-vars
  return function handleError(err, req, res, next) {
    if (res.headersSent) {
      return next(err);
    }

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Error interno del servicio';
    let details;

    if (err instanceof HttpError) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'El cuerpo de la peticion no es un JSON valido';
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'El cuerpo de la peticion supera el limite de 16 KB';
    } else if (err?.type === 'encoding.unsupported') {
      status = 415;
      code = 'UNSUPPORTED_ENCODING';
      message = 'Codificacion no soportada';
    }

    if (status >= 500) {
      logger.error('Error no controlado', {
        error: err?.message,
        stack: err?.stack,
        method: req.method,
        path: req.originalUrl,
      });
    }

    const body = {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    };

    res.status(status).json(body);
  };
}
