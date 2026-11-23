import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RegistryStore, STATUS } from '../src/registry/store.js';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

function setup() {
  let now = BASE_TIME;
  const store = new RegistryStore({ now: () => now });

  return {
    store,
    advance(ms) {
      now += ms;
    },
  };
}

const channels = {
  name: 'channels',
  host: '127.0.0.1',
  port: 3001,
  healthPath: '/health',
};

describe('RegistryStore', () => {
  it('registra una instancia con id unico, url y estado healthy', () => {
    const { store } = setup();
    const { instance, created } = store.register(channels);

    assert.equal(created, true);
    assert.match(instance.id, /^[0-9a-f-]{36}$/);
    assert.equal(instance.name, 'channels');
    assert.equal(instance.url, 'http://127.0.0.1:3001');
    assert.equal(instance.status, STATUS.HEALTHY);
    assert.equal(instance.lastHeartbeat, '2026-01-01T00:00:00.000Z');
    assert.equal(store.totalInstances(), 1);
  });

  it('no duplica name+host+port y conserva el id original', () => {
    const { store } = setup();
    const first = store.register(channels).instance;
    const second = store.register({ ...channels, healthPath: '/healthz' });

    assert.equal(second.created, false);
    assert.equal(second.instance.id, first.id);
    assert.equal(second.instance.healthPath, '/healthz');
    assert.equal(store.totalInstances(), 1);
  });

  it('normaliza host en la clave de unicidad', () => {
    const { store } = setup();
    store.register({ ...channels, host: 'LocalHost' });
    store.register({ ...channels, host: 'localhost' });

    assert.equal(store.totalInstances(), 1);
  });

  it('renueva lastHeartbeat y marca healthy con heartbeat', () => {
    const { store, advance } = setup();
    const { instance } = store.register(channels);

    store.markChecked(instance.id, { ok: false, statusCode: 500 });
    advance(1000);

    const renewed = store.heartbeat(channels);

    assert.equal(renewed.status, STATUS.HEALTHY);
    assert.equal(renewed.lastHeartbeat, '2026-01-01T00:00:01.000Z');
  });

  it('devuelve null en heartbeat de una instancia desconocida', () => {
    const { store } = setup();
    assert.equal(store.heartbeat(channels), null);
  });

  it('elimina una instancia con unregister', () => {
    const { store } = setup();
    store.register(channels);

    const removed = store.unregister(channels);

    assert.equal(removed.name, 'channels');
    assert.equal(store.totalInstances(), 0);
    assert.equal(store.unregister(channels), null);
  });

  it('listHealthy filtra las instancias unhealthy', () => {
    const { store } = setup();
    const one = store.register(channels).instance;
    store.register({ ...channels, port: 3002 });

    store.markChecked(one.id, { ok: false, statusCode: 503 });

    const healthy = store.listHealthy('channels');
    assert.equal(healthy.length, 1);
    assert.equal(healthy[0].port, 3002);
  });

  it('removeExpired elimina solo las instancias que superan el TTL', () => {
    const { store, advance } = setup();
    store.register(channels); // vieja
    advance(20_000);
    store.register({ ...channels, port: 3002 }); // reciente
    advance(15_000);

    const removed = store.removeExpired(30_000);

    assert.equal(removed.length, 1);
    assert.equal(removed[0].instance.port, 3001);
    assert.equal(removed[0].ageMs, 35_000);
    assert.equal(store.totalInstances(), 1);
    assert.equal(store.listByName('channels')[0].port, 3002);
  });

  it('un health check exitoso renueva el TTL', () => {
    const { store, advance } = setup();
    const { instance } = store.register(channels);

    advance(20_000);
    store.markChecked(instance.id, { ok: true, statusCode: 200 });
    advance(15_000);

    assert.equal(store.removeExpired(30_000).length, 0);
    assert.equal(store.totalInstances(), 1);
  });

  it('describeAll agrupa por nombre y cuenta servicios e instancias', () => {
    const { store } = setup();
    store.register(channels);
    store.register({ ...channels, port: 3002 });
    store.register({ name: 'gateway', host: 'gateway', port: 8080, healthPath: '/health' });

    const description = store.describeAll();

    assert.equal(description.totalServices, 2);
    assert.equal(description.totalInstances, 3);
    assert.deepEqual(Object.keys(description.services), ['channels', 'gateway']);
    assert.equal(description.services.channels.instances.length, 2);
    assert.equal(description.services.channels.totalInstances, 2);
  });

  it('hasService distingue un servicio registrado sin instancias healthy', () => {
    const { store } = setup();
    const { instance } = store.register(channels);
    store.markChecked(instance.id, { ok: false, statusCode: 500 });

    assert.equal(store.hasService('channels'), true);
    assert.equal(store.listHealthy('channels').length, 0);
    assert.equal(store.hasService('events'), false);
  });
});
