import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, createServer } from 'node:http';
import { startApp } from '../src/server.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-http-'));
  const app = await startApp({ dataDir, port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (path, method = 'GET', body, headers = {}) => fetch(app.url + path, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-inventory-request': '1' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, request };
}

test('HTTP persists an assignment and returns history and a portable save', async (t) => {
  const { request } = await fixture(t);
  const employeeResponse = await request('/api/employees', 'POST', { name: 'Test Person', position: 'Encoder' });
  assert.equal(employeeResponse.status, 201);
  const employee = await employeeResponse.json();
  const equipmentResponse = await request('/api/equipment', 'POST', { propertyNumber: 'EQ-001', name: 'Laptop', employeeId: employee.id });
  assert.equal(equipmentResponse.status, 201);
  const equipment = await equipmentResponse.json();
  const history = await (await request(`/api/equipment/${equipment.id}/history`)).json();
  assert.ok(history.length >= 1);
  const state = await (await request('/api/state')).json();
  assert.equal(state.equipment[0].employeeId, employee.id);
  const save = await request('/api/backups/download');
  assert.equal(save.status, 200);
  assert.match(save.headers.get('content-disposition'), /\.inventory/);
  const snapshot = await save.json();
  assert.equal(snapshot.equipment.length, 1);
  const preview = await (await request('/api/backups/preview', 'POST', snapshot)).json();
  assert.equal(preview.equipmentCount, 1);
  assert.equal((await request('/api/backups/restore', 'POST', { snapshot })).status, 400);
  const restore = await request('/api/backups/restore', 'POST', { snapshot, confirm: true });
  assert.equal(restore.status, 200);
  assert.match((await restore.json()).recoveryFile, /\.inventory$/);
});

test('cross-site/foreign-host calls, missing mutation header, bad JSON and traversal are rejected', async (t) => {
  const { app, request } = await fixture(t);
  assert.equal((await request('/api/state', 'GET', undefined, { origin: 'https://elsewhere.example' })).status, 403);
  const foreignHostStatus = await new Promise((done, reject) => {
    const req = httpRequest(app.url + '/api/state', { headers: { host: 'elsewhere.example' } }, res => { res.resume(); res.on('end', () => done(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await request('/api/state', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/employees', 'POST', { name: 'Nope' }, { 'x-inventory-request': '' })).status, 403);
  const malformed = await fetch(app.url + '/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', 'x-inventory-request': '1' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await request('/src/store.mjs')).status, 404);
  assert.equal((await request('/data/inventory.sqlite')).status, 404);
  assert.equal((await request('/..%2f..%2fpackage.json')).status, 404);
  const denied = await request('/internal/shutdown', 'POST', {}, { authorization: 'Bearer wrong' });
  assert.equal(denied.status, 403);
  assert.equal((await request('/api/health')).status, 200);
});

test('validation errors use a readable envelope; failed loads preserve data', async (t) => {
  const { request } = await fixture(t);
  const created = await request('/api/equipment', 'POST', { propertyNumber: 'A-1', name: 'Monitor' });
  assert.equal(created.status, 201);
  const bad = await request('/api/equipment', 'POST', { propertyNumber: ' a-1 ', name: 'Duplicate' });
  assert.ok([400, 409].includes(bad.status));
  assert.equal(typeof (await bad.json()).error, 'string');
  const before = await (await request('/api/state')).json();
  const badLoad = await request('/api/backups/restore', 'POST', { snapshot: { version: 999 }, confirm: true });
  assert.equal(badLoad.status, 400);
  assert.deepEqual(await (await request('/api/state')).json(), before);
});

test('occupied preferred port falls back to an actual free loopback port and stops only its own instance', async t => {
  const occupant = createServer((req, res) => { res.end('Original occupant'); });
  await new Promise((done, reject) => { occupant.once('error', reject); occupant.listen(0, '127.0.0.1', done); });
  const preferredPort = occupant.address().port;
  const occupantUrl = `http://127.0.0.1:${preferredPort}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'office-port-'));
  let app;
  t.after(async () => {
    if (app) await app.close();
    await new Promise(done => occupant.close(done));
    await rm(dataDir, { recursive: true, force: true });
  });
  app = await startApp({ dataDir, port: preferredPort, writeRuntime: true });
  const actualPort = Number(new URL(app.url).port);
  assert.equal(new URL(app.url).hostname, '127.0.0.1');
  assert.notEqual(actualPort, preferredPort);
  assert.ok(actualPort > 0);
  const runtimeFile = join(dataDir, 'runtime.json');
  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
  assert.equal(runtime.port, actualPort);
  const response = await fetch(app.url + '/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).instanceId, runtime.instanceId);
  assert.equal(await (await fetch(occupantUrl)).text(), 'Original occupant');
  const stopped = await fetch(app.url + '/internal/shutdown', { method: 'POST', headers: { authorization: `Bearer ${runtime.shutdownToken}` } });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { stopped: true });
  await app.close();
  await assert.rejects(readFile(runtimeFile, 'utf8'), { code: 'ENOENT' });
  assert.equal(await (await fetch(occupantUrl)).text(), 'Original occupant');
});

test('invalid requested port fails instead of silently choosing a different port', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-bad-port-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(startApp({ dataDir, port: -1 }), { code: 'ERR_SOCKET_BAD_PORT' });
});

test('HTTP employee edits retain employee numbers and divisions in state and portable saves', async t => {
  const { request } = await fixture(t);
  const response = await request('/api/employees', 'POST', { name: 'Ana Santos', employeeNumber: ' PTO-001 ', division: 'LTSAD' });
  assert.equal(response.status, 201);
  const employee = await response.json();
  const update = await request(`/api/employees/${employee.id}`, 'PUT', { division: 'REVDIV' });
  assert.equal(update.status, 200);
  const state = await (await request('/api/state')).json();
  assert.equal(state.employees[0].employeeNumber, 'PTO-001');
  assert.equal(state.employees[0].division, 'REVDIV');
  const duplicate = await request('/api/employees', 'POST', { name: 'Duplicate', employeeNumber: 'pto-001' });
  assert.equal(duplicate.status, 409);
  assert.equal((await request(`/api/employees/${employee.id}`, 'PUT', { division: 'OTHER' })).status, 400);
  const snapshot = await (await request('/api/backups/download')).json();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.employees[0].employeeNumber, 'PTO-001');
  assert.equal(snapshot.employees[0].division, 'REVDIV');
  assert.equal((await request('/api/backups/restore', 'POST', { snapshot, confirm: true })).status, 200);
  assert.deepEqual(await (await request('/api/state')).json(), state);
});
