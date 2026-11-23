import { isIP } from 'node:net';

import { badRequest } from './errors.js';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export const DEFAULT_HEALTH_PATH = '/health';

function ensureObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest(
      'El cuerpo de la peticion debe ser un objeto JSON con los campos name, host y port',
    );
  }

  return input;
}

export function normalizeServiceName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('"name" es obligatorio y debe ser un texto', {
      field: 'name',
    });
  }

  const name = value.trim().toLowerCase();

  if (!NAME_PATTERN.test(name)) {
    throw badRequest(
      'Formato de "name" invalido: usa minusculas, numeros, guion o guion bajo (max. 63 caracteres y debe empezar por letra o numero)',
      { field: 'name', received: value },
    );
  }

  return name;
}

export function normalizeHost(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('"host" es obligatorio y debe ser un texto', {
      field: 'host',
    });
  }

  const host = value.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    throw badRequest(
      '"host" no debe incluir el esquema (http:// o https://); indica solo el hostname o la IP',
      { field: 'host', received: value },
    );
  }

  if (/[\s/?#@]/.test(host)) {
    throw badRequest(
      '"host" no debe contener espacios, rutas, query strings ni credenciales',
      { field: 'host', received: value },
    );
  }

  const ipVersion = isIP(host);
  if (ipVersion === 0 && !HOSTNAME_PATTERN.test(host)) {
    throw badRequest('"host" no es un hostname o una IP valida', {
      field: 'host',
      received: value,
    });
  }

  return host.toLowerCase();
}

export function normalizePort(value) {
  if (value === undefined || value === null || value === '') {
    throw badRequest('"port" es obligatorio', { field: 'port' });
  }

  const port = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest('"port" debe ser un entero entre 1 y 65535', {
      field: 'port',
      received: value,
    });
  }

  return port;
}

export function normalizeHealthPath(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_HEALTH_PATH;
  }

  if (typeof value !== 'string') {
    throw badRequest('"healthPath" debe ser un texto que empiece por "/"', {
      field: 'healthPath',
    });
  }

  const healthPath = value.trim();

  if (!healthPath.startsWith('/') || /[\s]/.test(healthPath) || healthPath.length > 2048) {
    throw badRequest(
      'Formato de "healthPath" invalido: debe empezar por "/" y no contener espacios',
      { field: 'healthPath', received: value },
    );
  }

  return healthPath;
}

/** Valida el body completo de POST /register. */
export function parseRegistration(input) {
  const body = ensureObject(input);

  return {
    name: normalizeServiceName(body.name),
    host: normalizeHost(body.host),
    port: normalizePort(body.port),
    healthPath: normalizeHealthPath(body.healthPath),
  };
}

/** Valida el identificador de instancia usado por /heartbeat y /unregister. */
export function parseTarget(input) {
  const body = ensureObject(input);

  return {
    name: normalizeServiceName(body.name),
    host: normalizeHost(body.host),
    port: normalizePort(body.port),
  };
}

/** Construye la URL base de la instancia (soporta IPv6 entre corchetes). */
export function buildUrl(host, port) {
  const hostname = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}
