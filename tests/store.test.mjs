import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/store.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'office-store-'));
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, open(name = 'one') { const store = createStore({ dataDir: join(root, name) }); stores.push(store); return store; } };
}
function fails(status, callback) {
  assert.throws(callback, error => error.status === status && typeof error.message === 'string' && error.message.length > 4);
}
function populated(store) {
  const employee = store.saveEmployee({ name: 'Ana Santos', position: 'Clerk' });
  const item = store.saveEquipment({ propertyNumber: 'PC-01', name: 'Desktop', employeeId: employee.id });
  return { employee, item };
}

test('starts empty, persists employees, settings, equipment and full assignment history across restart', t => {
  const env = setup(t);
  let store = env.open();
  assert.deepEqual(store.getState(), { settings: { officeName: '' }, employees: [], equipment: [] });
  store.updateSettings({ officeName: ' Records Office ' });
  const { employee, item } = populated(store);
  const second = store.saveEmployee({ name: 'Ben Cruz' });
  const transferred = store.saveEquipment({ employeeId: second.id, notes: 'Transferred to records' }, item.id);
  store.saveEquipment({ archived: true }, item.id);
  const restored = store.saveEquipment({ archived: false, employeeId: null }, item.id);
  const history = store.getHistory(item.id);
  assert.equal(history.length, 4);
  assert.equal(history[0].before, null);
  assert.deepEqual(history[0].after, item);
  assert.deepEqual(history[1].before, item);
  assert.deepEqual(history[1].after, transferred);
  assert.match(history[1].summary, /Ana Santos.*Ben Cruz/);
  assert.match(history[2].summary, /archiv/i);
  assert.match(history[3].summary, /restor/i);
  assert.deepEqual(history[3].after, restored);
  store.saveEmployee({ active: false }, employee.id);
  const snapshot = store.exportSnapshot();
  store.close();
  store = env.open();
  assert.deepEqual(store.getState().settings, { officeName: 'Records Office' });
  assert.deepEqual(store.exportSnapshot().equipment, snapshot.equipment);
  assert.deepEqual(store.exportSnapshot().employees, snapshot.employees);
  assert.deepEqual(store.getHistory(item.id), history);
});

test('rejects duplicate property numbers, invalid inputs and missing references without partial changes', t => {
  const store = setup(t).open();
  const { employee, item } = populated(store);
  const unchanged = store.exportSnapshot();
  fails(409, () => store.saveEquipment({ propertyNumber: ' pc-01 ', name: 'Duplicate' }));
  fails(400, () => store.saveEquipment({ name: 'Missing number' }));
  fails(400, () => store.saveEquipment({ propertyNumber: 'X', name: 'X', condition: 'Excellent' }));
  fails(400, () => store.saveEquipment({ employeeId: randomUUID() }, item.id));
  fails(400, () => store.saveEmployee({ active: 'false' }, employee.id));
  fails(404, () => store.saveEmployee({ name: 'Absent' }, randomUUID()));
  fails(404, () => store.getHistory(randomUUID()));
  assert.deepEqual(store.exportSnapshot().equipment, unchanged.equipment);
  assert.deepEqual(store.exportSnapshot().history, unchanged.history);
  assert.equal(store.saveEquipment({ propertyNumber: ' PC-01 ' }, item.id).propertyNumber, 'PC-01');
  store.saveEquipment({ archived: true }, item.id);
  store.saveEmployee({ active: false }, employee.id);
  store.saveEquipment({ notes: 'Archived assignment to former employee' }, item.id);
  fails(400, () => store.saveEquipment({ propertyNumber: 'PC-02', name: 'Another', employeeId: employee.id }));
  fails(409, () => store.saveEquipment({ propertyNumber: 'pc-01', name: 'Still duplicate' }));
});

test('deactivation requires returning, transferring or archiving every active assignment', t => {
  const store = setup(t).open();
  const { employee, item } = populated(store);
  assert.throws(() => store.saveEmployee({ active: false }, employee.id), error => error.status === 400 && /Reassign or return/.test(error.message));
  assert.equal(store.getState().employees[0].active, true);
  store.saveEquipment({ employeeId: null }, item.id);
  assert.equal(store.saveEmployee({ active: false }, employee.id).active, false);
  store.saveEmployee({ active: true }, employee.id);
  store.saveEquipment({ employeeId: employee.id }, item.id);
  const second = store.saveEmployee({ name: 'Transfer recipient' });
  store.saveEquipment({ employeeId: second.id }, item.id);
  assert.equal(store.saveEmployee({ active: false }, employee.id).active, false);
  store.saveEquipment({ archived: true }, item.id);
  assert.equal(store.saveEmployee({ active: false }, second.id).active, false);
  assert.equal(store.getState().equipment[0].employeeId, second.id);
  assert.equal(store.getHistory(item.id).at(-1).after.employeeId, second.id);
  assert.doesNotThrow(() => store.previewSnapshot(store.exportSnapshot()));
});

test('restoring archived equipment requires returning it or choosing an active employee', t => {
  const store = setup(t).open();
  const { employee, item } = populated(store);
  store.saveEquipment({ archived: true }, item.id);
  store.saveEmployee({ active: false }, employee.id);
  const unchanged = store.exportSnapshot();
  fails(400, () => store.saveEquipment({ archived: false }, item.id));
  assert.deepEqual(store.getState(), targetState(unchanged));
  assert.deepEqual(store.getHistory(item.id), unchanged.history);
  const restored = store.saveEquipment({ archived: false, employeeId: null }, item.id);
  assert.equal(restored.employeeId, null);
  assert.equal(restored.archived, false);
  assert.equal(store.getHistory(item.id)[0].after.employeeId, employee.id);
  assert.doesNotThrow(() => store.previewSnapshot(store.exportSnapshot()));
});

test('import refuses active equipment assigned to an inactive employee but preserves inactive historical references', t => {
  const env = setup(t);
  const source = env.open();
  const target = env.open('target');
  const { employee, item } = populated(source);
  const invalid = source.exportSnapshot();
  invalid.employees[0].active = false;
  target.saveEmployee({ name: 'Existing target employee' });
  const prior = target.exportSnapshot();
  fails(400, () => target.previewSnapshot(invalid));
  fails(400, () => target.restoreSnapshot(invalid));
  assert.deepEqual(target.getState(), targetState(prior));
  source.saveEquipment({ employeeId: null }, item.id);
  source.saveEmployee({ active: false }, employee.id);
  const valid = source.exportSnapshot();
  assert.equal(valid.history[0].after.employeeId, employee.id);
  target.restoreSnapshot(valid);
  assert.deepEqual(target.getState(), source.getState());
  assert.deepEqual(target.getHistory(item.id), valid.history);
});

test('portable export replaces another database and automatic recovery restores its prior records', t => {
  const env = setup(t);
  const source = env.open('source');
  const target = env.open('target');
  const { item } = populated(source);
  source.updateSettings({ officeName: 'Source Office' });
  source.saveEquipment({ condition: 'Needs repair' }, item.id);
  target.saveEmployee({ name: 'Prior Employee' });
  target.updateSettings({ officeName: 'Target Office' });
  const prior = target.exportSnapshot();
  const exported = JSON.parse(JSON.stringify(source.exportSnapshot()));
  assert.deepEqual(target.previewSnapshot(exported), { savedAt: exported.savedAt, officeName: 'Source Office', employeeCount: 1, equipmentCount: 1, historyCount: 2 });
  const result = target.restoreSnapshot(exported);
  assert.match(result.recoveryFile, /^backups\/[^/]+\.inventory$/);
  assert.deepEqual(target.getState(), source.getState());
  assert.deepEqual(target.getHistory(item.id), source.getHistory(item.id));
  const recovery = JSON.parse(readFileSync(join(env.root, 'target', result.recoveryFile), 'utf8'));
  assert.deepEqual(recovery.employees, prior.employees);
  target.restoreSnapshot(recovery);
  assert.deepEqual(target.getState(), { settings: prior.settings, employees: prior.employees, equipment: prior.equipment });
  target.close();
  assert.deepEqual(env.open('target').getState(), targetState(prior));
});
function targetState(snapshot) { return { settings: snapshot.settings, employees: snapshot.employees, equipment: snapshot.equipment }; }

test('validates complete imported schema, dates, IDs, references and history before changing any data', t => {
  const store = setup(t).open();
  const { item } = populated(store);
  const original = store.exportSnapshot();
  const cases = [
    s => { s.version = 3; },
    s => { s.format = 'another-app'; },
    s => { s.savedAt = '2026-02-30T00:00:00.000Z'; },
    s => { s.settings.officeName = 3; },
    s => { s.employees[0].active = 1; },
    s => { s.employees[0].id = 'not-a-uuid'; },
    s => { s.employees.push(structuredClone(s.employees[0])); },
    s => { s.equipment[0].archived = 'false'; },
    s => { s.equipment[0].employeeId = randomUUID(); },
    s => { s.equipment[0].updatedAt = 'bad'; },
    s => { s.equipment[0].createdAt = '2099-01-01T00:00:00.000Z'; },
    s => { s.equipment[0].condition = 'unknown'; },
    s => { s.equipment.push({ ...s.equipment[0], id: randomUUID(), propertyNumber: ' pc-01 ' }); },
    s => { s.history.push(structuredClone(s.history[0])); },
    s => { s.history[0].equipmentId = randomUUID(); },
    s => { s.history[0].after.id = randomUUID(); },
    s => { s.history[0].after.employeeId = randomUUID(); },
    s => { s.history[0].after.name = 'Out of sync'; },
    s => { delete s.equipment[0].notes; },
    s => { s.history = []; },
  ];
  for (const corrupt of cases) {
    const value = structuredClone(original);
    corrupt(value);
    fails(400, () => store.previewSnapshot(value));
    fails(400, () => store.restoreSnapshot(value));
    assert.deepEqual(store.getState(), targetState(original));
    assert.deepEqual(store.getHistory(item.id), original.history);
  }
  for (const value of [null, [], {}, 'broken', { ...original, equipment: null }]) fails(400, () => store.restoreSnapshot(value));
});

test('equipment write and history commit atomically, and a failed replacement rolls back all records', t => {
  const env = setup(t);
  const store = env.open();
  const { item } = populated(store);
  const original = store.exportSnapshot();
  const connection = new DatabaseSync(join(env.root, 'one', 'inventory.sqlite'));
  try {
    connection.exec("CREATE TRIGGER reject_history BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'Test write failure'); END;");
    assert.throws(() => store.saveEquipment({ name: 'Changed' }, item.id), /Test write failure/);
    assert.deepEqual(store.getState(), targetState(original));
    assert.deepEqual(store.getHistory(item.id), original.history);
    const incoming = structuredClone(original);
    incoming.settings.officeName = 'Replacement office';
    incoming.employees[0].name = 'Replacement employee';
    assert.throws(() => store.restoreSnapshot(incoming), /Test write failure/);
    assert.deepEqual(store.getState(), targetState(original));
    assert.deepEqual(store.getHistory(item.id), original.history);
  } finally { connection.close(); }
});

test('recovery filesystem failure prevents replacement', t => {
  const env = setup(t);
  const store = env.open();
  populated(store);
  const original = store.exportSnapshot();
  writeFileSync(join(env.root, 'one', 'backups'), 'blocked');
  const incoming = structuredClone(original);
  incoming.settings.officeName = 'Must not save';
  assert.throws(() => store.restoreSnapshot(incoming));
  assert.deepEqual(store.getState(), targetState(original));
  assert.deepEqual(store.exportSnapshot().history, original.history);
});

test('readable history of maximum-length notes can be previewed and restored', t => {
  const env = setup(t);
  const store = env.open();
  const { item } = populated(store);
  store.saveEquipment({ notes: 'a'.repeat(20000) }, item.id);
  store.saveEquipment({ notes: 'b'.repeat(20000) }, item.id);
  const snapshot = store.exportSnapshot();
  const other = env.open('other');
  other.previewSnapshot(snapshot);
  other.restoreSnapshot(snapshot);
  assert.deepEqual(other.getHistory(item.id), snapshot.history);
});

test('editing a save from a faster computer preserves monotonic dates and portable history', t => {
  const env = setup(t);
  const source = env.open();
  const { employee, item } = populated(source);
  const snapshot = source.exportSnapshot();
  const futureCreated = new Date(Date.now() + 60000).toISOString();
  const futureUpdated = new Date(Date.now() + 120000).toISOString();
  snapshot.savedAt = futureUpdated;
  for (const record of [snapshot.employees[0], snapshot.equipment[0], snapshot.history[0].after]) {
    record.createdAt = futureCreated;
    record.updatedAt = futureUpdated;
  }
  snapshot.history[0].at = futureUpdated;
  const target = env.open('target');
  target.restoreSnapshot(snapshot);
  const editedEmployee = target.saveEmployee({ position: 'Updated locally' }, employee.id);
  const editedEquipment = target.saveEquipment({ notes: 'Edited on slower computer' }, item.id);
  assert.ok(editedEmployee.updatedAt >= futureUpdated);
  assert.ok(editedEquipment.updatedAt >= futureUpdated);
  assert.equal(editedEmployee.createdAt, futureCreated);
  assert.equal(editedEquipment.createdAt, futureCreated);
  const exported = target.exportSnapshot();
  assert.equal(target.getHistory(item.id).at(-1).at, editedEquipment.updatedAt);
  assert.doesNotThrow(() => target.previewSnapshot(exported));
  const third = env.open('third');
  third.restoreSnapshot(exported);
  assert.deepEqual(third.getState(), target.getState());
  assert.deepEqual(third.getHistory(item.id), target.getHistory(item.id));
});

test('employee numbers and divisions persist through edits and restart without changing assignments', t => {
  const env = setup(t);
  let store = env.open();
  const employee = store.saveEmployee({ name: ' Ana Santos ', position: ' Clerk ', employeeNumber: ' PTO-001 ', division: ' LTSAD ' });
  const item = store.saveEquipment({ propertyNumber: 'PC-01', name: 'Desktop', employeeId: employee.id });
  assert.equal(employee.employeeNumber, 'PTO-001');
  assert.equal(employee.division, 'LTSAD');
  const edited = store.saveEmployee({ division: 'CRADD' }, employee.id);
  assert.equal(edited.employeeNumber, 'PTO-001');
  assert.equal(edited.id, employee.id);
  store.close();
  store = env.open();
  assert.deepEqual(store.getState().employees, [edited]);
  assert.equal(store.getState().equipment[0].employeeId, employee.id);
  assert.equal(store.getHistory(item.id)[0].after.employeeId, employee.id);
});

test('employee numbers are unique when present and invalid employee details never change data', t => {
  const store = setup(t).open();
  const employee = store.saveEmployee({ name: 'Ana Santos', employeeNumber: 'PTO-001', division: 'LTOD' });
  const second = store.saveEmployee({ name: 'Ben Cruz' });
  const third = store.saveEmployee({ name: 'Cora Reyes', employeeNumber: ' ' });
  assert.equal(second.employeeNumber, '');
  assert.equal(second.division, '');
  assert.equal(third.employeeNumber, '');
  const before = store.getState();
  fails(409, () => store.saveEmployee({ name: 'Duplicate', employeeNumber: ' pto-001 ' }));
  fails(409, () => store.saveEmployee({ employeeNumber: 'pto-001' }, second.id));
  for (const input of [{ employeeNumber: 1 }, { employeeNumber: null }, { division: 'UNKNOWN' }, { division: false }, { division: null }]) {
    fails(400, () => store.saveEmployee(input, employee.id));
  }
  assert.deepEqual(store.getState(), before);
  assert.equal(store.saveEmployee({ employeeNumber: ' PTO-001 ', division: 'REVDIV' }, employee.id).division, 'REVDIV');
});

test('version 2 saves preserve employee details and history and reject missing fields or duplicate employee numbers', t => {
  const env = setup(t);
  const source = env.open();
  const employee = source.saveEmployee({ name: 'Ana Santos', employeeNumber: 'PTO-001', division: 'LTSAD' });
  source.saveEmployee({ name: 'Ben Cruz', employeeNumber: 'PTO-002', division: 'CRADD' });
  const item = source.saveEquipment({ propertyNumber: 'PC-01', name: 'Desktop', employeeId: employee.id });
  source.saveEquipment({ notes: 'Preserve this history' }, item.id);
  const snapshot = source.exportSnapshot();
  assert.equal(snapshot.version, 2);
  const target = env.open('target');
  target.restoreSnapshot(snapshot);
  assert.deepEqual(target.getState(), source.getState());
  assert.deepEqual(target.getHistory(item.id), source.getHistory(item.id));
  const before = target.getState();
  for (const corrupt of [
    s => { delete s.employees[0].employeeNumber; },
    s => { delete s.employees[0].division; },
    s => { s.employees[0].division = 'UNKNOWN'; },
    s => { s.employees[1].employeeNumber = ' pto-001 '; },
  ]) {
    const invalid = structuredClone(snapshot);
    corrupt(invalid);
    fails(400, () => target.previewSnapshot(invalid));
    fails(400, () => target.restoreSnapshot(invalid));
    assert.deepEqual(target.getState(), before);
  }
});

test('legacy version 1 saves gain blank employee details while malformed records remain rejected', t => {
  const env = setup(t);
  const source = env.open();
  const { employee, item } = populated(source);
  const legacy = source.exportSnapshot();
  legacy.version = 1;
  delete legacy.employees[0].employeeNumber;
  delete legacy.employees[0].division;
  const untouched = structuredClone(legacy);
  const target = env.open('target');
  target.previewSnapshot(legacy);
  target.restoreSnapshot(legacy);
  assert.deepEqual(legacy, untouched);
  assert.deepEqual(target.getState().employees[0], { ...legacy.employees[0], employeeNumber: '', division: '' });
  assert.equal(target.getState().equipment[0].employeeId, employee.id);
  assert.deepEqual(target.getHistory(item.id), legacy.history);
  const migrated = target.exportSnapshot();
  assert.equal(migrated.version, 2);
  assert.doesNotThrow(() => target.previewSnapshot(migrated));
  for (const corrupt of [
    s => { s.employees[0] = []; },
    s => { s.employees[0] = null; },
    s => { delete s.employees[0].position; },
    s => { s.employees[0].unexpected = ''; },
    s => { s.employees[0].employeeNumber = null; },
    s => { s.employees[0].division = null; },
  ]) {
    const invalid = structuredClone(legacy);
    corrupt(invalid);
    fails(400, () => target.previewSnapshot(invalid));
    fails(400, () => target.restoreSnapshot(invalid));
  }
  assert.deepEqual(target.getState(), targetState(migrated));
});

test('legacy database employee records can be read, exported and edited without changing their identity', t => {
  const env = setup(t);
  let store = env.open();
  const { employee, item } = populated(store);
  const legacy = { ...employee };
  delete legacy.employeeNumber;
  delete legacy.division;
  store.close();
  const connection = new DatabaseSync(join(env.root, 'one', 'inventory.sqlite'));
  connection.prepare('UPDATE employees SET data=? WHERE id=?').run(JSON.stringify(legacy), employee.id);
  connection.close();
  store = env.open();
  assert.deepEqual(store.getState().employees[0], { ...legacy, employeeNumber: '', division: '' });
  assert.doesNotThrow(() => store.previewSnapshot(store.exportSnapshot()));
  const edited = store.saveEmployee({ position: 'Senior Clerk' }, employee.id);
  assert.equal(edited.id, employee.id);
  assert.equal(edited.employeeNumber, '');
  assert.equal(edited.division, '');
  assert.equal(store.getState().equipment[0].employeeId, employee.id);
  assert.equal(store.getHistory(item.id)[0].after.employeeId, employee.id);
});
