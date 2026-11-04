import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const account = { id: 'BANK-TEST', bankName: 'Banco ficticio', holderName: 'Titular de prueba',
  holderDocument: 'DOCUMENTO-PRUEBA', accountType: 'Ahorros', accountNumber: 'CUENTA-PRUEBA' };
const pdf = { mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.7\nTest receipt').toString('base64') };
const requestId = 'request-00000000-0000-0000-000000000001';

function harness({ liveAdapter = true } = {}) {
  const tables = {
    CONTRATOS: [{ id: 'C1', clienteId: 'CLI1', estado: 'ACTIVO' }, { id: 'C2', clienteId: 'CLI2', estado: 'ACTIVO' }],
    CARTERA: [
      { id: 'M1', contratoId: 'C1', periodo: 'ENE 2026', valorBase: 100, descuento: 5, cargoExtra: 10, valorPagado: 5, pagoId: '', estado: 'PENDIENTE' },
      { id: 'M2', contratoId: 'C1', periodo: 'FEB 2026', valorBase: 200, descuento: 0, cargoExtra: 0, valorPagado: 0, pagoId: '', estado: 'PENDIENTE' },
      { id: 'M3', contratoId: 'C2', periodo: 'MAR 2026', valorBase: 300, descuento: 0, cargoExtra: 0, valorPagado: 0, pagoId: '', estado: 'PENDIENTE' }
    ], PAGOS: [], TRANSFERENCIAS: []
  };
  const properties = { FORTTU_TRANSFER_ENABLED: 'true', FORTTU_RECEIPTS_FOLDER_ID: 'private-fixture-folder' };
  const files = new Map();
  const calls = { provider: [], versions: 0, ledgerWrites: 0 };
  const failures = { ledgerWriteAt: 0, approvePayment: false, versions: false, provider: false, folderShared: false };
  let resultStatus = 'PENDING';
  let modifyResult = value => value;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] ?? null,
      setProperty: (key, value) => { properties[key] = value; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: randomUUID,
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, value) => [...createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value.map(v => (v + 256) % 256))).digest()],
      base64Decode: value => [...Buffer.from(value, 'base64')],
      newBlob: (bytes, mimeType, name) => ({ bytes, mimeType, name }),
      formatDate: () => new Date().toISOString()
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' },
      getFolderById: () => ({
        getOwner: () => ({}), getSharingAccess: () => failures.folderShared ? 'ANYONE' : 'PRIVATE',
        getEditors: () => [], getViewers: () => [],
        createFile: blob => {
          const id = randomUUID();
          const file = { getId: () => id, getBlob: () => blob, setSharing() {} };
          files.set(id, file);
          return file;
        }
      }),
      getFileById: id => files.get(id)
    }
  });
  vm.runInContext(source, context);
  context.getDb_ = () => ({ getSheetByName: name => ({ name }) });
  context.getRows_ = sheet => clone(tables[sheet.name] || []);
  context.getRowsByValue_ = (sheet, field, value) => clone((tables[sheet.name] || []).filter(row => String(row[field] ?? '') === String(value)));
  context.findDataRow_ = (sheet, field, value) => {
    const index = tables[sheet.name].findIndex(row => row[field] === value);
    return index === -1 ? 0 : index + 2;
  };
  context.appendObject_ = (name, headers, record) => { tables[name].push(clone(record)); };
  context.writeObjectToRow_ = (name, headers, row, record) => {
    if (name === 'CARTERA') {
      calls.ledgerWrites++;
      if (calls.ledgerWrites === failures.ledgerWriteAt) throw new Error('Injected ledger write failure');
    }
    if (name === 'PAGOS' && record.estado === 'APROBADO' && failures.approvePayment) {
      failures.approvePayment = false;
      throw new Error('Injected payment write failure');
    }
    assert.ok(row >= 2);
    tables[name][row - 2] = clone(record);
  };
  context.markDataChanged_ = () => {
    if (failures.versions) { failures.versions = false; throw new Error('Injected version failure'); }
    calls.versions++;
  };
  if (liveAdapter) context.forttuTransferAdapter_ = () => ({
    ready: true,
    listBankAccounts: () => [clone(account)],
    reconcileReceipt: (order, blob) => {
      calls.provider.push({ reference: order.id, hasBlob: Boolean(blob) });
      if (failures.provider) throw new Error('DO NOT EXPOSE remote-secret');
      return modifyResult({ status: resultStatus, reference: order.id, authenticated: true, settled: true,
        accountId: account.id, amountInCents: order.valorCentavos, currency: 'COP',
        transactionId: 'TX-' + order.id, verificationId: 'VERIFY-' + order.id });
    }
  });
  function create(ids = ['M1', 'M2'], id = requestId, contract = 'C1') {
    return context.createTransferOrder(contract, ids, account.id, id);
  }
  function submit(order, receipt = pdf) { return context.submitTransferReceipt(order.reference, order.accessToken, receipt); }
  return { context, tables, properties, files, calls, failures, create, submit,
    status: value => { resultStatus = value; }, result: fn => { modifyResult = fn; } };
}

test('production adapter remains unavailable even if the enabling property is set', () => {
  const h = harness({ liveAdapter: false });
  assert.equal(h.context.getTransferAvailability().available, false);
  assert.throws(() => h.create(), /todavía no está habilitado/);
  assert.throws(() => h.context.getTransferBankAccounts('C1'), /todavía no está habilitado/);
  assert.equal(h.tables.TRANSFERENCIAS.length, 0);
});

test('order snapshots months, server-calculated balance, bank account and beneficiary', () => {
  const h = harness();
  const order = h.create();
  assert.equal(order.amountInCents, 30000);
  assert.equal(order.contractId, 'C1');
  assert.equal(order.account.accountNumber, account.accountNumber);
  assert.equal(order.status, 'ESPERANDO_COMPROBANTE');
  assert.equal(order.success, false);
  assert.equal(h.tables.TRANSFERENCIAS[0].clienteId, 'CLI1');
  assert.equal(h.tables.PAGOS.length, 0);
  assert.equal(h.tables.CARTERA[0].valorPagado, 5);
  assert.ok(!JSON.stringify(h.tables.TRANSFERENCIAS).includes(order.accessToken));
  assert.throws(() => h.context.getTransferOrder(order.reference, 'forged'), /acceder/);
  const view = h.context.getTransferOrder(order.reference, order.accessToken);
  assert.equal(view.accessToken, undefined);
  assert.equal(view.verificacionJson, undefined);
  assert.equal(view.comprobanteId, undefined);
});

test('creation is idempotent and overlapping requests remain blocked without time-based release', () => {
  const h = harness();
  const first = h.create();
  const same = h.create(['M2', 'M1']);
  assert.equal(same.reference, first.reference);
  assert.equal(same.accessToken, first.accessToken);
  assert.equal(h.tables.TRANSFERENCIAS.length, 1);
  assert.throws(() => h.create(['M1'], 'different-request-0000000001'), /solicitud de pago/);
  assert.throws(() => h.create(['M1']), /otra selección/);
  assert.throws(() => h.create(['M1', 'M1'], 'different-request-0000000002'), /meses distintos/);
  assert.throws(() => h.create(['M3'], 'different-request-0000000003'), /no pertenece/);
});

test('pending gateway payments also prevent overlapping transfer orders', () => {
  const h = harness();
  h.tables.PAGOS.push({ contratoId: 'C1', estado: 'PENDIENTE', detalleJson: '[{"id":"M1","amount":100}]' });
  assert.throws(() => h.create(), /solicitud de pago/);
});

test('receipts are signature-checked, bounded, private and deduplicated without marking months paid', () => {
  const h = harness();
  const order = h.create();
  assert.throws(() => h.submit(order, { mimeType: 'application/pdf', base64: Buffer.from('<script>no</script>').toString('base64') }), /válido/);
  assert.throws(() => h.submit(order, { mimeType: 'application/pdf', base64: 'A'.repeat(5592412) }), /4 MB/);
  h.failures.folderShared = true;
  assert.throws(() => h.submit(order), /carpeta.*privada/);
  assert.equal(h.files.size, 0);
  h.failures.folderShared = false;
  const result = h.submit(order);
  assert.equal(result.status, 'PENDIENTE_VERIFICACION');
  assert.equal(result.success, false);
  assert.equal(h.tables.CARTERA[0].valorPagado, 5);
  assert.equal(h.tables.PAGOS.length, 0);
  assert.equal(h.files.size, 1);
  assert.equal(h.submit(order).status, result.status);
  assert.equal(h.files.size, 1);
  const other = h.create(['M3'], 'different-request-0000000004', 'C2');
  assert.throws(() => h.submit(other), /otra solicitud/);
});

test('pending and unauthenticated verification results never credit the ledger', () => {
  for (const modify of [value => value, value => ({ ...value, status: 'VERIFIED', authenticated: false })]) {
    const h = harness();
    const order = h.create(); h.submit(order); h.result(modify);
    h.context.reconcileForttuTransfers();
    assert.equal(h.tables.TRANSFERENCIAS[0].estado, 'PENDIENTE_VERIFICACION');
    assert.equal(h.tables.PAGOS.length, 0);
    assert.equal(h.calls.ledgerWrites, 0);
  }
});

test('rejects mismatched amount, currency, destination, transaction and unsettled evidence', () => {
  for (const patch of [{ amountInCents: 1 }, { currency: 'USD' }, { accountId: 'OTHER' },
    { transactionId: '' }, { transactionId: '=IMPORTDATA("unsafe")' }, { verificationId: '' }, { settled: false }]) {
    const h = harness(); const order = h.create(); h.submit(order); h.status('VERIFIED');
    h.result(value => ({ ...value, ...patch }));
    h.context.reconcileForttuTransfers();
    assert.equal(h.tables.TRANSFERENCIAS[0].estado, 'EN_REVISION');
    assert.equal(h.tables.PAGOS.length, 0);
    assert.equal(h.calls.ledgerWrites, 0);
  }
});

test('verified payment updates exactly its beneficiary months once, without browser participation', () => {
  const h = harness(); const order = h.create(); h.submit(order); h.status('VERIFIED');
  h.context.reconcileForttuTransfers();
  assert.equal(h.context.getTransferOrder(order.reference, order.accessToken).success, true);
  assert.equal(h.tables.PAGOS.length, 1);
  assert.equal(h.tables.PAGOS[0].estado, 'APROBADO');
  assert.equal(h.tables.PAGOS[0].metodo, 'TRANSFERENCIA_FORTTU');
  assert.equal(h.tables.PAGOS[0].valor, 300);
  assert.equal(h.tables.CARTERA[0].valorPagado, 105);
  assert.equal(h.tables.CARTERA[1].valorPagado, 200);
  assert.equal(h.tables.CARTERA[2].valorPagado, 0);
  const writes = h.calls.ledgerWrites;
  h.context.reconcileForttuTransfers();
  assert.equal(h.calls.ledgerWrites, writes);
  assert.equal(h.tables.PAGOS.length, 1);
  assert.equal(h.calls.provider.length, 1);
});

test('interrupted ledger, payment and version writes recover without adding money twice', () => {
  for (const failure of ['ledger', 'payment', 'versions']) {
    const h = harness(); const order = h.create(); h.submit(order); h.status('VERIFIED');
    if (failure === 'ledger') h.failures.ledgerWriteAt = 2;
    if (failure === 'payment') h.failures.approvePayment = true;
    if (failure === 'versions') h.failures.versions = true;
    h.context.reconcileForttuTransfers();
    assert.equal(h.context.getTransferOrder(order.reference, order.accessToken).success, false);
    h.context.reconcileForttuTransfers();
    assert.equal(h.context.getTransferOrder(order.reference, order.accessToken).success, true);
    assert.equal(h.tables.CARTERA[0].valorPagado, 105);
    assert.equal(h.tables.CARTERA[1].valorPagado, 200);
    assert.equal(h.tables.PAGOS.length, 1);
    assert.equal(h.calls.provider.length, 1);
  }
});

test('concurrent manual payments, changed debts or missing months enter review without hidden excess', () => {
  for (const mutate of [
    rows => { rows[0].valorPagado = 50; }, rows => { rows[1].cargoExtra = 10; }, rows => { rows.splice(1, 1); }
  ]) {
    const h = harness(); const order = h.create(); h.submit(order); h.status('VERIFIED'); mutate(h.tables.CARTERA);
    h.context.reconcileForttuTransfers();
    assert.equal(h.tables.TRANSFERENCIAS[0].estado, 'EN_REVISION');
    assert.equal(h.context.getTransferOrder(order.reference, order.accessToken).success, false);
    assert.equal(h.calls.ledgerWrites, 0);
    assert.equal(h.tables.PAGOS.length, 0);
  }
});

test('one banking transaction cannot pay two orders, even if receipt files differ', () => {
  const h = harness();
  const first = h.create(['M1']); const second = h.create(['M2'], 'different-request-0000000005');
  h.submit(first); h.submit(second, { ...pdf, base64: Buffer.from('%PDF-1.7\nDifferent image same transaction').toString('base64') });
  h.status('VERIFIED'); h.result(value => ({ ...value, transactionId: 'ONE-BANK-TX' }));
  h.context.reconcileForttuTransfers();
  assert.equal(h.tables.TRANSFERENCIAS[0].estado, 'APROBADO');
  assert.equal(h.tables.TRANSFERENCIAS[1].estado, 'EN_REVISION');
  assert.equal(h.tables.PAGOS.length, 1);
  assert.equal(h.tables.CARTERA[1].valorPagado, 0);
});

test('timeouts retain pending verification and sanitize provider errors', () => {
  const h = harness(); const order = h.create(); h.submit(order); h.failures.provider = true;
  h.context.reconcileForttuTransfers();
  assert.equal(h.tables.TRANSFERENCIAS[0].estado, 'PENDIENTE_VERIFICACION');
  assert.ok(!JSON.stringify(h.tables).includes('remote-secret'));
  assert.equal(h.tables.PAGOS.length, 0);
  h.failures.provider = false; h.status('VERIFIED'); h.context.reconcileForttuTransfers();
  assert.equal(h.context.getTransferOrder(order.reference, order.accessToken).success, true);
  assert.equal(h.calls.provider[0].reference, h.calls.provider[1].reference);
});

test('rejected evidence never credits months and the browser cannot directly invoke approval helpers', () => {
  const h = harness(); const order = h.create(); h.submit(order); h.status('REJECTED');
  h.context.reconcileForttuTransfers();
  assert.equal(h.tables.TRANSFERENCIAS[0].estado, 'RECHAZADO');
  assert.equal(h.tables.PAGOS.length, 0);
  assert.equal(h.calls.ledgerWrites, 0);
  h.context.jsonOutput_ = value => value;
  const denied = h.context.apiOutput_({ action: 'transferApplyVerifiedOrder_', args: [h.tables.TRANSFERENCIAS[0]] });
  assert.equal(denied.ok, false);
});

test('monetary calculations reject booleans, blanks, sub-cent values and unsafe integers', () => {
  const h = harness();
  for (const value of [true, false, null, '', ' ', 1.001, -1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => h.context.transferCents_(value), /monetario inválido/);
  }
  assert.equal(h.context.transferCents_('1234.56'), 123456);
});

test('authenticated polling verifies only its order and never accepts a browser approval', () => {
  const h = harness();
  const order = h.create(); h.submit(order); h.status('VERIFIED');
  const other = h.create(['M3'], 'another-request-0000000000009', 'C2');
  h.submit(other, { ...pdf, base64: Buffer.from('%PDF-1.7\nOther receipt').toString('base64') });
  h.tables.TRANSFERENCIAS.forEach(row => { row.actualizadoEn = '2020-01-01T00:00:00Z'; });
  assert.throws(() => h.context.refreshTransferOrder(order.reference, 'bad-token'), /acceder/);
  assert.equal(h.calls.provider.length, 0);
  const approved = h.context.refreshTransferOrder(order.reference, order.accessToken);
  assert.equal(approved.success, true);
  assert.equal(h.tables.TRANSFERENCIAS[1].estado, 'PENDIENTE_VERIFICACION');
  assert.equal(h.tables.CARTERA[2].valorPagado, 0);
  h.context.refreshTransferOrder(order.reference, order.accessToken);
  assert.equal(h.tables.PAGOS.length, 1);
  assert.equal(h.calls.provider.length, 1);
});

test('polling is throttled between tabs; timeouts keep the receipt and can recover', () => {
  const h = harness(); const order = h.create(); h.submit(order);
  h.context.refreshTransferOrder(order.reference, order.accessToken);
  assert.equal(h.calls.provider.length, 0);
  h.tables.TRANSFERENCIAS[0].actualizadoEn = '2020-01-01T00:00:00Z';
  h.failures.provider = true;
  const pending = h.context.refreshTransferOrder(order.reference, order.accessToken);
  assert.equal(pending.status, 'PENDIENTE_VERIFICACION');
  assert.equal(pending.receiptUploaded, true);
  h.context.refreshTransferOrder(order.reference, order.accessToken);
  assert.equal(h.calls.provider.length, 1);
  h.failures.provider = false; h.status('VERIFIED');
  h.tables.TRANSFERENCIAS[0].actualizadoEn = '2020-01-01T00:00:00Z';
  assert.equal(h.context.refreshTransferOrder(order.reference, order.accessToken).success, true);
});

test('public API has no simulation, direct reconciliation or new Wompi checkout actions', () => {
  const h = harness(); h.context.jsonOutput_ = value => value;
  for (const action of ['simulateTransferVerification', 'createWompiCheckout', 'reconcileForttuTransfers', 'transferReconcileOrder_']) {
    assert.equal(h.context.apiOutput_({ action, args: [] }).ok, false);
  }
});
