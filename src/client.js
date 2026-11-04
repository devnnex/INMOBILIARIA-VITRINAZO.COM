import { Backend, formatMoney, formatDate, escapeHtml, showToast, setBusy, setPageLoader } from './common.js';
import { openTransferPayment, updateTransferResume, getTransferToRestore } from './transfer.js';

  'use strict';
  const elements = {
    form: document.getElementById('lookupForm'), input: document.getElementById('lookupInput'), clear: document.getElementById('clearLookup'),
    account: document.getElementById('consultar'), greeting: document.getElementById('accountGreeting'), updated: document.getElementById('accountUpdated'),
    tabs: document.getElementById('contractTabs'), property: document.getElementById('propertyCard'), ledger: document.getElementById('ledgerList'),
    filters: document.getElementById('ledgerFilters'), selectAll: document.getElementById('selectAllMonths'), selectedCount: document.getElementById('selectedCount'),
    total: document.getElementById('selectedTotal'), paymentBar: document.getElementById('paymentBar'), openPayment: document.getElementById('openPayment'),
    newLookup: document.getElementById('newLookup'), demoHint: document.getElementById('demoHint')
  };
  const state = { query: '', contracts: [], activeId: '', selected: new Set(), filter: 'all', version: 0, poller: null };
  const ACCOUNT_CACHE_KEY = 'vitrinazo-last-account-v2-' + (Backend.isLive ? 'live' : 'demo');

  function normalizeAccountQuery(value) { return String(value || '').trim().toUpperCase().replace(/[\s.]/g, ''); }
  function getCachedAccount(query) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(ACCOUNT_CACHE_KEY) || 'null');
      const fresh = cached && Date.now() - Number(cached.savedAt || 0) < 5 * 60 * 1000;
      return fresh && cached.query === normalizeAccountQuery(query) && cached.result && Array.isArray(cached.result.contracts) ? cached.result : null;
    } catch (error) { return null; }
  }
  function cacheAccount(query, result) {
    try { sessionStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify({ query: normalizeAccountQuery(query), savedAt: Date.now(), result: result })); } catch (error) { /* cache unavailable */ }
  }
  function showAccountResult(query, result, shouldScroll) {
    state.query = query;
    state.contracts = result.contracts;
    state.version = result.version || state.version || 0;
    if (!state.contracts.some(function (item) { return item.id === state.activeId; })) state.activeId = state.contracts[0].id;
    state.selected.clear();
    renderAccount();
    elements.account.hidden = false;
    if (shouldScroll) elements.account.scrollIntoView({ behavior: 'smooth', block: 'start' });
    cacheAccount(query, { found: true, version: state.version, contracts: state.contracts });
    startVersionPolling();
  }

  if (!Backend.isLive) elements.demoHint.hidden = false;

  elements.input.addEventListener('input', function () { elements.clear.hidden = !elements.input.value; });
  elements.clear.addEventListener('click', function () { elements.input.value = ''; elements.clear.hidden = true; elements.input.focus(); });
  document.querySelectorAll('[data-demo-query]').forEach(function (button) {
    button.addEventListener('click', function () { elements.input.value = button.dataset.demoQuery; elements.form.requestSubmit(); });
  });

  elements.form.addEventListener('submit', async function (event) {
    event.preventDefault();
    const query = elements.input.value.trim();
    if (query.length < 4) { showToast('Escribe una cédula o contrato válido.', 'error'); elements.input.focus(); return; }
    const submit = elements.form.querySelector('[type="submit"]');
    const cached = getCachedAccount(query);
    let loaderVisible = false;
    let loaderTimer = null;
    if (cached) showAccountResult(query, cached, true);
    else {
      setBusy(submit, true, 'Consultando');
      loaderTimer = setTimeout(function () {
        loaderVisible = true;
        setPageLoader(true, {
          title: 'Consultando tu cuenta',
          messages: ['Buscando tus contratos…', 'Organizando los meses y pagos…', 'Preparando un resumen claro para ti…']
        });
      }, 220);
    }
    try {
      const result = cached ? await Backend.call('syncAccount', query, cached.version) : await Backend.call('lookupAccount', query);
      if (cached && !result.changed) return;
      if (!result.found) {
        sessionStorage.removeItem(ACCOUNT_CACHE_KEY);
        elements.account.hidden = true;
        showToast('No encontramos contratos asociados a ese dato.', 'error');
        return;
      }
      showAccountResult(query, result, !cached);
    } catch (error) { showToast(error.message || 'No fue posible consultar en este momento.', 'error'); }
    finally {
      clearTimeout(loaderTimer);
      setBusy(submit, false);
      if (loaderVisible) setPageLoader(false);
    }
  });

  function renderAccount() {
    const contract = getActiveContract();
    if (!contract) return;
    elements.greeting.textContent = 'Hola, ' + String(contract.cliente.nombre || '').split(' ')[0];
    elements.updated.textContent = 'Información actualizada ahora · ' + contract.cliente.documento;
    elements.tabs.innerHTML = state.contracts.map(function (item) {
      return '<button class="contract-tab ' + (item.id === state.activeId ? 'is-active' : '') + '" type="button" role="tab" aria-selected="' + (item.id === state.activeId) + '" data-contract="' + escapeHtml(item.id) + '"><span>' + escapeHtml(item.vivienda.codigo) + '</span><small>' + escapeHtml(item.id) + '</small></button>';
    }).join('');
    elements.tabs.querySelectorAll('[data-contract]').forEach(function (button) {
      button.addEventListener('click', function () { state.activeId = button.dataset.contract; state.selected.clear(); renderAccount(); });
    });
    renderProperty(contract);
    renderLedger(contract);
    updateSelection();
    updateTransferResume(contract.id);
  }

  function renderProperty(contract) {
    const home = contract.vivienda;
    elements.property.innerHTML = '<div class="property-card__visual"><div><span>' + escapeHtml(home.tipo || 'Vivienda') + ' · ' + escapeHtml(home.barrio) + '</span><h3>' + escapeHtml(home.codigo) + '</h3></div></div>' +
      '<div class="property-card__body"><p>' + escapeHtml(home.direccion) + '<br>' + escapeHtml(home.ciudad) + '</p><div class="property-meta"><div><span>Contrato</span><strong>' + escapeHtml(contract.id) + '</strong></div><div><span>El contrato empieza el</span><strong>' + formatDate(contract.fechaInicio) + '</strong></div><div><span>Arriendo mensual</span><strong>' + formatMoney(contract.canonMensual) + '</strong></div><div><span>Estado</span><strong>' + escapeHtml(contract.estado) + '</strong></div></div><div class="balance-card"><span>Total que falta por pagar</span><strong>' + formatMoney(contract.resumen.saldo) + '</strong></div></div>';
  }

  function renderLedger(contract) {
    const items = contract.cartera.filter(function (item) {
      if (state.filter === 'pending') return item.saldo > 0;
      if (state.filter === 'paid') return item.saldo <= 0;
      return true;
    });
    if (!items.length) {
      elements.ledger.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM8 3v4m8-4v4M4 10h16"/></svg><p>No hay meses en este filtro.</p></div>';
      return;
    }
    elements.ledger.innerHTML = items.map(function (item) {
      const selected = state.selected.has(item.id), paid = item.saldo <= 0;
      const adjustments = [];
      if (Number(item.descuento) > 0) adjustments.push('−' + formatMoney(item.descuento) + ' descuento');
      if (Number(item.cargoExtra) > 0) adjustments.push('+' + formatMoney(item.cargoExtra) + ' cobro adicional');
      const original = Number(item.valorBase) + Number(item.cargoExtra || 0);
      return '<article class="ledger-item ' + (selected ? 'is-selected ' : '') + (paid ? 'is-paid' : '') + '" data-ledger-id="' + escapeHtml(item.id) + '">' +
        '<label class="check-label" aria-label="Seleccionar ' + escapeHtml(formatSelectedMonth(item.periodo)) + '"><input type="checkbox" ' + (selected ? 'checked ' : '') + (paid ? 'disabled ' : '') + 'data-ledger-check="' + escapeHtml(item.id) + '"><span></span></label>' +
        '<div class="ledger-item__period"><strong>' + escapeHtml(formatSelectedMonth(item.periodo)) + '</strong><span>Vence ' + formatDate(item.fechaVencimiento) + '</span></div>' +
        '<div class="ledger-item__note"><span>' + (adjustments.length ? escapeHtml(adjustments.join(' · ')) : 'Sin cambios en el valor') + '</span><p title="' + escapeHtml(item.observacion || '') + '">' + escapeHtml(item.observacion || 'Valor mensual del arriendo') + '</p></div>' +
        '<div class="ledger-item__amount">' + (Number(item.descuento) > 0 ? '<del>' + formatMoney(original) + '</del>' : '<span>Falta por pagar</span>') + '<strong>' + formatMoney(item.saldo) + '</strong></div>' +
        '<span class="badge ' + badgeClass(item.estadoCalculado) + '">' + escapeHtml(item.estadoCalculado) + '</span></article>';
    }).join('');
    elements.ledger.querySelectorAll('[data-ledger-check]').forEach(function (checkbox) {
      checkbox.addEventListener('change', function () { toggleItem(checkbox.dataset.ledgerCheck, checkbox.checked); });
    });
    elements.ledger.querySelectorAll('.ledger-item').forEach(function (item) {
      item.addEventListener('click', function (event) {
        if (event.target.closest('input, label')) return;
        const checkbox = item.querySelector('input');
        if (!checkbox || checkbox.disabled) return;
        checkbox.checked = !checkbox.checked; toggleItem(checkbox.dataset.ledgerCheck, checkbox.checked);
      });
    });
  }

  function badgeClass(status) {
    return status === 'PAGADO' ? 'badge--paid' : status === 'VENCIDO' ? 'badge--overdue' : 'badge--pending';
  }
  function toggleItem(id, selected) {
    if (selected) state.selected.add(id); else state.selected.delete(id);
    const item = elements.ledger.querySelector('[data-ledger-id="' + CSS.escape(id) + '"]');
    if (item) item.classList.toggle('is-selected', selected);
    updateSelection();
  }
  function updateSelection() {
    const contract = getActiveContract();
    const selectedItems = contract ? contract.cartera.filter(function (item) { return state.selected.has(item.id) && item.saldo > 0; }) : [];
    const total = selectedItems.reduce(function (sum, item) { return sum + Number(item.saldo); }, 0);
    elements.selectedCount.textContent = selectedItems.length + (selectedItems.length === 1 ? ' seleccionado' : ' seleccionados');
    elements.total.textContent = formatMoney(total);
    elements.openPayment.disabled = !selectedItems.length;
    elements.paymentBar.classList.toggle('is-visible', selectedItems.length > 0);
    const pending = contract ? contract.cartera.filter(function (item) { return item.saldo > 0; }) : [];
    elements.selectAll.checked = pending.length > 0 && pending.every(function (item) { return state.selected.has(item.id); });
    elements.selectAll.indeterminate = selectedItems.length > 0 && !elements.selectAll.checked;
  }
  function getActiveContract() { return state.contracts.find(function (item) { return item.id === state.activeId; }); }

  elements.filters.addEventListener('click', function (event) {
    const button = event.target.closest('[data-filter]'); if (!button) return;
    state.filter = button.dataset.filter;
    elements.filters.querySelectorAll('[data-filter]').forEach(function (item) { item.classList.toggle('is-active', item === button); });
    renderLedger(getActiveContract());
  });
  elements.selectAll.addEventListener('change', function () {
    const contract = getActiveContract(); if (!contract) return;
    contract.cartera.filter(function (item) { return item.saldo > 0; }).forEach(function (item) { if (elements.selectAll.checked) state.selected.add(item.id); else state.selected.delete(item.id); });
    renderLedger(contract); updateSelection();
  });
  elements.newLookup.addEventListener('click', function () { state.selected.clear(); updateSelection(); document.getElementById('inicio').scrollIntoView({ behavior: 'smooth' }); setTimeout(function () { elements.input.focus(); elements.input.select(); }, 500); });

  function formatSelectedMonth(value) {
    const text = String(value || '').trim();
    const names = { ENE: 'Enero', FEB: 'Febrero', MAR: 'Marzo', ABR: 'Abril', MAY: 'Mayo', JUN: 'Junio', JUL: 'Julio', AGO: 'Agosto', SEP: 'Septiembre', OCT: 'Octubre', NOV: 'Noviembre', DIC: 'Diciembre' };
    const match = text.toUpperCase().match(/^(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\s+(\d{4})$/);
    if (match) return names[match[1]] + ' ' + match[2];
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      const label = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric', timeZone: 'America/Bogota' }).format(date);
      return label.charAt(0).toUpperCase() + label.slice(1).replace(' de ', ' ');
    }
    return text || 'Mes seleccionado';
  }

  elements.openPayment.addEventListener('click', async function () {
    const contract = getActiveContract();
    if (!contract || !state.selected.size) return;
    const months = contract.cartera.filter(item => state.selected.has(item.id)).map(item => ({
      id: item.id, period: item.periodo, amountInCents: Math.round(item.saldo * 100)
    }));
    try { await openTransferPayment(contract.id, months.map(month => month.id), refreshAfterTransfer, false, months); }
    catch (error) { showToast(error.message, 'error'); }
  });

  async function refreshAfterTransfer() {
    state.selected.clear();
    if (!state.query) return;
    // La confirmación requiere una consulta fresca, sin reutilizar la caché previa al pago.
    const result = await Backend.call('lookupAccount', state.query);
    if (result.found) showAccountResult(state.query, result, false);
  }
  document.getElementById('resumeTransfer').addEventListener('click', async function () {
    try { await openTransferPayment(state.activeId, [], refreshAfterTransfer, true); }
    catch (error) { showToast(error.message, 'error'); }
  });

  function startVersionPolling() {
    clearTimeout(state.poller);
    scheduleAccountSync(1500);
  }

  function scheduleAccountSync(delay) {
    clearTimeout(state.poller);
    if (!state.query) return;
    state.poller = setTimeout(async function () {
      try {
        const result = await Backend.call('syncAccount', state.query, state.version);
        if (result.changed && result.found) {
          const activeStillExists = result.contracts.some(function (item) { return item.id === state.activeId; });
          state.contracts = result.contracts;
          state.version = result.version;
          if (!activeStillExists) state.activeId = result.contracts[0].id;
          const validIds = new Set(getActiveContract().cartera.filter(function (item) { return item.saldo > 0; }).map(function (item) { return item.id; }));
          state.selected.forEach(function (id) { if (!validIds.has(id)) state.selected.delete(id); });
          renderAccount();
          cacheAccount(state.query, { found: true, version: state.version, contracts: state.contracts });
          showToast('Tu estado de cuenta se actualizó.');
        } else if (result.version) {
          state.version = result.version;
        }
      } catch (error) { /* el siguiente ciclo reintenta sin interrumpir */ }
      const hasPending = state.contracts.some(function (contract) {
        return contract.cartera.some(function (item) { return item.estadoCalculado === 'PENDIENTE' && item.pagoId; });
      });
      scheduleAccountSync(document.hidden ? 90000 : hasPending ? 5000 : 20000);
    }, delay);
  }

  document.addEventListener('visibilitychange', function () {
    if (state.query) scheduleAccountSync(document.hidden ? 90000 : 150);
  });
  window.addEventListener('focus', function () { if (state.query) scheduleAccountSync(100); });

  async function restoreTransferSession() {
    const saved = getTransferToRestore();
    if (!saved) return;
    state.query = saved.contractId;
    state.activeId = saved.contractId;
    elements.input.value = saved.contractId;
    // Recuperar el comprobante no depende de que la consulta de cartera termine.
    const account = Backend.call('lookupAccount', saved.contractId).then(function (result) {
      if (result.found) showAccountResult(saved.contractId, result, false);
    }).catch(function () { /* la solicitud sigue accesible por su capacidad */ });
    await openTransferPayment(saved.contractId, [], refreshAfterTransfer, true);
    await account;
  }
  restoreTransferSession().catch(error => showToast(error.message, 'error'));

  if (!Backend.isLive) {
    document.getElementById('resetDemo').addEventListener('click', function () {
      localStorage.removeItem('vitrinazo-demo-v2');
      localStorage.removeItem('vitrinazo-transfer-orders-v2-demo');
      sessionStorage.removeItem('vitrinazo-active-transfer-demo');
      sessionStorage.removeItem(ACCOUNT_CACHE_KEY);
      window.location.reload();
    });
  }
