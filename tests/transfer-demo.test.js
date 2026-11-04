import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/common.js', import.meta.url), 'utf8')
  .replace(/export \{[^}]+\};/, 'globalThis.api = Backend;');
const receipt = { mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.7\nDEMO ONLY').toString('base64') };

function load(storage = new Map()) {
  const context = vm.createContext({
    window: { location: { search: '?demo=1' } }, URLSearchParams,
    document: { querySelectorAll: () => [], querySelector: () => null },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID }, structuredClone, atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: callback => callback(),
    fetch() { throw new Error('A simulation must never contact the production backend'); }
  });
  vm.runInContext(source, context);
  return { call: (method, ...args) => context.api.call(method, ...args), storage, api: context.api };
}

async function create(h, ids = ['CAR-DEMO-003', 'CAR-DEMO-004']) {
  return h.call('createTransferOrder', 'CV-2026-0042', ids, 'DEMO-A', randomUUID());
}

test('explicit demo mode uses fictitious accounts and never contacts the configured production URL', async () => {
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
