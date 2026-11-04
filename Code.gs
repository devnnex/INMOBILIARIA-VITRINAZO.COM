/**
 * Vitrinazo — API backend sobre Google Apps Script.
 *
 * El frontend externo se comunica exclusivamente con doGet/doPost. Las
 * funciones terminadas en _ son internas. No hay instalación manual: la primera
 * solicitud prepara la base, el administrador y la sincronización.
 * setupProject() queda disponible solo como diagnóstico o reparación.
 */

const APP = Object.freeze({
  name: 'Vitrinazo',
  defaultAdminPin: '1234', // Solo para pruebas. Cámbielo antes de producción.
  schemaVersion: '5',
  triggerRetryMillis: 6 * 60 * 60 * 1000,
  adminPageSize: 1000,
  adminMaxPageSize: 1000,
  timezone: 'America/Bogota',
  currency: 'COP',
  sheets: Object.freeze({
    clients: 'CLIENTES',
    properties: 'VIVIENDAS',
    contracts: 'CONTRATOS',
    ledger: 'CARTERA',
    payments: 'PAGOS',
    admins: 'ADMINISTRADORES',
    transfers: 'TRANSFERENCIAS'
  }),
  headers: Object.freeze({
    CLIENTES: ['id', 'documento', 'nombre', 'email', 'telefono', 'estado', 'creadoEn'],
    VIVIENDAS: ['id', 'codigo', 'direccion', 'ciudad', 'barrio', 'tipo', 'canon', 'estado', 'creadoEn'],
    CONTRATOS: ['id', 'clienteId', 'viviendaId', 'fechaInicio', 'fechaFin', 'canonMensual', 'estado', 'deposito', 'creadoEn'],
    CARTERA: ['id', 'contratoId', 'periodo', 'fechaVencimiento', 'valorBase', 'descuento', 'cargoExtra', 'observacion', 'estado', 'valorPagado', 'pagoId', 'actualizadoEn'],
    PAGOS: ['id', 'contratoId', 'clienteId', 'valor', 'metodo', 'estado', 'referencia', 'transaccionId', 'detalleJson', 'creadoEn', 'pagadoEn', 'nota'],
    ADMINISTRADORES: ['id', 'usuario', 'nombre', 'pinHash', 'pinSalt', 'estado', 'creadoEn', 'ultimoAcceso'],
    TRANSFERENCIAS: ['id', 'solicitudId', 'contratoId', 'clienteId', 'valorCentavos', 'moneda', 'asignacionesJson', 'cuentaJson', 'estado', 'comprobanteId', 'comprobanteHash', 'verificacionJson', 'ultimoError', 'creadoEn', 'actualizadoEn']
  })
});

const ADMIN_SECTIONS = Object.freeze({
  clients: 'CLIENTES',
  properties: 'VIVIENDAS',
  contracts: 'CONTRATOS',
  ledger: 'CARTERA',
  payments: 'PAGOS'
});

function doGet(e) {
  ensureProjectReady_();
  return jsonOutput_({
    ok: true,
    service: APP.name + ' API',
    schemaVersion: APP.schemaVersion,
    dataVersion: getDataVersion(),
    ready: true,
    timestamp: nowIso_()
  });
}

function doPost(e) {
  ensureProjectReady_();
  const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  if (payload.event === 'transaction.updated') {
    processWompiEvent_(payload);
    return jsonOutput_({ ok: true });
  }
  if (payload.action) return apiOutput_(payload);
  throw new Error('Solicitud no reconocida.');
}

function apiOutput_(payload) {
  try {
    const actions = {
      lookupAccount: lookupAccount,
      getContractDetails: getContractDetails,
      getDataVersion: getDataVersion,
      getPaymentStatus: getPaymentStatus,
      adminLogin: adminLogin,
      getAdminProfile: getAdminProfile,
      updateAdminProfile: updateAdminProfile,
      adminLogout: adminLogout,
      getAdminDashboard: getAdminDashboard,
      getAdminPage: getAdminPage,
      getAdminSync: getAdminSync,
      getForttuStatus: getForttuStatus,
      testForttuConnection: testForttuConnection,
      previewForttuResource: previewForttuResource,
      getTransferAvailability: getTransferAvailability,
      getTransferBankAccounts: getTransferBankAccounts,
      createTransferOrder: createTransferOrder,
      submitTransferReceipt: submitTransferReceipt,
      getTransferOrder: getTransferOrder,
      refreshTransferOrder: refreshTransferOrder,
      getContractLedgerForAdmin: getContractLedgerForAdmin,
      getClientAccountForAdmin: getClientAccountForAdmin,
      syncAccount: syncAccount,
      saveClient: saveClient,
      updateClient: updateClient,
      deleteClient: deleteClient,
      saveProperty: saveProperty,
      updateProperty: updateProperty,
      deleteProperty: deleteProperty,
      saveContract: saveContract,
      updateContract: updateContract,
      deleteContract: deleteContract,
      adjustLedgerItem: adjustLedgerItem,
      registerManualPayment: registerManualPayment,
      updateManualPayment: updateManualPayment,
      deleteManualPayment: deleteManualPayment
    };
    const action = String(payload.action || '');
    if (!Object.prototype.hasOwnProperty.call(actions, action)) throw new Error('Acción no permitida.');
    const args = Array.isArray(payload.args) ? payload.args : [];
    const needsLock = ['saveClient', 'updateClient', 'deleteClient', 'saveProperty', 'updateProperty', 'deleteProperty', 'saveContract', 'adjustLedgerItem', 'registerManualPayment'].indexOf(action) !== -1;
    const invoke = function () { return actions[action].apply(null, args); };
    return jsonOutput_({ ok: true, data: needsLock ? withScriptLock_(invoke) : invoke() });
  } catch (error) {
    return jsonOutput_({ ok: false, error: error && error.message ? error.message : 'Error interno.' });
  }
}

function withScriptLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return callback(); } finally { lock.releaseLock(); }
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function getAppUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (error) { return ''; }
}

/**
 * Diagnóstico/reparación opcional. No es necesario ejecutarla al desplegar:
 * doGet y doPost realizan esta preparación automáticamente en la primera petición.
 */
function setupProject() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return setupProject_();
  } finally {
    lock.releaseLock();
  }
}

function setupProject_() {
  const props = PropertiesService.getScriptProperties();
  const db = getDb_();
  Object.keys(APP.headers).forEach(function (sheetName) {
    ensureSheet_(db, sheetName, APP.headers[sheetName]);
  });

  const adminSetup = ensureDefaultAdmin_(db);
  if (!props.getProperty('DATA_VERSION')) props.setProperty('DATA_VERSION', '1');
  if (!props.getProperty('ADMIN_SESSION_VERSION')) props.setProperty('ADMIN_SESSION_VERSION', '1');
  initializeDataVersions_(props);
  const triggersReady = ensureChangeTriggers_(db);
  props.setProperties({
    PROJECT_READY: '1',
    PROJECT_SCHEMA_VERSION: APP.schemaVersion,
    CHANGE_TRIGGERS_READY: triggersReady ? '1' : '0',
    CHANGE_TRIGGERS_LAST_ATTEMPT: String(Date.now())
  }, false);
  ['ADMIN_PIN_SALT', 'ADMIN_PIN_HASH', 'ADMIN_INITIAL_PIN'].forEach(function (key) {
    props.deleteProperty(key);
  });
  const result = {
    spreadsheetUrl: db.getUrl(),
    adminUser: adminSetup.usuario,
    adminPin: adminSetup.created ? APP.defaultAdminPin : 'El administrador ya estaba configurado. Ejecute resetAdminPin() si necesita restaurar 1234.',
    changeTriggersReady: triggersReady,
    next: 'Inicialización terminada. Configure las llaves WOMPI_* antes de recibir pagos reales.'
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function ensureProjectReady_() {
  const props = PropertiesService.getScriptProperties();
  const schemaReady = props.getProperty('PROJECT_READY') === '1' &&
    props.getProperty('PROJECT_SCHEMA_VERSION') === APP.schemaVersion;
  const triggersReady = props.getProperty('CHANGE_TRIGGERS_READY') === '1';
  const lastTriggerAttempt = Number(props.getProperty('CHANGE_TRIGGERS_LAST_ATTEMPT') || 0);
  const triggerRetryDue = Date.now() - lastTriggerAttempt >= APP.triggerRetryMillis;
  if (schemaReady && (triggersReady || !triggerRetryDue)) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const readyAfterLock = props.getProperty('PROJECT_READY') === '1' &&
      props.getProperty('PROJECT_SCHEMA_VERSION') === APP.schemaVersion;
    if (!readyAfterLock) {
      setupProject_();
      return;
    }

    const retryAfterLock = Date.now() - Number(props.getProperty('CHANGE_TRIGGERS_LAST_ATTEMPT') || 0) >= APP.triggerRetryMillis;
    if (props.getProperty('CHANGE_TRIGGERS_READY') !== '1' && retryAfterLock) {
      const installed = ensureChangeTriggers_(getDb_());
      props.setProperties({
        CHANGE_TRIGGERS_READY: installed ? '1' : '0',
        CHANGE_TRIGGERS_LAST_ATTEMPT: String(Date.now())
      }, false);
    }
  } finally {
    lock.releaseLock();
  }
}

function resetAdminPin_() {
  ensureProjectReady_();
  const props = PropertiesService.getScriptProperties();
  const pin = APP.defaultAdminPin;
  const salt = Utilities.getUuid();
  const sheet = getDb_().getSheetByName(APP.sheets.admins);
  const row = findDataRow_(sheet, 'id', 'ADM-OWNER');
  if (!row) throw new Error('No se encontró el administrador propietario. Vuelva a abrir la aplicación para reparar la inicialización.');
  setCellByHeader_(sheet, row, APP.headers.ADMINISTRADORES, 'pinSalt', salt);
  setCellByHeader_(sheet, row, APP.headers.ADMINISTRADORES, 'pinHash', sha256Hex_(salt + pin));
  setCellByHeader_(sheet, row, APP.headers.ADMINISTRADORES, 'estado', 'ACTIVO');
  props.setProperty('ADMIN_SESSION_VERSION', String(Number(props.getProperty('ADMIN_SESSION_VERSION') || 0) + 1));
  console.log('Nuevo PIN administrativo: ' + pin);
  return pin;
}

function resetAdminPin() {
  return resetAdminPin_();
}

function getDb_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('DATABASE_SPREADSHEET_ID');
  if (savedId) return SpreadsheetApp.openById(savedId);

  let db = null;
  try { db = SpreadsheetApp.getActiveSpreadsheet(); } catch (error) { db = null; }
  if (!db) db = SpreadsheetApp.create('Vitrinazo · Base inmobiliaria');
  props.setProperty('DATABASE_SPREADSHEET_ID', db.getId());
  return db;
}

function ensureSheet_(db, name, headers) {
  let sheet = db.getSheetByName(name);
  if (!sheet) sheet = db.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#0a273b')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
    sheet.autoResizeColumns(1, headers.length);
  }
  return sheet;
}

function ensureDefaultAdmin_(db) {
  const sheet = db.getSheetByName(APP.sheets.admins);
  const admins = getRows_(sheet);
  const existing = admins.find(function (item) { return item.id === 'ADM-OWNER'; });
  if (existing) return { created: false, usuario: existing.usuario || 'admin' };

  const salt = Utilities.getUuid();
  sheet.appendRow([
    'ADM-OWNER',
    'admin',
    'Administrador principal',
    sha256Hex_(salt + APP.defaultAdminPin),
    salt,
    'ACTIVO',
    nowIso_(),
    ''
  ]);
  return { created: true, usuario: 'admin' };
}

function initializeDataVersions_(props) {
  const globalVersion = props.getProperty('DATA_VERSION') || '1';
  const values = {};
  Object.keys(ADMIN_SECTIONS).forEach(function (section) {
    const key = dataVersionKey_(section);
    if (!props.getProperty(key)) values[key] = globalVersion;
  });
  if (Object.keys(values).length) props.setProperties(values, false);
}

function ensureChangeTriggers_(db) {
  try {
    const existing = ScriptApp.getProjectTriggers().map(function (trigger) { return trigger.getHandlerFunction(); });
    if (existing.indexOf('handleSpreadsheetEdit') === -1) {
      ScriptApp.newTrigger('handleSpreadsheetEdit').forSpreadsheet(db).onEdit().create();
    }
    if (existing.indexOf('handleSpreadsheetChange') === -1) {
      ScriptApp.newTrigger('handleSpreadsheetChange').forSpreadsheet(db).onChange().create();
    }
    return true;
  } catch (error) {
    console.warn('No fue posible instalar los triggers de Sheets: ' + error.message);
    return false;
  }
}

function handleSpreadsheetEdit(e) {
  const sheet = e && e.range && e.range.getSheet();
  const section = sheet ? sectionFromSheetName_(sheet.getName()) : '';
  if (section) markDataChanged_(section === 'ledger' ? ['ledger', 'contracts'] : [section]);
}

function handleSpreadsheetChange(e) {
  if (e && e.changeType === 'EDIT') return;
  markDataChanged_(Object.keys(ADMIN_SECTIONS));
}

function seedDemoData_(db) {
  const now = nowIso_();
  const clientId = 'CLI-DEMO-001';
  const propertyId = 'VIV-DEMO-001';
  const contractId = 'CV-2026-0042';
  db.getSheetByName(APP.sheets.clients).appendRow([
    clientId, '1020304050', 'Mariana Torres', 'mariana@ejemplo.com', '300 555 0142', 'ACTIVO', now
  ]);
  db.getSheetByName(APP.sheets.properties).appendRow([
    propertyId, 'VTZ-042', 'Carrera 18 # 92–41, Apto 804', 'Bogotá D.C.', 'Chicó', 'Apartamento', 2450000, 'OCUPADA', now
  ]);
  db.getSheetByName(APP.sheets.contracts).appendRow([
    contractId, clientId, propertyId, '2026-01-01', '2026-12-31', 2450000, 'ACTIVO', 2450000, now
  ]);

  const demoLedger = [
    ['ENE 2026', '2026-01-10', 2450000, 0, 0, 'Pago recibido', 'PAGADO', 2450000],
    ['FEB 2026', '2026-02-10', 2450000, 0, 0, 'Pago recibido', 'PAGADO', 2450000],
    ['MAR 2026', '2026-03-10', 2450000, 120000, 0, 'Descuento por pronto pago', 'PENDIENTE', 0],
    ['ABR 2026', '2026-04-10', 2450000, 0, 85000, 'Reparación de vidrio reportada', 'PENDIENTE', 0],
    ['MAY 2026', '2026-05-10', 2450000, 0, 0, '', 'PENDIENTE', 0],
    ['JUN 2026', '2026-06-10', 2450000, 0, 0, '', 'PENDIENTE', 0]
  ].map(function (row, index) {
    return ['CAR-DEMO-' + String(index + 1).padStart(3, '0'), contractId].concat(row, ['', now]);
  });
  db.getSheetByName(APP.sheets.ledger)
    .getRange(2, 1, demoLedger.length, APP.headers.CARTERA.length)
    .setValues(demoLedger);
  markDataChanged_(Object.keys(ADMIN_SECTIONS));
}

// -----------------------------------------------------------------------------
// Portal público
// -----------------------------------------------------------------------------

function lookupAccount(query) {
  const value = normalizeSearch_(query);
  if (value.length < 4) throw new Error('Escribe una cédula o contrato válido.');
  const version = getDataVersion();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'PUBLIC_ACCOUNT_' + version + '_' + sha256Hex_(value).slice(0, 24);
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const db = getDb_();
  const contractSheet = db.getSheetByName(APP.sheets.contracts);
  let contracts = getRowsByValue_(contractSheet, 'id', value);
  if (!contracts.length && /^\d+$/.test(value)) {
    getRowsByValue_(db.getSheetByName(APP.sheets.clients), 'documento', value).forEach(function (client) {
      contracts = contracts.concat(getRowsByValue_(contractSheet, 'clienteId', client.id));
    });
  }
  if (!contracts.length) {
    const propertySheet = db.getSheetByName(APP.sheets.properties);
    const matchingProperty = (getRowsByValue_(propertySheet, 'codigo', value)[0] || getRowsByNormalizedValue_(propertySheet, 'codigo', value)[0]);
    if (matchingProperty) contracts = getRowsByValue_(contractSheet, 'viviendaId', matchingProperty.id);
  }
  contracts = uniqueRowsById_(contracts);

  const data = contracts.length ? getPublicDataForContracts_(contracts, db) : null;
  const result = contracts.length ? {
    found: true,
    version: version,
    contracts: contracts.map(function (contract) { return publicContractView_(contract, data); })
  } : { found: false, version: version, query: String(query || '') };
  const serialized = JSON.stringify(result);
  if (serialized.length < 90000) cache.put(cacheKey, serialized, 300);
  return result;
}

function getContractDetails(contractId) {
  const db = getDb_();
  const contract = getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'id', clean_(contractId))[0];
  if (!contract) throw new Error('El contrato no existe.');
  const data = getPublicDataForContracts_([contract], db);
  return { version: getDataVersion(), contract: publicContractView_(contract, data) };
}

function getPublicDataForContracts_(contracts, db) {
  const clients = [];
  const properties = [];
  let ledger = [];
  contracts.forEach(function (contract) {
    clients.push.apply(clients, getRowsByValue_(db.getSheetByName(APP.sheets.clients), 'id', contract.clienteId));
    properties.push.apply(properties, getRowsByValue_(db.getSheetByName(APP.sheets.properties), 'id', contract.viviendaId));
    ledger = ledger.concat(getRowsByValue_(db.getSheetByName(APP.sheets.ledger), 'contratoId', contract.id));
  });
  return {
    clients: uniqueRowsById_(clients),
    properties: uniqueRowsById_(properties),
    contracts: contracts,
    ledger: uniqueRowsById_(ledger),
    payments: []
  };
}

function getDataVersion() {
  return Number(PropertiesService.getScriptProperties().getProperty('DATA_VERSION') || 1);
}

function syncAccount(query, knownVersion) {
  const version = getDataVersion();
  if (Number(knownVersion || 0) === version) return { changed: false, version: version };
  const account = lookupAccount(query);
  account.changed = true;
  return account;
}

function getPaymentStatus(reference) {
  const cleanReference = String(reference || '').trim();
  if (!cleanReference) return { found: false };
  const payment = getRowsByValue_(getDb_().getSheetByName(APP.sheets.payments), 'referencia', cleanReference)[0];
  if (!payment) return { found: false };
  return {
    found: true,
    status: payment.estado,
    amount: number_(payment.valor),
    contractId: payment.contratoId,
    reference: payment.referencia,
    paidAt: payment.pagadoEn || ''
  };
}

function publicContractView_(contract, data) {
  const client = data.clients.find(function (item) { return item.id === contract.clienteId; }) || {};
  const property = data.properties.find(function (item) { return item.id === contract.viviendaId; }) || {};
  const ledger = data.ledger
    .filter(function (item) { return item.contratoId === contract.id; })
    .map(enrichLedgerItem_)
    .sort(function (a, b) { return String(a.fechaVencimiento).localeCompare(String(b.fechaVencimiento)); });
  const balance = ledger.reduce(function (sum, item) { return sum + item.saldo; }, 0);
  const overdue = ledger.filter(function (item) { return item.estadoCalculado === 'VENCIDO'; }).length;

  return {
    id: contract.id,
    estado: contract.estado,
    fechaInicio: contract.fechaInicio,
    fechaFin: contract.fechaFin,
    canonMensual: number_(contract.canonMensual),
    cliente: {
      nombre: client.nombre || '',
      documento: maskDocument_(client.documento),
      email: maskEmail_(client.email)
    },
    vivienda: {
      id: property.id || '',
      codigo: property.codigo || '',
      direccion: property.direccion || '',
      ciudad: property.ciudad || '',
      barrio: property.barrio || '',
      tipo: property.tipo || ''
    },
    cartera: ledger,
    resumen: { saldo: balance, vencidos: overdue, pendientes: ledger.filter(function (x) { return x.saldo > 0; }).length }
  };
}

function enrichLedgerItem_(item) {
  const base = number_(item.valorBase);
  const discount = number_(item.descuento);
  const extra = number_(item.cargoExtra);
  const paid = number_(item.valorPagado);
  const balance = Math.max(0, base - discount + extra - paid);
  let computed = String(item.estado || 'PENDIENTE').toUpperCase();
  if (balance <= 0) computed = 'PAGADO';
  else if (String(item.fechaVencimiento) < todayIso_()) computed = 'VENCIDO';
  else computed = 'PENDIENTE';
  return Object.assign({}, item, {
    valorBase: base,
    descuento: discount,
    cargoExtra: extra,
    valorPagado: paid,
    saldo: balance,
    estadoCalculado: computed
  });
}

// -----------------------------------------------------------------------------
// Wompi / PSE
// -----------------------------------------------------------------------------

function createWompiCheckout(contractId, ledgerIds, payer) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
  if (!Array.isArray(ledgerIds) || !ledgerIds.length) throw new Error('Selecciona al menos un mes.');
  const db = getDb_();
  const contract = getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'id', contractId)[0];
  if (!contract) throw new Error('Contrato no encontrado.');
  const contractLedger = getRowsByValue_(db.getSheetByName(APP.sheets.ledger), 'contratoId', contractId);
  const contractPayments = getRowsByValue_(db.getSheetByName(APP.sheets.payments), 'contratoId', contractId);
  const items = contractLedger
    .filter(function (item) { return ledgerIds.indexOf(item.id) !== -1; })
    .map(enrichLedgerItem_)
    .filter(function (item) { return item.saldo > 0; });
  if (items.length !== ledgerIds.length) throw new Error('Uno de los meses cambió. Actualiza la consulta.');

  if (getRowsByValue_(db.getSheetByName(APP.sheets.transfers), 'contratoId', contract.id).some(function (order) {
    return order.estado !== 'RECHAZADO' && JSON.parse(order.asignacionesJson).some(function (item) { return ledgerIds.indexOf(item.id) !== -1; });
  })) throw new Error('Hay una transferencia pendiente o en revisión para uno de estos meses. Consulta su estado.');

  const total = items.reduce(function (sum, item) { return sum + item.saldo; }, 0);
  const amountInCents = Math.round(total * 100);
  const reference = ('VTZ-' + contractId + '-' + Date.now()).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
  const props = PropertiesService.getScriptProperties();
  const publicKey = props.getProperty('WOMPI_PUBLIC_KEY');
  const integritySecret = props.getProperty('WOMPI_INTEGRITY_SECRET');
  const eventsSecret = props.getProperty('WOMPI_EVENTS_SECRET');
  const selectedPaymentOption = payer && payer.paymentOption === 'WOMPI_CHECKOUT' ? 'WOMPI_CHECKOUT' : 'PSE_WOMPI';

  const allocations = items.map(function (item) { return { id: item.id, amount: item.saldo }; });
  const recentPending = contractPayments.some(function (payment) {
    if (payment.estado !== 'PENDIENTE') return false;
    const age = Date.now() - new Date(payment.creadoEn).getTime();
    if (!Number.isFinite(age) || age > 20 * 60 * 1000) return false;
    try {
      const pendingIds = JSON.parse(payment.detalleJson || '[]').map(function (item) { return item.id; });
      return ledgerIds.some(function (id) { return pendingIds.indexOf(id) !== -1; });
    } catch (error) { return false; }
  });
  if (recentPending) throw new Error('Ya existe un pago en proceso para uno de estos meses. Espera unos minutos o actualiza la consulta.');
  if (!publicKey || !integritySecret || !eventsSecret) {
    return {
      configured: false,
      reference: reference,
      total: total,
      message: 'Configura WOMPI_PUBLIC_KEY, WOMPI_INTEGRITY_SECRET y WOMPI_EVENTS_SECRET antes de recibir pagos.'
    };
  }

  appendPayment_({
    id: makeId_('PAG'),
    contratoId: contract.id,
    clienteId: contract.clienteId,
    valor: total,
    metodo: selectedPaymentOption,
    estado: 'PENDIENTE',
    referencia: reference,
    transaccionId: '',
    detalleJson: JSON.stringify(allocations),
    creadoEn: nowIso_(),
    pagadoEn: '',
    nota: selectedPaymentOption === 'PSE_WOMPI' ? 'PSE procesado por Wompi' : 'Checkout Wompi'
  });
  markDataChanged_(['payments']);

  const signature = sha256Hex_(reference + amountInCents + APP.currency + integritySecret);
  const client = getRowsByValue_(db.getSheetByName(APP.sheets.clients), 'id', contract.clienteId)[0] || {};
  const customer = Object.assign({}, client, payer || {});
  const returnBase = validHttpUrl_(customer.returnUrl) || getAppUrl_();
  const redirectUrl = returnBase + (returnBase.indexOf('?') === -1 ? '?' : '&') + 'payment=return&reference=' + encodeURIComponent(reference);
  const query = {
    'public-key': publicKey,
    currency: APP.currency,
    'amount-in-cents': amountInCents,
    reference: reference,
    'signature:integrity': signature,
    'redirect-url': redirectUrl,
    'customer-data:email': customer.email || '',
    'customer-data:full-name': customer.nombre || customer.fullName || '',
    'customer-data:phone-number': String(customer.telefono || customer.phone || '').replace(/\D/g, ''),
    'customer-data:phone-number-prefix': '+57',
    'customer-data:legal-id': String(client.documento || '').replace(/\D/g, ''),
    'customer-data:legal-id-type': 'CC'
  };
  const checkoutUrl = 'https://checkout.wompi.co/p/?' + Object.keys(query)
    .filter(function (key) { return query[key] !== ''; })
    .map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(query[key]); })
    .join('&');
  return { configured: true, checkoutUrl: checkoutUrl, reference: reference, total: total };
  } finally {
    lock.releaseLock();
  }
}

function processWompiEvent_(payload) {
  const secret = PropertiesService.getScriptProperties().getProperty('WOMPI_EVENTS_SECRET');
  if (!secret) throw new Error('WOMPI_EVENTS_SECRET no configurado.');
  const properties = (payload.signature && payload.signature.properties) || [];
  const joined = properties.map(function (path) { return getByPath_(payload.data, path); }).join('') + payload.timestamp + secret;
  const expected = sha256Hex_(joined);
  const received = String(payload.signature && payload.signature.checksum || '').toLowerCase();
  if (!safeEqual_(expected, received)) throw new Error('Firma de evento inválida.');

  const transaction = payload.data && payload.data.transaction;
  if (!transaction || !transaction.reference) return;
  const status = String(transaction.status || '').toUpperCase();
  updatePaymentFromGateway_(transaction.reference, status, transaction.id || '', number_(transaction.amount_in_cents) / 100);
}

function updatePaymentFromGateway_(reference, status, transactionId, paidAmount) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = getDb_().getSheetByName(APP.sheets.payments);
    const headers = APP.headers.PAGOS;
    const payment = getRowsByValue_(sheet, 'referencia', reference)[0];
    if (!payment) throw new Error('No encontramos el número de este pago.');
    if (payment.estado === 'APROBADO') return;
    if (status === 'APPROVED' && Math.round(number_(payment.valor)) !== Math.round(paidAmount)) {
      throw new Error('El valor recibido no coincide con el valor esperado para este pago.');
    }

    const rowIndex = findDataRow_(sheet, 'referencia', reference);
    setCellByHeader_(sheet, rowIndex, headers, 'estado', translateGatewayStatus_(status));
    setCellByHeader_(sheet, rowIndex, headers, 'transaccionId', transactionId);
    if (status === 'APPROVED') {
      setCellByHeader_(sheet, rowIndex, headers, 'pagadoEn', nowIso_());
      applyPaymentAllocations_(payment);
    }
    markDataChanged_(['payments', 'ledger', 'contracts']);
  } finally {
    lock.releaseLock();
  }
}

function translateGatewayStatus_(status) {
  return ({ APPROVED: 'APROBADO', DECLINED: 'RECHAZADO', VOIDED: 'ANULADO', ERROR: 'ERROR', PENDING: 'PENDIENTE' })[status] || status;
}

function applyPaymentAllocations_(payment) {
  const allocations = JSON.parse(payment.detalleJson || '[]');
  const sheet = getDb_().getSheetByName(APP.sheets.ledger);
  const headers = APP.headers.CARTERA;
  const updates = [];
  allocations.forEach(function (allocation) {
    const match = getRowsWithNumbersByValue_(sheet, 'id', allocation.id)[0];
    if (!match) return;
    const record = match.record;
    const currentPaid = number_(record.valorPagado);
    const base = number_(record.valorBase);
    const discount = number_(record.descuento);
    const extra = number_(record.cargoExtra);
    const totalDue = Math.max(0, base - discount + extra);
    const newPaid = Math.min(totalDue, currentPaid + number_(allocation.amount));
    record.valorPagado = newPaid;
    record.pagoId = payment.id;
    record.estado = newPaid >= totalDue ? 'PAGADO' : 'PENDIENTE';
    record.actualizadoEn = nowIso_();
    updates.push({ rowNumber: match.rowNumber, record: record });
  });
  writeRowUpdates_(sheet, headers, updates);
}

// -----------------------------------------------------------------------------
// Sesión y panel administrativo
// -----------------------------------------------------------------------------

function adminLogin(pin) {
  ensureProjectReady_();
  return withScriptLock_(function () {
    const props = PropertiesService.getScriptProperties();
    let attempts = {};
    try { attempts = JSON.parse(props.getProperty('ADMIN_LOGIN_GUARD') || '{}') || {}; } catch (error) { /* Empty guard. */ }
    if (Number(attempts.blockedUntil || 0) > Date.now()) return { ok: false, message: 'Demasiados intentos. Reintenta en unos minutos.' };
    const sheet = getDb_().getSheetByName(APP.sheets.admins);
    const admin = getRows_(sheet).find(function (item) {
      return item.id === 'ADM-OWNER' && String(item.estado || '').toUpperCase() === 'ACTIVO';
    });
    if (!admin || !admin.pinSalt || !admin.pinHash) return { ok: false, needsSetup: true };
    const submittedPin = String(pin || '').trim();
    if (!safeEqual_(sha256Hex_(admin.pinSalt + submittedPin), admin.pinHash)) {
      const failures = Number(attempts.blockedUntil || 0) ? 1 : Number(attempts.failures || 0) + 1;
      props.setProperty('ADMIN_LOGIN_GUARD', JSON.stringify({ failures: failures, blockedUntil: failures >= 5 ? Date.now() + 5 * 60 * 1000 : 0 }));
      return { ok: false, message: 'PIN incorrecto.' };
    }
    props.setProperty('ADMIN_LOGIN_GUARD', '{}');
    const session = issueAdminSession_();
    const row = findDataRow_(sheet, 'id', admin.id);
    setCellByHeader_(sheet, row, APP.headers.ADMINISTRADORES, 'ultimoAcceso', nowIso_());
    return Object.assign({ ok: true, admin: publicAdminProfile_(admin) }, session);
  });
}

function issueAdminSession_() {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const version = PropertiesService.getScriptProperties().getProperty('ADMIN_SESSION_VERSION') || '1';
  const now = Date.now();
  const day = Utilities.formatDate(new Date(now), APP.timezone, 'yyyy-MM-dd');
  const midnight = Date.parse(day + 'T00:00:00-05:00') + 24 * 60 * 60 * 1000;
  const expiresAt = Math.min(now + 21600 * 1000, midnight);
  CacheService.getScriptCache().put('ADMIN_TOKEN_' + token, JSON.stringify({ version: version, day: day, expiresAt: expiresAt }), Math.max(1, Math.floor((expiresAt - now) / 1000)));
  return { token: token, expiresAt: expiresAt, serverNow: now, expiresIn: Math.max(1, Math.floor((expiresAt - now) / 1000)) };
}

function ownerAdmin_() {
  const admin = getRows_(getDb_().getSheetByName(APP.sheets.admins)).find(function (item) {
    return item.id === 'ADM-OWNER' && String(item.estado || '').toUpperCase() === 'ACTIVO';
  });
  if (!admin) throw new Error('La cuenta administrativa no está disponible.');
  return admin;
}

function publicAdminProfile_(admin) {
  const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PROFILE_ADM-OWNER');
  let contact = {};
  try { contact = JSON.parse(stored || '{}') || {}; } catch (error) { /* Optional contact data. */ }
  return { id: admin.id, usuario: admin.usuario, nombre: admin.nombre, email: String(contact.email || ''), telefono: String(contact.telefono || '') };
}

function getAdminProfile(token) {
  assertAdmin_(token);
  return { admin: publicAdminProfile_(ownerAdmin_()) };
}

function updateAdminProfile(token, input) {
  assertAdmin_(token);
  return withScriptLock_(function () {
    assertAdmin_(token);
    const admin = ownerAdmin_();
    const data = input || {};
    const nombre = String(data.nombre || '').trim();
    const usuario = String(data.usuario || '').trim();
    const email = String(data.email || '').trim();
    const telefono = String(data.telefono || '').trim();
    if (nombre.length < 2 || nombre.length > 100 || /^[=+@-]/.test(nombre) || /[\r\n\t]/.test(nombre)) throw new Error('Escribe un nombre válido de 2 a 100 caracteres.');
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{2,39}$/.test(usuario)) throw new Error('El usuario debe tener entre 3 y 40 letras, números, puntos o guiones, y comenzar con una letra.');
    if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Revisa el correo electrónico.');
    if (telefono && !/^[+\d () .-]{5,30}$/.test(telefono)) throw new Error('Revisa el número de teléfono.');
    const newPin = String(data.newPin || '');
    const changingPin = Boolean(newPin || data.currentPin || data.confirmPin);
    if (changingPin) {
      if (!safeEqual_(sha256Hex_(admin.pinSalt + String(data.currentPin || '')), admin.pinHash)) throw new Error('El PIN actual no es correcto.');
      if (!/^\d{4,12}$/.test(newPin)) throw new Error('El nuevo PIN debe tener entre 4 y 12 números.');
      if (newPin !== String(data.confirmPin || '')) throw new Error('Los nuevos PIN no coinciden.');
    }
    const sheet = getDb_().getSheetByName(APP.sheets.admins);
    const row = findDataRow_(sheet, 'id', admin.id);
    setCellByHeader_(sheet, row, APP.headers.ADMINISTRADORES, 'nombre', nombre);
    setCellByHeader_(sheet, row, APP.headers.ADMINISTRADORES, 'usuario', usuario);
    const props = PropertiesService.getScriptProperties();
    props.setProperty('ADMIN_PROFILE_ADM-OWNER', JSON.stringify({ email: email, telefono: telefono }));
    if (changingPin) {
      const salt = Utilities.getUuid().replace(/-/g, '');
      setCellByHeader_(sheet, row, APP.headers.ADMINISTRADORES, 'pinSalt', salt);
      setCellByHeader_(sheet, row, APP.headers.ADMINISTRADORES, 'pinHash', sha256Hex_(salt + newPin));
      props.setProperty('ADMIN_SESSION_VERSION', String(Number(props.getProperty('ADMIN_SESSION_VERSION') || '1') + 1));
      CacheService.getScriptCache().remove('ADMIN_TOKEN_' + token);
    }
    const session = changingPin ? issueAdminSession_() : { token: token, expiresAt: assertAdmin_(token).expiresAt, serverNow: Date.now() };
    return Object.assign({ ok: true, admin: publicAdminProfile_({ id: admin.id, nombre: nombre, usuario: usuario }), pinChanged: changingPin }, session);
  });
}

function adminLogout(token) {
  CacheService.getScriptCache().remove('ADMIN_TOKEN_' + String(token || ''));
  return { ok: true };
}

function getAdminDashboard(token, limit) {
  assertAdmin_(token);
  const safeLimit = normalizePageLimit_(limit);
  const data = getSnapshot_(true);
  const pages = {
    clients: pageFromRows_(data.clients, safeLimit),
    properties: pageFromRows_(data.properties, safeLimit),
    contracts: pageFromRows_(enrichAdminContractsFromData_(data.contracts, data), safeLimit),
    ledger: pageFromRows_(enrichAdminLedgerFromData_(data.ledger, data), safeLimit),
    payments: pageFromRows_(data.payments, safeLimit)
  };
  return adminPayloadFromPages_(pages, getAdminStatsFromData_(data));
}

function getAdminPage(token, section, offset, limit) {
  assertAdmin_(token);
  const cleanSection = normalizeAdminSection_(section);
  return {
    version: getDataVersion(),
    versions: getDataVersions_(),
    section: cleanSection,
    page: getAdminSectionPage_(cleanSection, offset, limit)
  };
}

function getAdminSync(token, knownVersions, limit) {
  assertAdmin_(token);
  const currentVersions = getDataVersions_();
  const known = knownVersions && typeof knownVersions === 'object' ? knownVersions : {};
  const changedSections = Object.keys(ADMIN_SECTIONS).filter(function (section) {
    return Number(known[section] || 0) !== Number(currentVersions[section] || 0);
  });
  if (!changedSections.length) {
    return { changed: false, version: getDataVersion(), versions: currentVersions, sections: {} };
  }

  const pages = {};
  changedSections.forEach(function (section) {
    pages[section] = getAdminSectionPage_(section, 0, limit);
  });
  return {
    changed: true,
    version: getDataVersion(),
    versions: currentVersions,
    changedSections: changedSections,
    stats: getAdminStats_(),
    sections: pages
  };
}

function getContractLedgerForAdmin(token, contractId) {
  assertAdmin_(token);
  const id = clean_(contractId);
  if (!id) throw new Error('Selecciona un contrato.');
  return getRowsByValue_(getDb_().getSheetByName(APP.sheets.ledger), 'contratoId', id)
    .map(enrichLedgerItem_)
    .sort(function (a, b) { return String(a.fechaVencimiento).localeCompare(String(b.fechaVencimiento)); });
}

function getClientAccountForAdmin(token, clientId) {
  assertAdmin_(token);
  const id = clean_(clientId);
  if (!id) throw new Error('Selecciona un cliente.');
  const db = getDb_();
  const client = getRowsByValue_(db.getSheetByName(APP.sheets.clients), 'id', id)[0];
  if (!client) throw new Error('No encontramos este cliente.');
  const contracts = getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'clienteId', id);
  let ledger = [];
  let payments = [];
  contracts.forEach(function (contract) {
    ledger = ledger.concat(getRowsByValue_(db.getSheetByName(APP.sheets.ledger), 'contratoId', contract.id));
    payments = payments.concat(getRowsByValue_(db.getSheetByName(APP.sheets.payments), 'contratoId', contract.id));
  });
  const data = { clients: [client], properties: [], contracts: contracts, ledger: ledger, payments: payments };
  contracts.forEach(function (contract) {
    data.properties = data.properties.concat(getRowsByValue_(db.getSheetByName(APP.sheets.properties), 'id', contract.viviendaId));
  });
  return {
    client: client,
    contracts: enrichAdminContractsFromData_(contracts, data),
    ledger: enrichAdminLedgerFromData_(ledger, data),
    payments: payments
  };
}

function adminPayloadFromPages_(pages, stats) {
  const result = {
    version: getDataVersion(),
    versions: getDataVersions_(),
    stats: stats || getAdminStats_(),
    pageInfo: {}
  };
  Object.keys(ADMIN_SECTIONS).forEach(function (section) {
    const page = pages[section];
    result[section] = page.items;
    result.pageInfo[section] = {
      total: page.total,
      offset: page.offset,
      nextOffset: page.nextOffset,
      hasMore: page.hasMore,
      limit: page.limit
    };
  });
  return result;
}

function pageFromRows_(rows, limit) {
  const total = rows.length;
  const items = rows.slice(Math.max(0, total - limit)).reverse();
  return { items: items, total: total, offset: 0, limit: limit, nextOffset: items.length, hasMore: items.length < total };
}

function getAdminStatsFromData_(data) {
  const ledger = data.ledger.map(enrichLedgerItem_);
  return {
    clientes: data.clients.length,
    contratosActivos: data.contracts.filter(function (item) { return item.estado === 'ACTIVO'; }).length,
    cartera: ledger.reduce(function (sum, item) { return sum + item.saldo; }, 0),
    recaudado: data.payments.filter(function (item) { return item.estado === 'APROBADO'; })
      .reduce(function (sum, item) { return sum + number_(item.valor); }, 0)
  };
}

function enrichAdminContractsFromData_(contracts, data) {
  const clients = indexRowsBy_(data.clients, 'id');
  const properties = indexRowsBy_(data.properties, 'id');
  const balances = {};
  const dueDays = {};
  data.ledger.forEach(function (item) {
    balances[item.contratoId] = number_(balances[item.contratoId]) + enrichLedgerItem_(item).saldo;
    if (!dueDays[item.contratoId]) dueDays[item.contratoId] = dueDayFromValue_(item.fechaVencimiento);
  });
  return contracts.map(function (contract) {
    const client = clients[contract.clienteId] || {};
    const property = properties[contract.viviendaId] || {};
    return Object.assign({}, contract, { clienteNombre: client.nombre || '', viviendaCodigo: property.codigo || '', saldo: number_(balances[contract.id]), diaVencimiento: dueDays[contract.id] || 10 });
  });
}

function enrichAdminLedgerFromData_(ledger, data) {
  const contracts = indexRowsBy_(data.contracts, 'id');
  const clients = indexRowsBy_(data.clients, 'id');
  return ledger.map(function (item) {
    const contract = contracts[item.contratoId] || {};
    const client = clients[contract.clienteId] || {};
    return Object.assign(enrichLedgerItem_(item), { clienteNombre: client.nombre || '' });
  });
}

function getAdminSectionPage_(section, offset, limit) {
  const cleanSection = normalizeAdminSection_(section);
  const safeOffset = Math.max(0, Math.floor(number_(offset)));
  const safeLimit = normalizePageLimit_(limit);
  const versions = getDataVersions_();
  const cache = CacheService.getScriptCache();
  const cacheKey = ['ADMIN_PAGE', cleanSection, versions[cleanSection], safeOffset, safeLimit].join('_');
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const db = getDb_();
  const sheetName = ADMIN_SECTIONS[cleanSection];
  const page = getRowsPage_(db.getSheetByName(sheetName), safeOffset, safeLimit);
  let items = page.items;
  if (cleanSection === 'contracts') items = enrichAdminContracts_(items, db);
  if (cleanSection === 'ledger') items = enrichAdminLedger_(items, db);
  page.items = items;

  const serialized = JSON.stringify(page);
  if (serialized.length < 90000) cache.put(cacheKey, serialized, 120);
  return page;
}

function getAdminStats_() {
  const version = getDataVersion();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'ADMIN_STATS_' + version;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const db = getDb_();
  const contracts = getRows_(db.getSheetByName(APP.sheets.contracts));
  const ledger = getRows_(db.getSheetByName(APP.sheets.ledger)).map(enrichLedgerItem_);
  const payments = getRows_(db.getSheetByName(APP.sheets.payments));
  const stats = {
    clientes: Math.max(0, db.getSheetByName(APP.sheets.clients).getLastRow() - 1),
    contratosActivos: contracts.filter(function (item) { return item.estado === 'ACTIVO'; }).length,
    cartera: ledger.reduce(function (sum, item) { return sum + item.saldo; }, 0),
    recaudado: payments.filter(function (item) { return item.estado === 'APROBADO'; })
      .reduce(function (sum, item) { return sum + number_(item.valor); }, 0)
  };
  cache.put(cacheKey, JSON.stringify(stats), 120);
  return stats;
}

function enrichAdminContracts_(contracts, db) {
  const clients = indexRowsBy_(getRows_(db.getSheetByName(APP.sheets.clients)), 'id');
  const properties = indexRowsBy_(getRows_(db.getSheetByName(APP.sheets.properties)), 'id');
  const balances = {};
  const dueDays = {};
  const wanted = {};
  contracts.forEach(function (contract) { wanted[contract.id] = true; });
  getRows_(db.getSheetByName(APP.sheets.ledger)).forEach(function (item) {
    if (!wanted[item.contratoId]) return;
    balances[item.contratoId] = number_(balances[item.contratoId]) + enrichLedgerItem_(item).saldo;
    if (!dueDays[item.contratoId]) dueDays[item.contratoId] = dueDayFromValue_(item.fechaVencimiento);
  });
  return contracts.map(function (contract) {
    const client = clients[contract.clienteId] || {};
    const property = properties[contract.viviendaId] || {};
    return Object.assign({}, contract, {
      clienteNombre: client.nombre || '',
      viviendaCodigo: property.codigo || '',
      saldo: number_(balances[contract.id]),
      diaVencimiento: dueDays[contract.id] || 10
    });
  });
}

function enrichAdminLedger_(ledger, db) {
  const contracts = indexRowsBy_(getRows_(db.getSheetByName(APP.sheets.contracts)), 'id');
  const clients = indexRowsBy_(getRows_(db.getSheetByName(APP.sheets.clients)), 'id');
  return ledger.map(function (item) {
    const contract = contracts[item.contratoId] || {};
    const client = clients[contract.clienteId] || {};
    return Object.assign(enrichLedgerItem_(item), { clienteNombre: client.nombre || '' });
  });
}

function saveClient(token, input) {
  assertAdmin_(token);
  requireFields_(input, ['documento', 'nombre']);
  const document = String(input.documento).replace(/\D/g, '');
  const db = getDb_();
  if (getRowsByValue_(db.getSheetByName(APP.sheets.clients), 'documento', document).length) {
    throw new Error('Ya existe un cliente con ese documento.');
  }
  const record = {
    id: makeId_('CLI'), documento: document, nombre: clean_(input.nombre), email: clean_(input.email),
    telefono: clean_(input.telefono), estado: 'ACTIVO', creadoEn: nowIso_()
  };
  appendObject_(APP.sheets.clients, APP.headers.CLIENTES, record);
  markDataChanged_(['clients']);
  return { ok: true, record: record };
}

function updateClient(token, input) {
  assertAdmin_(token);
  requireFields_(input, ['id', 'documento', 'nombre']);
  const sheet = getDb_().getSheetByName(APP.sheets.clients);
  const document = String(input.documento).replace(/\D/g, '');
  if (getRowsByValue_(sheet, 'documento', document).some(function (item) { return item.id !== input.id; })) {
    throw new Error('Ya existe otro cliente con ese número de documento.');
  }
  const match = getRowsWithNumbersByValue_(sheet, 'id', input.id)[0];
  const existing = match && match.record;
  if (!existing) throw new Error('No encontramos este cliente.');
  const record = Object.assign({}, existing, {
    documento: document,
    nombre: clean_(input.nombre),
    email: clean_(input.email),
    telefono: clean_(input.telefono),
    estado: normalizeStatus_(input.estado, ['ACTIVO', 'INACTIVO'], existing.estado || 'ACTIVO')
  });
  writeObjectToRow_(APP.sheets.clients, APP.headers.CLIENTES, match.rowNumber, record);
  markDataChanged_(['clients', 'contracts', 'ledger']);
  return { ok: true, record: record };
}

function deleteClient(token, id) {
  assertAdmin_(token);
  const db = getDb_();
  if (getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'clienteId', id).length) {
    throw new Error('Este cliente tiene contratos. Elimina primero esos contratos.');
  }
  const sheet = db.getSheetByName(APP.sheets.clients);
  const row = findDataRow_(sheet, 'id', id);
  if (!row) throw new Error('No encontramos este cliente.');
  sheet.deleteRow(row);
  markDataChanged_(['clients']);
  return { ok: true, id: id };
}

function saveProperty(token, input) {
  assertAdmin_(token);
  requireFields_(input, ['codigo', 'direccion', 'ciudad']);
  const db = getDb_();
  const code = clean_(input.codigo).toUpperCase();
  if (getRowsByValue_(db.getSheetByName(APP.sheets.properties), 'codigo', code).length) {
    throw new Error('Ya existe una vivienda con ese código.');
  }
  const record = {
    id: makeId_('VIV'), codigo: code, direccion: clean_(input.direccion), ciudad: clean_(input.ciudad),
    barrio: clean_(input.barrio), tipo: clean_(input.tipo || 'Vivienda'), canon: number_(input.canon),
    estado: 'DISPONIBLE', creadoEn: nowIso_()
  };
  appendObject_(APP.sheets.properties, APP.headers.VIVIENDAS, record);
  markDataChanged_(['properties']);
  return { ok: true, record: record };
}

function updateProperty(token, input) {
  assertAdmin_(token);
  requireFields_(input, ['id', 'codigo', 'direccion', 'ciudad']);
  const db = getDb_();
  const sheet = db.getSheetByName(APP.sheets.properties);
  const code = clean_(input.codigo).toUpperCase();
  if (getRowsByValue_(sheet, 'codigo', code).some(function (item) { return item.id !== input.id; })) {
    throw new Error('Ya existe otra vivienda con ese código.');
  }
  const match = getRowsWithNumbersByValue_(sheet, 'id', input.id)[0];
  const existing = match && match.record;
  if (!existing) throw new Error('No encontramos esta vivienda.');
  const linked = getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'viviendaId', input.id).some(function (item) { return item.estado === 'ACTIVO'; });
  const record = Object.assign({}, existing, {
    codigo: code,
    direccion: clean_(input.direccion),
    ciudad: clean_(input.ciudad),
    barrio: clean_(input.barrio),
    tipo: clean_(input.tipo || 'Vivienda'),
    canon: Math.max(0, number_(input.canon)),
    estado: linked ? 'OCUPADA' : normalizeStatus_(input.estado, ['DISPONIBLE', 'OCUPADA', 'MANTENIMIENTO'], existing.estado || 'DISPONIBLE')
  });
  writeObjectToRow_(APP.sheets.properties, APP.headers.VIVIENDAS, match.rowNumber, record);
  markDataChanged_(['properties', 'contracts']);
  return { ok: true, record: record };
}

function deleteProperty(token, id) {
  assertAdmin_(token);
  const db = getDb_();
  if (getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'viviendaId', id).length) {
    throw new Error('Esta vivienda tiene contratos. Elimina primero esos contratos.');
  }
  const sheet = db.getSheetByName(APP.sheets.properties);
  const row = findDataRow_(sheet, 'id', id);
  if (!row) throw new Error('No encontramos esta vivienda.');
  sheet.deleteRow(row);
  markDataChanged_(['properties']);
  return { ok: true, id: id };
}

function saveContract(token, input) {
  assertAdmin_(token);
  requireFields_(input, ['clienteId', 'viviendaId', 'fechaInicio', 'fechaFin', 'canonMensual']);
  const db = getDb_();
  if (!getRowsByValue_(db.getSheetByName(APP.sheets.clients), 'id', input.clienteId).length) throw new Error('Cliente inválido.');
  const propertySheet = db.getSheetByName(APP.sheets.properties);
  const propertyMatch = getRowsWithNumbersByValue_(propertySheet, 'id', input.viviendaId)[0];
  if (!propertyMatch) throw new Error('Vivienda inválida.');
  if (String(input.fechaFin) < String(input.fechaInicio)) throw new Error('La fecha final debe ser posterior a la inicial.');
  const rent = number_(input.canonMensual);
  if (rent <= 0) throw new Error('El valor mensual del arriendo debe ser mayor que cero.');

  const contractId = makeContractId_();
  const record = {
    id: contractId, clienteId: input.clienteId, viviendaId: input.viviendaId,
    fechaInicio: input.fechaInicio, fechaFin: input.fechaFin, canonMensual: rent,
    estado: 'ACTIVO', deposito: number_(input.deposito), creadoEn: nowIso_()
  };
  appendObject_(APP.sheets.contracts, APP.headers.CONTRATOS, record);
  generateLedger_(contractId, input.fechaInicio, input.fechaFin, rent, number_(input.diaVencimiento) || 10);
  if (number_(propertyMatch.record.canon) <= 0) {
    propertyMatch.record.canon = rent;
    propertyMatch.record.estado = 'OCUPADA';
    writeObjectToRow_(APP.sheets.properties, APP.headers.VIVIENDAS, propertyMatch.rowNumber, propertyMatch.record);
  } else {
    updatePropertyStatus_(input.viviendaId, 'OCUPADA');
  }
  markDataChanged_(['contracts', 'ledger', 'properties']);
  return { ok: true, contractId: contractId, record: record };
}

function updateContract(token, input) {
  assertAdmin_(token);
  requireFields_(input, ['id', 'clienteId', 'viviendaId', 'fechaInicio', 'fechaFin', 'canonMensual']);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const db = getDb_();
    const contractSheet = db.getSheetByName(APP.sheets.contracts);
    const contractMatch = getRowsWithNumbersByValue_(contractSheet, 'id', input.id)[0];
    const existing = contractMatch && contractMatch.record;
    if (!existing) throw new Error('No encontramos este contrato.');
    if (!getRowsByValue_(db.getSheetByName(APP.sheets.clients), 'id', input.clienteId).length) throw new Error('Selecciona un cliente válido.');
    if (!getRowsByValue_(db.getSheetByName(APP.sheets.properties), 'id', input.viviendaId).length) throw new Error('Selecciona una vivienda válida.');
    if (String(input.fechaFin) < String(input.fechaInicio)) throw new Error('La fecha final debe ser posterior a la inicial.');
    const rent = number_(input.canonMensual);
    if (rent <= 0) throw new Error('El valor mensual del arriendo debe ser mayor que cero.');
    syncContractLedger_(existing.id, input.fechaInicio, input.fechaFin, rent, number_(input.diaVencimiento) || 10);
    const record = Object.assign({}, existing, {
      clienteId: input.clienteId,
      viviendaId: input.viviendaId,
      fechaInicio: input.fechaInicio,
      fechaFin: input.fechaFin,
      canonMensual: rent,
      deposito: Math.max(0, number_(input.deposito)),
      estado: normalizeStatus_(input.estado, ['ACTIVO', 'FINALIZADO', 'CANCELADO'], existing.estado || 'ACTIVO')
    });
    writeObjectToRow_(APP.sheets.contracts, APP.headers.CONTRATOS, contractMatch.rowNumber, record);
    if (existing.viviendaId !== record.viviendaId || record.estado !== 'ACTIVO') releasePropertyIfUnused_(existing.viviendaId, existing.id);
    if (record.estado === 'ACTIVO') updatePropertyStatus_(record.viviendaId, 'OCUPADA');
    else releasePropertyIfUnused_(record.viviendaId, record.id);
    markDataChanged_(['contracts', 'ledger', 'properties']);
    return { ok: true, record: record };
  } finally {
    lock.releaseLock();
  }
}

function deleteContract(token, id) {
  assertAdmin_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const db = getDb_();
    const contract = getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'id', id)[0];
    if (!contract) throw new Error('No encontramos este contrato.');
    if (getRowsByValue_(db.getSheetByName(APP.sheets.transfers), 'contratoId', id).length) {
      throw new Error('Este contrato tiene solicitudes de transferencia y debe conservarse como historial.');
    }
    if (getRowsByValue_(db.getSheetByName(APP.sheets.payments), 'contratoId', id).some(function (item) { return item.estado === 'APROBADO'; })) {
      throw new Error('Este contrato tiene pagos aprobados y debe conservarse como historial. Puedes marcarlo como finalizado.');
    }
    deleteRowsMatching_(APP.sheets.payments, function (item) { return item.contratoId === id; });
    deleteRowsMatching_(APP.sheets.ledger, function (item) { return item.contratoId === id; });
    deleteRowsMatching_(APP.sheets.contracts, function (item) { return item.id === id; });
    releasePropertyIfUnused_(contract.viviendaId, id);
    markDataChanged_(['contracts', 'ledger', 'payments', 'properties']);
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

function adjustLedgerItem(token, input) {
  assertAdmin_(token);
  requireFields_(input, ['id']);
  const sheet = getDb_().getSheetByName(APP.sheets.ledger);
  const match = getRowsWithNumbersByValue_(sheet, 'id', input.id)[0];
  if (!match) throw new Error('No encontramos este cobro mensual.');
  const row = match.rowNumber;
  const headers = APP.headers.CARTERA;
  const existing = match.record;
  const record = Object.assign({}, existing, {
    descuento: Math.max(0, number_(input.descuento)),
    cargoExtra: Math.max(0, number_(input.cargoExtra)),
    observacion: clean_(input.observacion),
    actualizadoEn: nowIso_()
  });
  sheet.getRange(row, 1, 1, headers.length).setValues([
    headers.map(function (header) { return record[header] === undefined ? '' : record[header]; })
  ]);
  markDataChanged_(['ledger', 'contracts']);
  return { ok: true, record: enrichLedgerItem_(record) };
}

function registerManualPayment(token, input) {
  assertAdmin_(token);
  requireFields_(input, ['contratoId', 'ledgerIds', 'metodo']);
  const ids = Array.isArray(input.ledgerIds) ? input.ledgerIds : [];
  if (!ids.length) throw new Error('Selecciona al menos un mes.');
  const db = getDb_();
  const contract = getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'id', input.contratoId)[0];
  if (!contract) throw new Error('Contrato no encontrado.');
  const items = getRowsByValue_(db.getSheetByName(APP.sheets.ledger), 'contratoId', contract.id).filter(function (item) { return ids.indexOf(item.id) !== -1; })
    .map(enrichLedgerItem_).filter(function (item) { return item.saldo > 0; });
  const totalDue = items.reduce(function (sum, item) { return sum + item.saldo; }, 0);
  let amount = number_(input.valor || totalDue);
  if (amount <= 0 || amount > totalDue) throw new Error('El valor debe ser mayor que cero y no superar lo que falta por pagar en los meses elegidos.');

  const allocations = [];
  items.forEach(function (item) {
    const applied = Math.min(item.saldo, amount);
    if (applied > 0) allocations.push({ id: item.id, amount: applied });
    amount -= applied;
  });
  const payment = {
    id: makeId_('PAG'), contratoId: contract.id, clienteId: contract.clienteId,
    valor: allocations.reduce(function (sum, item) { return sum + item.amount; }, 0),
    metodo: clean_(input.metodo).toUpperCase(), estado: 'APROBADO', referencia: makeId_('MAN'),
    transaccionId: '', detalleJson: JSON.stringify(allocations), creadoEn: nowIso_(),
    pagadoEn: input.fecha || todayIso_(), nota: clean_(input.nota)
  };
  appendPayment_(payment);
  applyPaymentAllocations_(payment);
  markDataChanged_(['payments', 'ledger', 'contracts']);
  return { ok: true, paymentId: payment.id, record: payment };
}

function updateManualPayment(token, input) {
  assertAdmin_(token);
  requireFields_(input, ['id', 'contratoId', 'ledgerIds', 'metodo']);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const db = getDb_();
    const paymentSheet = db.getSheetByName(APP.sheets.payments);
    const paymentMatch = getRowsWithNumbersByValue_(paymentSheet, 'id', input.id)[0];
    const payment = paymentMatch && paymentMatch.record;
    assertEditableManualPayment_(payment);
    const contract = getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'id', input.contratoId)[0];
    if (!contract) throw new Error('No encontramos el contrato elegido.');
    const ids = Array.isArray(input.ledgerIds) ? input.ledgerIds : [];
    if (!ids.length) throw new Error('Selecciona al menos un mes.');
    const previous = parseAllocations_(payment.detalleJson);
    const previousById = indexAllocations_(previous);
    const candidates = getRowsByValue_(db.getSheetByName(APP.sheets.ledger), 'contratoId', contract.id).filter(function (item) { return ids.indexOf(item.id) !== -1; }).map(function (item) {
      const enriched = enrichLedgerItem_(item);
      enriched.availableForEdit = enriched.saldo + number_(previousById[item.id]);
      return enriched;
    });
    if (candidates.length !== ids.length) throw new Error('Uno de los meses elegidos ya no está disponible.');
    const totalAvailable = candidates.reduce(function (sum, item) { return sum + item.availableForEdit; }, 0);
    let remaining = number_(input.valor || totalAvailable);
    if (remaining <= 0 || remaining > totalAvailable) throw new Error('El valor no puede superar lo que falta por pagar en los meses elegidos.');
    const allocations = [];
    candidates.forEach(function (item) {
      const applied = Math.min(item.availableForEdit, remaining);
      if (applied > 0) allocations.push({ id: item.id, amount: applied });
      remaining -= applied;
    });
    replacePaymentAllocations_(payment.id, previous, allocations);
    const record = Object.assign({}, payment, {
      contratoId: contract.id,
      clienteId: contract.clienteId,
      valor: allocations.reduce(function (sum, item) { return sum + item.amount; }, 0),
      metodo: clean_(input.metodo).toUpperCase(),
      detalleJson: JSON.stringify(allocations),
      pagadoEn: input.fecha || todayIso_(),
      nota: clean_(input.nota)
    });
    writeObjectToRow_(APP.sheets.payments, APP.headers.PAGOS, paymentMatch.rowNumber, record);
    markDataChanged_(['payments', 'ledger', 'contracts']);
    return { ok: true, record: record };
  } finally {
    lock.releaseLock();
  }
}

function deleteManualPayment(token, id) {
  assertAdmin_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const payment = getRowsByValue_(getDb_().getSheetByName(APP.sheets.payments), 'id', id)[0];
    assertEditableManualPayment_(payment);
    replacePaymentAllocations_(payment.id, parseAllocations_(payment.detalleJson), []);
    deleteRowsMatching_(APP.sheets.payments, function (item) { return item.id === id; });
    markDataChanged_(['payments', 'ledger', 'contracts']);
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

function assertAdmin_(token) {
  const expectedVersion = PropertiesService.getScriptProperties().getProperty('ADMIN_SESSION_VERSION') || '1';
  const invalid = function () { throw new Error('Tu sesión administrativa venció. Ingresa de nuevo.'); };
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return invalid();
  const cache = CacheService.getScriptCache();
  let session;
  try { session = JSON.parse(cache.get('ADMIN_TOKEN_' + token) || 'null'); } catch (error) { return invalid(); }
  if (!session || session.version !== expectedVersion || !Number.isFinite(session.expiresAt) ||
      Date.now() >= session.expiresAt || session.day !== Utilities.formatDate(new Date(), APP.timezone, 'yyyy-MM-dd')) {
    cache.remove('ADMIN_TOKEN_' + token);
    return invalid();
  }
  return session;
}

// -----------------------------------------------------------------------------
// Forttu: preparación de integración. Solo lectura; activación explícita.
// El contrato real del proveedor se configura según INTEGRACION_FORTTU.md.
// -----------------------------------------------------------------------------

const FORTTU_RESOURCES = Object.freeze({
  clients: 'CLIENTES', properties: 'VIVIENDAS', contracts: 'CONTRATOS',
  ledger: 'CARTERA', payments: 'PAGOS'
});

function getForttuStatus(token) {
  assertAdmin_(token);
  const enabled = PropertiesService.getScriptProperties().getProperty('FORTTU_ENABLED') === 'true';
  let config;
  try { config = forttuConfig_(); } catch (error) {
    return { provider: 'forttu', enabled: enabled, configured: false, mode: 'read-only', message: error.message };
  }
  return {
    provider: 'forttu', enabled: enabled, configured: true, mode: 'read-only',
    resources: Object.keys(config.resources), connectionVerified: false,
    message: enabled ? 'Preparado para probar la conexión.' : 'Conector preparado y desactivado.'
  };
}

function testForttuConnection(token) {
  assertAdmin_(token);
  const config = forttuActiveConfig_();
  if (!config.testPath) throw new Error('FORTTU_CONFIG_JSON: falta testPath, una ruta GET de diagnóstico autorizada.');
  forttuGet_(config, config.testPath, '');
  return { provider: 'forttu', reachable: true, checkedAt: nowIso_(), mode: 'read-only' };
}

function previewForttuResource(token, resource, options) {
  assertAdmin_(token);
  const config = forttuActiveConfig_();
  if (!Object.prototype.hasOwnProperty.call(config.resources, resource)) {
    throw new Error('Recurso Forttu no configurado.');
  }
  const spec = config.resources[resource];
  const query = forttuQuery_(spec, options);
  const payload = forttuGet_(config, spec.path, query);
  const rows = forttuValue_(payload, spec.itemsPath);
  if (!Array.isArray(rows)) throw new Error('Forttu: la ruta itemsPath no contiene una lista. Revise el mapeo.');
  const records = rows.slice(0, 100).map(function (row) { return forttuMapRecord_(row, spec.fields); });
  const ids = Object.create(null);
  records.forEach(function (row) {
    if (ids[row.id]) throw new Error('Forttu: identificadores duplicados en la vista previa.');
    ids[row.id] = true;
  });
  const nextCursor = spec.nextCursorPath ? forttuValue_(payload, spec.nextCursorPath) : null;
  if (nextCursor != null && typeof nextCursor !== 'string' && typeof nextCursor !== 'number') {
    throw new Error('Forttu: cursor de paginación inválido.');
  }
  return {
    provider: 'forttu', resource: resource, mode: 'read-only', records: records,
    received: rows.length, truncated: rows.length > records.length,
    nextCursor: nextCursor == null ? null : String(nextCursor), imported: false
  };
}

function forttuActiveConfig_() {
  if (PropertiesService.getScriptProperties().getProperty('FORTTU_ENABLED') !== 'true') {
    throw new Error('La integración con Forttu está desactivada.');
  }
  return forttuConfig_();
}

function forttuConfig_() {
  const props = PropertiesService.getScriptProperties();
  let config;
  try { config = JSON.parse(props.getProperty('FORTTU_CONFIG_JSON') || 'null'); } catch (error) {
    throw new Error('FORTTU_CONFIG_JSON no es un JSON válido.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Falta configurar FORTTU_CONFIG_JSON con el contrato oficial de la API.');
  }
  // Dominio HTTPS explícito; sin usuario, contraseña, puerto, query ni fragmento.
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.replace(/\/$/, '') : '';
  const match = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(\/[^?#]*)?$/i.exec(baseUrl);
  if (!match || /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/i.test(match[1]) ||
      /[\\\s%]/.test(baseUrl)) {
    throw new Error('FORTTU_CONFIG_JSON: baseUrl debe ser una URL HTTPS del servidor autorizado.');
  }
  if (match[2]) forttuPath_(match[2]);
  config.baseUrl = baseUrl;
  if (!config.auth || ['bearer', 'apiKey'].indexOf(config.auth.type) === -1) {
    throw new Error('Forttu: configure auth.type como bearer o apiKey; otros protocolos requieren adaptar el conector.');
  }
  if (config.auth.type === 'apiKey' &&
      (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(config.auth.header || '') ||
       /^(?:host|cookie|content-type|content-length|accept|connection|proxy-.*|sec-.*)$/i.test(config.auth.header))) {
    throw new Error('Forttu: cabecera de API key inválida.');
  }
  const secret = props.getProperty('FORTTU_API_TOKEN');
  if (!secret || /[\r\n]/.test(secret)) throw new Error('Falta una credencial válida en FORTTU_API_TOKEN.');
  if (config.testPath) forttuPath_(config.testPath);
  if (!config.resources || typeof config.resources !== 'object' || Array.isArray(config.resources)) {
    throw new Error('Forttu: configure resources, aunque sea un objeto vacío para la prueba inicial.');
  }
  Object.keys(config.resources).forEach(function (resource) {
    if (!Object.prototype.hasOwnProperty.call(FORTTU_RESOURCES, resource)) throw new Error('Forttu: recurso desconocido en la configuración.');
    const spec = config.resources[resource];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Forttu: especificación de recurso inválida.');
    forttuPath_(spec.path);
    forttuFieldPath_(spec.itemsPath, true);
    if (spec.nextCursorPath != null) forttuFieldPath_(spec.nextCursorPath, false);
    if (!spec.fields || typeof spec.fields !== 'object' || Array.isArray(spec.fields) || !spec.fields.id) {
      throw new Error('Forttu: cada recurso requiere fields e identificador externo id.');
    }
    Object.keys(spec.fields).forEach(function (field) {
      if (APP.headers[FORTTU_RESOURCES[resource]].indexOf(field) === -1) throw new Error('Forttu: campo de destino desconocido.');
      forttuFieldPath_(spec.fields[field], false);
    });
    forttuQuery_(spec, {});
  });
  return config;
}

function forttuPath_(path) {
  if (typeof path !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(path)) {
    throw new Error('Forttu: use rutas relativas que empiecen por /, sin URL, parámetros ni segmentos especiales.');
  }
  return path;
}

function forttuFieldPath_(path, allowRoot) {
  if (allowRoot && path === '') return;
  if (typeof path !== 'string' || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(path) ||
      path.split('.').some(function (key) { return ['__proto__', 'constructor', 'prototype'].indexOf(key) !== -1; })) {
    throw new Error('Forttu: ruta de campo inválida. Use nombres separados por puntos.');
  }
}

function forttuValue_(object, path) {
  if (path === '') return object;
  return path.split('.').reduce(function (value, key) {
    return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
  }, object);
}

function forttuQuery_(spec, options) {
  const names = spec.query || {};
  if (!names || typeof names !== 'object' || Array.isArray(names)) throw new Error('Forttu: query debe ser un objeto.');
  const used = [];
  Object.keys(names).forEach(function (key) {
    if (['page', 'limit', 'cursor'].indexOf(key) === -1 || typeof names[key] !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(names[key]) || used.indexOf(names[key]) !== -1) {
      throw new Error('Forttu: mapeo de parámetros de paginación inválido.');
    }
    used.push(names[key]);
  });
  if (options == null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) throw new Error('Forttu: opciones de consulta inválidas.');
  return Object.keys(options).map(function (key) {
    if (!Object.prototype.hasOwnProperty.call(names, key)) throw new Error('Forttu: parámetro de consulta no configurado.');
    const value = options[key];
    if (key === 'page' || key === 'limit') {
      if (!Number.isInteger(value) || value < (key === 'page' ? 0 : 1) || value > (key === 'limit' ? 100 : 1000000)) {
        throw new Error('Forttu: página o límite inválido. El límite máximo es 100.');
      }
    } else if (typeof value !== 'string' || value.length > 1000) {
      throw new Error('Forttu: cursor inválido.');
    }
    return encodeURIComponent(names[key]) + '=' + encodeURIComponent(String(value));
  }).join('&');
}

function forttuGet_(config, path, query) {
  forttuPath_(path);
  const secret = PropertiesService.getScriptProperties().getProperty('FORTTU_API_TOKEN');
  const headers = { Accept: 'application/json' };
  if (config.auth.type === 'bearer') headers.Authorization = 'Bearer ' + secret;
  else headers[config.auth.header] = secret;
  let response;
  try {
    response = UrlFetchApp.fetch(config.baseUrl + path + (query ? '?' + query : ''), {
      method: 'get', headers: headers, muteHttpExceptions: true,
      followRedirects: false, validateHttpsCertificates: true
    });
  } catch (error) {
    // No propagar excepciones del transporte: pueden contener URL o credenciales.
    throw new Error('No fue posible contactar Forttu. Revise conectividad y configuración en el servidor.');
  }
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    const reason = status === 401 || status === 403 ? 'Revise las credenciales y permisos.' :
      status === 429 ? 'Límite de consultas alcanzado; espere antes de reintentar.' :
      status >= 300 && status < 400 ? 'Use la URL final; no se siguen redirecciones.' : 'Revise la ruta y disponibilidad del servicio.';
    throw new Error('Forttu respondió HTTP ' + status + '. ' + reason);
  }
  const body = response.getContentText();
  if (body.length > 1000000) throw new Error('Forttu: respuesta demasiado grande. Reduzca la página en la API.');
  try { return JSON.parse(body); } catch (error) { throw new Error('Forttu no devolvió JSON válido. Revise el contrato de la API.'); }
}

function forttuMapRecord_(row, fields) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Forttu: registro inválido.');
  const record = {};
  Object.keys(fields).forEach(function (field) {
    const value = forttuValue_(row, fields[field]);
    if (value == null) return;
    if (['string', 'number', 'boolean'].indexOf(typeof value) === -1 ||
        (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Forttu: el mapeo requiere campos escalares.');
    if ((field === 'id' || /Id$/.test(field) || field === 'documento') && typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new Error('Forttu: identificador numérico inseguro. Solicite identificadores como texto.');
    }
    record[field] = field === 'id' || /Id$/.test(field) || field === 'documento' ? String(value) : value;
  });
  if (!record.id || !record.id.trim() || typeof forttuValue_(row, fields.id) === 'boolean') {
    throw new Error('Forttu: cada registro debe tener un identificador externo válido.');
  }
  return record;
}

// -----------------------------------------------------------------------------
// Transferencia bancaria con comprobante. Adaptador oficial pendiente.
// Los estados de esta orden son independientes de los pagos históricos Wompi.
// -----------------------------------------------------------------------------

/**
 * Único punto a implementar con el ingeniero según el contrato real de Forttu.
 * No cambiar ready a true sin implementar ambos métodos y validar su protocolo.
 * reconcileReceipt debe resolver reintentos por order.id sin duplicar envíos y
 * confirmar un abono real, no solamente OCR o autenticidad de una imagen.
 */
function forttuTransferAdapter_() {
  return {
    ready: false,
    listBankAccounts: function (contract) { throw new Error('Pendiente adaptar las cuentas bancarias de Forttu.'); },
    reconcileReceipt: function (order, receiptBlob, context) { throw new Error('Pendiente adaptar el envío y la verificación de Forttu.'); }
  };
}

function getTransferAvailability() {
  const props = PropertiesService.getScriptProperties();
  return {
    available: props.getProperty('FORTTU_TRANSFER_ENABLED') === 'true' && forttuTransferAdapter_().ready === true,
    maxReceiptBytes: 4 * 1024 * 1024,
    acceptedTypes: ['application/pdf', 'image/jpeg', 'image/png']
  };
}

function transferAdapter_() {
  if (!getTransferAvailability().available) throw new Error('El pago por transferencia todavía no está habilitado.');
  return forttuTransferAdapter_();
}

function getTransferBankAccounts(contractId) {
  const adapter = transferAdapter_();
  const contract = transferContract_(contractId);
  const accounts = adapter.listBankAccounts(contract);
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 20) throw new Error('No hay cuentas bancarias disponibles para este contrato.');
  const ids = Object.create(null);
  return accounts.map(function (account) {
    const normalized = {};
    ['id', 'bankName', 'holderName', 'holderDocument', 'accountType', 'accountNumber'].forEach(function (key) {
      if (typeof account[key] !== 'string' || !account[key].trim() || account[key].length > 200) {
        throw new Error('Forttu devolvió una cuenta bancaria incompleta.');
      }
      normalized[key] = account[key];
    });
    if (ids[normalized.id]) throw new Error('Forttu devolvió cuentas bancarias duplicadas.');
    ids[normalized.id] = true;
    return normalized;
  });
}

function transferContract_(id) {
  const contract = getRowsByValue_(getDb_().getSheetByName(APP.sheets.contracts), 'id', String(id || ''))[0];
  if (!contract || contract.estado !== 'ACTIVO') throw new Error('El contrato no está disponible para recibir este pago.');
  return contract;
}

function transferCents_(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) {
    throw new Error('Valor monetario inválido en la cartera.');
  }
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  if (value == null || value === '' || !Number.isFinite(amount) || !Number.isSafeInteger(cents) ||
      Math.abs(amount * 100 - cents) > 0.00001 || cents < 0) throw new Error('Valor monetario inválido en la cartera.');
  return cents;
}

function transferAllocation_(row) {
  const due = transferCents_(row.valorBase) - transferCents_(row.descuento || 0) + transferCents_(row.cargoExtra || 0);
  const paid = transferCents_(row.valorPagado || 0);
  if (!Number.isSafeInteger(due) || due <= paid) throw new Error('Uno de los meses ya no tiene saldo pendiente.');
  return { id: row.id, period: row.periodo, amountCents: due - paid, beforePaidCents: paid, dueCents: due };
}

function createTransferOrder(contractId, ledgerIds, accountId, requestId) {
  transferAdapter_();
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{20,80}$/.test(requestId)) throw new Error('Identificador de solicitud inválido.');
  if (!Array.isArray(ledgerIds) || !ledgerIds.length || ledgerIds.length > 100 ||
      ledgerIds.some(function (id) { return typeof id !== 'string' || !id; }) || new Set(ledgerIds).size !== ledgerIds.length) {
    throw new Error('Selecciona entre uno y cien meses distintos.');
  }
  return withScriptLock_(function () {
    const db = getDb_();
    const sheet = db.getSheetByName(APP.sheets.transfers);
    const previous = getRowsByValue_(sheet, 'solicitudId', requestId)[0];
    if (previous) {
      const previousIds = JSON.parse(previous.asignacionesJson).map(function (item) { return item.id; }).sort().join('|');
      if (previous.contratoId !== contractId || JSON.parse(previous.cuentaJson).id !== accountId || previousIds !== ledgerIds.slice().sort().join('|')) {
        throw new Error('La solicitud ya corresponde a otra selección.');
      }
      return transferPublicOrder_(previous, true);
    }
    const contract = transferContract_(contractId);
    // Las cuentas se recuperan del servidor, nunca de los datos del navegador.
    const account = getTransferBankAccounts(contract.id).find(function (item) { return item.id === accountId; });
    if (!account) throw new Error('La cuenta bancaria seleccionada no está disponible.');
    const rows = getRowsByValue_(db.getSheetByName(APP.sheets.ledger), 'contratoId', contract.id)
      .filter(function (row) { return ledgerIds.indexOf(row.id) !== -1; });
    if (rows.length !== ledgerIds.length) throw new Error('Uno de los meses no pertenece a este contrato.');
    const allocations = rows.map(transferAllocation_);
    const existingOrders = getRowsByValue_(sheet, 'contratoId', contract.id);
    const blocked = existingOrders.some(function (order) {
      if (order.estado === 'RECHAZADO') return false;
      return JSON.parse(order.asignacionesJson).some(function (item) { return ledgerIds.indexOf(item.id) !== -1; });
    });
    const gatewayPending = getRowsByValue_(db.getSheetByName(APP.sheets.payments), 'contratoId', contract.id).some(function (payment) {
      return payment.estado === 'PENDIENTE' && JSON.parse(payment.detalleJson || '[]').some(function (item) { return ledgerIds.indexOf(item.id) !== -1; });
    });
    if (blocked || gatewayPending) throw new Error('Hay una solicitud de pago para uno de estos meses. Revisa su estado antes de crear otra.');
    const amount = allocations.reduce(function (sum, allocation) { return sum + allocation.amountCents; }, 0);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Importe de la solicitud inválido.');
    const order = {
      id: 'TRF-' + Utilities.getUuid(), solicitudId: requestId, contratoId: contract.id, clienteId: contract.clienteId,
      valorCentavos: amount, moneda: APP.currency, asignacionesJson: JSON.stringify(allocations),
      cuentaJson: JSON.stringify(account), estado: 'ESPERANDO_COMPROBANTE', comprobanteId: '', comprobanteHash: '',
      verificacionJson: '', ultimoError: '', creadoEn: nowIso_(), actualizadoEn: nowIso_()
    };
    // Asegurar la clave antes de persistir: permite recuperar la misma capacidad.
    transferAccessToken_(order.id);
    appendObject_(APP.sheets.transfers, APP.headers.TRANSFERENCIAS, order);
    return transferPublicOrder_(order, true);
  });
}

function transferAccessToken_(reference) {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('FORTTU_ORDER_ACCESS_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('FORTTU_ORDER_ACCESS_SECRET', secret);
  }
  return sha256Hex_(secret + ':' + reference);
}

function transferAuthorizedOrder_(reference, accessToken) {
  const secret = PropertiesService.getScriptProperties().getProperty('FORTTU_ORDER_ACCESS_SECRET');
  if (!secret || typeof reference !== 'string' || typeof accessToken !== 'string' ||
      !safeEqual_(sha256Hex_(secret + ':' + reference), accessToken)) throw new Error('No fue posible acceder a esta solicitud de pago.');
  const order = getRowsByValue_(getDb_().getSheetByName(APP.sheets.transfers), 'id', reference)[0];
  if (!order) throw new Error('No fue posible acceder a esta solicitud de pago.');
  return order;
}

function transferPublicOrder_(order, includeToken) {
  const view = {
    reference: order.id, contractId: order.contratoId, amountInCents: Number(order.valorCentavos), currency: order.moneda,
    status: order.estado, account: JSON.parse(order.cuentaJson),
    months: JSON.parse(order.asignacionesJson).map(function (item) { return { id: item.id, period: item.period, amountInCents: item.amountCents }; }),
    receiptUploaded: Boolean(order.comprobanteId), updatedAt: order.actualizadoEn,
    success: order.estado === 'APROBADO'
  };
  if (includeToken) view.accessToken = transferAccessToken_(order.id);
  return view;
}

function getTransferOrder(reference, accessToken) {
  // Consultar órdenes existentes sigue funcionando aunque se desactive la creación.
  return transferPublicOrder_(transferAuthorizedOrder_(reference, accessToken), false);
}

/** Consulta autenticada que también impulsa la verificación de esta solicitud.
 * No recibe resultados, montos ni códigos de aprobación desde el navegador.
 * El trigger sigue siendo el respaldo cuando el cliente abandona el sitio.
 */
function refreshTransferOrder(reference, accessToken) {
  const order = transferAuthorizedOrder_(reference, accessToken);
  if (getTransferAvailability().available && ['PENDIENTE_VERIFICACION', 'VERIFICADO', 'APLICANDO'].indexOf(order.estado) !== -1) {
    transferReconcileOrder_(order.id, true);
  }
  return getTransferOrder(reference, accessToken);
}

function transferReceiptBytes_(receipt) {
  if (!receipt || typeof receipt.base64 !== 'string' || receipt.base64.length > 5592408 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(receipt.base64) || receipt.base64.length % 4 !== 0) throw new Error('El comprobante es inválido o supera 4 MB.');
  const bytes = Utilities.base64Decode(receipt.base64);
  const type = receipt.mimeType;
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('El comprobante es inválido o supera 4 MB.');
  const unsigned = bytes.slice(0, 8).map(function (value) { return (value + 256) % 256; });
  const valid = type === 'application/pdf' && unsigned.slice(0, 5).join(',') === '37,80,68,70,45' ||
    type === 'image/png' && unsigned.join(',') === '137,80,78,71,13,10,26,10' ||
    type === 'image/jpeg' && unsigned.slice(0, 3).join(',') === '255,216,255';
  if (!valid) throw new Error('Sube un comprobante PDF, JPG o PNG válido.');
  return bytes;
}

function submitTransferReceipt(reference, accessToken, receipt) {
  transferAdapter_();
  return withScriptLock_(function () {
    const order = transferAuthorizedOrder_(reference, accessToken);
    const bytes = transferReceiptBytes_(receipt);
    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
      .map(function (value) { return ('0' + ((value + 256) % 256).toString(16)).slice(-2); }).join('');
    if (order.comprobanteHash === hash) return transferPublicOrder_(order, false);
    if (order.estado !== 'ESPERANDO_COMPROBANTE') throw new Error('Esta solicitud ya tiene un comprobante. Consulta su verificación.');
    const reused = getRowsByValue_(getDb_().getSheetByName(APP.sheets.transfers), 'comprobanteHash', hash);
    if (reused.length) throw new Error('Este comprobante ya está asociado a otra solicitud. Solicita revisión.');
    const folderId = PropertiesService.getScriptProperties().getProperty('FORTTU_RECEIPTS_FOLDER_ID');
    if (!folderId) throw new Error('Falta configurar el almacenamiento privado de comprobantes.');
    const extension = receipt.mimeType === 'application/pdf' ? '.pdf' : receipt.mimeType === 'image/png' ? '.png' : '.jpg';
    // El nombre lo genera el servidor. No se confía en el nombre del archivo subido.
    const blob = Utilities.newBlob(bytes, receipt.mimeType, order.id + extension);
    const file = transferReceiptFolder_(folderId).createFile(blob);
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    order.comprobanteId = file.getId();
    order.comprobanteHash = hash;
    order.estado = 'PENDIENTE_VERIFICACION';
    transferSaveOrder_(order);
    return transferPublicOrder_(order, false);
  });
}

function transferSaveOrder_(order) {
  order.actualizadoEn = nowIso_();
  const row = findDataRow_(getDb_().getSheetByName(APP.sheets.transfers), 'id', order.id);
  writeObjectToRow_(APP.sheets.transfers, APP.headers.TRANSFERENCIAS, row, order);
}

function transferReceiptFolder_(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  if (!folder.getOwner() || folder.getSharingAccess() !== DriveApp.Access.PRIVATE || folder.getEditors().length || folder.getViewers().length) {
    throw new Error('La carpeta de comprobantes debe ser privada, sin colaboradores ni enlaces compartidos.');
  }
  return folder;
}

/** Ejecutar desde el editor al integrar; no está expuesta en apiOutput_. */
function setupForttuTransferReconciliation() {
  transferAdapter_();
  const folderId = PropertiesService.getScriptProperties().getProperty('FORTTU_RECEIPTS_FOLDER_ID');
  if (!folderId) throw new Error('Configure una carpeta privada de comprobantes.');
  transferReceiptFolder_(folderId);
  if (!ScriptApp.getProjectTriggers().some(function (trigger) { return trigger.getHandlerFunction() === 'reconcileForttuTransfers'; })) {
    ScriptApp.newTrigger('reconcileForttuTransfers').timeBased().everyMinutes(1).create();
  }
}

/** El trigger procesa comprobantes aunque el usuario cierre el navegador. */
function reconcileForttuTransfers() {
  if (!getTransferAvailability().available) return;
  const started = Date.now();
  const orders = getRows_(getDb_().getSheetByName(APP.sheets.transfers))
    .filter(function (order) { return ['PENDIENTE_VERIFICACION', 'VERIFICADO', 'APLICANDO'].indexOf(order.estado) !== -1; })
    .sort(function (a, b) { return String(a.actualizadoEn).localeCompare(String(b.actualizadoEn)); }).slice(0, 5);
  orders.forEach(function (candidate) {
    if (Date.now() - started > 60000) return;
    transferReconcileOrder_(candidate.id, false);
  });
}

/** Procesamiento común para la consulta del cliente y la tarea en segundo plano. */
function transferProviderContext_(order) {
  const db = getDb_();
  const contract = getRowsByValue_(db.getSheetByName(APP.sheets.contracts), 'id', order.contratoId)[0];
  const client = getRowsByValue_(db.getSheetByName(APP.sheets.clients), 'id', order.clienteId)[0];
  if (!contract || !client || contract.clienteId !== order.clienteId) throw new Error('El cliente de la solicitud no coincide con el contrato.');
  return {
    reference: order.id, contractId: order.contratoId,
    customer: { id: client.id, document: String(client.documento || ''), fullName: String(client.nombre || '') },
    expectedPayment: { amountInCents: Number(order.valorCentavos), currency: order.moneda,
      accountId: JSON.parse(order.cuentaJson).id,
      months: JSON.parse(order.asignacionesJson).map(function (item) { return { id: item.id, period: item.period, amountInCents: item.amountCents }; })
    }
  };
}

function transferReconcileOrder_(reference, interactive) {
  return withScriptLock_(function () {
      const order = getRowsByValue_(getDb_().getSheetByName(APP.sheets.transfers), 'id', reference)[0];
      if (!order || ['PENDIENTE_VERIFICACION', 'VERIFICADO', 'APLICANDO'].indexOf(order.estado) === -1) return;
      // Coordinar pestañas y clics repetidos sin volver a enviar al proveedor.
      if (interactive && Date.now() - Date.parse(order.actualizadoEn) < 8000) return;
      try {
        if (order.estado === 'PENDIENTE_VERIFICACION') {
          const receipt = DriveApp.getFileById(order.comprobanteId).getBlob();
          const result = transferAdapter_().reconcileReceipt(order, receipt, transferProviderContext_(order));
          if (!result || result.authenticated !== true || result.reference !== order.id) throw new Error('Untrusted response');
          if (result.status === 'PENDING') { order.ultimoError = ''; transferSaveOrder_(order); return; }
          if (result.status === 'REJECTED') { order.estado = 'RECHAZADO'; order.ultimoError = ''; transferSaveOrder_(order); return; }
          try { transferValidateVerification_(order, result); } catch (error) {
            order.estado = 'EN_REVISION';
            order.ultimoError = 'La respuesta no acredita el abono exacto de esta solicitud.';
            transferSaveOrder_(order);
            return;
          }
          const verified = {};
          ['status', 'authenticated', 'settled', 'reference', 'accountId', 'currency', 'amountInCents', 'transactionId', 'verificationId'].forEach(function (key) { verified[key] = result[key]; });
          order.verificacionJson = JSON.stringify(verified);
          order.estado = 'VERIFICADO';
          order.ultimoError = '';
          transferSaveOrder_(order);
        }
        transferApplyVerifiedOrder_(order);
      } catch (error) {
        // No persistir mensajes del transporte o datos privados del proveedor.
        order.ultimoError = 'La solicitud requiere otro intento o revisión del integrador.';
        transferSaveOrder_(order);
      }
  });
}

function transferValidateVerification_(order, result) {
  const account = JSON.parse(order.cuentaJson);
  if (!result || result.status !== 'VERIFIED' || result.authenticated !== true || result.settled !== true ||
      result.reference !== order.id || result.accountId !== account.id || result.currency !== order.moneda ||
      !Number.isSafeInteger(result.amountInCents) || result.amountInCents !== Number(order.valorCentavos) ||
      typeof result.transactionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(result.transactionId) ||
      typeof result.verificationId !== 'string' || !result.verificationId.trim() || result.verificationId.length > 200) {
    throw new Error('La verificación no acredita el abono exacto de esta solicitud.');
  }
}

function transferApplicationPlan_(order, rows, transactionAlreadyUsed) {
  const verification = JSON.parse(order.verificacionJson || 'null');
  transferValidateVerification_(order, verification);
  if (transactionAlreadyUsed) throw new Error('La transacción bancaria ya está asociada a otra solicitud.');
  const allocations = JSON.parse(order.asignacionesJson);
  if (!Array.isArray(allocations) || !allocations.length || new Set(allocations.map(function (a) { return a.id; })).size !== allocations.length ||
      allocations.reduce(function (sum, allocation) { return sum + allocation.amountCents; }, 0) !== Number(order.valorCentavos)) {
    throw new Error('Las asignaciones no coinciden con la orden.');
  }
  const paymentId = 'PAG-' + order.id;
  return allocations.map(function (allocation) {
    const row = rows.find(function (item) { return item.id === allocation.id; });
    if (!row || row.contratoId !== order.contratoId) throw new Error('La obligación ya no pertenece al contrato.');
    if (![allocation.amountCents, allocation.beforePaidCents, allocation.dueCents].every(Number.isSafeInteger) ||
        allocation.amountCents <= 0 || allocation.beforePaidCents < 0 || allocation.dueCents !== allocation.beforePaidCents + allocation.amountCents) {
      throw new Error('Asignación monetaria inválida.');
    }
    const paid = transferCents_(row.valorPagado || 0);
    const due = transferCents_(row.valorBase) - transferCents_(row.descuento || 0) + transferCents_(row.cargoExtra || 0);
    if (due !== allocation.dueCents) throw new Error('La obligación cambió desde que se creó la solicitud.');
    // Recuperación: una fila que ya tiene el marcador y el valor final se omite.
    if (row.pagoId === paymentId && paid === allocation.dueCents) return { id: row.id, skip: true };
    if (paid !== allocation.beforePaidCents) throw new Error('La obligación recibió otro pago y requiere conciliación.');
    return { id: row.id, skip: false, record: Object.assign({}, row, {
      valorPagado: allocation.dueCents / 100, pagoId: paymentId, estado: 'PAGADO', actualizadoEn: nowIso_()
    }) };
  });
}

function transferApplyVerifiedOrder_(order) {
  const db = getDb_();
  const verification = JSON.parse(order.verificacionJson);
  const others = getRows_(db.getSheetByName(APP.sheets.transfers));
  const transactionUsed = others.some(function (other) {
    if (other.id === order.id || !other.verificacionJson) return false;
    return JSON.parse(other.verificacionJson).transactionId === verification.transactionId;
  }) || getRowsByValue_(db.getSheetByName(APP.sheets.payments), 'transaccionId', verification.transactionId)
    .some(function (payment) { return payment.referencia !== order.id; });
  const ledger = db.getSheetByName(APP.sheets.ledger);
  let plan;
  try {
    plan = transferApplicationPlan_(order, getRowsByValue_(ledger, 'contratoId', order.contratoId), transactionUsed);
  } catch (error) {
    order.estado = 'EN_REVISION';
    order.ultimoError = 'El abono requiere conciliación; la cartera o la transacción no coinciden.';
    transferSaveOrder_(order);
    markDataChanged_(['ledger', 'contracts', 'payments']);
    return;
  }
  order.estado = 'APLICANDO';
  transferSaveOrder_(order);
  const payments = db.getSheetByName(APP.sheets.payments);
  let payment = getRowsByValue_(payments, 'referencia', order.id)[0];
  if (!payment) {
    payment = {
      id: 'PAG-' + order.id, contratoId: order.contratoId, clienteId: order.clienteId,
      valor: Number(order.valorCentavos) / 100, metodo: 'TRANSFERENCIA_FORTTU', estado: 'PENDIENTE',
      referencia: order.id, transaccionId: verification.transactionId,
      detalleJson: JSON.stringify(JSON.parse(order.asignacionesJson).map(function (a) { return { id: a.id, amount: a.amountCents / 100 }; })),
      creadoEn: order.creadoEn, pagadoEn: '', nota: 'Transferencia con comprobante verificada por Forttu'
    };
    appendPayment_(payment);
  }
  // Cada fila guarda importe final y marcador en una sola escritura. Un reintento
  // vuelve a validar TODAS las asignaciones antes de continuar las pendientes.
  plan.forEach(function (entry) {
    if (!entry.skip) writeObjectToRow_(APP.sheets.ledger, APP.headers.CARTERA, findDataRow_(ledger, 'id', entry.id), entry.record);
  });
  payment.estado = 'APROBADO';
  payment.pagadoEn = payment.pagadoEn || nowIso_();
  writeObjectToRow_(APP.sheets.payments, APP.headers.PAGOS, findDataRow_(payments, 'referencia', order.id), payment);
  // Si falla la notificación de versiones, el trigger puede reintentar antes del
  // estado final sin volver a sumar dinero a las obligaciones.
  markDataChanged_(['payments', 'ledger', 'contracts']);
  order.estado = 'APROBADO';
  order.ultimoError = '';
  transferSaveOrder_(order);
}

// -----------------------------------------------------------------------------
// Persistencia, caché y utilidades
// -----------------------------------------------------------------------------

function getSnapshot_(fresh) {
  const version = getDataVersion();
  const cache = CacheService.getScriptCache();
  const key = 'SNAPSHOT_' + version;
  if (!fresh) {
    const cached = cache.get(key);
    if (cached) return JSON.parse(cached);
  }
  const db = getDb_();
  const snapshot = {
    clients: getRows_(db.getSheetByName(APP.sheets.clients)),
    properties: getRows_(db.getSheetByName(APP.sheets.properties)),
    contracts: getRows_(db.getSheetByName(APP.sheets.contracts)),
    ledger: getRows_(db.getSheetByName(APP.sheets.ledger)),
    payments: getRows_(db.getSheetByName(APP.sheets.payments))
  };
  const serialized = JSON.stringify(snapshot);
  if (serialized.length < 90000) cache.put(key, serialized, 120);
  return snapshot;
}

function getRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values.shift();
  return rowsToObjects_(headers, values);
}

function getRowsByValue_(sheet, headerName, value) {
  return getRowsWithNumbersByValue_(sheet, headerName, value).map(function (item) { return item.record; });
}

function getRowsWithNumbersByValue_(sheet, headerName, value) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const column = headers.indexOf(headerName) + 1;
  if (!column) return [];
  const rowNumbers = sheet.getRange(2, column, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(value))
    .matchEntireCell(true)
    .findAll()
    .map(function (match) { return match.getRow(); })
    .sort(function (a, b) { return a - b; });
  if (!rowNumbers.length) return [];
  const firstRow = rowNumbers[0];
  const rowSet = rowNumbers.reduce(function (result, rowNumber) { result[rowNumber] = true; return result; }, {});
  const values = sheet.getRange(firstRow, 1, rowNumbers[rowNumbers.length - 1] - firstRow + 1, lastColumn).getValues();
  return values.map(function (row, index) {
      const rowNumber = firstRow + index;
      if (!rowSet[rowNumber]) return null;
      return {
        rowNumber: rowNumber,
        record: rowsToObjects_(headers, [row])[0]
      };
    })
    .filter(function (item) { return item && item.record; });
}

function getRowsByNormalizedValue_(sheet, headerName, value) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const column = headers.indexOf(headerName) + 1;
  if (!column) return [];
  const values = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getValues();
  const rows = [];
  values.forEach(function (row, index) {
    if (normalizeSearch_(row[0]) !== normalizeSearch_(value)) return;
    rows.push(rowsToObjects_(headers, sheet.getRange(index + 2, 1, 1, lastColumn).getValues())[0]);
  });
  return rows.filter(Boolean);
}

function uniqueRowsById_(rows) {
  const seen = {};
  return rows.filter(function (row) {
    const id = String(row && row.id || '');
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
  });
}

function getRowsPage_(sheet, offset, limit) {
  if (!sheet || sheet.getLastRow() < 2) {
    return { items: [], total: 0, offset: 0, limit: limit, nextOffset: 0, hasMore: false };
  }
  const total = sheet.getLastRow() - 1;
  const safeOffset = Math.min(Math.max(0, offset), total);
  const count = Math.min(limit, Math.max(0, total - safeOffset));
  if (!count) return { items: [], total: total, offset: safeOffset, limit: limit, nextOffset: safeOffset, hasMore: false };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const endRow = sheet.getLastRow() - safeOffset;
  const startRow = endRow - count + 1;
  const values = sheet.getRange(startRow, 1, count, headers.length).getValues().reverse();
  const items = rowsToObjects_(headers, values);
  const nextOffset = safeOffset + count;
  return { items: items, total: total, offset: safeOffset, limit: limit, nextOffset: nextOffset, hasMore: nextOffset < total };
}

function rowsToObjects_(headers, values) {
  return values.filter(function (row) { return row.some(function (cell) { return cell !== ''; }); }).map(function (row) {
    return headers.reduce(function (object, header, index) {
      const value = row[index];
      object[header] = value instanceof Date ? Utilities.formatDate(value, APP.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX") : value;
      return object;
    }, {});
  });
}

function indexRowsBy_(rows, key) {
  return rows.reduce(function (index, row) {
    index[row[key]] = row;
    return index;
  }, {});
}

function normalizeAdminSection_(section) {
  const value = String(section || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ADMIN_SECTIONS, value)) throw new Error('Sección administrativa inválida.');
  return value;
}

function normalizePageLimit_(limit) {
  const parsed = Math.floor(number_(limit)) || APP.adminPageSize;
  return Math.min(APP.adminMaxPageSize, Math.max(1, parsed));
}

function appendObject_(sheetName, headers, object) {
  const sheet = getDb_().getSheetByName(sheetName);
  sheet.appendRow(headers.map(function (header) { return object[header] === undefined ? '' : object[header]; }));
}

function appendPayment_(payment) {
  appendObject_(APP.sheets.payments, APP.headers.PAGOS, payment);
}

function generateLedger_(contractId, start, end, rent, dueDay) {
  const startDate = parseIsoDate_(start);
  const monthCount = contractMonthCount_(start, end);
  const months = [];
  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1, 12, 0, 0);
  while (months.length < monthCount && months.length < 240) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const due = new Date(year, month, Math.min(28, dueDay), 12, 0, 0);
    const period = monthName_(month) + ' ' + year;
    months.push([
      makeId_('CAR'), contractId, period, formatDate_(due), rent, 0, 0, '', 'PENDIENTE', 0, '', nowIso_()
    ]);
    cursor = new Date(year, month + 1, 1, 12, 0, 0);
  }
  if (!months.length) throw new Error('No fue posible crear los cobros mensuales.');
  const sheet = getDb_().getSheetByName(APP.sheets.ledger);
  sheet.getRange(sheet.getLastRow() + 1, 1, months.length, APP.headers.CARTERA.length).setValues(months);
}

function updatePropertyStatus_(propertyId, status) {
  const sheet = getDb_().getSheetByName(APP.sheets.properties);
  const row = findDataRow_(sheet, 'id', propertyId);
  if (row) setCellByHeader_(sheet, row, APP.headers.VIVIENDAS, 'estado', status);
}

function findDataRow_(sheet, headerName, value) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const column = headers.indexOf(headerName) + 1;
  if (!column) return 0;
  const values = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < values.length; i += 1) if (String(values[i][0]) === String(value)) return i + 2;
  return 0;
}

function setCellByHeader_(sheet, row, headers, header, value) {
  const column = headers.indexOf(header) + 1;
  if (row && column) sheet.getRange(row, column).setValue(value);
}

function writeObjectToRow_(sheetName, headers, row, object) {
  if (!row) throw new Error('No encontramos el registro que quieres editar.');
  getDb_().getSheetByName(sheetName).getRange(row, 1, 1, headers.length).setValues([
    headers.map(function (header) { return object[header] === undefined ? '' : object[header]; })
  ]);
}

function writeRowUpdates_(sheet, headers, updates) {
  const sorted = updates.slice().sort(function (a, b) { return a.rowNumber - b.rowNumber; });
  let group = [];
  function flush_() {
    if (!group.length) return;
    sheet.getRange(group[0].rowNumber, 1, group.length, headers.length).setValues(group.map(function (item) {
      return headers.map(function (header) { return item.record[header] === undefined ? '' : item.record[header]; });
    }));
    group = [];
  }
  sorted.forEach(function (item) {
    if (group.length && item.rowNumber !== group[group.length - 1].rowNumber + 1) flush_();
    group.push(item);
  });
  flush_();
}

function deleteRowsMatching_(sheetName, predicate) {
  const sheet = getDb_().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values.shift();
  let deleted = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const object = headers.reduce(function (result, header, column) {
      const value = values[index][column];
      result[header] = value instanceof Date ? Utilities.formatDate(value, APP.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX") : value;
      return result;
    }, {});
    if (predicate(object)) {
      sheet.deleteRow(index + 2);
      deleted += 1;
    }
  }
  return deleted;
}

function normalizeStatus_(value, allowed, fallback) {
  const status = clean_(value).toUpperCase();
  return allowed.indexOf(status) !== -1 ? status : fallback;
}

function releasePropertyIfUnused_(propertyId, excludedContractId) {
  if (!propertyId) return;
  const contracts = getRowsByValue_(getDb_().getSheetByName(APP.sheets.contracts), 'viviendaId', propertyId);
  const occupied = contracts.some(function (item) {
    return item.id !== excludedContractId && item.viviendaId === propertyId && item.estado === 'ACTIVO';
  });
  updatePropertyStatus_(propertyId, occupied ? 'OCUPADA' : 'DISPONIBLE');
}

function syncContractLedger_(contractId, start, end, rent, dueDay) {
  const sheet = getDb_().getSheetByName(APP.sheets.ledger);
  const matches = getRowsWithNumbersByValue_(sheet, 'contratoId', contractId);
  const rows = matches.map(function (item) { return item.record; });
  const existingByMonth = {};
  matches.forEach(function (item) { existingByMonth[monthKeyFromValue_(item.record.fechaVencimiento)] = item; });

  const desired = [];
  const startDate = parseIsoDate_(start);
  const monthCount = contractMonthCount_(start, end);
  let cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1, 12, 0, 0);
  while (desired.length < monthCount && desired.length < 240) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    desired.push({
      key: year + '-' + String(month + 1).padStart(2, '0'),
      period: monthName_(month) + ' ' + year,
      due: formatDate_(new Date(year, month, Math.min(28, dueDay), 12, 0, 0))
    });
    cursor = new Date(year, month + 1, 1, 12, 0, 0);
  }
  if (!desired.length) throw new Error('No fue posible crear los cobros mensuales.');
  const desiredKeys = {};
  desired.forEach(function (item) { desiredKeys[item.key] = true; });
  rows.forEach(function (item) {
    if (!desiredKeys[monthKeyFromValue_(item.fechaVencimiento)] && number_(item.valorPagado) > 0) {
      throw new Error('No puedes quitar un mes que ya tiene pagos. Conserva ese mes o marca el contrato como finalizado.');
    }
  });
  desired.forEach(function (wanted) {
    const match = existingByMonth[wanted.key];
    const existing = match && match.record;
    const totalDue = Math.max(0, rent - number_(existing && existing.descuento) + number_(existing && existing.cargoExtra));
    if (existing && number_(existing.valorPagado) > totalDue) {
      throw new Error('El nuevo valor mensual deja un mes por debajo de lo que ya se pagó. Ajusta primero ese pago o usa un valor mayor.');
    }
  });
  const additions = [];
  const updates = [];
  const updatedAt = nowIso_();
  desired.forEach(function (wanted) {
    const match = existingByMonth[wanted.key];
    if (!match) {
      additions.push([makeId_('CAR'), contractId, wanted.period, wanted.due, rent, 0, 0, '', 'PENDIENTE', 0, '', updatedAt]);
      return;
    }
    const existing = match.record;
    const totalDue = Math.max(0, rent - number_(existing.descuento) + number_(existing.cargoExtra));
    const paid = number_(existing.valorPagado);
    const record = Object.assign({}, existing, {
      periodo: wanted.period,
      fechaVencimiento: wanted.due,
      valorBase: rent,
      valorPagado: paid,
      estado: paid >= totalDue ? 'PAGADO' : 'PENDIENTE',
      actualizadoEn: updatedAt
    });
    updates.push({
      rowNumber: match.rowNumber,
      values: APP.headers.CARTERA.map(function (header) { return record[header] === undefined ? '' : record[header]; })
    });
  });
  updates.sort(function (a, b) { return a.rowNumber - b.rowNumber; });
  let group = [];
  function writeGroup_() {
    if (!group.length) return;
    sheet.getRange(group[0].rowNumber, 1, group.length, APP.headers.CARTERA.length)
      .setValues(group.map(function (item) { return item.values; }));
    group = [];
  }
  updates.forEach(function (item) {
    if (group.length && item.rowNumber !== group[group.length - 1].rowNumber + 1) writeGroup_();
    group.push(item);
  });
  writeGroup_();

  matches.filter(function (item) {
    return !desiredKeys[monthKeyFromValue_(item.record.fechaVencimiento)];
  }).map(function (item) { return item.rowNumber; }).sort(function (a, b) { return b - a; }).forEach(function (rowNumber) {
    sheet.deleteRow(rowNumber);
  });
  if (additions.length) sheet.getRange(sheet.getLastRow() + 1, 1, additions.length, APP.headers.CARTERA.length).setValues(additions);
}

function monthKeyFromValue_(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})-(\d{2})/);
  return match ? match[1] + '-' + match[2] : text;
}

function dueDayFromValue_(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-(\d{2})/);
  return match ? Math.min(28, Math.max(1, Number(match[1]) || 10)) : 10;
}

function contractMonthCount_(start, end) {
  const from = String(start || '').split('-').map(Number);
  const to = String(end || '').split('-').map(Number);
  if (from.length !== 3 || to.length !== 3 || from.some(function (value) { return !Number.isFinite(value); }) || to.some(function (value) { return !Number.isFinite(value); })) return 0;
  const fromDate = new Date(from[0], from[1] - 1, from[2], 12, 0, 0);
  const toDate = new Date(to[0], to[1] - 1, to[2], 12, 0, 0);
  if (toDate <= fromDate) return 0;
  const completedMonthDifference = (to[0] - from[0]) * 12 + to[1] - from[1];
  const billedMonths = completedMonthDifference + (to[2] > from[2] ? 1 : 0);
  return Math.min(240, Math.max(1, billedMonths));
}

function parseAllocations_(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(function (item) { return { id: String(item.id || ''), amount: Math.max(0, number_(item.amount)) }; }).filter(function (item) { return item.id && item.amount > 0; }) : [];
  } catch (error) {
    return [];
  }
}

function indexAllocations_(allocations) {
  return allocations.reduce(function (index, item) {
    index[item.id] = number_(index[item.id]) + number_(item.amount);
    return index;
  }, {});
}

function assertEditableManualPayment_(payment) {
  if (!payment) throw new Error('No encontramos este pago.');
  if (String(payment.referencia || '').indexOf('MAN-') !== 0 || payment.transaccionId) {
    throw new Error('Los pagos procesados por una entidad bancaria no se pueden editar ni eliminar.');
  }
  if (payment.estado !== 'APROBADO') throw new Error('Solo puedes modificar pagos manuales aprobados.');
}

function replacePaymentAllocations_(paymentId, previous, next) {
  const sheet = getDb_().getSheetByName(APP.sheets.ledger);
  const headers = APP.headers.CARTERA;
  const before = indexAllocations_(previous);
  const after = indexAllocations_(next);
  const ids = {};
  const updates = [];
  Object.keys(before).concat(Object.keys(after)).forEach(function (id) { ids[id] = true; });
  Object.keys(ids).forEach(function (id) {
    const match = getRowsWithNumbersByValue_(sheet, 'id', id)[0];
    if (!match) return;
    const record = match.record;
    const currentPaid = number_(record.valorPagado);
    const base = number_(record.valorBase);
    const discount = number_(record.descuento);
    const extra = number_(record.cargoExtra);
    const totalDue = Math.max(0, base - discount + extra);
    const paid = Math.min(totalDue, Math.max(0, currentPaid - number_(before[id]) + number_(after[id])));
    record.valorPagado = paid;
    record.estado = paid >= totalDue ? 'PAGADO' : 'PENDIENTE';
    if (number_(after[id]) > 0) record.pagoId = paymentId;
    else if (String(record.pagoId) === String(paymentId)) record.pagoId = '';
    record.actualizadoEn = nowIso_();
    updates.push({ rowNumber: match.rowNumber, record: record });
  });
  writeRowUpdates_(sheet, headers, updates);
}

function markDataChanged_(sections) {
  const props = PropertiesService.getScriptProperties();
  initializeDataVersions_(props);
  const nextVersion = String(Math.max(Date.now(), Number(props.getProperty('DATA_VERSION') || 0) + 1));
  const changedSections = Array.isArray(sections) && sections.length ? sections : Object.keys(ADMIN_SECTIONS);
  const values = { DATA_VERSION: nextVersion };
  changedSections.forEach(function (section) {
    if (Object.prototype.hasOwnProperty.call(ADMIN_SECTIONS, section)) values[dataVersionKey_(section)] = nextVersion;
  });
  props.setProperties(values, false);
  return getDataVersions_();
}

function getDataVersions_() {
  const props = PropertiesService.getScriptProperties();
  initializeDataVersions_(props);
  const versions = {};
  Object.keys(ADMIN_SECTIONS).forEach(function (section) {
    versions[section] = Number(props.getProperty(dataVersionKey_(section)) || props.getProperty('DATA_VERSION') || 1);
  });
  return versions;
}

function dataVersionKey_(section) {
  return 'DATA_VERSION_' + String(section || '').toUpperCase();
}

function sectionFromSheetName_(sheetName) {
  const name = String(sheetName || '').toUpperCase();
  const match = Object.keys(ADMIN_SECTIONS).find(function (section) { return ADMIN_SECTIONS[section] === name; });
  return match || '';
}

function requireFields_(object, fields) {
  fields.forEach(function (field) {
    if (!object || object[field] === undefined || object[field] === null || object[field] === '') {
      throw new Error('Falta el campo ' + field + '.');
    }
  });
}

function getByPath_(object, path) {
  return String(path).split('.').reduce(function (value, key) { return value == null ? '' : value[key]; }, object) || '';
}

function safeEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(function (byte) { const normalized = byte < 0 ? byte + 256 : byte; return ('0' + normalized.toString(16)).slice(-2); })
    .join('');
}

function normalizeSearch_(value) { return String(value || '').trim().toUpperCase().replace(/[\s.]/g, ''); }
function clean_(value) { return String(value || '').trim().slice(0, 500); }
function validHttpUrl_(value) {
  const url = String(value || '').trim();
  return /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#].*)?$/i.test(url) ? url.slice(0, 1000) : '';
}
function number_(value) { const number = Number(value || 0); return Number.isFinite(number) ? number : 0; }
function nowIso_() { return Utilities.formatDate(new Date(), APP.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function todayIso_() { return Utilities.formatDate(new Date(), APP.timezone, 'yyyy-MM-dd'); }
function formatDate_(date) { return Utilities.formatDate(date, APP.timezone, 'yyyy-MM-dd'); }
function parseIsoDate_(value) { const parts = String(value).split('-').map(Number); return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0); }
function monthName_(month) { return ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'][month]; }
function makeId_(prefix) { return prefix + '-' + Utilities.getUuid().split('-')[0].toUpperCase(); }
function makeContractId_() { return 'CV-' + Utilities.formatDate(new Date(), APP.timezone, 'yyyy') + '-' + Math.floor(1000 + Math.random() * 9000); }
function maskDocument_(value) { const text = String(value || ''); return text.length > 4 ? '••••••' + text.slice(-4) : text; }
function maskEmail_(value) { const parts = String(value || '').split('@'); return parts.length === 2 ? parts[0].slice(0, 2) + '•••@' + parts[1] : ''; }
