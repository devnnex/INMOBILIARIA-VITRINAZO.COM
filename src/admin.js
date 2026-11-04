import { Backend, formatMoney, formatDate, formatRentalMonth, formatPaymentMethod, escapeHtml, initials, debounce, showToast, setBusy, setPageLoader } from './common.js';

'use strict';

const PAGE_SIZE = 1000;
const state = {
  token: sessionStorage.getItem('vitrinazo-admin-token') || '',
  data: null,
  version: 0,
  versions: {},
  pageInfo: {},
  rendered: {},
  view: 'dashboard',
  syncTimer: null,
  syncing: false,
  manualLedger: [],
  manualEditingPayment: null,
  deleteTarget: null,
  clientAccountId: '',
  clientAccountContractId: '',
  mutationQueues: {},
  idAliases: {},
  deletedKeys: new Set(),
  channel: 'BroadcastChannel' in window ? new BroadcastChannel('vitrinazo-admin-sync') : null
};

const login = document.getElementById('adminLogin');
const shell = document.getElementById('adminShell');
const loginForm = document.getElementById('adminLoginForm');
const demoHint = document.getElementById('adminDemoHint');
const recordDialog = document.getElementById('recordDialog');
const recordForm = document.getElementById('recordForm');
const adjustDialog = document.getElementById('adjustDialog');
const adjustForm = document.getElementById('adjustForm');
const manualDialog = document.getElementById('manualPaymentDialog');
const manualForm = document.getElementById('manualPaymentForm');
const deleteDialog = document.getElementById('deleteDialog');
const deleteForm = document.getElementById('deleteForm');
const clientAccountDialog = document.getElementById('clientAccountDialog');
const syncStatus = document.getElementById('syncStatus');

if (!Backend.isLive) demoHint.hidden = false;
document.querySelectorAll('[data-demo-pin]').forEach(function (button) {
  button.addEventListener('click', function () {
    document.getElementById('adminPin').value = button.dataset.demoPin;
    loginForm.requestSubmit();
  });
});
document.getElementById('togglePin').addEventListener('click', function () {
  const input = document.getElementById('adminPin');
  input.type = input.type === 'password' ? 'text' : 'password';
  this.textContent = input.type === 'password' ? 'Ver' : 'Ocultar';
});

loginForm.addEventListener('submit', async function (event) {
  event.preventDefault();
  const button = loginForm.querySelector('[type="submit"]');
  setBusy(button, true, 'Validando');
  try {
    const result = await Backend.call('adminLogin', new FormData(loginForm).get('pin'));
    if (!result.ok) throw new Error(result.needsSetup ? 'La inicialización automática aún no terminó. Reintenta en unos segundos o actualiza el despliegue de Apps Script.' : result.message || 'No fue posible ingresar.');
    state.token = result.token;
    sessionStorage.setItem('vitrinazo-admin-token', state.token);
    await enterAdmin();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
});

async function enterAdmin() {
  setPageLoader(true, {
    title: 'Preparando el panel',
    messages: ['Organizando clientes y viviendas…', 'Actualizando contratos y cobros…', 'Dejando todo listo para trabajar…']
  });
  try {
    await loadDashboard(true);
    login.hidden = true;
    shell.hidden = false;
    startSyncLoop();
  } finally {
    setPageLoader(false);
  }
}

async function loadDashboard(silent) {
  setSyncStatus('Cargando información…');
  try {
    const result = await Backend.call('getAdminDashboard', state.token, PAGE_SIZE);
    state.data = result;
    state.version = result.version || 0;
    state.versions = result.versions || {};
    state.pageInfo = result.pageInfo || {};
    renderAll();
    setSyncStatus('Información al día');
  } catch (error) {
    handleAdminError(error, silent);
    throw error;
  }
}

function startSyncLoop() {
  clearTimeout(state.syncTimer);
  scheduleSync(1500);
}

function scheduleSync(delay) {
  clearTimeout(state.syncTimer);
  if (!state.token) return;
  state.syncTimer = setTimeout(async function () {
    await syncChanges(true);
    scheduleSync(nextSyncDelay());
  }, delay);
}

function nextSyncDelay() {
  if (document.hidden) return 90000;
  const hasPendingPayment = state.data && state.data.payments.some(function (payment) { return payment.estado === 'PENDIENTE'; });
  return hasPendingPayment ? 5000 : 20000;
}

async function syncChanges(silent) {
  if (state.syncing || !state.token || !state.data) return false;
  state.syncing = true;
  setSyncStatus('Comprobando cambios…');
  try {
    const result = await Backend.call('getAdminSync', state.token, state.versions, PAGE_SIZE);
    state.version = result.version || state.version;
    state.versions = result.versions || state.versions;
    if (!result.changed) {
      setSyncStatus('Información al día');
      return false;
    }
    state.data.stats = result.stats || state.data.stats;
    Object.keys(result.sections || {}).forEach(function (section) {
      applySectionPage(section, result.sections[section], true);
    });
    renderStats();
    renderChangedSections(result.changedSections || Object.keys(result.sections || {}));
    setSyncStatus('Actualizado ahora');
    if (!silent) showToast('El panel recibió los cambios más recientes.');
    return true;
  } catch (error) {
    handleAdminError(error, true);
    setSyncStatus('Se reintentará automáticamente');
    return false;
  } finally {
    state.syncing = false;
  }
}

function applySectionPage(section, page, replace) {
  const incoming = (Array.isArray(page.items) ? page.items : []).filter(function (item) {
    return !state.deletedKeys.has(item.id || item.referencia) && !state.deletedKeys.has(item.contratoId);
  });
  if (replace) {
    const pending = (state.data[section] || []).filter(function (item) { return item.__pending; });
    const pendingKeys = new Set(pending.map(function (item) { return item.id || item.referencia; }));
    state.data[section] = pending.concat(incoming.filter(function (item) {
      return !pendingKeys.has(item.id || item.referencia);
    }));
  } else {
    const existing = new Set(state.data[section].map(function (item) { return item.id || item.referencia; }));
    state.data[section] = state.data[section].concat(incoming.filter(function (item) {
      return !existing.has(item.id || item.referencia);
    }));
  }
  const optimisticOnly = replace ? state.data[section].filter(function (item) {
    return item.__pending && !incoming.some(function (saved) { return (saved.id || saved.referencia) === (item.id || item.referencia); });
  }).length : 0;
  state.pageInfo[section] = {
    total: Number(page.total || 0) + optimisticOnly,
    offset: page.offset,
    nextOffset: page.nextOffset,
    hasMore: page.hasMore,
    limit: page.limit,
    __simulationBaseTotal: page.__simulationBaseTotal
  };
}

function renderChangedSections(sections) {
  if (sections.indexOf('clients') !== -1) renderClients();
  if (sections.indexOf('properties') !== -1) renderProperties();
  if (sections.indexOf('contracts') !== -1) { renderContracts(); renderManualContracts(); }
  if (sections.indexOf('payments') !== -1) renderPayments();
  if (state.clientAccountId && sections.some(function (section) { return ['clients', 'contracts', 'ledger', 'payments'].indexOf(section) !== -1; })) renderClientAccount();
}

async function loadMore(section, button) {
  const page = state.pageInfo[section];
  if (!page || !page.hasMore) return;
  const knownSectionVersion = state.versions[section];
  setBusy(button, true, 'Cargando');
  setPageLoader(true, {
    title: 'Cargando más registros',
    messages: ['Buscando el siguiente bloque…', 'Ordenando la información…', 'Preparando los registros para mostrarlos…']
  });
  try {
    const result = await Backend.call('getAdminPage', state.token, section, page.nextOffset, PAGE_SIZE);
    if (Number(result.versions[section]) !== Number(knownSectionVersion)) {
      await syncChanges(true);
      showToast('La información cambió mientras cargabas. Ya mostramos la versión más reciente.');
      return;
    }
    applySectionPage(section, result.page, false);
    renderChangedSections([section]);
  } catch (error) {
    handleAdminError(error, false);
  } finally {
    setBusy(button, false);
    setPageLoader(false);
  }
}

function handleAdminError(error, silent) {
  if (/sesión|session/i.test(error.message || '')) {
    state.token = '';
    sessionStorage.removeItem('vitrinazo-admin-token');
    clearTimeout(state.syncTimer);
    login.hidden = false;
    shell.hidden = true;
  }
  if (!silent) showToast(error.message || 'No fue posible actualizar.', 'error');
}

function setSyncStatus(message) {
  if (syncStatus) syncStatus.textContent = message;
}

function announceMutation() {
  if (state.channel) state.channel.postMessage({ type: 'changed', at: Date.now() });
  try { localStorage.setItem('vitrinazo-admin-change', String(Date.now())); } catch (error) { /* storage unavailable */ }
}

function setupDismissibleDialog(dialog) {
  dialog.querySelectorAll('[data-dialog-close]').forEach(function (button) {
    button.addEventListener('click', function () { dialog.close(); });
  });
  dialog.addEventListener('click', function (event) {
    const box = dialog.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === dialog && outside) dialog.close();
  });
}

[recordDialog, adjustDialog, manualDialog, deleteDialog, clientAccountDialog].forEach(setupDismissibleDialog);

const copInputFormatter = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

function parseCurrencyInput(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return digits ? Number(digits) : '';
}

function setCurrencyInputValue(input, value) {
  if (!input) return;
  const amount = parseCurrencyInput(value);
  input.dataset.rawValue = amount === '' ? '' : String(amount);
  input.value = amount === '' ? '' : '$ ' + copInputFormatter.format(amount);
  validateCurrencyInput(input);
}

function validateCurrencyInput(input) {
  const value = parseCurrencyInput(input.value);
  const minimum = Number(input.dataset.currencyMin || 0);
  input.setCustomValidity(value !== '' && value < minimum ? 'Ingresa un valor mínimo de ' + formatMoney(minimum) + '.' : '');
}

function setupCurrencyInputs(root) {
  root.querySelectorAll('[data-currency-input]').forEach(function (input) {
    if (input.dataset.currencyBound === '1') return;
    input.dataset.currencyBound = '1';
    input.addEventListener('input', function () { setCurrencyInputValue(input, input.value); });
    input.addEventListener('focus', function () { input.select(); });
    setCurrencyInputValue(input, input.value);
  });
}

function readFormValues(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  form.querySelectorAll('[data-currency-input][name]').forEach(function (input) {
    values[input.name] = parseCurrencyInput(input.value);
  });
  return values;
}

setupCurrencyInputs(document);

function optimisticId(prefix) {
  return 'TEMP-' + prefix + '-' + Date.now() + '-' + Math.random().toString(16).slice(2, 7);
}

function enqueueMutation(key, task) {
  const previous = state.mutationQueues[key] || Promise.resolve();
  const next = previous.catch(function () { /* a later change can still succeed */ }).then(task);
  state.mutationQueues[key] = next;
  next.finally(function () {
    if (state.mutationQueues[key] === next) delete state.mutationQueues[key];
  }).catch(function () { /* handled by the caller */ });
  return next;
}

function markRevision(record) {
  if (!record) return 0;
  record.__revision = Number(record.__revision || 0) + 1;
  record.__pending = true;
  return record.__revision;
}

function reconcileAfterFailure(error) {
  setSyncStatus('Revisando el último cambio…');
  showToast(error.message, 'error');
  const pending = {};
  ['clients', 'properties', 'contracts', 'ledger', 'payments'].forEach(function (section) {
    pending[section] = (state.data[section] || []).filter(function (item) { return item.__pending; });
  });
  Backend.call('getAdminDashboard', state.token, PAGE_SIZE).then(function (result) {
    state.data = result;
    state.version = result.version || state.version;
    state.versions = result.versions || state.versions;
    state.pageInfo = result.pageInfo || state.pageInfo;
    Object.keys(pending).forEach(function (section) {
      const keys = new Set(pending[section].map(function (item) { return item.id || item.referencia; }));
      state.data[section] = pending[section].concat((state.data[section] || []).filter(function (item) {
        const key = item.id || item.referencia;
        return !keys.has(key) && !state.deletedKeys.has(key) && !state.deletedKeys.has(item.contratoId);
      }));
    });
    renderAll();
    renderClientAccount();
    setSyncStatus('Información revisada');
  }).catch(function () { setSyncStatus('Se reintentará automáticamente'); });
}

function captureOptimisticState(sections) {
  const snapshot = {
    stats: Object.assign({}, state.data.stats),
    sections: {},
    pageInfo: {}
  };
  sections.forEach(function (section) {
    snapshot.sections[section] = (state.data[section] || []).map(function (item) { return Object.assign({}, item); });
    snapshot.pageInfo[section] = state.pageInfo[section] ? Object.assign({}, state.pageInfo[section]) : null;
  });
  return snapshot;
}

function restoreOptimisticState(snapshot) {
  state.data.stats = snapshot.stats;
  Object.keys(snapshot.sections).forEach(function (section) {
    state.data[section] = snapshot.sections[section];
    if (snapshot.pageInfo[section]) state.pageInfo[section] = snapshot.pageInfo[section];
  });
  renderStats();
  renderChangedSections(Object.keys(snapshot.sections));
}

function incrementPageTotal(section) {
  if (!state.pageInfo[section]) return;
  state.pageInfo[section].total = Number(state.pageInfo[section].total || 0) + 1;
  state.pageInfo[section].nextOffset = Number(state.pageInfo[section].nextOffset || 0) + 1;
}

function decrementPageTotal(section, count) {
  if (!state.pageInfo[section]) return;
  const amount = Math.max(1, Number(count || 1));
  state.pageInfo[section].total = Math.max(0, Number(state.pageInfo[section].total || 0) - amount);
  state.pageInfo[section].nextOffset = Math.max(0, Number(state.pageInfo[section].nextOffset || 0) - amount);
}

function finishOptimisticSave(sections) {
  announceMutation();
  setSyncStatus('Cambios guardados');
  renderChangedSections(sections);
  scheduleSync(100);
}

if (state.channel) {
  state.channel.onmessage = function (event) {
    if (event.data && event.data.type === 'changed') scheduleSync(100);
  };
}
window.addEventListener('storage', function (event) {
  if (event.key === 'vitrinazo-admin-change') scheduleSync(100);
  if (event.key === 'vitrinazo-transfer-simulation-v1') {
    try {
      if (JSON.parse(event.newValue || '{}').version !== JSON.parse(event.oldValue || '{}').version) refreshSimulatedPayments();
    } catch (error) { refreshSimulatedPayments(); }
  }
});
window.addEventListener('vitrinazo-transfer-change', refreshSimulatedPayments);

function refreshSimulatedPayments() {
  if (!state.data || !Backend.isTransferSimulation) return;
  state.data = Backend.projectAdminSimulation(state.data);
  state.pageInfo = state.data.pageInfo || state.pageInfo;
  renderStats(); renderRecentContracts(); renderContracts(); renderPayments(); renderManualContracts(); renderClientAccount();
}
document.addEventListener('visibilitychange', function () { scheduleSync(document.hidden ? 90000 : 150); });
window.addEventListener('focus', function () { refreshSimulatedPayments(); scheduleSync(100); });

function renderAll() {
  state.rendered = {};
  renderToday();
  renderStats();
  renderRecentContracts();
  renderManualContracts();
  const jobs = [renderClients, renderProperties, renderContracts, renderPayments];
  const runNext = function (deadline) {
    while (jobs.length && (!deadline || deadline.timeRemaining() > 4)) jobs.shift()();
    if (jobs.length) scheduleIdle(runNext);
  };
  scheduleIdle(runNext);
}

function scheduleIdle(callback) {
  if ('requestIdleCallback' in window) window.requestIdleCallback(callback, { timeout: 700 });
  else setTimeout(function () { callback(null); }, 30);
}

function renderToday() {
  const date = new Date();
  document.getElementById('todayCard').innerHTML = '<strong>' + date.getDate() + '</strong><span>' + date.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' }) + '</span>';
  const hour = date.getHours();
  document.getElementById('adminTitle').textContent = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
}

function renderStats() {
  const stats = state.data.stats;
  const cards = [
    ['Clientes', stats.clientes, '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/>'],
    ['Contratos activos', stats.contratosActivos, '<path d="M6 3h9l3 3v15H6zM9 12h6M9 16h6"/>'],
    ['Falta por cobrar', formatMoney(stats.cartera), '<path d="M4 5h16v14H4zM4 10h16"/>'],
    ['Dinero recibido', formatMoney(stats.recaudado), '<path d="M3 7h18v11H3zM3 10h18M7 15h3"/>']
  ];
  document.getElementById('statGrid').innerHTML = cards.map(function (card) {
    return '<article class="stat-card"><span>' + card[0] + '</span><span class="stat-card__icon"><svg viewBox="0 0 24 24">' + card[2] + '</svg></span><strong>' + escapeHtml(card[1]) + '</strong></article>';
  }).join('');
  const denominator = stats.recaudado + stats.cartera;
  const percent = denominator ? Math.round(stats.recaudado / denominator * 100) : 0;
  document.getElementById('collectionDonut').style.setProperty('--percent', percent);
  document.getElementById('collectionPercent').textContent = percent + '%';
  document.getElementById('collectedValue').textContent = formatMoney(stats.recaudado);
  document.getElementById('outstandingValue').textContent = formatMoney(stats.cartera) + ' por cobrar';
}

function renderClients() {
  document.getElementById('clientsTable').innerHTML = state.data.clients.map(function (client) {
    const reference = String(client.id || '').indexOf('TEMP-') === 0 ? 'Cliente nuevo' : client.id;
    const account = '<button class="row-action" type="button" data-client-account="' + escapeHtml(client.id) + '"><span aria-hidden="true">◎</span><b>Ver cuenta</b></button>';
    return '<tr data-status="' + escapeHtml(client.estado) + '"><td><button class="row-person row-person--button" type="button" data-client-account="' + escapeHtml(client.id) + '"><span class="row-avatar">' + escapeHtml(initials(client.nombre)) + '</span><span><strong>' + escapeHtml(client.nombre) + '</strong><small>' + escapeHtml(reference) + '</small></span></button></td><td>' + escapeHtml(client.documento) + '</td><td>' + escapeHtml(client.email || '—') + '<small>' + escapeHtml(client.telefono || '') + '</small></td><td><span class="badge ' + (client.estado === 'ACTIVO' ? 'badge--active' : 'badge--overdue') + '">' + escapeHtml(client.estado) + '</span></td><td><div class="row-actions">' + account + rowActions('client', client.id, true) + '</div></td></tr>';
  }).join('') || emptyRow(5, 'No hay clientes creados.');
  labelTableCells('clientsTable');
  applyTableFilters('clients');
  renderPagination('clients');
  state.rendered.clients = true;
}

function renderProperties() {
  document.getElementById('propertiesTable').innerHTML = state.data.properties.map(function (home) {
    return '<tr data-status="' + escapeHtml(home.estado) + '"><td><strong>' + escapeHtml(home.codigo) + '</strong><small>' + escapeHtml(home.barrio || home.ciudad) + '</small></td><td>' + escapeHtml(home.direccion) + '<small>' + escapeHtml(home.ciudad || '') + '</small></td><td>' + escapeHtml(home.tipo) + '</td><td><strong>' + formatMoney(home.canon) + '</strong></td><td><span class="badge ' + (home.estado === 'OCUPADA' ? 'badge--pending' : home.estado === 'MANTENIMIENTO' ? 'badge--overdue' : 'badge--active') + '">' + escapeHtml(home.estado) + '</span></td><td>' + rowActions('property', home.id) + '</td></tr>';
  }).join('') || emptyRow(6, 'No hay viviendas creadas.');
  labelTableCells('propertiesTable');
  applyTableFilters('properties');
  renderPagination('properties');
  state.rendered.properties = true;
}

function renderContracts() {
  document.getElementById('contractsTable').innerHTML = state.data.contracts.map(function (contract) {
    const reference = String(contract.id || '').indexOf('TEMP-') === 0 ? 'Contrato nuevo' : contract.id;
    return '<tr data-status="' + escapeHtml(contract.estado) + '"><td><strong>' + escapeHtml(reference) + '</strong></td><td>' + escapeHtml(contract.clienteNombre) + '</td><td>' + escapeHtml(contract.viviendaCodigo) + '</td><td>' + formatDate(contract.fechaInicio) + '<small>hasta ' + formatDate(contract.fechaFin) + '</small></td><td><strong>' + formatMoney(contract.saldo) + '</strong></td><td><span class="badge ' + (contract.estado === 'ACTIVO' ? 'badge--active' : 'badge--overdue') + '">' + escapeHtml(contract.estado) + '</span></td><td>' + rowActions('contract', contract.id) + '</td></tr>';
  }).join('') || emptyRow(7, 'No hay contratos creados.');
  labelTableCells('contractsTable');
  applyTableFilters('contracts');
  renderRecentContracts();
  renderPagination('contracts');
  state.rendered.contracts = true;
}

function renderRecentContracts() {
  document.getElementById('recentContracts').innerHTML = state.data.contracts.slice(0, 5).map(function (contract) {
    const reference = String(contract.id || '').indexOf('TEMP-') === 0 ? 'Contrato nuevo' : contract.id;
    return '<tr><td><strong>' + escapeHtml(reference) + '</strong></td><td>' + escapeHtml(contract.clienteNombre) + '</td><td>' + escapeHtml(contract.viviendaCodigo) + '</td><td><strong>' + formatMoney(contract.saldo) + '</strong></td><td><span class="badge ' + (contract.estado === 'ACTIVO' ? 'badge--active' : 'badge--overdue') + '">' + escapeHtml(contract.estado) + '</span></td></tr>';
  }).join('') || emptyRow(5, 'No hay contratos.');
  labelTableCells('recentContracts');
}

function renderLedger() {
  const table = document.getElementById('ledgerTable');
  if (!table) return;
  table.innerHTML = state.data.ledger.map(function (item) {
    const adjustments = Number(item.cargoExtra || 0) - Number(item.descuento || 0);
    return '<tr><td><strong>' + escapeHtml(item.contratoId) + '</strong><small>' + escapeHtml(item.clienteNombre || '') + '</small></td><td>' + escapeHtml(formatRentalMonth(item.periodo, item.fechaVencimiento)) + '<small>' + formatDate(item.fechaVencimiento) + '</small></td><td>' + formatMoney(item.valorBase) + '</td><td class="' + (adjustments < 0 ? 'positive' : '') + '">' + (adjustments === 0 ? '—' : (adjustments > 0 ? '+' : '') + formatMoney(adjustments)) + '<small>' + escapeHtml(item.observacion || '') + '</small></td><td><strong>' + formatMoney(item.saldo) + '</strong></td><td><span class="badge ' + badgeClass(item.estadoCalculado) + '">' + escapeHtml(item.estadoCalculado) + '</span></td><td><button class="row-action" data-adjust="' + escapeHtml(item.id) + '" title="Cambiar el valor del mes">✎</button></td></tr>';
  }).join('') || emptyRow(7, 'No hay cobros creados.');
  labelTableCells('ledgerTable');
  document.querySelectorAll('[data-adjust]').forEach(function (button) { button.addEventListener('click', function () { openAdjust(button.dataset.adjust); }); });
  renderPagination('ledger');
  state.rendered.ledger = true;
}

function renderPayments() {
  document.getElementById('paymentsTable').innerHTML = state.data.payments.map(function (payment) {
    const editable = isEditableManualPayment(payment);
    const actions = editable ? rowActions('payment', payment.id) : '<span class="protected-record" title="Los pagos bancarios se conservan como historial">Protegido</span>';
    const reference = String(payment.id || '').indexOf('TEMP-') === 0 ? 'Pago reciente' : payment.referencia;
    const contract = state.data.contracts.find(item => item.id === payment.contratoId);
    return '<tr data-payment-id="' + escapeHtml(payment.id) + '" data-status="' + escapeHtml(payment.estado) + '"><td><strong>' + escapeHtml(reference) + '</strong><small>' + escapeHtml(payment.transaccionId || 'Pago agregado aquí') + '</small></td><td>' + escapeHtml(payment.contratoId) + '<small>' + escapeHtml(payment.clienteNombre || contract?.clienteNombre || '') + '</small></td><td><strong>' + formatMoney(payment.valor) + '</strong><small class="payment-month-labels">' + escapeHtml(paymentMonthLabels(payment)) + '</small></td><td>' + escapeHtml(formatPaymentMethod(payment.metodo)) + '</td><td>' + formatDate(payment.pagadoEn || payment.creadoEn) + '</td><td><span class="badge ' + (payment.estado === 'APROBADO' ? 'badge--paid' : payment.estado === 'PENDIENTE' ? 'badge--pending' : 'badge--overdue') + '">' + escapeHtml(payment.estado) + '</span></td><td>' + actions + '</td></tr>';
  }).join('') || emptyRow(7, 'No hay pagos registrados.');
  labelTableCells('paymentsTable');
  applyTableFilters('payments');
  renderPagination('payments');
  state.rendered.payments = true;
}

function paymentMonthLabels(payment) {
  if (Array.isArray(payment.meses)) return payment.meses.map(month => formatRentalMonth(month)).join(' · ');
  return parsePaymentAllocations(payment).map(function (allocation) {
    const row = state.data.ledger.find(item => item.id === allocation.id && item.contratoId === payment.contratoId);
    return row ? formatRentalMonth(row.periodo, row.fechaVencimiento) : '';
  }).filter(Boolean).join(' · ');
}

function renderPagination(section) {
  const container = document.querySelector('[data-pagination="' + section + '"]');
  const page = state.pageInfo[section];
  if (!container || !page) return;
  const loaded = Math.min(state.data[section].length, page.total);
  container.querySelector('span').textContent = loaded.toLocaleString('es-CO') + ' de ' + Number(page.total || 0).toLocaleString('es-CO') + ' registros';
  container.hidden = !page.hasMore;
}

function emptyRow(columns, message) { return '<tr><td colspan="' + columns + '"><div class="empty-state">' + escapeHtml(message) + '</div></td></tr>'; }
function badgeClass(status) { return status === 'PAGADO' ? 'badge--paid' : status === 'VENCIDO' ? 'badge--overdue' : 'badge--pending'; }

function rowActions(type, id, inline) {
  const content = '<button class="row-action" type="button" data-edit-type="' + escapeHtml(type) + '" data-record-id="' + escapeHtml(id) + '"><span aria-hidden="true">✎</span><b>Editar</b></button><button class="row-action row-action--danger" type="button" data-delete-type="' + escapeHtml(type) + '" data-record-id="' + escapeHtml(id) + '"><span aria-hidden="true">×</span><b>Eliminar</b></button>';
  return inline ? content : '<div class="row-actions">' + content + '</div>';
}

function isEditableManualPayment(payment) {
  return Boolean(payment && String(payment.referencia || '').indexOf('MAN-') === 0 && !payment.transaccionId && payment.estado === 'APROBADO');
}

function labelTableCells(bodyId) {
  const body = document.getElementById(bodyId);
  const table = body && body.closest('table');
  if (!table) return;
  const labels = Array.from(table.querySelectorAll('thead th')).map(function (header, index) {
    return header.textContent.trim() || (index === table.querySelectorAll('thead th').length - 1 ? 'Acción' : 'Información');
  });
  body.querySelectorAll('tr').forEach(function (row) {
    Array.from(row.children).forEach(function (cell, index) {
      if (cell.colSpan > 1) return;
      cell.dataset.label = labels[index] || 'Información';
    });
  });
}

function normalizeFilterText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function applyTableFilters(section) {
  const body = document.getElementById(section + 'Table');
  if (!body) return;
  const search = document.querySelector('[data-table-search="' + section + '"]');
  const filter = document.querySelector('[data-table-filter="' + section + '"]');
  const terms = normalizeFilterText(search && search.value).split(' ').filter(Boolean);
  const status = normalizeFilterText(filter && filter.value);
  body.querySelectorAll('tr').forEach(function (row) {
    if (row.querySelector('[colspan]')) { row.hidden = false; return; }
    const text = normalizeFilterText(row.textContent);
    const matchesSearch = terms.every(function (term) { return text.indexOf(term) !== -1; });
    const matchesStatus = !status || normalizeFilterText(row.dataset.status) === status;
    row.hidden = !(matchesSearch && matchesStatus);
  });
}

function mergeAccountData(result) {
  if (!result) return;
  if (result.client) {
    const clientIndex = state.data.clients.findIndex(function (item) { return item.id === result.client.id; });
    if (clientIndex !== -1 && !state.data.clients[clientIndex].__pending) state.data.clients[clientIndex] = result.client;
  }
  ['contracts', 'ledger', 'payments'].forEach(function (section) {
    (result[section] || []).forEach(function (incoming) {
      const index = state.data[section].findIndex(function (item) { return item.id === incoming.id; });
      if (index === -1) state.data[section].push(incoming);
      else if (!state.data[section][index].__pending) state.data[section][index] = incoming;
    });
  });
}

function openClientAccount(clientId) {
  const client = state.data.clients.find(function (item) { return item.id === clientId; });
  if (!client) return;
  state.clientAccountId = clientId;
  const firstContract = state.data.contracts.find(function (item) { return item.clienteId === clientId; });
  state.clientAccountContractId = firstContract ? firstContract.id : '';
  clientAccountDialog.showModal();
  renderClientAccount();
  if (String(clientId).indexOf('TEMP-') === 0) return;
  Backend.call('getClientAccountForAdmin', state.token, clientId).then(function (result) {
    if (state.clientAccountId !== clientId) return;
    mergeAccountData(result);
    if (!state.clientAccountContractId && result.contracts && result.contracts[0]) state.clientAccountContractId = result.contracts[0].id;
    renderClientAccount();
  }).catch(function (error) { handleAdminError(error, true); });
}

function renderClientAccount() {
  if (!state.clientAccountId || !clientAccountDialog.open) return;
  const client = state.data.clients.find(function (item) { return item.id === state.clientAccountId; });
  if (!client) { clientAccountDialog.close(); return; }
  const contracts = state.data.contracts.filter(function (item) { return item.clienteId === client.id; });
  if (!contracts.some(function (item) { return item.id === state.clientAccountContractId; })) state.clientAccountContractId = contracts[0] ? contracts[0].id : '';
  const contract = contracts.find(function (item) { return item.id === state.clientAccountContractId; });
  const ledger = contract ? state.data.ledger.filter(function (item) { return item.contratoId === contract.id; }).sort(function (a, b) { return String(a.fechaVencimiento).localeCompare(String(b.fechaVencimiento)); }) : [];
  const payments = contract ? state.data.payments.filter(function (item) { return item.contratoId === contract.id; }).sort(function (a, b) { return String(b.pagadoEn || b.creadoEn).localeCompare(String(a.pagadoEn || a.creadoEn)); }) : [];
  const balance = ledger.reduce(function (sum, item) { return sum + Number(item.saldo || 0); }, 0);
  const paid = ledger.reduce(function (sum, item) { return sum + Number(item.valorPagado || 0); }, 0);
  const pending = ledger.filter(function (item) { return Number(item.saldo || 0) > 0; }).length;

  document.getElementById('clientAccountTitle').textContent = client.nombre;
  document.getElementById('clientAccountIdentity').innerHTML = '<span><strong>Documento:</strong> ' + escapeHtml(client.documento || '—') + '</span><span><strong>Correo:</strong> ' + escapeHtml(client.email || '—') + '</span><span><strong>Celular:</strong> ' + escapeHtml(client.telefono || '—') + '</span>';
  document.getElementById('clientAccountContracts').innerHTML = contracts.length ? contracts.map(function (item) {
    return '<button class="client-contract-tab ' + (item.id === state.clientAccountContractId ? 'is-active' : '') + '" type="button" data-client-contract="' + escapeHtml(item.id) + '">' + escapeHtml(item.id) + ' · ' + escapeHtml(item.viviendaCodigo || 'Vivienda') + '</button>';
  }).join('') : '<p class="client-account__empty">Este cliente todavía no tiene contratos.</p>';
  document.getElementById('clientAccountSummary').innerHTML = [
    ['Falta por pagar', formatMoney(balance)],
    ['Pagado', formatMoney(paid)],
    ['Meses pendientes', pending.toLocaleString('es-CO')]
  ].map(function (item) { return '<div class="client-account__metric"><span>' + item[0] + '</span><strong>' + item[1] + '</strong></div>'; }).join('');
  document.getElementById('clientAccountMonths').innerHTML = ledger.length ? ledger.map(function (item) {
    const discount = Number(item.descuento || 0);
    const extra = Number(item.cargoExtra || 0);
    const changes = [discount ? '−' + formatMoney(discount) + ' de descuento' : '', extra ? '+' + formatMoney(extra) + ' adicional' : ''].filter(Boolean).join(' · ') || 'Sin cambios al valor';
    return '<article class="account-month' + (Number(item.saldo) <= 0 ? ' is-paid' : '') + '" data-ledger-id="' + escapeHtml(item.id) + '"><div><strong>' + escapeHtml(formatRentalMonth(item.periodo, item.fechaVencimiento)) + '</strong><small>Pago límite: ' + formatDate(item.fechaVencimiento) + '</small><span class="account-month__changes">' + escapeHtml(changes) + '</span></div><div class="account-month__amount"><span>Falta por pagar</span><strong>' + formatMoney(item.saldo) + '</strong><span class="badge ' + badgeClass(item.estadoCalculado) + '">' + escapeHtml(item.estadoCalculado) + '</span></div><button class="row-action" type="button" data-adjust="' + escapeHtml(item.id) + '"><span aria-hidden="true">✎</span><b>Cambiar valor</b></button></article>';
  }).join('') : '<p class="client-account__empty">No hay meses registrados para este contrato.</p>';
  document.getElementById('clientAccountPayments').innerHTML = payments.length ? payments.map(function (payment) {
    return '<article class="account-payment"><div><strong>' + escapeHtml(payment.referencia || payment.id) + '</strong><small>' + formatDate(payment.pagadoEn || payment.creadoEn) + ' · ' + escapeHtml(formatPaymentMethod(payment.metodo)) + '</small><small class="payment-month-labels">' + escapeHtml(paymentMonthLabels(payment)) + '</small></div><strong>' + formatMoney(payment.valor) + '</strong></article>';
  }).join('') : '<p class="client-account__empty">Todavía no hay pagos registrados para este contrato.</p>';
}

clientAccountDialog.addEventListener('close', function () {
  state.clientAccountId = '';
  state.clientAccountContractId = '';
});

document.querySelectorAll('[data-load-more]').forEach(function (button) {
  button.addEventListener('click', function () { loadMore(button.dataset.loadMore, button); });
});
document.querySelectorAll('[data-view]').forEach(function (button) { button.addEventListener('click', function () { switchView(button.dataset.view); }); });
document.querySelectorAll('[data-go]').forEach(function (button) { button.addEventListener('click', function () { switchView(button.dataset.go); }); });

function switchView(view) {
  state.view = view;
  const renderers = { clients: renderClients, properties: renderProperties, contracts: renderContracts, payments: renderPayments };
  if (renderers[view] && !state.rendered[view]) renderers[view]();
  document.querySelectorAll('[data-panel]').forEach(function (panel) { panel.classList.toggle('is-active', panel.dataset.panel === view); });
  document.querySelectorAll('[data-view]').forEach(function (button) { button.classList.toggle('is-active', button.dataset.view === view); });
  const names = { dashboard: 'Resumen', clients: 'Clientes', properties: 'Viviendas', contracts: 'Contratos', payments: 'Pagos' };
  document.getElementById('adminBreadcrumb').textContent = 'Panel / ' + names[view];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.getElementById('refreshAdmin').addEventListener('click', async function () {
  const button = this;
  button.disabled = true;
  setPageLoader(true, {
    title: 'Actualizando el panel',
    messages: ['Comprobando cambios recientes…', 'Actualizando los cobros…', 'Terminando la actualización…']
  });
  try { await loadDashboard(); showToast('Información actualizada.'); } finally { button.disabled = false; setPageLoader(false); }
});
document.getElementById('quickCreate').addEventListener('click', function () { openRecord('client'); });
document.querySelectorAll('[data-action]').forEach(function (button) {
  button.addEventListener('click', function () {
    const action = button.dataset.action;
    if (action === 'new-client') openRecord('client');
    if (action === 'new-property') openRecord('property');
    if (action === 'new-contract') openRecord('contract');
    if (action === 'manual-payment') {
      openManualPayment();
      if (button.closest('#clientAccountDialog') && state.clientAccountContractId) {
        manualForm.elements.contratoId.value = state.clientAccountContractId;
        loadManualLedger(state.clientAccountContractId, false);
      }
    }
  });
});

document.addEventListener('click', function (event) {
  const accountButton = event.target.closest('[data-client-account]');
  if (accountButton) {
    openClientAccount(accountButton.dataset.clientAccount);
    return;
  }
  const contractTab = event.target.closest('[data-client-contract]');
  if (contractTab) {
    state.clientAccountContractId = contractTab.dataset.clientContract;
    renderClientAccount();
    return;
  }
  const adjustButton = event.target.closest('[data-adjust]');
  if (adjustButton) {
    openAdjust(adjustButton.dataset.adjust);
    return;
  }
  const editButton = event.target.closest('[data-edit-type]');
  if (editButton) {
    const type = editButton.dataset.editType;
    const record = findAdminRecord(type, editButton.dataset.recordId);
    if (type === 'payment') openManualPayment(record);
    else if (record) openRecord(type, record);
    return;
  }
  const deleteButton = event.target.closest('[data-delete-type]');
  if (deleteButton) openDelete(deleteButton.dataset.deleteType, deleteButton.dataset.recordId);
});

function findAdminRecord(type, id) {
  const section = type === 'client' ? 'clients' : type === 'property' ? 'properties' : type === 'contract' ? 'contracts' : 'payments';
  return (state.data[section] || []).find(function (item) { return item.id === id; });
}

const deleteMethods = {
  client: 'deleteClient',
  property: 'deleteProperty',
  contract: 'deleteContract',
  payment: 'deleteManualPayment'
};

function openDelete(type, id) {
  const record = findAdminRecord(type, id);
  if (!record) return;
  const labels = {
    client: record.nombre,
    property: record.codigo + ' · ' + record.direccion,
    contract: record.id,
    payment: record.referencia + ' · ' + formatMoney(record.valor)
  };
  const names = { client: 'cliente', property: 'vivienda', contract: 'contrato', payment: 'pago' };
  state.deleteTarget = { type: type, id: id };
  document.getElementById('deleteTitle').textContent = 'Eliminar ' + names[type];
  document.getElementById('deleteMessage').textContent = 'Vas a eliminar “' + labels[type] + '”. Si tiene información financiera que debe conservarse, el sistema protegerá el registro.';
  deleteDialog.showModal();
}

function parsePaymentAllocations(payment) {
  try {
    const allocations = JSON.parse(payment && payment.detalleJson || '[]');
    return Array.isArray(allocations) ? allocations.map(function (item) {
      return { id: String(item.id || ''), amount: Math.max(0, Number(item.amount || 0)) };
    }).filter(function (item) { return item.id && item.amount > 0; }) : [];
  } catch (error) {
    return [];
  }
}

function applyAllocationLocally(allocation, direction) {
  const item = state.data.ledger.find(function (row) { return row.id === allocation.id; });
  if (!item) return;
  const totalDue = Math.max(0, Number(item.valorBase || 0) - Number(item.descuento || 0) + Number(item.cargoExtra || 0));
  item.valorPagado = Math.min(totalDue, Math.max(0, Number(item.valorPagado || 0) + direction * Number(allocation.amount || 0)));
  item.saldo = Math.max(0, totalDue - item.valorPagado);
  item.estadoCalculado = item.saldo <= 0 ? 'PAGADO' : String(item.fechaVencimiento || '').slice(0, 10) < new Date().toISOString().slice(0, 10) ? 'VENCIDO' : 'PENDIENTE';
  item.__pending = true;
}

function applyOptimisticDelete(type, id) {
  if (type === 'client') {
    state.data.clients = state.data.clients.filter(function (item) { return item.id !== id; });
    state.data.stats.clientes = Math.max(0, Number(state.data.stats.clientes || 0) - 1);
    decrementPageTotal('clients');
    if (state.clientAccountId === id && clientAccountDialog.open) clientAccountDialog.close();
    renderStats(); renderClients();
    return ['clients'];
  }
  if (type === 'property') {
    state.data.properties = state.data.properties.filter(function (item) { return item.id !== id; });
    decrementPageTotal('properties');
    renderProperties();
    return ['properties'];
  }
  if (type === 'contract') {
    const contract = findAdminRecord('contract', id);
    if (!contract) return [];
    const removedLedgerCount = state.data.ledger.filter(function (item) { return item.contratoId === id; }).length;
    const removedPaymentCount = state.data.payments.filter(function (item) { return item.contratoId === id; }).length;
    state.data.contracts = state.data.contracts.filter(function (item) { return item.id !== id; });
    state.data.ledger = state.data.ledger.filter(function (item) { return item.contratoId !== id; });
    state.data.payments = state.data.payments.filter(function (item) { return item.contratoId !== id; });
    if (contract.estado === 'ACTIVO') state.data.stats.contratosActivos = Math.max(0, Number(state.data.stats.contratosActivos || 0) - 1);
    state.data.stats.cartera = Math.max(0, Number(state.data.stats.cartera || 0) - Number(contract.saldo || 0));
    const home = state.data.properties.find(function (item) { return item.id === contract.viviendaId; });
    if (home) home.estado = state.data.contracts.some(function (item) { return item.viviendaId === home.id && item.estado === 'ACTIVO'; }) ? 'OCUPADA' : 'DISPONIBLE';
    decrementPageTotal('contracts');
    if (removedLedgerCount) decrementPageTotal('ledger', removedLedgerCount);
    if (removedPaymentCount) decrementPageTotal('payments', removedPaymentCount);
    renderStats(); renderContracts(); renderProperties(); renderPayments(); renderManualContracts(); renderClientAccount();
    return ['contracts', 'properties', 'ledger', 'payments'];
  }
  const payment = findAdminRecord('payment', id);
  if (!payment) return [];
  const allocations = parsePaymentAllocations(payment);
  const restoredBalance = allocations.reduce(function (sum, item) { return sum + Number(item.amount || 0); }, 0);
  allocations.forEach(function (allocation) { applyAllocationLocally(allocation, -1); });
  state.data.payments = state.data.payments.filter(function (item) { return item.id !== id; });
  const contract = state.data.contracts.find(function (item) { return item.id === payment.contratoId; });
  if (contract) contract.saldo = Number(contract.saldo || 0) + restoredBalance;
  state.data.stats.cartera = Number(state.data.stats.cartera || 0) + restoredBalance;
  state.data.stats.recaudado = Math.max(0, Number(state.data.stats.recaudado || 0) - Number(payment.valor || 0));
  decrementPageTotal('payments');
  renderStats(); renderPayments(); renderContracts(); renderClientAccount();
  return ['payments', 'ledger', 'contracts'];
}

deleteForm.addEventListener('submit', function (event) {
  event.preventDefault();
  const target = state.deleteTarget;
  if (!target) return;
  state.deletedKeys.add(target.id);
  const changedSections = applyOptimisticDelete(target.type, target.id);
  deleteDialog.close();
  setSyncStatus('Información al día');
  const queueKey = target.type + ':' + target.id;
  const targetCopy = Object.assign({}, target);
  state.deleteTarget = null;
  enqueueMutation(queueKey, function () {
    return Backend.call(deleteMethods[targetCopy.type], state.token, state.idAliases[targetCopy.id] || targetCopy.id);
  }).then(function () {
    state.deletedKeys.delete(targetCopy.id);
    state.deletedKeys.delete(state.idAliases[targetCopy.id]);
    finishOptimisticSave(changedSections);
    showToast('Registro eliminado correctamente.');
  }).catch(function (error) {
    state.deletedKeys.delete(targetCopy.id);
    state.deletedKeys.delete(state.idAliases[targetCopy.id]);
    reconcileAfterFailure(error);
  });
});

const recordConfigs = {
  client: { title: 'Crear cliente', editTitle: 'Editar cliente', kicker: 'Nuevo cliente', editKicker: 'Información del cliente', method: 'saveClient', updateMethod: 'updateClient', fields: function (editing) { return '<label>Número de documento<input name="documento" inputmode="numeric" required></label><label>Nombre completo<input name="nombre" autocomplete="name" required></label><label>Correo<input type="email" name="email" autocomplete="email"></label><label>Celular<input type="tel" name="telefono" autocomplete="tel"></label>' + (editing ? '<label class="form-span">Estado<select name="estado"><option value="ACTIVO">Activo</option><option value="INACTIVO">Inactivo</option></select></label>' : ''); } },
  property: { title: 'Crear vivienda', editTitle: 'Editar vivienda', kicker: 'Nueva vivienda', editKicker: 'Información de la vivienda', method: 'saveProperty', updateMethod: 'updateProperty', fields: function (editing) { return '<label>Código de la vivienda<input name="codigo" placeholder="VTZ-106" required></label><label>Tipo<select name="tipo"><option>Apartamento</option><option>Casa</option><option>Local</option><option>Oficina</option></select></label><label class="form-span">Dirección<input name="direccion" required></label><label>Ciudad<input name="ciudad" value="Bogotá D.C." required></label><label>Barrio<input name="barrio"></label><label class="form-span">Valor mensual sugerido del arriendo<input type="text" name="canon" inputmode="numeric" autocomplete="off" data-currency-input data-currency-min="0"><span class="field-help">Es el valor recomendado que se cobrará cada mes.</span></label>' + (editing ? '<label class="form-span">Estado<select name="estado"><option value="DISPONIBLE">Disponible</option><option value="OCUPADA">Ocupada</option><option value="MANTENIMIENTO">En mantenimiento</option></select></label>' : ''); } },
  contract: { title: 'Crear contrato', editTitle: 'Editar contrato', kicker: 'Nuevo contrato', editKicker: 'Información del contrato', method: 'saveContract', updateMethod: 'updateContract', fields: function (editing) {
    const clients = state.data.clients.map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.nombre) + ' · ' + escapeHtml(item.documento) + '</option>'; }).join('');
    const homes = state.data.properties.map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.codigo) + ' · ' + escapeHtml(item.direccion) + '</option>'; }).join('');
    return '<label class="form-span">Cliente<select name="clienteId" required><option value="">Selecciona</option>' + clients + '</select></label><label class="form-span">Vivienda<select name="viviendaId" required><option value="">Selecciona</option>' + homes + '</select></label><label>Fecha de inicio<input type="date" name="fechaInicio" required></label><label>Fecha final<input type="date" name="fechaFin" required></label><label>Valor mensual del arriendo<input type="text" name="canonMensual" inputmode="numeric" autocomplete="off" data-currency-input data-currency-min="1" required><span class="field-help">Es el dinero que el cliente pagará cada mes.</span></label><label>Dinero de garantía<input type="text" name="deposito" inputmode="numeric" autocomplete="off" data-currency-input data-currency-min="0"><span class="field-help">Dinero que se guarda para cubrir posibles daños.</span></label><label>Día límite para pagar<input type="number" name="diaVencimiento" inputmode="numeric" min="1" max="28" value="10"></label>' + (editing ? '<label>Estado<select name="estado"><option value="ACTIVO">Activo</option><option value="FINALIZADO">Finalizado</option><option value="CANCELADO">Cancelado</option></select></label>' : '') + '<div class="contract-live-total form-span"><span>Falta por pagar con estos valores</span><strong id="contractLiveTotal">$0</strong><small id="contractLiveMonths">Completa las fechas y el valor mensual.</small></div>';
  } }
};

function openRecord(type, record) {
  const config = recordConfigs[type];
  const editing = Boolean(record);
  recordForm.reset();
  recordForm.dataset.type = type;
  recordForm.dataset.mode = editing ? 'edit' : 'create';
  recordForm.dataset.id = editing ? record.id : '';
  document.getElementById('recordKicker').textContent = editing ? config.editKicker : config.kicker;
  document.getElementById('recordTitle').textContent = editing ? config.editTitle : config.title;
  document.getElementById('recordSubmit').textContent = editing ? 'Guardar cambios' : 'Guardar registro';
  document.getElementById('recordFields').innerHTML = config.fields(editing);
  setupCurrencyInputs(document.getElementById('recordFields'));
  if (editing) populateRecordForm(type, record);
  if (type === 'contract') setupContractLiveCalculation(record);
  recordDialog.showModal();
}

function setupContractLiveCalculation(record) {
  function update() {
    const values = readFormValues(recordForm);
    const months = countContractMonths(values.fechaInicio, values.fechaFin);
    const rent = Number(values.canonMensual || 0);
    let balance = months * rent;
    if (record && months) {
      const firstMonth = contractMonthIndex(values.fechaInicio);
      const lastMonth = firstMonth + months - 1;
      state.data.ledger.filter(function (item) {
        const itemMonth = contractMonthIndex(item.fechaVencimiento);
        return item.contratoId === record.id && itemMonth >= firstMonth && itemMonth <= lastMonth;
      }).forEach(function (item) {
        balance += Math.max(0, rent - Number(item.descuento || 0) + Number(item.cargoExtra || 0) - Number(item.valorPagado || 0)) - rent;
      });
    }
    document.getElementById('contractLiveTotal').textContent = formatMoney(Math.max(0, balance));
    document.getElementById('contractLiveMonths').textContent = months ? months + (months === 1 ? ' mes calculado al instante.' : ' meses calculados al instante.') : 'Completa las fechas y el valor mensual.';
  }
  ['fechaInicio', 'fechaFin', 'canonMensual'].forEach(function (name) {
    recordForm.elements[name].addEventListener('input', update);
    recordForm.elements[name].addEventListener('change', update);
  });
  recordForm.elements.viviendaId.addEventListener('change', function () {
    const property = state.data.properties.find(function (item) { return item.id === recordForm.elements.viviendaId.value; });
    const suggestedRent = Number(property && property.canon || 0);
    setCurrencyInputValue(recordForm.elements.canonMensual, suggestedRent > 0 ? suggestedRent : '');
    update();
  });
  update();
}

function populateRecordForm(type, record) {
  Object.keys(record).forEach(function (name) {
    const field = recordForm.elements[name];
    if (!field) return;
    if (field.matches('[data-currency-input]')) setCurrencyInputValue(field, record[name]);
    else if (field.type === 'date') field.value = String(record[name] || '').slice(0, 10);
    else field.value = record[name] == null ? '' : record[name];
  });
  if (type === 'contract') {
    const ledgerItem = state.data.ledger.find(function (item) { return item.contratoId === record.id; });
    const dueDate = ledgerItem && String(ledgerItem.fechaVencimiento || '').slice(0, 10);
    if (dueDate) recordForm.elements.diaVencimiento.value = Number(dueDate.slice(-2)) || 10;
  }
}

function countContractMonths(start, end) {
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

function contractMonthIndex(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : -1;
}

function monthKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  return match ? match[1] + '-' + match[2] : '';
}

function syncContractLedgerLocally(contract, input) {
  const current = state.data.ledger.filter(function (item) { return item.contratoId === contract.id; });
  const byMonth = current.reduce(function (index, item) { index[monthKey(item.fechaVencimiento)] = item; return index; }, {});
  const from = String(input.fechaInicio || '').split('-').map(Number);
  const rent = Math.max(0, Number(input.canonMensual || 0));
  const dueDay = Math.min(28, Math.max(1, Number(input.diaVencimiento || 10)));
  const names = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  const next = [];
  let year = from[0];
  let month = from[1] - 1;
  let guard = 0;
  const monthCount = countContractMonths(input.fechaInicio, input.fechaFin);
  while (next.length < monthCount && guard < 240) {
    const key = year + '-' + String(month + 1).padStart(2, '0');
    const existing = byMonth[key] || {};
    const paid = Number(existing.valorPagado || 0);
    const discount = Number(existing.descuento || 0);
    const extra = Number(existing.cargoExtra || 0);
    const balance = Math.max(0, rent - discount + extra - paid);
    next.push(Object.assign({}, existing, {
      id: existing.id || optimisticId('LEDGER'),
      contratoId: contract.id,
      periodo: names[month] + ' ' + year,
      fechaVencimiento: key + '-' + String(dueDay).padStart(2, '0'),
      valorBase: rent,
      descuento: discount,
      cargoExtra: extra,
      observacion: existing.observacion || '',
      estado: balance <= 0 ? 'PAGADO' : 'PENDIENTE',
      valorPagado: paid,
      pagoId: existing.pagoId || '',
      saldo: balance,
      estadoCalculado: balance <= 0 ? 'PAGADO' : key + '-' + String(dueDay).padStart(2, '0') < new Date().toISOString().slice(0, 10) ? 'VENCIDO' : 'PENDIENTE',
      clienteNombre: contract.clienteNombre || '',
      __pending: true
    }));
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    guard += 1;
  }
  state.data.ledger = state.data.ledger.filter(function (item) { return item.contratoId !== contract.id; }).concat(next);
  contract.saldo = next.reduce(function (sum, item) { return sum + Number(item.saldo || 0); }, 0);
  return next;
}

function validateContractEditLocally(contractId, input) {
  const start = String(input.fechaInicio || '').split('-').map(Number);
  const first = start[0] * 12 + start[1] - 1;
  const last = first + countContractMonths(input.fechaInicio, input.fechaFin) - 1;
  const rent = Number(input.canonMensual || 0);
  const conflict = state.data.ledger.find(function (item) {
    if (item.contratoId !== contractId) return false;
    const parts = monthKey(item.fechaVencimiento).split('-').map(Number);
    const month = parts[0] * 12 + parts[1] - 1;
    const paid = Number(item.valorPagado || 0);
    if ((month < first || month > last) && paid > 0) return true;
    return month >= first && month <= last && paid > Math.max(0, rent - Number(item.descuento || 0) + Number(item.cargoExtra || 0));
  });
  return conflict ? 'Ese cambio dejaría por fuera dinero que ya fue pagado. Conserva esos meses o usa un valor mensual mayor.' : '';
}

function applyOptimisticRecord(type, input, temporaryId) {
  const createdAt = new Date().toISOString();
  if (type === 'client') {
    state.data.clients.unshift({
      id: temporaryId,
      documento: String(input.documento || '').replace(/\D/g, ''),
      nombre: input.nombre,
      email: input.email || '',
      telefono: input.telefono || '',
      estado: 'ACTIVO',
      creadoEn: createdAt,
      __pending: true
    });
    state.data.stats.clientes += 1;
    incrementPageTotal('clients');
    renderStats();
    renderClients();
    return ['clients'];
  }

  if (type === 'property') {
    state.data.properties.unshift({
      id: temporaryId,
      codigo: String(input.codigo || '').toUpperCase(),
      direccion: input.direccion,
      ciudad: input.ciudad,
      barrio: input.barrio || '',
      tipo: input.tipo || 'Vivienda',
      canon: Number(input.canon || 0),
      estado: 'DISPONIBLE',
      creadoEn: createdAt,
      __pending: true
    });
    incrementPageTotal('properties');
    renderProperties();
    return ['properties'];
  }

  const client = state.data.clients.find(function (item) { return item.id === input.clienteId; }) || {};
  const home = state.data.properties.find(function (item) { return item.id === input.viviendaId; }) || {};
  const estimatedBalance = countContractMonths(input.fechaInicio, input.fechaFin) * Number(input.canonMensual || 0);
  const contract = {
    id: temporaryId,
    clienteId: input.clienteId,
    viviendaId: input.viviendaId,
    fechaInicio: input.fechaInicio,
    fechaFin: input.fechaFin,
    canonMensual: Number(input.canonMensual || 0),
    deposito: Number(input.deposito || 0),
    estado: 'ACTIVO',
    creadoEn: createdAt,
    clienteNombre: client.nombre || '',
    viviendaCodigo: home.codigo || '',
    saldo: estimatedBalance,
    __pending: true
  };
  state.data.contracts.unshift(contract);
  const ledger = syncContractLedgerLocally(contract, input);
  if (home.id) {
    home.estado = 'OCUPADA';
    if (Number(home.canon || 0) <= 0) home.canon = Number(input.canonMensual || 0);
  }
  state.data.stats.contratosActivos += 1;
  state.data.stats.cartera += estimatedBalance;
  incrementPageTotal('contracts');
  if (state.pageInfo.ledger) {
    state.pageInfo.ledger.total = Number(state.pageInfo.ledger.total || 0) + ledger.length;
    state.pageInfo.ledger.nextOffset = Number(state.pageInfo.ledger.nextOffset || 0) + ledger.length;
  }
  renderStats();
  renderContracts();
  renderProperties();
  renderManualContracts();
  return ['contracts', 'properties', 'ledger'];
}

function renameOptimisticId(type, temporaryId, savedId) {
  if (!savedId || savedId === temporaryId) return temporaryId;
  state.idAliases[temporaryId] = savedId;
  if (state.deletedKeys.has(temporaryId)) state.deletedKeys.add(savedId);
  const section = type === 'client' ? 'clients' : type === 'property' ? 'properties' : 'contracts';
  const record = state.data[section].find(function (item) { return item.id === temporaryId; });
  if (record) record.id = savedId;
  if (type === 'client') state.data.contracts.forEach(function (item) { if (item.clienteId === temporaryId) item.clienteId = savedId; });
  if (type === 'property') state.data.contracts.forEach(function (item) { if (item.viviendaId === temporaryId) item.viviendaId = savedId; });
  if (type === 'contract') {
    state.data.ledger.forEach(function (item) { if (item.contratoId === temporaryId) item.contratoId = savedId; });
    state.data.payments.forEach(function (item) { if (item.contratoId === temporaryId) item.contratoId = savedId; });
    if (state.clientAccountContractId === temporaryId) state.clientAccountContractId = savedId;
  }
  return savedId;
}

function confirmOptimisticRecord(type, temporaryId, result, revision) {
  const section = type === 'client' ? 'clients' : type === 'property' ? 'properties' : 'contracts';
  const savedId = result.contractId || result.record && result.record.id || state.idAliases[temporaryId] || temporaryId;
  renameOptimisticId(type, temporaryId, savedId);
  const record = state.data[section].find(function (item) { return item.id === savedId || item.id === temporaryId; });
  if (!record) return;
  if (Number(record.__revision || 0) !== Number(revision || 0)) return;
  const localFields = type === 'contract' ? {
    clienteNombre: record.clienteNombre,
    viviendaCodigo: record.viviendaCodigo,
    saldo: record.saldo
  } : {};
  Object.assign(record, result.record || {}, localFields);
  delete record.__pending;
  delete record.__revision;
  if (type === 'contract') {
    state.data.ledger.forEach(function (item) {
      if (item.contratoId === record.id) delete item.__pending;
    });
  }
}

function applyOptimisticEdit(type, input) {
  const section = type === 'client' ? 'clients' : type === 'property' ? 'properties' : 'contracts';
  const record = state.data[section].find(function (item) { return item.id === input.id; });
  if (!record) return [];
  if (type === 'client') {
    Object.assign(record, input, { documento: String(input.documento || '').replace(/\D/g, ''), __pending: true });
    state.data.contracts.forEach(function (contract) { if (contract.clienteId === record.id) contract.clienteNombre = record.nombre; });
    state.data.ledger.forEach(function (item) {
      const contract = state.data.contracts.find(function (row) { return row.id === item.contratoId; });
      if (contract && contract.clienteId === record.id) item.clienteNombre = record.nombre;
    });
    renderClients(); renderContracts(); renderClientAccount();
    return ['clients', 'contracts', 'ledger'];
  }
  if (type === 'property') {
    Object.assign(record, input, { codigo: String(input.codigo || '').toUpperCase(), canon: Number(input.canon || 0), __pending: true });
    state.data.contracts.forEach(function (contract) { if (contract.viviendaId === record.id) contract.viviendaCodigo = record.codigo; });
    renderProperties(); renderContracts(); renderClientAccount();
    return ['properties', 'contracts'];
  }
  const wasActive = record.estado === 'ACTIVO';
  const previousBalance = Number(record.saldo || 0);
  const previousHomeId = record.viviendaId;
  const client = state.data.clients.find(function (item) { return item.id === input.clienteId; }) || {};
  const home = state.data.properties.find(function (item) { return item.id === input.viviendaId; }) || {};
  Object.assign(record, input, {
    canonMensual: Number(input.canonMensual || 0),
    deposito: Number(input.deposito || 0),
    clienteNombre: client.nombre || '',
    viviendaCodigo: home.codigo || '',
    __pending: true
  });
  syncContractLedgerLocally(record, input);
  state.data.stats.cartera = Math.max(0, Number(state.data.stats.cartera || 0) + Number(record.saldo || 0) - previousBalance);
  if (wasActive !== (record.estado === 'ACTIVO')) state.data.stats.contratosActivos = Math.max(0, Number(state.data.stats.contratosActivos || 0) + (record.estado === 'ACTIVO' ? 1 : -1));
  const oldHome = state.data.properties.find(function (item) { return item.id === previousHomeId; });
  if (oldHome && (previousHomeId !== record.viviendaId || record.estado !== 'ACTIVO')) {
    const stillOccupied = state.data.contracts.some(function (item) { return item.id !== record.id && item.viviendaId === previousHomeId && item.estado === 'ACTIVO'; });
    oldHome.estado = stillOccupied ? 'OCUPADA' : 'DISPONIBLE';
  }
  if (home.id && record.estado === 'ACTIVO') home.estado = 'OCUPADA';
  renderStats(); renderContracts(); renderProperties(); renderManualContracts(); renderClientAccount();
  return ['contracts', 'properties', 'ledger'];
}

recordForm.addEventListener('submit', function (event) {
  event.preventDefault();
  if (!recordForm.reportValidity()) return;
  const type = recordForm.dataset.type;
  const config = recordConfigs[type];
  const editing = recordForm.dataset.mode === 'edit';
  const input = readFormValues(recordForm);
  if (editing) input.id = recordForm.dataset.id;
  if (editing && type === 'contract') {
    const conflictMessage = validateContractEditLocally(input.id, input);
    if (conflictMessage) { showToast(conflictMessage, 'error'); return; }
  }
  const temporaryId = editing ? input.id : optimisticId(type.toUpperCase());
  const changedSections = editing ? applyOptimisticEdit(type, input) : applyOptimisticRecord(type, input, temporaryId);
  const localRecord = findAdminRecord(type, temporaryId);
  const revision = markRevision(localRecord);
  const queueKey = type + ':' + temporaryId;
  recordDialog.close();
  setSyncStatus('Información al día');
  enqueueMutation(queueKey, function () {
    const payload = Object.assign({}, input);
    if (editing) payload.id = state.idAliases[input.id] || input.id;
    const dependencies = type === 'contract' ? [state.mutationQueues['client:' + input.clienteId], state.mutationQueues['property:' + input.viviendaId]].filter(Boolean) : [];
    return Promise.all(dependencies.map(function (dependency) { return dependency.catch(function () { /* backend validates the final state */ }); })).then(function () {
      if (type === 'contract') {
        payload.clienteId = state.idAliases[input.clienteId] || input.clienteId;
        payload.viviendaId = state.idAliases[input.viviendaId] || input.viviendaId;
      }
      return Backend.call(editing ? config.updateMethod : config.method, state.token, payload);
    });
  }).then(function (result) {
    confirmOptimisticRecord(type, temporaryId, result, revision);
    finishOptimisticSave(changedSections);
    showToast(editing ? 'Cambios guardados correctamente.' : type === 'contract' ? 'Contrato ' + result.contractId + ' creado.' : 'Registro creado correctamente.');
  }).catch(function (error) {
    const current = findAdminRecord(type, state.idAliases[temporaryId] || temporaryId);
    if (current && Number(current.__revision || 0) === revision) {
      delete current.__pending;
      delete current.__revision;
      if (type === 'contract') state.data.ledger.forEach(function (ledgerItem) {
        if (ledgerItem.contratoId === current.id) delete ledgerItem.__pending;
      });
    }
    reconcileAfterFailure(error);
  });
});

function openAdjust(id) {
  const item = state.data.ledger.find(function (row) { return row.id === id; });
  if (!item) return;
  adjustForm.elements.id.value = item.id;
  setCurrencyInputValue(adjustForm.elements.descuento, item.descuento || 0);
  setCurrencyInputValue(adjustForm.elements.cargoExtra, item.cargoExtra || 0);
  adjustForm.elements.observacion.value = item.observacion || '';
  document.getElementById('adjustTitle').textContent = formatRentalMonth(item.periodo, item.fechaVencimiento) + ' · ' + item.contratoId;
  adjustDialog.showModal();
}

adjustForm.addEventListener('submit', function (event) {
  event.preventDefault();
  if (!adjustForm.reportValidity()) return;
  const input = readFormValues(adjustForm);
  const item = state.data.ledger.find(function (row) { return row.id === input.id; });
  if (!item) return;
  const previousBalance = Number(item.saldo || 0);
  item.descuento = Math.max(0, Number(input.descuento || 0));
  item.cargoExtra = Math.max(0, Number(input.cargoExtra || 0));
  item.observacion = input.observacion || '';
  item.saldo = Math.max(0, Number(item.valorBase || 0) - item.descuento + item.cargoExtra - Number(item.valorPagado || 0));
  item.estadoCalculado = item.saldo <= 0 ? 'PAGADO' : String(item.fechaVencimiento) < new Date().toISOString().slice(0, 10) ? 'VENCIDO' : 'PENDIENTE';
  const revision = markRevision(item);
  const balanceDifference = item.saldo - previousBalance;
  state.data.stats.cartera = Math.max(0, Number(state.data.stats.cartera || 0) + balanceDifference);
  const contract = state.data.contracts.find(function (row) { return row.id === item.contratoId; });
  if (contract) contract.saldo = Math.max(0, Number(contract.saldo || 0) + balanceDifference);
  adjustDialog.close();
  renderStats();
  renderContracts();
  renderClientAccount();
  setSyncStatus('Información al día');
  enqueueMutation('ledger:' + input.id, function () {
    return Backend.call('adjustLedgerItem', state.token, input);
  }).then(function () {
    if (Number(item.__revision || 0) === revision) {
      delete item.__pending;
      delete item.__revision;
    }
    finishOptimisticSave(['ledger', 'contracts']);
    showToast('El valor del mes quedó actualizado.');
  }).catch(function (error) {
    if (Number(item.__revision || 0) === revision) {
      delete item.__pending;
      delete item.__revision;
    }
    reconcileAfterFailure(error);
  });
});

function renderManualContracts() {
  const select = manualForm.elements.contratoId;
  const current = select.value;
  const editingContractId = state.manualEditingPayment && state.manualEditingPayment.contratoId;
  select.innerHTML = '<option value="">Selecciona un contrato</option>' + state.data.contracts.filter(function (item) { return item.estado === 'ACTIVO' || item.id === editingContractId; }).map(function (item) {
    return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.id) + ' · ' + escapeHtml(item.clienteNombre) + '</option>';
  }).join('');
  if (state.data.contracts.some(function (item) { return item.id === current; })) select.value = current;
}

function openManualPayment(payment) {
  manualForm.reset();
  state.manualLedger = [];
  state.manualEditingPayment = payment || null;
  renderManualContracts();
  document.getElementById('manualPaymentKicker').textContent = payment ? 'Cambiar pago agregado' : 'Pago agregado por el administrador';
  document.getElementById('manualPaymentTitle').textContent = payment ? 'Editar pago recibido' : 'Agregar pago recibido';
  document.getElementById('manualPaymentSubmit').textContent = payment ? 'Guardar cambios' : 'Guardar pago';
  manualForm.elements.fecha.value = payment ? String(payment.pagadoEn || payment.creadoEn || '').slice(0, 10) : new Date().toISOString().slice(0, 10);
  manualForm.elements.contratoId.value = payment ? payment.contratoId : '';
  manualForm.elements.metodo.value = payment ? payment.metodo : 'EFECTIVO';
  manualForm.elements.nota.value = payment ? payment.nota || '' : '';
  setCurrencyInputValue(manualForm.elements.valor, payment ? payment.valor : '');
  document.getElementById('manualMonthPicker').innerHTML = '<p>Selecciona un contrato para ver los meses que faltan por pagar.</p>';
  manualDialog.showModal();
  if (payment) loadManualLedger(payment.contratoId, true);
}

manualForm.elements.contratoId.addEventListener('change', async function () {
  await loadManualLedger(this.value, false);
});

async function loadManualLedger(id, preservePaymentValue) {
  const picker = document.getElementById('manualMonthPicker');
  if (!id) { picker.innerHTML = '<p>Selecciona un contrato para ver los meses que faltan por pagar.</p>'; return; }
  const local = state.data.ledger.filter(function (item) { return item.contratoId === id; });
  if (local.length) {
    state.manualLedger = local.map(function (item) { return Object.assign({}, item); });
    renderManualLedgerOptions(id, preservePaymentValue);
  } else picker.innerHTML = '<p>Cargando meses pendientes…</p>';
  try {
    state.manualLedger = await Backend.call('getContractLedgerForAdmin', state.token, id);
    renderManualLedgerOptions(id, preservePaymentValue);
  } catch (error) {
    if (!local.length) picker.innerHTML = '<p>No fue posible cargar los meses.</p>';
    else showToast('Mostramos la información disponible mientras se reintenta la sincronización.', 'error');
  }
}

function renderManualLedgerOptions(id, preservePaymentValue) {
  const picker = document.getElementById('manualMonthPicker');
  const oldAllocations = state.manualEditingPayment && state.manualEditingPayment.contratoId === id ? parsePaymentAllocations(state.manualEditingPayment) : [];
  const oldById = oldAllocations.reduce(function (index, item) { index[item.id] = item.amount; return index; }, {});
  state.manualLedger.forEach(function (item) { item.availableForEdit = Number(item.saldo || 0) + Number(oldById[item.id] || 0); });
  const items = state.manualLedger.filter(function (item) { return item.availableForEdit > 0; });
  picker.innerHTML = items.length ? items.map(function (item) {
    return '<label class="month-option"><input type="checkbox" name="ledgerIds" value="' + escapeHtml(item.id) + '"' + (oldById[item.id] ? ' checked' : '') + '><span>' + escapeHtml(formatRentalMonth(item.periodo, item.fechaVencimiento)) + '</span><strong>' + formatMoney(item.availableForEdit) + '</strong></label>';
  }).join('') : '<p>Este contrato no tiene pagos pendientes.</p>';
  picker.querySelectorAll('input').forEach(function (input) { input.addEventListener('change', syncManualTotal); });
  if (preservePaymentValue && state.manualEditingPayment && state.manualEditingPayment.contratoId === id) setCurrencyInputValue(manualForm.elements.valor, state.manualEditingPayment.valor);
  else syncManualTotal();
}

function syncManualTotal() {
  const ids = Array.from(manualForm.querySelectorAll('[name="ledgerIds"]:checked')).map(function (input) { return input.value; });
  const total = state.manualLedger.filter(function (item) { return ids.indexOf(item.id) !== -1; }).reduce(function (sum, item) { return sum + Number(item.availableForEdit == null ? item.saldo : item.availableForEdit); }, 0) || '';
  setCurrencyInputValue(manualForm.elements.valor, total);
}

manualForm.addEventListener('submit', function (event) {
  event.preventDefault();
  const form = new FormData(manualForm);
  const input = readFormValues(manualForm);
  input.ledgerIds = form.getAll('ledgerIds');
  if (!input.ledgerIds.length) { showToast('Selecciona al menos un mes.', 'error'); return; }
  const editing = Boolean(state.manualEditingPayment);
  if (editing) input.id = state.manualEditingPayment.id;
  const snapshot = captureOptimisticState(['payments', 'ledger', 'contracts']);
  const temporaryId = editing ? input.id : optimisticId('PAYMENT');
  const previousPayment = editing ? findAdminRecord('payment', input.id) : null;
  const previousAllocations = parsePaymentAllocations(previousPayment);
  if (previousPayment) {
    const restoredBalance = previousAllocations.reduce(function (sum, item) { return sum + Number(item.amount || 0); }, 0);
    previousAllocations.forEach(function (allocation) { applyAllocationLocally(allocation, -1); });
    const previousContract = state.data.contracts.find(function (row) { return row.id === previousPayment.contratoId; });
    if (previousContract) previousContract.saldo = Number(previousContract.saldo || 0) + restoredBalance;
    state.data.stats.cartera = Number(state.data.stats.cartera || 0) + restoredBalance;
    state.data.stats.recaudado = Math.max(0, Number(state.data.stats.recaudado || 0) - Number(previousPayment.valor || 0));
  }
  let remaining = Number(input.valor || 0);
  let appliedTotal = 0;
  const allocations = [];
  input.ledgerIds.forEach(function (id) {
    const source = state.manualLedger.find(function (row) { return row.id === id; });
    const available = Number(source && (source.availableForEdit == null ? source.saldo : source.availableForEdit) || 0);
    const applied = Math.min(available, remaining);
    if (applied <= 0) return;
    appliedTotal += applied;
    remaining -= applied;
    const allocation = { id: id, amount: applied };
    allocations.push(allocation);
    applyAllocationLocally(allocation, 1);
  });
  if (remaining > 0 || appliedTotal <= 0) { restoreOptimisticState(snapshot); showToast('El valor supera lo que falta por pagar en los meses elegidos.', 'error'); return; }
  const contract = state.data.contracts.find(function (row) { return row.id === input.contratoId; }) || {};
  if (contract.id) contract.saldo = Math.max(0, Number(contract.saldo || 0) - appliedTotal);
  state.data.stats.cartera = Math.max(0, Number(state.data.stats.cartera || 0) - appliedTotal);
  state.data.stats.recaudado = Number(state.data.stats.recaudado || 0) + appliedTotal;
  const optimisticPayment = {
    id: temporaryId, contratoId: input.contratoId, clienteId: contract.clienteId || '', valor: appliedTotal,
    metodo: String(input.metodo || '').toUpperCase(), estado: 'APROBADO', referencia: previousPayment ? previousPayment.referencia : temporaryId,
    transaccionId: '', detalleJson: JSON.stringify(allocations), creadoEn: previousPayment ? previousPayment.creadoEn : new Date().toISOString(),
    pagadoEn: input.fecha, nota: input.nota || '', __pending: true
  };
  if (previousPayment) Object.assign(previousPayment, optimisticPayment);
  else {
    state.data.payments.unshift(optimisticPayment);
    incrementPageTotal('payments');
  }
  const localPayment = previousPayment || optimisticPayment;
  const paymentRevision = markRevision(localPayment);
  const touchedIds = previousAllocations.map(function (item) { return item.id; }).concat(input.ledgerIds);
  const ledgerRevisions = {};
  state.data.ledger.forEach(function (row) {
    if (touchedIds.indexOf(row.id) !== -1) ledgerRevisions[row.id] = markRevision(row);
  });
  manualDialog.close();
  renderStats();
  renderPayments();
  renderContracts();
  renderClientAccount();
  setSyncStatus('Información al día');
  const queueKey = 'payment:' + temporaryId;
  state.manualEditingPayment = null;
  enqueueMutation(queueKey, function () {
    const payload = Object.assign({}, input, {
      contratoId: state.idAliases[input.contratoId] || input.contratoId,
      id: editing ? state.idAliases[input.id] || input.id : input.id
    });
    const dependency = state.mutationQueues['contract:' + input.contratoId];
    return Promise.resolve(dependency).catch(function () { /* backend will validate */ }).then(function () {
      payload.contratoId = state.idAliases[input.contratoId] || input.contratoId;
      return Backend.call(editing ? 'updateManualPayment' : 'registerManualPayment', state.token, payload);
    });
  }).then(function (result) {
    const savedId = result.record && result.record.id || temporaryId;
    if (savedId !== temporaryId) {
      state.idAliases[temporaryId] = savedId;
      const temporaryPayment = state.data.payments.find(function (row) { return row.id === temporaryId; });
      if (temporaryPayment) temporaryPayment.id = savedId;
    }
    const payment = state.data.payments.find(function (row) { return row.id === savedId; });
    if (payment && Number(payment.__revision || 0) === paymentRevision) {
      Object.assign(payment, result.record || {});
      delete payment.__pending;
      delete payment.__revision;
    }
    state.data.ledger.forEach(function (row) {
      if (Number(row.__revision || 0) === Number(ledgerRevisions[row.id] || -1)) {
        delete row.__pending;
        delete row.__revision;
      }
    });
    finishOptimisticSave(['payments', 'ledger', 'contracts']);
    showToast(editing ? 'Pago actualizado. Los cobros ya reflejan el cambio.' : 'Pago guardado. Los cobros pendientes ya se actualizaron.');
  }).catch(function (error) {
    const payment = state.data.payments.find(function (row) { return row.id === (state.idAliases[temporaryId] || temporaryId); });
    if (payment && Number(payment.__revision || 0) === paymentRevision) {
      delete payment.__pending;
      delete payment.__revision;
    }
    state.data.ledger.forEach(function (row) {
      if (Number(row.__revision || 0) === Number(ledgerRevisions[row.id] || -1)) {
        delete row.__pending;
        delete row.__revision;
      }
    });
    reconcileAfterFailure(error);
  });
});

document.querySelectorAll('[data-table-search]').forEach(function (input) {
  input.addEventListener('input', debounce(function () {
    applyTableFilters(input.dataset.tableSearch);
  }, 70));
});
document.querySelectorAll('[data-table-filter]').forEach(function (select) {
  select.addEventListener('change', function () { applyTableFilters(select.dataset.tableFilter); });
});

if (state.token) enterAdmin().catch(function () { /* handled above */ });
