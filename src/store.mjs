import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const conditions = ['Good', 'Needs repair', 'Unserviceable'];
export const DIVISIONS = ['', 'LTSAD', 'CRADD', 'LTOD', 'REVDIV'];
const equipmentText = ['propertyNumber', 'name', 'category', 'brand', 'model', 'serialNumber', 'location', 'condition', 'notes'];
const equipmentFields = ['id', ...equipmentText, 'employeeId', 'archived', 'createdAt', 'updatedAt'];
const employeeFields = ['id', 'name', 'position', 'employeeNumber', 'division', 'active', 'createdAt', 'updatedAt'];
const historyFields = ['id', 'equipmentId', 'at', 'action', 'summary', 'before', 'after'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
}
function keys(value, allowed, label, complete = true) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key)) || (complete && allowed.some(key => !Object.hasOwn(value, key)))) fail(`${label} has missing or unsupported fields.`);
}
function string(value, label, required = false) {
  if (typeof value !== 'string' || value.length > 20000 || (required && !value.trim())) fail(`${label} must be ${required ? 'nonempty ' : ''}text (up to 20,000 characters).`);
  return value;
}
function boolean(value, label) { if (typeof value !== 'boolean') fail(`${label} must be true or false.`); }
function uuid(value, label) { if (typeof value !== 'string' || !uuidPattern.test(value)) fail(`${label} must be a valid UUID.`); }
function date(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} must be a valid UTC timestamp.`);
}
function stamps(value, label) {
  uuid(value.id, `${label} ID`);
  date(value.createdAt, `${label} created date`);
  date(value.updatedAt, `${label} updated date`);
  if (value.createdAt > value.updatedAt) fail(`${label} updated date is before its created date.`);
}
function employeeRecord(value) {
  keys(value, employeeFields, 'Employee');
  stamps(value, 'Employee');
  string(value.name, 'Employee name', true);
  string(value.position, 'Position');
  string(value.employeeNumber, 'Employee ID');
  string(value.division, 'Division');
  if (!DIVISIONS.includes(value.division)) fail('Choose a valid division.');
  boolean(value.active, 'Employee active');
}
function employeeDefaults(value) {
  object(value, 'Employee');
  return { employeeNumber: '', division: '', ...value };
}
function equipmentRecord(value, employees, current = true) {
  keys(value, equipmentFields, 'Equipment');
  stamps(value, 'Equipment');
  for (const field of equipmentText) string(value[field], `Equipment ${field}`, ['propertyNumber', 'name'].includes(field));
  if (!conditions.includes(value.condition)) fail('Condition must be Good, Needs repair, or Unserviceable.');
  boolean(value.archived, 'Equipment archived');
  if (value.employeeId !== null) {
    uuid(value.employeeId, 'Assigned employee ID');
    if (!employees.has(value.employeeId)) fail('Assigned employee does not exist.');
    if (current && !value.archived && !employees.get(value.employeeId).active) fail('Choose an active employee or return this equipment before restoring or saving it.');
  }
}
function equal(a, b) {
  if (a === null || b === null) return a === b;
  return equipmentFields.every(key => a[key] === b[key]);
}
function describe(value) { return value ? (value.length > 120 ? value.slice(0, 120) + '…' : value) : '(blank)'; }
function changeTime(previous) {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) : 0, previous ? Date.parse(previous.createdAt) : 0)).toISOString();
}
function uniqueMap(records, label, validate) {
  if (!Array.isArray(records)) fail(`${label} must be a list.`);
  const map = new Map();
  for (const record of records) {
    validate(record);
    if (map.has(record.id)) fail(`Duplicate ${label} ID.`);
    map.set(record.id, record);
  }
  return map;
}
function preview(snapshot) {
  return { savedAt: snapshot.savedAt, officeName: snapshot.settings.officeName, equipmentCount: snapshot.equipment.length, employeeCount: snapshot.employees.length, historyCount: snapshot.history.length };
}
function validateSnapshot(snapshot) {
  keys(snapshot, ['format', 'version', 'savedAt', 'settings', 'employees', 'equipment', 'history'], 'Inventory save');
  if (snapshot.format !== 'office-inventory' || ![1, 2].includes(snapshot.version)) fail('This is not a compatible Office Inventory save (version 1 or 2).');
  date(snapshot.savedAt, 'Save date');
  keys(snapshot.settings, ['officeName'], 'Settings');
  string(snapshot.settings.officeName, 'Office name');
  const employeeNumbers = new Set();
  const employees = uniqueMap(snapshot.employees, 'employee', value => {
    const record = snapshot.version === 1 ? employeeDefaults(value) : value;
    employeeRecord(record);
    const numberKey = record.employeeNumber.trim().toLowerCase();
    if (numberKey && employeeNumbers.has(numberKey)) fail('Duplicate employee ID in inventory save.');
    if (numberKey) employeeNumbers.add(numberKey);
  });
  const propertyNumbers = new Set();
  const equipment = uniqueMap(snapshot.equipment, 'equipment', record => {
    equipmentRecord(record, employees);
    const propertyKey = record.propertyNumber.trim().toLowerCase();
    if (propertyNumbers.has(propertyKey)) fail('Duplicate property number in inventory save.');
    propertyNumbers.add(propertyKey);
  });
  const last = new Map();
  uniqueMap(snapshot.history, 'history', record => {
    keys(record, historyFields, 'History');
    uuid(record.id, 'History ID');
    uuid(record.equipmentId, 'History equipment ID');
    date(record.at, 'History date');
    string(record.action, 'History action', true);
    string(record.summary, 'History summary', true);
    if (!equipment.has(record.equipmentId)) fail('History refers to missing equipment.');
    equipmentRecord(record.after, employees, false);
    if (record.after.id !== record.equipmentId) fail('History equipment ID does not match its snapshot.');
    const preceding = last.get(record.equipmentId);
    if (record.before !== null) {
      equipmentRecord(record.before, employees, false);
      if (record.before.id !== record.equipmentId) fail('History before snapshot has the wrong equipment ID.');
    }
    if ((!preceding && record.before !== null) || (preceding && !equal(preceding.after, record.before))) fail('History snapshots do not form a complete change sequence.');
    if (record.after.updatedAt !== record.at || (preceding && preceding.at > record.at)) fail('History dates do not match the equipment change sequence.');
    last.set(record.equipmentId, record);
  });
  for (const [id, record] of equipment) if (!last.has(id) || !equal(last.get(id).after, record)) fail('Equipment does not match its latest history snapshot.');
  return preview(snapshot);
}

export function createStore({ dataDir }) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'inventory.sqlite'));
  db.exec(`PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES (1, '{"officeName":""}');
    CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS equipment (id TEXT PRIMARY KEY, property_key TEXT NOT NULL UNIQUE, employee_id TEXT REFERENCES employees(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, equipment_id TEXT NOT NULL REFERENCES equipment(id), data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS history_equipment ON history(equipment_id, sequence);`);
  let closed = false;
  const parseRecord = (table, data) => table === 'employees' ? employeeDefaults(JSON.parse(data)) : JSON.parse(data);
  const read = (table) => db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => parseRecord(table, row.data));
  const find = (table, id) => {
    const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    if (!row) fail(`${table === 'employees' ? 'Employee' : 'Equipment'} was not found.`, 404);
    return parseRecord(table, row.data);
  };
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const putEmployee = record => db.prepare('INSERT INTO employees(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.id, JSON.stringify(record));
  const putEquipment = record => db.prepare('INSERT INTO equipment(id,property_key,employee_id,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET property_key=excluded.property_key, employee_id=excluded.employee_id, data=excluded.data').run(record.id, record.propertyNumber.trim().toLowerCase(), record.employeeId, JSON.stringify(record));
  const putHistory = record => db.prepare('INSERT INTO history(id,equipment_id,data) VALUES (?,?,?)').run(record.id, record.equipmentId, JSON.stringify(record));
  const store = {
    getState() { return { settings: JSON.parse(db.prepare('SELECT data FROM settings WHERE id=1').get().data), employees: read('employees'), equipment: read('equipment') }; },
    saveEmployee(input, id) {
      keys(input, ['name', 'position', 'employeeNumber', 'division', 'active'], 'Employee input', false);
      const previous = id === undefined ? null : find('employees', id);
      const now = changeTime(previous);
      const record = { id: previous?.id ?? randomUUID(), name: '', position: '', employeeNumber: '', division: '', active: true, createdAt: now, ...previous, ...input, updatedAt: now };
      record.employeeNumber = string(record.employeeNumber, 'Employee ID').trim();
      record.division = string(record.division, 'Division').trim();
      employeeRecord(record);
      record.name = record.name.trim();
      record.position = record.position.trim();
      if (record.employeeNumber && read('employees').some(employee => employee.id !== record.id && employee.employeeNumber.trim().toLowerCase() === record.employeeNumber.toLowerCase())) fail('This employee ID already exists, including inactive employees.', 409);
      if (!record.active && read('equipment').some(item => item.employeeId === record.id && !item.archived)) fail("Reassign or return this employee's equipment before marking them inactive.");
      putEmployee(record);
      return record;
    },
    saveEquipment(input, id) {
      keys(input, [...equipmentText, 'employeeId', 'archived'], 'Equipment input', false);
      const previous = id === undefined ? null : find('equipment', id);
      const now = changeTime(previous);
      const record = { id: previous?.id ?? randomUUID(), ...Object.fromEntries(equipmentText.map(field => [field, ''])), condition: 'Good', employeeId: null, archived: false, createdAt: now, ...previous, ...input, updatedAt: now };
      const employees = new Map(read('employees').map(employee => [employee.id, employee]));
      equipmentRecord(record, employees);
      for (const field of equipmentText) record[field] = record[field].trim();
      if (record.employeeId !== null && (!previous || record.employeeId !== previous.employeeId) && !employees.get(record.employeeId).active) fail('Choose an active employee for this assignment.');
      const duplicate = db.prepare('SELECT id FROM equipment WHERE property_key=? AND id<>?').get(record.propertyNumber.toLowerCase(), record.id);
      if (duplicate) fail('This property number already exists, including archived equipment.', 409);
      if (previous && equipmentFields.filter(field => field !== 'updatedAt').every(field => previous[field] === record[field])) return previous;
      const changes = [];
      const employeeName = employeeId => employeeId ? describe(employees.get(employeeId).name) : 'Unassigned';
      if (previous && previous.employeeId !== record.employeeId) changes.push(`Assignment: ${employeeName(previous.employeeId)} → ${employeeName(record.employeeId)}`);
      if (previous && previous.archived !== record.archived) changes.push(record.archived ? 'Archived equipment' : 'Restored equipment');
      if (previous) for (const field of equipmentText) if (previous[field] !== record[field]) changes.push(`${field === 'propertyNumber' ? 'Property number' : field[0].toUpperCase() + field.slice(1)}: ${describe(previous[field])} → ${describe(record[field])}`);
      const history = { id: randomUUID(), equipmentId: record.id, at: now, action: previous ? (previous.archived !== record.archived ? (record.archived ? 'archived' : 'restored') : 'updated') : 'created', summary: previous ? changes.join('; ') : `Added ${describe(record.propertyNumber)} — ${describe(record.name)}; assigned to ${employeeName(record.employeeId)}`, before: previous, after: record };
      transaction(() => { putEquipment(record); putHistory(history); });
      return record;
    },
    getHistory(equipmentId) {
      find('equipment', equipmentId);
      return db.prepare('SELECT data FROM history WHERE equipment_id=? ORDER BY sequence').all(equipmentId).map(row => JSON.parse(row.data));
    },
    updateSettings(input) {
      keys(input, ['officeName'], 'Settings');
      const settings = { officeName: string(input.officeName, 'Office name').trim() };
      db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(settings));
      return settings;
    },
    exportSnapshot() { return { format: 'office-inventory', version: 2, savedAt: new Date().toISOString(), ...store.getState(), history: read('history') }; },
    previewSnapshot(snapshot) { return validateSnapshot(snapshot); },
    restoreSnapshot(snapshot) {
      const summary = validateSnapshot(snapshot);
      const recoveryFile = `backups/recovery-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.inventory`;
      // Flush a portable recovery save before entering the replacement transaction.
      mkdirSync(join(dataDir, 'backups'), { recursive: true });
      writeFileSync(join(dataDir, recoveryFile), JSON.stringify(store.exportSnapshot(), null, 2) + '\n', { encoding: 'utf8', flag: 'wx', flush: true });
      transaction(() => {
        db.exec('DELETE FROM history; DELETE FROM equipment; DELETE FROM employees;');
        for (const employee of snapshot.employees) putEmployee(employeeDefaults(employee));
        for (const equipment of snapshot.equipment) putEquipment(equipment);
        for (const history of snapshot.history) putHistory(history);
        db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(snapshot.settings));
      });
      return { summary, recoveryFile };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
  return store;
}
