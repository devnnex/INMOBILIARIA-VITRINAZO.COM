import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const input = { nombre: 'María López', usuario: 'maria.admin', email: 'maria@example.com', telefono: '+57 300 555 1234' };
function harness() {
  const admin = { id: 'ADM-OWNER', estado: 'ACTIVO', nombre: 'Administrador', usuario: 'admin', pinSalt: 'old-salt', pinHash: hash('old-salt1234') };
  const properties = { ADMIN_SESSION_VERSION: '1' }, sessions = new Map(), writes = [];
  let locked = false;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] ?? null, setProperty: (key, value) => { properties[key] = value; } }) },
    CacheService: { getScriptCache: () => ({ get: key => sessions.get(key) ?? null, put: (key, value) => sessions.set(key, value), remove: key => sessions.delete(key) }) },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(locked, false); locked = true; }, releaseLock() { locked = false; } }) },
    Utilities: { getUuid: randomUUID, sleep() {}, formatDate: () => '2026-11-04T12:00:00-05:00', DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (algorithm, value) => [...createHash(algorithm).update(value).digest()].map(byte => byte > 127 ? byte - 256 : byte) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: value => ({ value, setMimeType() { return this; } }) }
  });
  vm.runInContext(source, context);
  context.ensureProjectReady_ = () => {};
  context.getDb_ = () => ({ getSheetByName: () => ({}) });
  context.getRows_ = () => [{ ...admin }];
  context.findDataRow_ = () => 2;
  context.setCellByHeader_ = (sheet, row, headers, key, value) => { assert.equal(locked, true); writes.push({ key, value }); admin[key] = value; };
  const login = () => context.adminLogin('1234').token;
  return { context, admin, properties, sessions, writes, login };
}

test('profile endpoints reject unauthenticated requests and never disclose PIN material', () => {
  const h = harness();
  assert.throws(() => h.context.getAdminProfile('invalid'), /sesión/);
  assert.throws(() => h.context.updateAdminProfile('invalid', input), /sesión/);
  assert.equal(h.writes.length, 0);
  const login = h.context.adminLogin('1234');
  for (const result of [login.admin, h.context.getAdminProfile(login.token).admin]) {
    assert.deepEqual(Object.keys(result).sort(), ['email', 'id', 'nombre', 'telefono', 'usuario']);
    assert.ok(!JSON.stringify(result).includes(h.admin.pinHash));
    assert.ok(!JSON.stringify(result).includes(h.admin.pinSalt));
  }
});

test('profile persists safe fields without altering PIN or accepting administrative overrides', () => {
  const h = harness(), token = h.login(), oldHash = h.admin.pinHash;
  const result = h.context.updateAdminProfile(token, { ...input, id: 'OTHER', estado: 'INACTIVO', pinHash: 'attacker', pinSalt: 'attacker' });
  assert.equal(result.pinChanged, false);
  assert.equal(result.token, token);
  assert.equal(h.admin.pinHash, oldHash);
  assert.equal(h.admin.id, 'ADM-OWNER');
  assert.equal(h.admin.estado, 'ACTIVO');
  assert.equal(h.context.getAdminProfile(token).admin.email, input.email);
  assert.deepEqual(JSON.parse(h.properties['ADMIN_PROFILE_ADM-OWNER']), { email: input.email, telefono: input.telefono });
  assert.equal(h.context.adminLogin('1234').admin.nombre, input.nombre);
});

test('wrong current PIN, invalid new PIN and confirmation mismatch cause no profile or credential writes', () => {
  const h = harness(), token = h.login();
  const count = h.writes.length;
  for (const change of [
    { currentPin: '0000', newPin: '5678', confirmPin: '5678' },
    { currentPin: '1234', newPin: '123', confirmPin: '123' },
    { currentPin: '1234', newPin: '123abc', confirmPin: '123abc' },
    { currentPin: '1234', newPin: '5678', confirmPin: '5679' }
  ]) assert.throws(() => h.context.updateAdminProfile(token, { ...input, ...change }), /PIN/);
  assert.equal(h.writes.length, count);
  assert.equal(h.properties['ADMIN_PROFILE_ADM-OWNER'], undefined);
  assert.equal(h.context.adminLogin('1234').ok, true);
});

test('PIN rotation stores a salted hash, invalidates all prior sessions and keeps the current admin signed in', () => {
  const h = harness(), token = h.login(), another = h.login();
  const oldSalt = h.admin.pinSalt;
  const result = h.context.updateAdminProfile(token, { ...input, currentPin: '1234', newPin: '005678', confirmPin: '005678' });
  assert.equal(result.pinChanged, true);
  assert.notEqual(result.token, token);
  assert.notEqual(h.admin.pinSalt, oldSalt);
  assert.equal(h.admin.pinHash, hash(h.admin.pinSalt + '005678'));
  assert.ok(!h.writes.some(write => write.value === '005678'));
  assert.throws(() => h.context.getAdminProfile(token), /sesión/);
  assert.throws(() => h.context.getAdminProfile(another), /sesión/);
  assert.equal(h.context.getAdminProfile(result.token).admin.usuario, input.usuario);
  assert.equal(h.context.adminLogin('1234').ok, false);
  assert.equal(h.context.adminLogin('005678').ok, true);
  assert.ok(!JSON.stringify(result).includes('005678'));
});

test('logout is idempotent and revokes only the supplied session', () => {
  const h = harness(), token = h.login(), another = h.login();
  h.context.adminLogout(token);
  h.context.adminLogout(token);
  assert.throws(() => h.context.getAdminProfile(token), /sesión/);
  assert.equal(h.context.getAdminProfile(another).admin.id, 'ADM-OWNER');
});

test('invalid profile fields and spreadsheet formulas are rejected before writing', () => {
  const h = harness(), token = h.login(), count = h.writes.length;
  for (const bad of [{ nombre: '=HYPERLINK("https://example.com")' }, { nombre: 'A' }, { nombre: 'Name\nFormula' }, { usuario: '=formula' }, { email: 'not-email' }, { telefono: '<script>' }]) {
    assert.throws(() => h.context.updateAdminProfile(token, { ...input, ...bad }));
  }
  assert.equal(h.writes.length, count);
});

test('new actions are exposed by the API and private authentication helpers stay private', () => {
  const h = harness(), token = h.login();
  const call = (action, ...args) => JSON.parse(h.context.apiOutput_({ action, args }).value);
  assert.equal(call('getAdminProfile', token).data.admin.id, 'ADM-OWNER');
  assert.equal(call('updateAdminProfile', token, input).data.ok, true);
  assert.equal(call('issueAdminSession_').ok, false);
  assert.equal(call('adminLogout', token).data.ok, true);
  assert.equal(call('getAdminProfile', token).ok, false);
});
