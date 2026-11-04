import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const ADMIN_TOKEN = 'a'.repeat(64);

// Contrato ficticio de pruebas: no representa rutas ni campos de Forttu.
function fixtureConfig() {
  return {
    baseUrl: 'https://api.integration-fixture.com/v1',
    auth: { type: 'bearer' }, testPath: '/health',
    resources: {
      clients: {
        path: '/people', itemsPath: 'data.items', nextCursorPath: 'data.next',
        fields: { id: 'key', documento: 'identity.number', nombre: 'displayName' },
        query: { page: 'page_number', limit: 'page_size', cursor: 'after' }
      }
    }
  };
}

function harness({ config = fixtureConfig(), enabled = true, secret = 'server-only-secret',
  status = 200, body = { data: { items: [], next: null } }, transportError = false } = {}) {
  const properties = {
    FORTTU_ENABLED: String(enabled), FORTTU_API_TOKEN: secret,
    FORTTU_CONFIG_JSON: typeof config === 'string' ? config : JSON.stringify(config),
    ADMIN_SESSION_VERSION: '1'
  };
  const calls = [];
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] ?? null }) },
    CacheService: { getScriptCache: () => ({ get: key => key === 'ADMIN_TOKEN_' + ADMIN_TOKEN ? JSON.stringify({ version: '1', day: '2026-10-29', expiresAt: Date.now() + 3600000 }) : null, remove() {} }) },
    UrlFetchApp: { fetch: (url, options) => {
      calls.push({ url, options });
      if (transportError) throw new Error('Sensitive URL and ' + secret);
      return { getResponseCode: () => status, getContentText: () => typeof body === 'string' ? body : JSON.stringify(body) };
    } },
    Utilities: { formatDate: (date, zone, format) => format === 'yyyy-MM-dd' ? '2026-10-29' : '2026-10-29T12:00:00-05:00' },
    // Any persistence or payment side effect must fail the tests.
    SpreadsheetApp: new Proxy({}, { get() { throw new Error('Unexpected database access'); } }),
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: value => ({ value, setMimeType() { return this; } })
    }
  });
  vm.runInContext(source, context);
  return { context, calls, properties };
}

test('all Forttu actions require an authenticated administrator before any network access', () => {
  const { context, calls } = harness();
  for (const method of ['getForttuStatus', 'testForttuConnection', 'previewForttuResource']) {
    assert.throws(() => context[method]('invalid', 'clients'), /sesión administrativa/);
  }
  assert.equal(calls.length, 0);
});

test('disabled connector and missing configuration never make outgoing requests', () => {
  const { context, calls, properties } = harness({ enabled: false });
  assert.equal(context.getForttuStatus(ADMIN_TOKEN).enabled, false);
  assert.equal(context.getForttuStatus(ADMIN_TOKEN).connectionVerified, false);
  assert.throws(() => context.testForttuConnection(ADMIN_TOKEN), /desactivada/);
  assert.throws(() => context.previewForttuResource(ADMIN_TOKEN, 'clients'), /desactivada/);
  delete properties.FORTTU_ENABLED;
  assert.throws(() => context.testForttuConnection(ADMIN_TOKEN), /desactivada/);
  properties.FORTTU_ENABLED = 'true';
  delete properties.FORTTU_CONFIG_JSON;
  assert.equal(context.getForttuStatus(ADMIN_TOKEN).configured, false);
  assert.throws(() => context.testForttuConnection(ADMIN_TOKEN), /Falta configurar/);
  assert.equal(calls.length, 0);
});

test('preview maps only configured fields and preserves string identifiers and pagination', () => {
  const { context, calls } = harness({ body: { data: {
    items: [{ key: '00042', identity: { number: '001020' }, displayName: 'Persona de prueba', secretField: 'omit' }],
    next: 'cursor/2&x=1'
  } } });
  const result = context.previewForttuResource(ADMIN_TOKEN, 'clients', { page: 0, limit: 50, cursor: 'a&b' });
  assert.deepEqual(JSON.parse(JSON.stringify(result.records)), [{ id: '00042', documento: '001020', nombre: 'Persona de prueba' }]);
  assert.equal(result.nextCursor, 'cursor/2&x=1');
  assert.equal(result.imported, false);
  assert.equal(calls[0].url, 'https://api.integration-fixture.com/v1/people?page_number=0&page_size=50&after=a%26b');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer server-only-secret');
  assert.equal(calls[0].options.method, 'get');
  assert.equal(calls[0].options.followRedirects, false);
  assert.equal(calls[0].options.validateHttpsCertificates, true);
  assert.ok(!JSON.stringify(result).includes('server-only-secret'));
});

test('API key authentication and JSON connection diagnostics work without returning the response', () => {
  const config = fixtureConfig();
  config.auth = { type: 'apiKey', header: 'X-Fixture-Key' };
  const { context, calls } = harness({ config, body: { sensitive: 'must not return' } });
  const result = context.testForttuConnection(ADMIN_TOKEN);
  assert.equal(result.reachable, true);
  assert.equal(calls[0].options.headers['X-Fixture-Key'], 'server-only-secret');
  assert.ok(!JSON.stringify(result).includes('sensitive'));
  assert.ok(!JSON.stringify(context.getForttuStatus(ADMIN_TOKEN)).includes('server-only-secret'));
});

test('unsafe URLs, unconfigured resources, fields and pagination fail before fetching', () => {
  for (const url of ['http://api.integration-fixture.com', 'https://127.0.0.1',
    'https://user:password@api.integration-fixture.com', 'https://api.integration-fixture.com?key=secret',
    'https://api.integration-fixture.com/../other', 'https://api.integration-fixture.com/%2e%2e']) {
    const config = fixtureConfig(); config.baseUrl = url;
    const { context, calls } = harness({ config });
    assert.throws(() => context.testForttuConnection(ADMIN_TOKEN), /HTTPS|rutas relativas/);
    assert.equal(calls.length, 0);
  }
  const { context, calls } = harness();
  assert.throws(() => context.previewForttuResource(ADMIN_TOKEN, 'admins'), /no configurado/);
  assert.throws(() => context.previewForttuResource(ADMIN_TOKEN, '__proto__'), /no configurado/);
  assert.throws(() => context.previewForttuResource(ADMIN_TOKEN, 'clients', { limit: 101 }), /límite/);
  assert.throws(() => context.previewForttuResource(ADMIN_TOKEN, 'clients', { url: 'https://elsewhere.com' }), /no configurado/);
  assert.equal(calls.length, 0);
  for (const mutate of [
    config => { config.resources.clients.path = '//elsewhere.com'; },
    config => { config.resources.clients.fields.pinHash = 'password'; },
    config => { config.resources.clients.fields.id = '__proto__.id'; },
    config => { config.auth = { type: 'apiKey', header: 'Host' }; }
  ]) {
    const config = fixtureConfig(); mutate(config);
    const h = harness({ config });
    assert.throws(() => h.context.testForttuConnection(ADMIN_TOKEN));
    assert.equal(h.calls.length, 0);
  }
});

test('remote failures are sanitized and requests are never automatically retried', () => {
  for (const status of [301, 401, 403, 404, 429, 500]) {
    const { context, calls } = harness({ status, body: { token: 'server-only-secret' } });
    assert.throws(() => context.testForttuConnection(ADMIN_TOKEN), error =>
      error.message.includes('HTTP ' + status) && !error.message.includes('server-only-secret'));
    assert.equal(calls.length, 1);
  }
  const { context, calls } = harness({ transportError: true });
  assert.throws(() => context.testForttuConnection(ADMIN_TOKEN), error =>
    error.message.includes('No fue posible') && !error.message.includes('server-only-secret'));
  assert.equal(calls.length, 1);
});

test('malformed configuration, missing secrets and invalid JSON responses fail safely', () => {
  for (const options of [{ config: '{' }, { secret: '' }, { secret: 'key\r\ninjected' }]) {
    const { context, calls } = harness(options);
    assert.equal(context.getForttuStatus(ADMIN_TOKEN).configured, false);
    assert.throws(() => context.testForttuConnection(ADMIN_TOKEN));
    assert.equal(calls.length, 0);
  }
  for (const body of ['<html>Login</html>', 'x'.repeat(1000001)]) {
    const { context } = harness({ body });
    assert.throws(() => context.testForttuConnection(ADMIN_TOKEN), /JSON válido|demasiado grande/);
  }
});

test('preview rejects missing or duplicate IDs, unsafe numeric IDs, and nested field values', () => {
  for (const items of [[{}], [{ key: '' }], [{ key: true }], [{ key: 9007199254740992 }],
    [{ key: 'one' }, { key: 'one' }], [{ key: 'one', displayName: { nested: 'value' } }]]) {
    const { context } = harness({ body: { data: { items } } });
    assert.throws(() => context.previewForttuResource(ADMIN_TOKEN, 'clients'), /identificador|escalares/);
  }
  const { context } = harness({ body: { data: { items: {} } } });
  assert.throws(() => context.previewForttuResource(ADMIN_TOKEN, 'clients'), /no contiene una lista/);
});

test('preview is capped and reports truncation instead of silently suggesting a complete import', () => {
  const items = Array.from({ length: 101 }, (_, i) => ({ key: String(i) }));
  const { context } = harness({ body: { data: { items } } });
  const result = context.previewForttuResource(ADMIN_TOKEN, 'clients');
  assert.equal(result.records.length, 100);
  assert.equal(result.received, 101);
  assert.equal(result.truncated, true);
  assert.equal(result.imported, false);
});

test('Forttu actions use the existing API envelope; unknown writes are not exposed', () => {
  const { context, calls } = harness({ enabled: false });
  const status = JSON.parse(context.apiOutput_({ action: 'getForttuStatus', args: [ADMIN_TOKEN] }).value);
  assert.equal(status.ok, true);
  assert.equal(status.data.mode, 'read-only');
  const denied = JSON.parse(context.apiOutput_({ action: 'previewForttuResource', args: ['invalid', 'clients'] }).value);
  assert.equal(denied.ok, false);
  const write = JSON.parse(context.apiOutput_({ action: 'importForttuResource', args: [ADMIN_TOKEN, 'clients'] }).value);
  assert.equal(write.ok, false);
  assert.equal(calls.length, 0);
});
