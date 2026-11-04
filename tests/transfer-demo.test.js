import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/common.js', import.meta.url), 'utf8')
  .replace(/export \{[^}]+\};/, 'globalThis.api = Backend; globalThis.formatRentalMonth = formatRentalMonth;');
const receipt = { mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.7\nDEMO ONLY').toString('base64') };

function load(storage = new Map()) {
  const now = Date.now();
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    window: { location: { search: '' } }, URLSearchParams,
    document: { querySelectorAll: () => [], querySelector: () => null },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID }, structuredClone, atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: callback => callback(),
    fetch() { throw new Error('A simulation must never contact the production backend'); }
  });
  vm.runInContext(source.replace(/const APPS_SCRIPT_URL = '[^']*';/, "const APPS_SCRIPT_URL = '';"), context);
  return { call: (method, ...args) => context.api.call(method, ...args), storage, api: context.api };
}

async function create(h, ids = ['CAR-DEMO-003', 'CAR-DEMO-004']) {
  return h.call('createTransferOrder', 'CV-2026-0042', ids, 'DEMO-A', randomUUID());
}

test('offline fixtures use fictitious accounts without requiring URL parameters', async () => {
  const h = load();
  assert.equal(h.api.isLive, false);
  assert.equal((await h.call('getTransferAvailability')).available, true);
  const accounts = await h.call('getTransferBankAccounts', 'CV-2026-0042');
  assert.ok(accounts.every(account => account.accountNumber.startsWith('CUENTA-DEMO-')));
  const order = await create(h);
  assert.equal(order.amountInCents, (2330000 + 2535000) * 100);
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await h.call('refreshTransferOrder', order.reference, order.accessToken)).success, false);
  const account = await h.call('lookupAccount', 'CV-2026-0042');
  assert.equal(account.contracts[0].cartera.find(row => row.id === 'CAR-DEMO-003').valorPagado, 0);
});

const liveFixture = {
  id: 'CONTRATO-CUALQUIERA', estado: 'ACTIVO', resumen: { saldo: 4700000 },
  cartera: [
    { id: 'MES-CUALQUIERA-1', periodo: 'NOV 2026', valorBase: 2000000, descuento: 50000, cargoExtra: 0, valorPagado: 250000, saldo: 1700000, fechaVencimiento: '2026-11-10', estado: 'PENDIENTE' },
    { id: 'MES-CUALQUIERA-2', periodo: 'DIC 2026', valorBase: 3000000, descuento: 0, cargoExtra: 0, valorPagado: 0, saldo: 3000000, fechaVencimiento: '2026-12-10', estado: 'PENDIENTE' }
  ]
};

function adminFixture(contract) {
  const ledger = contract.cartera.map(row => ({ ...row, contratoId: contract.id }));
  const snapshot = {
    version: 1, versions: { clients: 1, properties: 1, contracts: 1, ledger: 1, payments: 1 },
    clients: [{ id: 'CLI-REAL-1', documento: '123456789', nombre: 'Cliente de prueba uno' }], properties: [],
    contracts: [{ id: contract.id, clienteId: 'CLI-REAL-1', clienteNombre: 'Cliente de prueba uno', estado: 'ACTIVO', saldo: 4700000 }],
    ledger,
    payments: [{ id: 'REAL-1', referencia: 'MAN-REAL-1', contratoId: contract.id, clienteId: 'CLI-REAL-1', valor: 250000, estado: 'APROBADO', metodo: 'EFECTIVO' }],
    stats: { clientes: 1, contratosActivos: 1, cartera: 4700000, recaudado: 250000 }, pageInfo: {}
  };
  for (const section of ['clients', 'properties', 'contracts', 'ledger', 'payments']) snapshot.pageInfo[section] = { total: snapshot[section].length, offset: 0, nextOffset: snapshot[section].length, limit: 1000, hasMore: false };
  return snapshot;
}

function loadWithBackend(storage = new Map(), { enabled = true, contract = structuredClone(liveFixture), clock = { now: Date.now() }, admin = adminFixture(contract) } = {}) {
  const requests = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return clock.now; } },
    window: { location: { search: '' } }, URLSearchParams,
    document: { querySelectorAll: () => [], querySelector: () => null },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID }, structuredClone, atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: callback => callback(),
    fetch(url, options) {
      const payload = JSON.parse(options.body); requests.push(payload);
      let result = payload.action === 'lookupAccount' || payload.action === 'syncAccount'
        ? { ok: true, data: { found: true, version: 1, changed: true, contracts: [structuredClone(contract)] } }
        : { ok: false, error: 'Acción no permitida.' };
      if (payload.action === 'getAdminDashboard') result = { ok: true, data: structuredClone(admin) };
      if (payload.action === 'getContractLedgerForAdmin') result = { ok: true, data: structuredClone(admin.ledger.filter(row => row.contratoId === payload.args[1])) };
      if (payload.action === 'getClientAccountForAdmin') {
        const client = admin.clients.find(row => row.id === payload.args[1]);
        const contracts = admin.contracts.filter(row => row.clienteId === client.id);
        const ids = new Set(contracts.map(row => row.id));
        result = { ok: true, data: structuredClone({ client, contracts, ledger: admin.ledger.filter(row => ids.has(row.contratoId)), payments: admin.payments.filter(row => ids.has(row.contratoId)) }) };
      }
      if (payload.action === 'getAdminPage') {
        const section = payload.args[1], offset = payload.args[2] || 0;
        result = { ok: true, data: { version: 1, versions: admin.versions, section, page: { ...admin.pageInfo[section], items: structuredClone(admin[section].slice(offset)), offset } } };
      }
      if (payload.action === 'getAdminSync') {
        const sections = {};
        if (admin.changed) for (const section of ['contracts', 'ledger', 'payments']) sections[section] = { ...admin.pageInfo[section], items: structuredClone(admin[section]) };
        result = { ok: true, data: { version: 1, versions: admin.versions, changed: Boolean(admin.changed), stats: structuredClone(admin.stats), sections } };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(result) });
    }
  });
  vm.runInContext(enabled ? source : source.replace('const TRANSFER_SIMULATION_ENABLED = true;', 'const TRANSFER_SIMULATION_ENABLED = false;'), context);
  return { call: (method, ...args) => context.api.call(method, ...args), api: context.api, storage, requests, contract, clock, admin, formatMonth: context.formatRentalMonth };
}

async function createLiveOrder(h, ids = ['MES-CUALQUIERA-1']) {
  await h.call('lookupAccount', liveFixture.id);
  return h.call('createTransferOrder', liveFixture.id, ids, 'DEMO-A', randomUUID());
}

test('default URL simulates transfers for any real contract even when the old backend rejects transfer actions', async () => {
  const h = loadWithBackend();
  assert.equal(h.api.isLive, true);
  assert.equal(h.api.isTransferSimulation, true);
  assert.equal((await h.call('getTransferAvailability')).available, true);
  const order = await createLiveOrder(h);
  assert.equal(order.contractId, liveFixture.id);
  assert.equal(order.amountInCents, 170000000);
  assert.equal((await h.call('getTransferBankAccounts', liveFixture.id)).length, 2);
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  assert.equal((await h.call('refreshTransferOrder', order.reference, order.accessToken)).success, false);
  assert.deepEqual(h.requests.map(request => request.action), ['lookupAccount']);
});

test('default simulation survives reload, pays only selected months locally and never writes to the backend', async () => {
  const h = loadWithBackend(); const order = await createLiveOrder(h);
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  const reloaded = loadWithBackend(h.storage);
  assert.equal((await reloaded.call('getTransferOrder', order.reference, order.accessToken)).status, 'PENDIENTE_VERIFICACION');
  const paid = await reloaded.call('simulateTransferVerification', order.reference, order.accessToken, 'APPROVED');
  assert.equal(paid.success, true);
  for (let attempt = 0; attempt < 3; attempt++) {
    const contract = (await reloaded.call('lookupAccount', liveFixture.id)).contracts[0];
    assert.equal(contract.cartera[0].saldo, 0);
    assert.equal(contract.cartera[0].valorPagado, 1950000);
    assert.equal(contract.cartera[1].saldo, 3000000);
    assert.equal(contract.resumen.saldo, 3000000);
  }
  assert.equal(reloaded.contract.cartera[0].valorPagado, 250000);
  assert.ok(reloaded.requests.every(request => request.action === 'lookupAccount'));
  assert.ok(!h.storage.get('vitrinazo-transfer-simulation-v1').includes(receipt.base64));
});

test('reset restores the original account; switching off simulation uses the real API with no simulated credits', async () => {
  const h = loadWithBackend(); const order = await createLiveOrder(h);
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  await h.call('simulateTransferVerification', order.reference, order.accessToken, 'APPROVED');
  const real = loadWithBackend(h.storage, { enabled: false });
  assert.equal(real.api.isTransferSimulation, false);
  assert.equal((await real.call('lookupAccount', liveFixture.id)).contracts[0].cartera[0].saldo, 1700000);
  await assert.rejects(real.call('getTransferAvailability'), /Acción no permitida/);
  h.api.resetTransferSimulation();
  assert.equal((await h.call('lookupAccount', liveFixture.id)).contracts[0].cartera[0].saldo, 1700000);
});

test('cached real contracts can prepare a simulation and debt changes prevent approval', async () => {
  const h = loadWithBackend();
  h.api.prepareTransferSimulation(structuredClone(liveFixture));
  const order = await h.call('createTransferOrder', liveFixture.id, ['MES-CUALQUIERA-1'], 'DEMO-A', randomUUID());
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  h.contract.cartera[0].cargoExtra = 200;
  await h.call('lookupAccount', liveFixture.id);
  assert.equal((await h.call('simulateTransferVerification', order.reference, order.accessToken, 'APPROVED')).status, 'EN_REVISION');
});

test('approving one contract cannot pay another contract even when monthly row identifiers coincide', async () => {
  const h = loadWithBackend(); const order = await createLiveOrder(h);
  h.api.prepareTransferSimulation({ ...structuredClone(liveFixture), id: 'OTRO-CONTRATO' });
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  await h.call('simulateTransferVerification', order.reference, order.accessToken, 'APPROVED');
  const otherOrder = await h.call('createTransferOrder', 'OTRO-CONTRATO', ['MES-CUALQUIERA-1'], 'DEMO-A', randomUUID());
  assert.equal(otherOrder.amountInCents, 170000000);
  assert.equal(otherOrder.success, false);
});

test('a valid upload is approved automatically after verification, survives reload and credits once without a confirmation click', async () => {
  const h = loadWithBackend(); const order = await createLiveOrder(h);
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  assert.equal((await h.call('refreshTransferOrder', order.reference, order.accessToken)).status, 'PENDIENTE_VERIFICACION');
  h.clock.now += 2500;
  const resumed = loadWithBackend(h.storage, { clock: h.clock });
  assert.equal((await resumed.call('refreshTransferOrder', order.reference, order.accessToken)).status, 'APROBADO');
  assert.equal((await resumed.call('refreshTransferOrder', order.reference, order.accessToken)).success, true);
  const result = (await resumed.call('lookupAccount', liveFixture.id)).contracts[0];
  assert.equal(result.cartera[0].saldo, 0);
  assert.equal(result.cartera[1].saldo, 3000000);
  assert.equal(JSON.parse(h.storage.get('vitrinazo-transfer-simulation-v1')).payments.length, 1);
  assert.ok(resumed.requests.every(request => request.action === 'lookupAccount'));
});

test('automatic verification still rejects changed amounts rather than celebrating a stale payment', async () => {
  const h = loadWithBackend(); const order = await createLiveOrder(h);
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  h.contract.cartera[0].cargoExtra = 100;
  await h.call('lookupAccount', liveFixture.id);
  h.clock.now += 2500;
  assert.equal((await h.call('refreshTransferOrder', order.reference, order.accessToken)).status, 'EN_REVISION');
  assert.equal((await h.call('lookupAccount', liveFixture.id)).contracts[0].cartera[0].valorPagado, 250000);
});

test('demo approval pays only selected months once and survives a page reload', async () => {
  const h = load(); const order = await create(h);
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  const reloaded = load(h.storage);
  assert.equal((await reloaded.call('getTransferOrder', order.reference, order.accessToken)).status, 'PENDIENTE_VERIFICACION');
  const result = await reloaded.call('simulateTransferVerification', order.reference, order.accessToken, 'APPROVED');
  assert.equal(result.success, true);
  await reloaded.call('simulateTransferVerification', order.reference, order.accessToken, 'APPROVED');
  const contract = (await reloaded.call('lookupAccount', 'CV-2026-0042')).contracts[0];
  assert.equal(contract.cartera.find(row => row.id === 'CAR-DEMO-003').saldo, 0);
  assert.equal(contract.cartera.find(row => row.id === 'CAR-DEMO-004').saldo, 0);
  assert.equal(contract.cartera.find(row => row.id === 'CAR-DEMO-005').valorPagado, 0);
  const stored = JSON.parse(h.storage.get('vitrinazo-demo-v2'));
  assert.equal(stored.payments.filter(payment => payment.referencia === order.reference).length, 1);
  assert.ok(!h.storage.get('vitrinazo-demo-v2').includes(receipt.base64));
});

test('rejected, pending and wrong-amount demo responses never pay months', async () => {
  for (const outcome of ['REJECTED', 'WRONG_AMOUNT', 'PENDING']) {
    const h = load(); const order = await create(h);
    await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
    const result = await h.call('simulateTransferVerification', order.reference, order.accessToken, outcome);
    assert.equal(result.success, false);
    assert.equal(result.status, { REJECTED: 'RECHAZADO', WRONG_AMOUNT: 'EN_REVISION', PENDING: 'PENDIENTE_VERIFICACION' }[outcome]);
    const contract = (await h.call('lookupAccount', 'CV-2026-0042')).contracts[0];
    assert.equal(contract.cartera.find(row => row.id === 'CAR-DEMO-003').valorPagado, 0);
  }
});

test('demo requires a receipt, a valid access token and valid file signatures', async () => {
  const h = load(); const order = await create(h);
  assert.equal((await h.call('simulateTransferVerification', order.reference, order.accessToken, 'APPROVED')).success, false);
  await assert.rejects(h.call('submitTransferReceipt', order.reference, 'bad-token', receipt), /acceder/);
  await assert.rejects(h.call('submitTransferReceipt', order.reference, order.accessToken, { mimeType: 'image/png', base64: Buffer.from('fake image').toString('base64') }), /válido/);
  assert.equal((await h.call('getTransferOrder', order.reference, order.accessToken)).status, 'ESPERANDO_COMPROBANTE');
});

async function approveAutomatically(h) {
  const order = await createLiveOrder(h);
  await h.call('submitTransferReceipt', order.reference, order.accessToken, receipt);
  h.clock.now += 2500;
  await h.call('refreshTransferOrder', order.reference, order.accessToken);
  return order;
}

test('admin shows the simulated credit, paid months, customer and history from the same browser without writing real records', async () => {
  const portal = loadWithBackend(); await approveAutomatically(portal);
  const admin = loadWithBackend(portal.storage);
  const dashboard = await admin.call('getAdminDashboard', 'admin-token', 1000);
  assert.equal(dashboard.stats.cartera, 3000000);
  assert.equal(dashboard.stats.recaudado, 1950000);
  assert.equal(dashboard.contracts[0].saldo, 3000000);
  assert.equal(dashboard.ledger[0].estadoCalculado, 'PAGADO');
  assert.equal(dashboard.ledger[1].saldo, 3000000);
  assert.equal(dashboard.payments.length, 2);
  assert.equal(dashboard.payments[0].clienteId, 'CLI-REAL-1');
  assert.equal(dashboard.payments[0].clienteNombre, 'Cliente de prueba uno');
  assert.equal(dashboard.payments[0].metodo, 'TRANSFERENCIA_SIMULADA');
  const account = await admin.call('getClientAccountForAdmin', 'admin-token', 'CLI-REAL-1');
  assert.equal(account.ledger[0].saldo, 0);
  assert.equal(account.payments.length, 2);
  assert.equal((await admin.call('getContractLedgerForAdmin', 'admin-token', liveFixture.id))[0].saldo, 0);
  assert.equal(admin.admin.ledger[0].valorPagado, 250000);
  assert.ok(admin.requests.every(request => request.action.startsWith('get')));
});

test('an already open admin tab refreshes from shared storage idempotently and reset restores its original totals', async () => {
  const portal = loadWithBackend(); const admin = loadWithBackend(portal.storage);
  let dashboard = await admin.call('getAdminDashboard', 'admin-token', 1000);
  await approveAutomatically(portal);
  for (let attempt = 0; attempt < 3; attempt++) {
    dashboard = admin.api.projectAdminSimulation(dashboard);
    assert.equal(dashboard.stats.cartera, 3000000);
    assert.equal(dashboard.stats.recaudado, 1950000);
    assert.equal(dashboard.contracts[0].saldo, 3000000);
    assert.equal(dashboard.payments.length, 2);
    assert.equal(dashboard.pageInfo.payments.total, 2);
  }
  portal.api.resetTransferSimulation();
  dashboard = admin.api.projectAdminSimulation(dashboard);
  assert.equal(dashboard.stats.cartera, 4700000);
  assert.equal(dashboard.stats.recaudado, 250000);
  assert.equal(dashboard.ledger[0].saldo, 1700000);
  assert.equal(dashboard.contracts[0].saldo, 4700000);
  assert.equal(dashboard.payments.length, 1);
  assert.equal(dashboard.pageInfo.payments.total, 1);
});

test('admin pagination, sync and client scopes preserve the same simulation without crediting a different contract', async () => {
  const h = loadWithBackend(); await approveAutomatically(h);
  h.admin.clients.push({ id: 'CLI-REAL-2', nombre: 'Otro cliente' });
  h.admin.contracts.push({ id: 'OTRO-CONTRATO', clienteId: 'CLI-REAL-2', saldo: 9000000 });
  h.admin.ledger.push({ ...liveFixture.cartera[0], contratoId: 'OTRO-CONTRATO' });
  const account = await h.call('getClientAccountForAdmin', 'admin-token', 'CLI-REAL-2');
  assert.equal(account.ledger[0].saldo, 1700000);
  assert.equal(account.contracts[0].saldo, 9000000);
  assert.equal(account.payments.length, 0);
  const page = await h.call('getAdminPage', 'admin-token', 'payments', 0, 1000);
  assert.equal(page.page.items.length, 2);
  assert.equal(page.page.total, 2);
  h.admin.changed = true;
  const sync = await h.call('getAdminSync', 'admin-token', {});
  assert.equal(sync.stats.cartera, 3000000);
  assert.equal(sync.sections.ledger.items[0].saldo, 0);
  assert.equal(sync.sections.payments.items.length, 2);
  const real = loadWithBackend(h.storage, { enabled: false });
  assert.equal((await real.call('getAdminDashboard', 'admin-token')).stats.cartera, 4700000);
});

test('all rental periods use readable Spanish month names without changing their stored identifiers', () => {
  const h = loadWithBackend();
  for (const value of ['2026-11', '2026-11-01T00:00:00.000Z', 'NOV 2026', 'Noviembre 2026', 'nov. de 2026']) {
    assert.equal(h.formatMonth(value), 'Noviembre de 2026');
  }
  assert.equal(h.formatMonth('', '2027-01-10'), 'Enero de 2027');
  assert.equal(h.formatMonth('DIC 2026', '2027-01-02'), 'Diciembre de 2026');
});
