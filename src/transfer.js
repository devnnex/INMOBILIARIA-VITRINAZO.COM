import { Backend, escapeHtml, formatMoney, formatRentalMonth, setBusy, showToast } from './common.js';

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
    '<div class="transfer-confetti" aria-hidden="true"></div><div class="transfer-main">' +
    '<div class="transfer-heading"><span class="transfer-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m3 10 9-6 9 6M4 10h16M6 10v8m6-8v8m6-8v8M3 21h18"/></svg></span>' +
    '<p class="kicker">Tu próximo paso</p>' + (Backend.isTransferSimulation ? '<span class="transfer-test-tag">Modo prueba</span>' : '') + '</div>' +
    '<h2 id="transferTitle">Elige tu cuenta</h2>' +
    '<ol class="transfer-steps" aria-label="Pasos del pago"><li data-step="1" class="is-current"><span>01</span> Cuenta</li><li data-step="2"><span>02</span> Comprobante</li><li data-step="3"><span>03</span> Confirmación</li></ol>' +
    '<div class="transfer-selection"></div>' +
    '<div class="transfer-feedback" role="status" aria-live="polite">Preparando tu pago…</div>' +
    '<div class="transfer-progress" role="status" hidden><span class="transfer-loader" aria-hidden="true"></span><strong>Verificando tu pago<span>La confirmación aparecerá aquí.</span></strong></div>' +
    '<form class="transfer-account-form" hidden><label>Cuenta de destino<select name="accountId" required></select></label>' +
    '<button class="button button--primary button--full" type="submit">Continuar <span aria-hidden="true">→</span></button></form>' +
    '<div class="transfer-details"></div>' +
    '<form class="transfer-receipt-form" hidden><label class="transfer-dropzone"><input type="file" name="receipt" accept="application/pdf,image/jpeg,image/png" aria-label="Seleccionar comprobante" required>' +
    '<span class="transfer-upload-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 16V4m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg></span>' +
    '<strong data-receipt-label>Arrastra tu comprobante aquí</strong><span>o <b>selecciona un archivo</b></span><small>JPG, PNG o PDF · Hasta 4 MB</small></label>' +
    '<button class="button button--soft button--full" type="submit" hidden>Reintentar envío</button></form>' +
    '<div class="payment-modal__actions"><button class="button button--ghost" type="button" data-transfer-close>Volver después</button>' +
    '<button class="button button--soft" type="button" data-transfer-check hidden>Consultar estado</button>' +
    '<button class="button button--primary" type="button" data-transfer-finish hidden>Ver mi cuenta</button></div></div>' +
    '<section class="transfer-success" hidden aria-labelledby="transferSuccessTitle">' +
    '<div class="transfer-success__seal" aria-hidden="true"><span></span><svg viewBox="0 0 32 32"><path d="m9 16 5 5 10-11"/></svg></div>' +
    '<p class="kicker">Pago confirmado</p><h2 id="transferSuccessTitle">¡Pago exitoso!</h2><p class="transfer-success__intro">Tus meses seleccionados ya están pagados.</p>' +
    '<div class="transfer-success__receipt"><span>Total pagado</span><strong data-success-amount></strong><div class="transfer-success__months"></div>' +
    '<div class="transfer-success__meta"><span data-success-contract></span><span data-success-reference></span></div></div>' +
    '<button class="button button--primary button--full" type="button" data-transfer-finish>Volver a mi cuenta <span aria-hidden="true">→</span></button>' +
    (Backend.isTransferSimulation ? '<span class="transfer-success__test">Modo prueba</span>' : '') + '</section></div>';
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
  const main = dialog.querySelector('.transfer-main');
  const success = dialog.querySelector('.transfer-success');
  let confettiTimer = null;
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
      feedback.hidden = false;
    }
  }
  function renderSummary(months, amountInCents, reference) {
    summary.innerHTML = '<div class="payment-summary"><span>Total del pago</span><strong>' + escapeHtml(formatMoney(amountInCents / 100)) +
      '</strong><div class="payment-summary__months">' + months.map(month => '<span class="payment-month-chip">' + escapeHtml(formatRentalMonth(month.period)) + '</span>').join('') + '</div>' +
      (reference ? '<small title="' + escapeHtml(reference) + '">Referencia · ' + escapeHtml(reference) + '</small>' : '') + '</div>';
  }
  function render(result) {
    const changedStatus = !order || order.status !== result.status;
    order = result;
    const waiting = result.status === 'ESPERANDO_COMPROBANTE';
    const approved = result.status === 'APROBADO' && result.success === true;
    const pending = !waiting && !terminalStates.includes(result.status);
    receiptForm.hidden = !waiting;
    accountForm.hidden = true;
    checkButton.hidden = !pending || Backend.isTransferSimulation;
    finishButton.hidden = !terminalStates.includes(result.status);
    progress.hidden = !pending;
    dialog.setAttribute('aria-busy', String(pending));
    dialog.classList.toggle('transfer-modal--success', approved);
    main.hidden = approved;
    success.hidden = !approved;
    dialog.setAttribute('aria-labelledby', approved ? 'transferSuccessTitle' : 'transferTitle');
    feedback.hidden = pending;
    const step = waiting ? 2 : 3;
    dialog.querySelectorAll('[data-step]').forEach(item => {
      item.classList.toggle('is-current', Number(item.dataset.step) === step);
      item.classList.toggle('is-complete', Number(item.dataset.step) < step);
    });
    renderSummary(result.months, result.amountInCents, result.reference);
    const account = result.account;
    details.hidden = !waiting;
    const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/></svg>';
    details.innerHTML = '<dl class="transfer-bank-details">' +
      [['Banco', account.bankName], ['Titular', account.holderName], ['Documento', account.holderDocument],
        ['Tipo de cuenta', account.accountType], ['Número de cuenta', account.accountNumber], ['Valor a transferir', String(result.amountInCents / 100)]]
      .map(pair => '<div><dt>' + pair[0] + '</dt><dd><span>' + escapeHtml(pair[1]) + '</span>' +
        '<button class="transfer-copy" type="button" data-copy="' + escapeHtml(pair[1]) + '" aria-label="Copiar ' + pair[0].toLowerCase() + '">' + copyIcon + '</button></dd></div>').join('') + '</dl>';
    const messages = {
      ESPERANDO_COMPROBANTE: 'Transfiere el valor exacto y vuelve aquí con tu comprobante.',
      PENDIENTE_VERIFICACION: 'Verificando tu pago…',
      VERIFICADO: 'Actualizando tus meses…',
      APLICANDO: 'Actualizando tus meses…',
      EN_REVISION: 'Los datos no coinciden. Conserva tu referencia y contacta a la inmobiliaria antes de volver a pagar.',
      RECHAZADO: 'No pudimos verificar el comprobante. Contacta a la inmobiliaria antes de volver a pagar.',
      APROBADO: 'Los meses seleccionados ya están pagados.'
    };
    feedback.classList.remove('is-error');
    feedback.textContent = messages[result.status] || 'Tu transferencia está en revisión.';
    dialog.querySelector('#transferTitle').textContent = waiting ? 'Transfiere y adjunta' : pending ? 'Ya casi está' : 'Revisemos tu pago';
    if (approved) {
      success.querySelector('[data-success-amount]').textContent = formatMoney(result.amountInCents / 100);
      success.querySelector('.transfer-success__months').innerHTML = result.months.map(month => '<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>' + escapeHtml(formatRentalMonth(month.period)) + '</span>').join('');
      success.querySelector('[data-success-contract]').textContent = result.contractId;
      const reference = success.querySelector('[data-success-reference]');
      reference.textContent = 'Ref. ' + result.reference.slice(-8).toUpperCase();
      reference.title = result.reference;
    }
    if (changedStatus) dialog.querySelector('.modal__surface').scrollTop = 0;
    if (approved && !notifiedSuccess) {
      notifiedSuccess = true;
      forget();
      celebrate();
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
  function celebrate() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const container = dialog.querySelector('.transfer-confetti');
    const colors = ['#31b9ed', '#bda574', '#238c76', '#a1d9e8', '#e7c78c'];
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 52; index += 1) {
      const piece = document.createElement('i');
      piece.style.cssText = 'left:' + Math.random() * 100 + '%;background:' + colors[index % colors.length] + ';' +
        '--drift:' + (Math.random() * 240 - 120) + 'px;--fall:' + (dialog.clientHeight + 100) + 'px;' +
        '--spin:' + (Math.random() * 1000 - 500) + 'deg;--delay:' + Math.random() * 400 + 'ms;';
      fragment.appendChild(piece);
    }
    container.appendChild(fragment);
    confettiTimer = setTimeout(() => container.replaceChildren(), 4200);
  }
  async function check() {
    clearTimeout(poller);
    if (!dialog.open || !order || checking || uploading) return;
    checking = true;
    try {
      const result = await Backend.call('refreshTransferOrder', order.reference, accessToken);
      if (dialog.open) render(result);
    } catch (error) { fail(error); }
    finally {
      checking = false;
      if (dialog.open && order && !terminalStates.includes(order.status) && order.status !== 'ESPERANDO_COMPROBANTE') poller = setTimeout(check, document.hidden ? 30000 : Backend.isTransferSimulation ? 500 : 10000);
    }
  }
  function resumeCheck() { if (!document.hidden) check(); }
  document.addEventListener('visibilitychange', resumeCheck);
  window.addEventListener('focus', resumeCheck);
  window.addEventListener('pageshow', resumeCheck);
  dialog.querySelectorAll('[data-transfer-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.querySelectorAll('[data-transfer-finish]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', function () {
    clearTimeout(poller);
    clearTimeout(confettiTimer);
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
      const original = button.innerHTML;
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
      setTimeout(() => { button.innerHTML = original; }, 1800);
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
    const fileInput = receiptForm.elements.receipt;
    let submitted = false;
    uploading = true;
    fileInput.disabled = true;
    button.hidden = true;
    setBusy(button, true, 'Enviando comprobante');
    feedback.textContent = 'Enviando tu comprobante…';
    feedback.classList.remove('is-error');
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
    } catch (error) { fail(error); button.hidden = false; }
    finally { uploading = false; fileInput.disabled = false; setBusy(button, false); }
    if (submitted) await check();
  });
  const fileInput = receiptForm.elements.receipt;
  const dropzone = dialog.querySelector('.transfer-dropzone');
  fileInput.addEventListener('change', function () {
    if (!fileInput.files.length || uploading) return;
    dialog.querySelector('[data-receipt-label]').textContent = fileInput.files[0].name;
    receiptForm.requestSubmit();
  });
  ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, function (event) {
    event.preventDefault();
    if (!uploading) dropzone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, function (event) {
    event.preventDefault(); dropzone.classList.remove('is-dragging');
  }));
  dropzone.addEventListener('drop', function (event) {
    if (uploading || !event.dataTransfer.files.length) return;
    fileInput.files = event.dataTransfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
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
      feedback.textContent = 'Selecciona dónde quieres realizar la transferencia.';
      accountForm.hidden = false;
    }
  } catch (error) { fail(error); }
}
