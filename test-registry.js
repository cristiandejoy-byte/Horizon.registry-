#!/usr/bin/env node
/**
 * Prueba de humo end-to-end del Service Registry.
 *
 * Levanta dos instancias reales del servicio (una normal y otra con TTL corto),
 * registra varias instancias de ejemplo, descubre servicios, renueva latidos,
 * da de baja instancias y verifica la limpieza automatica por TTL.
 *
 * Uso:
 *   npm test                 # levanta sus propios procesos
 *   node test-registry.js
 *
 * No requiere dependencias externas: usa fetch y node:assert de Node 20+.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url));
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (text) => (COLOR ? `\u001b[32m${text}\u001b[0m` : text);
const red = (text) => (COLOR ? `\u001b[31m${text}\u001b[0m` : text);
const dim = (text) => (COLOR ? `\u001b[90m${text}\u001b[0m` : text);

const registryProcesses = [];
const dummyServers = [];
let checksPassed = 0;

function ok(label, extra = '') {
  checksPassed += 1;
  console.log(`  ${green('✓')} ${label}${extra ? dim(` — ${extra}`) : ''}`);
}

async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (error) {
    console.error(`  ${red('✗')} ${label}`);
    throw error;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startDummyService(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      dummyServers.push(server);
      resolve(server);
    });
  });
}

async function startRegistry(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const entry = { child, port, baseUrl: `http://127.0.0.1:${port}`, output: () => output };
  registryProcesses.push(entry);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `El Service Registry del puerto ${port} termino durante el arranque.\n${output}`,
      );
    }

    try {
      const response = await fetch(`${entry.baseUrl}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return entry;
      }
    } catch {
      // todavia no escucha; reintentar
    }

    await delay(150);
  }

  throw new Error(`Timeout esperando el Service Registry en el puerto ${port}.\n${output}`);
}

async function stopProcess(entry) {
  if (entry.child.exitCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => entry.child.once('exit', resolve));
  entry.child.kill('SIGTERM');

  await Promise.race([exited, delay(3000)]);
  if (entry.child.exitCode === null) {
    entry.child.kill('SIGKILL');
    await Promise.race([exited, delay(1000)]);
  }
}

async function request(baseUrl, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  const text = await response.text();
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  return { status: response.status, body: json, headers: response.headers };
}

async function cleanup() {
  for (const entry of registryProcesses) {
    await stopProcess(entry).catch(() => {});
  }

  await Promise.all(
    dummyServers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );

  // Cierra conexiones keep-alive que pudieran quedar abiertas.
  dummyServers.length = 0;
}

async function main() {
  console.log('\n▶ Prueba de humo del Service Registry de Horizon\n');

  const [mainPort, channelsPortA, channelsPortB, deadPort, ttlPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);

  await startDummyService(channelsPortA);
  await startDummyService(channelsPortB);

  const registry = await startRegistry(mainPort, {
    HEALTH_CHECK_INTERVAL_MS: '300',
    INSTANCE_TTL_MS: '30000',
    HEALTH_CHECK_TIMEOUT_MS: '200',
  });
  const base = registry.baseUrl;

  console.log(dim(`  Registry principal: ${base}`));
  console.log(
    dim(`  Instancias simuladas de channels: ${channelsPortA} y ${channelsPortB}\n`),
  );

  await check('GET /health responde 200 con status ok', async () => {
    const { status, body } = await request(base, 'GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'service-registry');
    assert.equal(body.registeredInstances, 0);
  });

  await check('GET /services empieza vacio', async () => {
    const { status, body } = await request(base, 'GET', '/services');
    assert.equal(status, 200);
    assert.equal(body.totalServices, 0);
    assert.equal(body.totalInstances, 0);
    assert.deepEqual(body.services, {});
  });

  let gateway;
  await check('POST /register registra el gateway (201)', async () => {
    const { status, body } = await request(base, 'POST', '/register', {
      name: 'gateway',
      host: '127.0.0.1',
      port: 5181,
      healthPath: '/health',
    });

    assert.equal(status, 201);
    assert.ok(body.id);
    assert.equal(body.name, 'gateway');
    assert.equal(body.url, 'http://127.0.0.1:5181');
    assert.equal(body.status, 'healthy');
    assert.ok(body.lastHeartbeat);
    gateway = body;
  });

  let channelA;
  let channelB;
  await check('POST /register registra channels en dos puertos (2 instancias)', async () => {
    const a = await request(base, 'POST', '/register', {
      name: 'channels',
      host: '127.0.0.1',
      port: channelsPortA,
      healthPath: '/health',
    });
    const b = await request(base, 'POST', '/register', {
      name: 'channels',
      host: '127.0.0.1',
      port: channelsPortB,
      healthPath: '/health',
    });

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.id, b.body.id);
    channelA = a.body;
    channelB = b.body;
  });

  await check('POST /register duplicado no crea otra instancia y conserva el id', async () => {
    const { status, body } = await request(base, 'POST', '/register', {
      name: 'channels',
      host: '127.0.0.1',
      port: channelsPortA,
      healthPath: '/health',
    });

    assert.equal(status, 200);
    assert.equal(body.id, channelA.id);

    const all = await request(base, 'GET', '/services');
    assert.equal(all.body.totalServices, 2);
    assert.equal(all.body.totalInstances, 3);
    assert.equal(all.body.services.channels.instances.length, 2);
  });

  await check('GET /services agrupa por nombre e incluye los campos esperados', async () => {
    const { status, body } = await request(base, 'GET', '/services');

    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.services), ['channels', 'gateway']);

    const instance = body.services.channels.instances[0];
    assert.ok(instance.id);
    assert.equal(instance.host, '127.0.0.1');
    assert.ok(Number.isInteger(instance.port));
    assert.match(instance.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(instance.status, 'healthy');
    assert.ok(instance.lastHeartbeat);
    assert.equal(body.services.gateway.instances[0].id, gateway.id);
  });

  await check('GET /services/channels devuelve solo instancias saludables', async () => {
    const { status, body } = await request(base, 'GET', '/services/channels');

    assert.equal(status, 200);
    assert.equal(body.name, 'channels');
    assert.equal(body.count, 2);
    assert.equal(body.instances.length, 2);
    assert.ok(body.instances.every((instance) => instance.status === 'healthy'));
    assert.deepEqual(
      body.instances.map((instance) => instance.port).sort((a, b) => a - b),
      [channelsPortA, channelsPortB].sort((a, b) => a - b),
    );
  });

  await check('GET /services/:name de un servicio desconocido responde 404', async () => {
    const { status, body } = await request(base, 'GET', '/services/events');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'SERVICE_NOT_FOUND');
  });

  await check('PUT /heartbeat renueva lastHeartbeat', async () => {
    await delay(60);

    const { status, body } = await request(base, 'PUT', '/heartbeat', {
      name: 'channels',
      host: '127.0.0.1',
      port: channelsPortA,
    });

    assert.equal(status, 200);
    assert.equal(body.id, channelA.id);
    assert.ok(
      Date.parse(body.lastHeartbeat) >= Date.parse(channelA.lastHeartbeat),
      'lastHeartbeat debe avanzar o mantenerse',
    );
    channelA = body;
  });

  await check('POST /heartbeat tambien funciona (alias)', async () => {
    const { status, body } = await request(base, 'POST', '/heartbeat', {
      name: 'gateway',
      host: '127.0.0.1',
      port: 5181,
    });

    assert.equal(status, 200);
    assert.equal(body.id, gateway.id);
  });

  await check('POST /heartbeat de una instancia desconocida responde 404', async () => {
    const { status, body } = await request(base, 'POST', '/heartbeat', {
      name: 'channels',
      host: '127.0.0.1',
      port: 65000,
    });

    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  await check('POST /register valida puerto y host (400)', async () => {
    const invalidPort = await request(base, 'POST', '/register', {
      name: 'channels',
      host: '127.0.0.1',
      port: 0,
    });
    const invalidHost = await request(base, 'POST', '/register', {
      name: 'channels',
      host: 'http://127.0.0.1',
      port: 3001,
    });

    assert.equal(invalidPort.status, 400);
    assert.equal(invalidPort.body.error.code, 'BAD_REQUEST');
    assert.equal(invalidHost.status, 400);
    assert.equal(invalidHost.body.error.code, 'BAD_REQUEST');
  });

  await check('JSON mal formado responde 400 INVALID_JSON', async () => {
    const response = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name": "channels",',
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_JSON');
  });

  await check('GET de una ruta inexistente responde 404', async () => {
    const { status, body } = await request(base, 'GET', '/no-existe');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'ROUTE_NOT_FOUND');
  });

  await check('DELETE /unregister con query string da de baja la instancia', async () => {
    const { status, body } = await request(
      base,
      'DELETE',
      `/unregister?name=channels&host=127.0.0.1&port=${channelsPortB}`,
    );

    assert.equal(status, 200);
    assert.equal(body.removed, true);
    assert.equal(body.instance.id, channelB.id);
    assert.equal(body.remainingInstances, 1);
  });

  await check('GET /services/channels refleja la baja (queda 1 instancia)', async () => {
    const { status, body } = await request(base, 'GET', '/services/channels');
    assert.equal(status, 200);
    assert.equal(body.count, 1);
    assert.equal(body.instances[0].id, channelA.id);
  });

  await check('DELETE /unregister repetido responde 404', async () => {
    const { status, body } = await request(base, 'DELETE', '/unregister', {
      name: 'channels',
      host: '127.0.0.1',
      port: channelsPortB,
    });

    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  await check('una instancia con health inaccesible pasa a unhealthy', async () => {
    const broken = await request(base, 'POST', '/register', {
      name: 'broken',
      host: '127.0.0.1',
      port: deadPort,
      healthPath: '/health',
    });
    assert.equal(broken.status, 201);

    await delay(1200);

    const { status, body } = await request(base, 'GET', '/services/broken');
    assert.equal(status, 200);
    assert.equal(body.count, 0);
    assert.match(body.message, /no tiene instancias saludables/);

    const all = await request(base, 'GET', '/services');
    assert.equal(all.body.services.broken.instances[0].status, 'unhealthy');
    assert.ok(all.body.services.broken.instances[0].lastCheckError);
  });

  // --- Limpieza automatica por TTL -------------------------------------
  console.log('');
  const ttlRegistry = await startRegistry(ttlPort, {
    HEALTH_CHECK_INTERVAL_MS: '500',
    INSTANCE_TTL_MS: '2000',
    HEALTH_CHECK_TIMEOUT_MS: '300',
  });
  const ttlBase = ttlRegistry.baseUrl;

  console.log(dim(`  Registry con TTL corto: ${ttlBase}\n`));

  await check('GET /health del registry con TTL corto responde 200', async () => {
    const { status } = await request(ttlBase, 'GET', '/health');
    assert.equal(status, 200);
  });

  await check('registra una instancia fantasma y una viva (self)', async () => {
    const ghost = await request(ttlBase, 'POST', '/register', {
      name: 'ghost',
      host: '127.0.0.1',
      port: deadPort,
      healthPath: '/health',
    });
    const alive = await request(ttlBase, 'POST', '/register', {
      name: 'self',
      host: '127.0.0.1',
      port: ttlPort,
      healthPath: '/health',
    });

    assert.equal(ghost.status, 201);
    assert.equal(alive.status, 201);
  });

  await check('expira la instancia sin latido y conserva la que responde health', async () => {
    // TTL 2 s + interval 0.5 s: esperamos a que el sweeper actue varias veces.
    await delay(4000);

    const { status, body } = await request(ttlBase, 'GET', '/services');
    assert.equal(status, 200);
    assert.equal(body.services.ghost, undefined, 'ghost debio eliminarse por TTL');
    assert.ok(body.services.self, 'self debio renovarse con los health checks');
    assert.equal(body.services.self.instances[0].status, 'healthy');
  });

  await check('POST /register invalido en el registry con TTL corto (400)', async () => {
    const { status } = await request(ttlBase, 'POST', '/register', {
      name: 'INVALID NAME',
      host: '127.0.0.1',
      port: 3001,
    });
    assert.equal(status, 400);
  });

  console.log(`\n${green('✔')} ${checksPassed} comprobaciones correctas\n`);
}

let exitCode = 0;

try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(`\n${red('✗ Prueba fallida:')} ${error.message}\n`);
} finally {
  await cleanup();

  if (exitCode === 0) {
    console.log(dim('  Procesos de prueba detenidos.\n'));
  }

  process.exit(exitCode);
}
