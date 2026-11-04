import { Backend, escapeHtml, formatMoney, setBusy, showToast } from './common.js';

const namespace = !Backend.isLive ? 'demo' : Backend.isTransferSimulation ? 'simulation' : 'live';
const storageKey = 'vitrinazo-transfer-orders-v2-' + namespace;
const activeKey = 'vitrinazo-active-transfer-' + namespace;
const terminalStates = ['APROBADO', 'RECHAZADO', 'EN_REVISION'];
let activeDialog = null;

function savedTransfers() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || (namespace === 'live' && localStorage.getItem('vitrinazo-transfer-orders-v1')) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) { return {}; }
}

function savedTransfer(contractId) {
  const saved = savedTransfers();
  const order = Object.prototype.hasOwnProperty.call(saved, contractId) ? saved[contractId] : null;
  return order && order.contractId === contractId && typeof order.reference === 'string' &&
    typeof order.accessToken === 'string' ? order : null;
}

function rememberTransfer(order, requestId) {
  const saved = savedTransfers();
  saved[order.contractId] = { contractId: order.contractId, reference: order.reference, accessToken: order.accessToken, requestId };
  try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch (error) {
    showToast('Mantén esta ventana abierta: el navegador no permite guardar tu solicitud.', 'error');
  }
  try { sessionStorage.setItem(activeKey, order.contractId); } catch (error) { /* almacenamiento opcional */ }
}

export function getTransferToRestore() {
  try { return savedTransfer(sessionStorage.getItem(activeKey)); } catch (error) { return null; }
}

export function updateTransferResume(contractId) {
  const button = document.getElementById('resumeTransfer');
  if (button) button.hidden = !savedTransfer(contractId);
}

export async function openTransferPayment(contractId, ledgerIds, onSuccess, resume = false, selection = []) {
  if (activeDialog) return;
  const saved = savedTransfer(contractId);
  resume = resume || Boolean(saved);
  if (resume && !saved) throw new Error('No hay una transferencia guardada para este contrato.');
  const dialog = document.createElement('dialog');
  activeDialog = dialog;
  dialog.className = 'modal payment-modal transfer-modal';
  dialog.setAttribute('aria-labelledby', 'transferTitle');
  dialog.innerHTML = '<div class="modal__surface">' +
    '<button class="modal__close" type="button" data-transfer-close aria-label="Cerrar">×</button>' +
    '<p class="kicker">Transferencia bancaria</p><h2 id="transferTitle">Elige la cuenta de destino</h2>' +
    '<ol class="transfer-steps" aria-label="Pasos del pago"><li>1. Transfiere</li><li>2. Sube el comprobante</li><li>3. Confirmación</li></ol>' +
    (Backend.isTransferSimulation ? '<p class="transfer-demo-notice">SIMULACIÓN DE PAGO · Cuentas ficticias. No realices transferencias reales. Los resultados de prueba se guardan solo en este navegador.</p>' : '') +
    '<div class="transfer-feedback" role="status" aria-live="polite">Consultando la información…</div>' +
    '<div class="transfer-progress" role="status" hidden><span class="button-spinner" aria-hidden="true">◌</span> Esperando la confirmación de Forttu…</div>' +
    '<div class="transfer-selection"></div>' +
    '<form class="transfer-account-form" hidden><label>¿A qué cuenta deseas transferir?<select name="accountId" required></select></label>' +
    '<button class="button button--primary button--full" type="submit">Confirmar cuenta y ver datos para pagar</button></form>' +
    '<div class="transfer-details"></div>' +
    '<form class="transfer-receipt-form" hidden><label>Adjunta el pantallazo o comprobante de tu pago' +
    '<input type="file" name="receipt" accept="application/pdf,image/jpeg,image/png" required></label>' +
    '<p class="field-hint">PDF, JPG o PNG. Máximo 4 MB. Selecciona el archivo y pulsa Enviar comprobante.</p>' +
    '<button class="button button--primary button--full" type="submit">Enviar comprobante</button></form>' +
    (Backend.isTransferSimulation ? '<div class="transfer-simulation" hidden><strong>Simular respuesta de Forttu</strong><p>Elige el resultado después de subir un archivo de prueba.</p>' +
      '<div><button class="button button--soft" type="button" data-simulate="APPROVED">Aprobar monto exacto</button>' +
      '<button class="button button--soft" type="button" data-simulate="WRONG_AMOUNT">Monto incorrecto</button>' +
      '<button class="button button--soft" type="button" data-simulate="REJECTED">Rechazar comprobante</button></div></div>' : '') +
    '<div class="payment-modal__actions"><button class="button button--ghost" type="button" data-transfer-close>Cerrar</button>' +
    '<button class="button button--soft" type="button" data-transfer-check hidden>Consultar verificación</button>' +
    '<button class="button button--primary" type="button" data-transfer-finish hidden>Volver a mi estado de cuenta</button></div></div>';
  document.body.appendChild(dialog);
  dialog.showModal();
  const feedback = dialog.querySelector('.transfer-feedback');
  const details = dialog.querySelector('.transfer-details');
  const summary = dialog.querySelector('.transfer-selection');
  const progress = dialog.querySelector('.transfer-progress');
  const accountForm = dialog.querySelector('.transfer-account-form');
  const receiptForm = dialog.querySelector('.transfer-receipt-form');
  const checkButton = dialog.querySelector('[data-transfer-check]');
  const finishButton = dialog.querySelector('[data-transfer-finish]');
  const simulation = dialog.querySelector('.transfer-simulation');
  let order = null, accessToken = saved && saved.accessToken, poller = null;
  let creating = false, uploading = false, checking = false, notifiedSuccess = false;
  const selectionKey = 'vitrinazo-transfer-request-' + namespace + ':' + JSON.stringify([contractId, ledgerIds.slice().sort()]);
  let requestId;
  try { requestId = sessionStorage.getItem(selectionKey); } catch (error) { /* almacenamiento opcional */ }
  requestId = requestId || crypto.randomUUID();

  function fail(error) {
    if (dialog.open) {
      feedback.textContent = error.message === 'Acción no permitida.'
        ? 'El pago por transferencia todavía no está disponible en este sitio.'
        : error.message || 'No fue posible consultar tu transferencia. Reintentaremos automáticamente.';
      feedback.classList.add('is-error');
    }
  }
  function renderSummary(months, amountInCents, reference) {
    summary.innerHTML = '<div class="payment-summary"><span>Total exacto a transferir</span><strong>' + escapeHtml(formatMoney(amountInCents / 100)) +
      '</strong><p>' + months.map(month => escapeHtml(month.period)).join(' · ') + '</p>' +
      (reference ? '<small>Referencia: ' + escapeHtml(reference) + '</small>' : '') + '</div>';
  }
  function render(result) {
    const changedStatus = !order || order.status !== result.status;
    order = result;
    const waiting = result.status === 'ESPERANDO_COMPROBANTE';
    const approved = result.status === 'APROBADO' && result.success === true;
    const pending = !waiting && !terminalStates.includes(result.status);
    receiptForm.hidden = !waiting;
    accountForm.hidden = true;
    checkButton.hidden = !pending;
    finishButton.hidden = !terminalStates.includes(result.status);
    progress.hidden = !pending;
    dialog.setAttribute('aria-busy', String(pending));
    dialog.classList.toggle('transfer-modal--success', approved);
    if (simulation) simulation.hidden = result.status !== 'PENDIENTE_VERIFICACION';
    renderSummary(result.months, result.amountInCents, result.reference);
    const account = result.account;
    details.innerHTML = '<details class="transfer-bank-collapsible"' + (waiting ? ' open' : '') + '><summary>Datos bancarios de esta solicitud</summary><dl class="transfer-bank-details">' +
      [['Banco', account.bankName], ['Titular', account.holderName], ['Documento', account.holderDocument],
        ['Tipo de cuenta', account.accountType], ['Número de cuenta', account.accountNumber], ['Valor a transferir', String(result.amountInCents / 100)]]
      .map(pair => '<div><dt>' + pair[0] + '</dt><dd><span>' + escapeHtml(pair[1]) + '</span>' +
        '<button class="transfer-copy" type="button" data-copy="' + escapeHtml(pair[1]) + '" aria-label="Copiar ' + pair[0].toLowerCase() + '">Copiar</button></dd></div>').join('') + '</dl></details>';
    const messages = {
      ESPERANDO_COMPROBANTE: 'Copia los datos y realiza el pago por el valor exacto desde tu banco. Luego vuelve a esta misma pantalla y adjunta el pantallazo. Puedes cambiar de aplicación: tu solicitud queda guardada. Si ya transferiste, no vuelvas a pagar.',
      PENDIENTE_VERIFICACION: 'Comprobante recibido. Forttu está verificando el pago. Permanece en esta sección: mostraremos la confirmación automáticamente. Los meses se actualizarán cuando se confirme el monto exacto. No vuelvas a transferir.',
      VERIFICADO: 'Forttu confirmó la transferencia. Estamos actualizando los meses que seleccionaste.',
      APLICANDO: 'Estamos actualizando tus meses. La confirmación aparecerá aquí al terminar.',
      EN_REVISION: 'No se pudo aplicar el pago automáticamente porque el monto u otros datos no coinciden con tu solicitud. Tus meses no se confirman como pagados. Conserva esta referencia y comunícate con la inmobiliaria. No repitas la transferencia.',
      RECHAZADO: 'Forttu no pudo verificar el pago con este comprobante. Los meses no se marcaron como pagados. Conserva tu referencia y comunícate con la inmobiliaria antes de volver a pagar.',
      APROBADO: 'Forttu confirmó el monto exacto y los meses seleccionados ya quedaron pagados. Tu estado de cuenta se ha actualizado.'
    };
    feedback.classList.remove('is-error');
    feedback.textContent = messages[result.status] || 'Tu transferencia está en revisión.';
    dialog.querySelector('h2').textContent = approved ? 'Pago realizado exitosamente' : waiting ? 'Realiza el pago y vuelve aquí' : 'Verificación de tu pago';
    if (changedStatus) dialog.querySelector('.modal__surface').scrollTop = 0;
    if (approved && !notifiedSuccess) {
      notifiedSuccess = true;
      forget();
      Promise.resolve(onSuccess()).catch(() => showToast('Pago confirmado. Vuelve a consultar tu estado de cuenta para actualizarlo.', 'error'));
    } else if (terminalStates.includes(result.status)) {
      try { sessionStorage.removeItem(activeKey); } catch (error) { /* almacenamiento opcional */ }
      if (result.status === 'RECHAZADO') forget();
    }
    updateTransferResume(contractId);
  }
  function forget() {
    const orders = savedTransfers();
    delete orders[contractId];
    const originalSelectionKey = order ? 'vitrinazo-transfer-request-' + namespace + ':' + JSON.stringify([contractId, order.months.map(month => month.id).sort()]) : selectionKey;
    try { localStorage.setItem(storageKey, JSON.stringify(orders)); sessionStorage.removeItem(activeKey); sessionStorage.removeItem(selectionKey); sessionStorage.removeItem(originalSelectionKey); } catch (error) { /* almacenamiento opcional */ }
  }
  function setSimulationBusy(busy) {
    if (simulation) simulation.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  }
  async function check() {
    clearTimeout(poller);
    if (!dialog.open || !order || checking || uploading) return;
    checking = true;
    setSimulationBusy(true);
    try {
      const result = await Backend.call('refreshTransferOrder', order.reference, accessToken);
      if (dialog.open) render(result);
    } catch (error) { fail(error); }
    finally {
      checking = false;
      setSimulationBusy(false);
      if (dialog.open && order && !terminalStates.includes(order.status) && order.status !== 'ESPERANDO_COMPROBANTE') poller = setTimeout(check, document.hidden ? 30000 : 10000);
    }
  }
  function resumeCheck() { if (!document.hidden) check(); }
  document.addEventListener('visibilitychange', resumeCheck);
  window.addEventListener('focus', resumeCheck);
  window.addEventListener('pageshow', resumeCheck);
  dialog.querySelectorAll('[data-transfer-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  finishButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', function () {
    clearTimeout(poller);
    document.removeEventListener('visibilitychange', resumeCheck);
    window.removeEventListener('focus', resumeCheck);
    window.removeEventListener('pageshow', resumeCheck);
    try { sessionStorage.removeItem(activeKey); } catch (error) { /* almacenamiento opcional */ }
    activeDialog = null; dialog.remove();
  });
  details.addEventListener('click', async function (event) {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copiado';
      setTimeout(() => { button.textContent = 'Copiar'; }, 1800);
    } catch (error) { showToast('Selecciona el dato y cópialo desde el menú de tu dispositivo.', 'error'); }
  });
  checkButton.addEventListener('click', async function () {
    if (checking) return;
    setBusy(checkButton, true, 'Consultando');
    try { await check(); } finally { setBusy(checkButton, false); }
  });
  accountForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (creating) return;
    const button = accountForm.querySelector('button');
    creating = true;
    setBusy(button, true, 'Guardando tu solicitud');
    try {
      try { sessionStorage.setItem(selectionKey, requestId); } catch (error) { /* el reintento conserva la clave */ }
      const result = await Backend.call('createTransferOrder', contractId, ledgerIds, accountForm.elements.accountId.value, requestId);
      accessToken = result.accessToken;
      rememberTransfer(result, requestId);
      updateTransferResume(contractId);
      if (dialog.open) { render(result); if (result.status !== 'ESPERANDO_COMPROBANTE') await check(); }
    } catch (error) { fail(error); }
    finally { creating = false; setBusy(button, false); }
  });
  receiptForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (uploading || !order) return;
    const button = receiptForm.querySelector('button');
    let submitted = false;
    uploading = true;
    setBusy(button, true, 'Enviando comprobante');
    feedback.textContent = 'Enviando tu comprobante. Espera en esta sección…';
    try {
      const file = receiptForm.elements.receipt.files[0];
      if (!file || !file.size || file.size > 4 * 1024 * 1024 || !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) throw new Error('Selecciona un PDF, JPG o PNG de máximo 4 MB.');
      const base64 = await new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('No fue posible leer el comprobante.'));
        reader.readAsDataURL(file);
      });
      const result = await Backend.call('submitTransferReceipt', order.reference, accessToken, { mimeType: file.type, base64 });
      submitted = true;
      if (dialog.open) { receiptForm.reset(); render(result); }
    } catch (error) { fail(error); }
    finally { uploading = false; setBusy(button, false); }
    if (submitted) await check();
  });
  if (simulation) simulation.addEventListener('click', async function (event) {
    const button = event.target.closest('[data-simulate]');
    if (!button || checking) return;
    checking = true;
    setSimulationBusy(true);
    try { render(await Backend.call('simulateTransferVerification', order.reference, accessToken, button.dataset.simulate)); }
    catch (error) { fail(error); }
    finally { checking = false; setSimulationBusy(false); }
  });
  try {
    if (resume) {
      const result = await Backend.call('getTransferOrder', saved.reference, saved.accessToken);
      if (!dialog.open) return;
      rememberTransfer({ ...result, accessToken }, saved.requestId);
      render(result);
      await check();
    } else {
      const available = await Backend.call('getTransferAvailability');
      if (!available.available) throw new Error('El pago por transferencia todavía no está habilitado. Intenta más tarde o comunícate con la inmobiliaria.');
      const accounts = await Backend.call('getTransferBankAccounts', contractId);
      if (!dialog.open) return;
      accountForm.elements.accountId.innerHTML = accounts.map(account => '<option value="' + escapeHtml(account.id) + '">' + escapeHtml(account.bankName + ' · ' + account.accountType + ' · ' + account.accountNumber) + '</option>').join('');
      if (selection.length) renderSummary(selection, selection.reduce((sum, month) => sum + month.amountInCents, 0));
      feedback.textContent = 'Elige la cuenta donde deseas pagar. Al confirmar, guardaremos tu solicitud y mostraremos los datos para copiar, hacer la transferencia y volver a subir el comprobante.';
      accountForm.hidden = false;
    }
  } catch (error) { fail(error); }
}
