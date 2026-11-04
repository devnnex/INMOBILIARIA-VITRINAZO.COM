'use strict';

  // Única configuración del backend. Pega aquí la URL /exec de Apps Script.
  const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwpwKc0HtTEUjuecdh37vQZoCvbgN3UCArbI_tP4UJFrVMALr5sgzpApHjA9ut7zi3P7w/exec';
  const DEMO_MODE = !APPS_SCRIPT_URL;
  // Mantener en true hasta conectar y probar el adaptador oficial de Forttu.
  const TRANSFER_SIMULATION_ENABLED = true;
  const moneyFormatter = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  const dateFormatter = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });

  function formatMoney(value) { return moneyFormatter.format(Number(value || 0)).replace(/\u00a0/g, ' '); }
  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(String(value).length === 10 ? value + 'T12:00:00' : value);
    return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
  }
  function formatRentalMonth(period, dueDate) {
    const names = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const short = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
    for (const value of [period, dueDate]) {
      const text = String(value || '').trim();
      const iso = text.match(/^(\d{4})-(\d{2})(?:\D|$)/);
      if (iso && Number(iso[2]) >= 1 && Number(iso[2]) <= 12) return names[Number(iso[2]) - 1] + ' de ' + iso[1];
      const words = text.replace(/\./g, '').toUpperCase().match(/^([A-ZÁÉÍÓÚ]+)\s+(?:DE\s+)?(\d{4})$/);
      if (words) {
        const month = short.findIndex((name, index) => name === words[1] || names[index].toUpperCase() === words[1]);
        if (month !== -1) return names[month] + ' de ' + words[2];
      }
    }
    return String(period || 'Mes del arriendo');
  }
  function formatPaymentMethod(value) {
    return ({ TRANSFERENCIA_SIMULADA: 'Transferencia · prueba', TRANSFERENCIA_FORTTU: 'Transferencia bancaria', TRANSFERENCIA: 'Transferencia', EFECTIVO: 'Efectivo', CONSIGNACION: 'Consignación' })[value] || String(value || '').replace('_WOMPI', '');
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[character];
    });
  }
  function initials(name) { return String(name || 'VI').split(/\s+/).slice(0, 2).map(function (part) { return part[0] || ''; }).join('').toUpperCase(); }
  function debounce(callback, delay) {
    let timer;
    return function () { const args = arguments; clearTimeout(timer); timer = setTimeout(function () { callback.apply(null, args); }, delay || 180); };
  }
  function showToast(message, type) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const host = document.querySelector('dialog[open] .modal__surface') || document.body;
    if (host && toast.parentElement !== host) host.appendChild(toast);
    toast.textContent = message;
    toast.className = 'toast is-visible' + (type === 'error' ? ' is-error' : '');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { toast.className = 'toast'; }, 3800);
  }
  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="button-spinner">◌</span> ' + (label || 'Procesando');
    } else {
      button.disabled = false;
      if (button.dataset.originalLabel) button.innerHTML = button.dataset.originalLabel;
    }
  }

  let loaderMessageTimer = null;
  function ensurePageLoader() {
    let loader = document.getElementById('experienceLoader');
    if (loader) return loader;
    loader = document.createElement('div');
    loader.id = 'experienceLoader';
    loader.className = 'experience-loader';
    loader.hidden = true;
    loader.setAttribute('role', 'status');
    loader.setAttribute('aria-live', 'polite');
    // El símbolo está integrado: nunca muestra una imagen rota ni espera la red.
    loader.innerHTML = '<div class="experience-loader__card"><div class="experience-loader__scene" aria-hidden="true"><span class="experience-loader__orbit experience-loader__orbit--one"></span><span class="experience-loader__orbit experience-loader__orbit--two"></span>' +
      '<svg class="experience-loader__brand" viewBox="0 0 256 256" width="52" height="52" focusable="false">' +
      '<path fill="#2db7f4" d="M16 62h51l61 116v56l-48-51Z"/>' +
      '<path fill="#071c2c" d="m128 178 61-116h51l-64 122-48 50Z"/>' +
      '<path fill="#36bdf7" d="m73 66 55-36v27L85 83Z"/>' +
      '<path fill="#12364e" d="m128 30 55 36-11 17-44-26Z"/>' +
      '<path fill="#29b5f2" d="m96 91 27-18v82Z"/>' +
      '<path fill="#0d293d" d="m133 73 31 18-31 64Z"/>' +
      '</svg><i></i></div><p class="kicker">Vitrinazo</p><strong data-loader-title>Preparando tu información</strong><p data-loader-message>Organizando los datos más recientes…</p><div class="experience-loader__progress" aria-hidden="true"><span></span><span></span><span></span></div></div>';
    document.body.appendChild(loader);
    return loader;
  }

  function setPageLoader(busy, options) {
    const loader = ensurePageLoader();
    clearInterval(loaderMessageTimer);
    loaderMessageTimer = null;
    if (!busy) {
      loader.classList.remove('is-visible');
      loader.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('page-is-loading');
      setTimeout(function () { if (!loader.classList.contains('is-visible')) loader.hidden = true; }, 220);
      return;
    }
    const settings = options || {};
    const messages = Array.isArray(settings.messages) && settings.messages.length ? settings.messages : [
      'Organizando los datos más recientes…',
      'Verificando que todo esté al día…',
      'Ya casi terminamos…'
    ];
    const title = loader.querySelector('[data-loader-title]');
    const message = loader.querySelector('[data-loader-message]');
    title.textContent = settings.title || 'Preparando tu información';
    message.textContent = messages[0];
    loader.hidden = false;
    loader.setAttribute('aria-hidden', 'false');
    document.body.classList.add('page-is-loading');
    loader.classList.add('is-visible');
    let index = 0;
    loaderMessageTimer = setInterval(function () {
      index = (index + 1) % messages.length;
      message.classList.remove('is-changing');
      void message.offsetWidth;
      message.textContent = messages[index];
      message.classList.add('is-changing');
    }, 1450);
  }

  function createDemoDatabase() {
    const saved = localStorage.getItem('vitrinazo-demo-v2');
    if (saved) {
      try { return JSON.parse(saved); } catch (error) { /* reset below */ }
    }
    const clients = [
      { id: 'CLI-DEMO-001', documento: '1020304050', nombre: 'Mariana Torres', email: 'mariana@ejemplo.com', telefono: '300 555 0142', estado: 'ACTIVO', creadoEn: '2026-01-02' },
      { id: 'CLI-DEMO-002', documento: '79246813', nombre: 'Andrés Rojas', email: 'andres@ejemplo.com', telefono: '311 208 4401', estado: 'ACTIVO', creadoEn: '2026-02-14' }
    ];
    const properties = [
      { id: 'VIV-DEMO-001', codigo: 'VTZ-042', direccion: 'Carrera 18 # 92–41, Apto 804', ciudad: 'Bogotá D.C.', barrio: 'Chicó', tipo: 'Apartamento', canon: 2450000, estado: 'OCUPADA', creadoEn: '2026-01-02' },
      { id: 'VIV-DEMO-002', codigo: 'VTZ-105', direccion: 'Calle 106 # 19–20, Casa 7', ciudad: 'Bogotá D.C.', barrio: 'Santa Bárbara', tipo: 'Casa', canon: 3800000, estado: 'OCUPADA', creadoEn: '2026-02-14' }
    ];
    const contracts = [
      { id: 'CV-2026-0042', clienteId: 'CLI-DEMO-001', viviendaId: 'VIV-DEMO-001', fechaInicio: '2026-01-01', fechaFin: '2026-12-31', canonMensual: 2450000, estado: 'ACTIVO', deposito: 2450000, creadoEn: '2026-01-02' },
      { id: 'CV-2026-0105', clienteId: 'CLI-DEMO-002', viviendaId: 'VIV-DEMO-002', fechaInicio: '2026-02-01', fechaFin: '2027-01-31', canonMensual: 3800000, estado: 'ACTIVO', deposito: 3800000, creadoEn: '2026-02-14' }
    ];
    const specs = [
      ['ENE 2026','2026-01-10',2450000,0,0,'Pago recibido','PAGADO',2450000],
      ['FEB 2026','2026-02-10',2450000,0,0,'Pago recibido','PAGADO',2450000],
      ['MAR 2026','2026-03-10',2450000,120000,0,'Descuento por pronto pago','PENDIENTE',0],
      ['ABR 2026','2026-04-10',2450000,0,85000,'Reparación de vidrio reportada','PENDIENTE',0],
      ['MAY 2026','2026-05-10',2450000,0,0,'','PENDIENTE',0],
      ['JUN 2026','2026-06-10',2450000,0,0,'','PENDIENTE',0],
      ['JUL 2026','2026-07-10',2450000,0,0,'','PENDIENTE',0],
      ['AGO 2026','2026-08-10',2450000,0,0,'','PENDIENTE',0],
      ['SEP 2026','2026-09-10',2450000,0,0,'','PENDIENTE',0],
      ['OCT 2026','2026-10-10',2450000,0,0,'','PENDIENTE',0],
      ['NOV 2026','2026-11-10',2450000,0,0,'','PENDIENTE',0],
      ['DIC 2026','2026-12-10',2450000,0,0,'','PENDIENTE',0]
    ];
    const ledger = specs.map(function (item, index) {
      return { id: 'CAR-DEMO-' + String(index + 1).padStart(3,'0'), contratoId: 'CV-2026-0042', periodo: item[0], fechaVencimiento: item[1], valorBase: item[2], descuento: item[3], cargoExtra: item[4], observacion: item[5], estado: item[6], valorPagado: item[7], pagoId: index < 2 ? 'PAG-DEMO-' + (index + 1) : '', actualizadoEn: '2026-09-29' };
    });
    ['FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC','ENE'].forEach(function (month, index) {
      const year = index === 11 ? 2027 : 2026;
      ledger.push({ id: 'CAR-B-' + String(index + 1).padStart(3,'0'), contratoId: 'CV-2026-0105', periodo: month + ' ' + year, fechaVencimiento: year + '-' + String(index === 11 ? 1 : index + 2).padStart(2,'0') + '-10', valorBase: 3800000, descuento: 0, cargoExtra: index === 2 ? 150000 : 0, observacion: index === 2 ? 'Mantenimiento de jardín' : '', estado: index < 7 ? 'PAGADO' : 'PENDIENTE', valorPagado: index < 7 ? 3800000 + (index === 2 ? 150000 : 0) : 0, pagoId: '', actualizadoEn: '2026-09-29' });
    });
    const payments = [
      { id: 'PAG-DEMO-002', contratoId: 'CV-2026-0042', clienteId: 'CLI-DEMO-001', valor: 2450000, metodo: 'TRANSFERENCIA_FORTTU', estado: 'APROBADO', referencia: 'TRF-DEMO-002', transaccionId: 'TX-DEMO-002', detalleJson: '[]', creadoEn: '2026-02-08', pagadoEn: '2026-02-08', nota: 'Pago de demostración' },
      { id: 'PAG-DEMO-001', contratoId: 'CV-2026-0042', clienteId: 'CLI-DEMO-001', valor: 2450000, metodo: 'EFECTIVO', estado: 'APROBADO', referencia: 'MAN-DEMO-001', transaccionId: '', detalleJson: '[]', creadoEn: '2026-01-09', pagadoEn: '2026-01-09', nota: 'Recibido en oficina' }
    ];
    return { version: 1, clients: clients, properties: properties, contracts: contracts, ledger: ledger, payments: payments };
  }

  let demoDb = createDemoDatabase();
  demoDb.transfers = demoDb.transfers || [];
  function persistDemo() { localStorage.setItem('vitrinazo-demo-v2', JSON.stringify(demoDb)); }
  function enrich(item) {
    const balance = Math.max(0, Number(item.valorBase) - Number(item.descuento || 0) + Number(item.cargoExtra || 0) - Number(item.valorPagado || 0));
    const computed = balance <= 0 ? 'PAGADO' : (item.fechaVencimiento < new Date().toISOString().slice(0,10) ? 'VENCIDO' : 'PENDIENTE');
    return Object.assign({}, item, { saldo: balance, estadoCalculado: computed });
  }
  function publicContract(contract) {
    const client = demoDb.clients.find(function (item) { return item.id === contract.clienteId; }) || {};
    const property = demoDb.properties.find(function (item) { return item.id === contract.viviendaId; }) || {};
    const ledger = demoDb.ledger.filter(function (item) { return item.contratoId === contract.id; }).map(enrich);
    return {
      id: contract.id, estado: contract.estado, fechaInicio: contract.fechaInicio, fechaFin: contract.fechaFin,
      canonMensual: contract.canonMensual,
      cliente: { nombre: client.nombre, documento: '••••••' + String(client.documento).slice(-4), email: client.email },
      vivienda: { id: property.id, codigo: property.codigo, direccion: property.direccion, ciudad: property.ciudad, barrio: property.barrio, tipo: property.tipo },
      cartera: ledger,
      resumen: { saldo: ledger.reduce(function (sum,item) { return sum + item.saldo; },0), vencidos: ledger.filter(function (item) { return item.estadoCalculado === 'VENCIDO'; }).length, pendientes: ledger.filter(function (item) { return item.saldo > 0; }).length }
    };
  }
  function adminSnapshot() {
    const ledger = demoDb.ledger.map(enrich);
    const contracts = demoDb.contracts.map(function (contract) {
      const client = demoDb.clients.find(function (item) { return item.id === contract.clienteId; }) || {};
      const property = demoDb.properties.find(function (item) { return item.id === contract.viviendaId; }) || {};
      return Object.assign({}, contract, { clienteNombre: client.nombre || '', viviendaCodigo: property.codigo || '', saldo: ledger.filter(function (item) { return item.contratoId === contract.id; }).reduce(function (sum,item) { return sum + item.saldo; },0) });
    });
    const versions = { clients: demoDb.version, properties: demoDb.version, contracts: demoDb.version, ledger: demoDb.version, payments: demoDb.version };
    const pageInfo = {};
    ['clients','properties','contracts','ledger','payments'].forEach(function (section) {
      const items = section === 'contracts' ? contracts : section === 'ledger' ? ledger : demoDb[section];
      pageInfo[section] = { total: items.length, offset: 0, nextOffset: items.length, hasMore: false, limit: 1000 };
    });
    return {
      version: demoDb.version,
      versions: versions,
      pageInfo: pageInfo,
      stats: { clientes: demoDb.clients.length, contratosActivos: demoDb.contracts.filter(function (item) { return item.estado === 'ACTIVO'; }).length, cartera: ledger.reduce(function (sum,item) { return sum + item.saldo; },0), recaudado: demoDb.payments.filter(function (item) { return item.estado === 'APROBADO'; }).reduce(function (sum,item) { return sum + Number(item.valor); },0) },
      clients: demoDb.clients.slice().reverse(), properties: demoDb.properties.slice().reverse(), contracts: contracts.slice().reverse(), ledger: ledger.slice().reverse(), payments: demoDb.payments.slice().reverse()
    };
  }

  function demoPage(section, offset, limit) {
    const snapshot = adminSnapshot();
    const items = snapshot[section] || [];
    const start = Number(offset || 0), size = Number(limit || 1000);
    return { items: items.slice(start, start + size), total: items.length, offset: start, limit: size, nextOffset: Math.min(items.length, start + size), hasMore: start + size < items.length };
  }

  function demoAllocations(payment) {
    try { const value=JSON.parse(payment && payment.detalleJson || '[]'); return Array.isArray(value)?value:[]; } catch(error) { return []; }
  }

  function demoReplaceAllocations(previous, next) {
    const before={}; const after={};
    previous.forEach(function(item){before[item.id]=Number(before[item.id]||0)+Number(item.amount||0);});
    next.forEach(function(item){after[item.id]=Number(after[item.id]||0)+Number(item.amount||0);});
    Object.keys(Object.assign({},before,after)).forEach(function(id){
      const item=demoDb.ledger.find(function(row){return row.id===id;}); if(!item)return;
      const total=Math.max(0,Number(item.valorBase||0)-Number(item.descuento||0)+Number(item.cargoExtra||0));
      item.valorPagado=Math.min(total,Math.max(0,Number(item.valorPagado||0)-Number(before[id]||0)+Number(after[id]||0)));
      item.estado=item.valorPagado>=total?'PAGADO':'PENDIENTE'; item.actualizadoEn=new Date().toISOString();
    });
  }

  function createTransferSimulation(database, persist) {
    return {
    getTransferAvailability: function () { return { available: true, demo: true }; },
    getTransferBankAccounts: function (contractId) {
      if (!database.contracts.some(item => item.id === contractId && item.estado === 'ACTIVO')) throw new Error('Contrato no disponible.');
      // Datos deliberadamente ficticios: no permiten realizar una transferencia.
      return [
        { id: 'DEMO-A', bankName: 'Banco A', holderName: 'Vitrinazo Inmobiliaria', holderDocument: 'NIT de prueba', accountType: 'Ahorros', accountNumber: 'CUENTA-DEMO-001' },
        { id: 'DEMO-B', bankName: 'Banco B', holderName: 'Vitrinazo Inmobiliaria', holderDocument: 'NIT de prueba', accountType: 'Corriente', accountNumber: 'CUENTA-DEMO-002' }
      ];
    },
    createTransferOrder: function (contractId, ledgerIds, accountId, requestId) {
      const previous = database.transfers.find(order => order.requestId === requestId);
      if (previous) {
        if (previous.contractId !== contractId || previous.account.id !== accountId || JSON.stringify(previous.months.map(m => m.id).sort()) !== JSON.stringify(ledgerIds.slice().sort())) throw new Error('La solicitud ya corresponde a otra selección.');
        return structuredClone(previous);
      }
      const account = this.getTransferBankAccounts(contractId).find(account => account.id === accountId);
      const rows = database.ledger.filter(row => row.contratoId === contractId && ledgerIds.includes(row.id));
      if (!account || !rows.length || rows.length !== ledgerIds.length || new Set(ledgerIds).size !== ledgerIds.length || rows.some(row => enrich(row).saldo <= 0)) throw new Error('Selecciona meses pendientes y una cuenta válida.');
      if (database.transfers.some(order => order.contractId === contractId && order.status !== 'RECHAZADO' && order.months.some(month => ledgerIds.includes(month.id)))) throw new Error('Hay una solicitud para estos meses. Revisa tu transferencia.');
      const months = rows.map(row => ({ id: row.id, period: row.periodo, amountInCents: Math.round(enrich(row).saldo * 100), beforePaidCents: Math.round(Number(row.valorPagado || 0) * 100) }));
      const order = { reference: 'TRF-DEMO-' + crypto.randomUUID(), accessToken: crypto.randomUUID(), requestId,
        contractId, customer: structuredClone(database.contracts.find(item => item.id === contractId)?.customer || {}), account, months, amountInCents: months.reduce((sum, month) => sum + month.amountInCents, 0),
        currency: 'COP', status: 'ESPERANDO_COMPROBANTE', receiptUploaded: false, success: false, demo: true };
      database.transfers.push(order); persist();
      return structuredClone(order);
    },
    getTransferOrder: function (reference, accessToken) {
      const order = database.transfers.find(order => order.reference === reference && order.accessToken === accessToken);
      if (!order) throw new Error('No fue posible acceder a esta solicitud.');
      const result = structuredClone(order);
      if (result.status === 'APROBADO' && !activeSimulationOrders(database).some(item => item.reference === result.reference)) { result.status = 'EN_REVISION'; result.success = false; }
      return result;
    },
    refreshTransferOrder: function (reference, accessToken) {
      const order = this.getTransferOrder(reference, accessToken);
      if (order.status === 'PENDIENTE_VERIFICACION' && Date.now() >= Number(order.verificationReadyAt || 0)) {
        return this.simulateTransferVerification(reference, accessToken, 'APPROVED');
      }
      return order;
    },
    submitTransferReceipt: function (reference, accessToken, receipt) {
      const order = this.getTransferOrder(reference, accessToken);
      if (order.receiptUploaded) return order;
      const bytes = atob(receipt.base64 || '');
      const signature = Array.from(bytes.slice(0, 8), value => value.charCodeAt(0)).join(',');
      if (!bytes.length || bytes.length > 4 * 1024 * 1024 || !(receipt.mimeType === 'application/pdf' && bytes.startsWith('%PDF-') || receipt.mimeType === 'image/jpeg' && signature.startsWith('255,216,255') || receipt.mimeType === 'image/png' && signature === '137,80,78,71,13,10,26,10')) throw new Error('Sube un PDF, JPG o PNG válido de máximo 4 MB.');
      Object.assign(database.transfers.find(item => item.reference === reference), {
        receiptUploaded: true, status: 'PENDIENTE_VERIFICACION', verificationReadyAt: Date.now() + 2200
      });
      persist();
      return this.getTransferOrder(reference, accessToken);
    },
    simulateTransferVerification: function (reference, accessToken, outcome) {
      const current = this.getTransferOrder(reference, accessToken);
      if (current.status !== 'PENDIENTE_VERIFICACION') return current;
      const order = database.transfers.find(item => item.reference === reference);
      if (!['APPROVED', 'WRONG_AMOUNT', 'REJECTED', 'PENDING'].includes(outcome)) throw new Error('Resultado de prueba inválido.');
      if (outcome === 'APPROVED' && !validSimulationAllocation(order)) order.status = 'EN_REVISION';
      else if (outcome === 'APPROVED') {
        const rows = order.months.map(month => database.ledger.find(row => row.id === month.id && row.contratoId === order.contractId));
        if (rows.some((row, index) => !row || Math.round(enrich(row).saldo * 100) !== order.months[index].amountInCents)) order.status = 'EN_REVISION';
        else {
          rows.forEach((row, index) => { row.valorPagado = Number(row.valorPagado || 0) + order.months[index].amountInCents / 100; row.estado = 'PAGADO'; row.pagoId = 'PAG-' + reference; });
          database.payments.push({ id: 'PAG-' + reference, contratoId: order.contractId, clienteId: order.customer?.id || '', clienteNombre: order.customer?.name || '', valor: order.amountInCents / 100,
            metodo: 'TRANSFERENCIA_FORTTU', estado: 'APROBADO', referencia: reference, transaccionId: 'TX-' + reference,
            detalleJson: JSON.stringify(order.months.map(month => ({ id: month.id, amount: month.amountInCents / 100 }))),
            creadoEn: new Date().toISOString(), pagadoEn: new Date().toISOString(), nota: 'Simulación local, sin pago real' });
          order.status = 'APROBADO'; order.success = true; database.version++;
        }
      } else if (outcome === 'WRONG_AMOUNT') order.status = 'EN_REVISION';
      else if (outcome === 'REJECTED') order.status = 'RECHAZADO';
      persist();
      return this.getTransferOrder(reference, accessToken);
    }
    };
  }

  const MockApi = {
    ...createTransferSimulation(demoDb, persistDemo),
    lookupAccount: function (query) {
      const value = String(query || '').trim().toUpperCase().replace(/[\s.]/g,'');
      const clientIds = demoDb.clients.filter(function (client) { return String(client.documento) === value; }).map(function (client) { return client.id; });
      const contracts = demoDb.contracts.filter(function (contract) { return contract.id.toUpperCase() === value || clientIds.indexOf(contract.clienteId) !== -1; });
      return { found: contracts.length > 0, version: demoDb.version, contracts: contracts.map(publicContract) };
    },
    getContractDetails: function (contractId) { return { version: demoDb.version, contract: publicContract(demoDb.contracts.find(function (item) { return item.id === contractId; })) }; },
    getDataVersion: function () { return demoDb.version; },
    syncAccount: function (query, version) { if (Number(version) === Number(demoDb.version)) return { changed: false, version: demoDb.version }; const result=this.lookupAccount(query); result.changed=true; return result; },
    getPaymentStatus: function (reference) { const payment=demoDb.payments.find(function(item){return item.referencia===reference;}); return payment?{found:true,status:payment.estado,amount:payment.valor,contractId:payment.contratoId,reference:payment.referencia,paidAt:payment.pagadoEn}:{found:false}; },
    adminLogin: function (pin) { return pin === '1234' ? { ok: true, token: 'demo-token', expiresIn: 21600 } : { ok: false, message: 'PIN incorrecto.' }; },
    getAdminDashboard: function () { return adminSnapshot(); },
    getAdminPage: function (token, section, offset, limit) { const snapshot=adminSnapshot(); return { version: demoDb.version, versions: snapshot.versions, section: section, page: demoPage(section, offset, limit) }; },
    getAdminSync: function (token, versions) { const snapshot=adminSnapshot(); const changed=Object.keys(snapshot.versions).filter(function(section){return Number((versions||{})[section])!==Number(demoDb.version);}); if(!changed.length)return {changed:false,version:demoDb.version,versions:snapshot.versions,sections:{}}; const sections={}; changed.forEach(function(section){sections[section]=demoPage(section,0,1000);}); return {changed:true,version:demoDb.version,versions:snapshot.versions,changedSections:changed,stats:snapshot.stats,sections:sections}; },
    getContractLedgerForAdmin: function (token, contractId) { return demoDb.ledger.filter(function(item){return item.contratoId===contractId;}).map(enrich); },
    saveClient: function (token, input) {
      if (demoDb.clients.some(function (item) { return item.documento === String(input.documento); })) throw new Error('Ya existe un cliente con ese documento.');
      demoDb.clients.push({ id: 'CLI-' + Date.now(), documento: String(input.documento), nombre: input.nombre, email: input.email || '', telefono: input.telefono || '', estado: 'ACTIVO', creadoEn: new Date().toISOString() }); demoDb.version++; persistDemo(); return { ok: true };
    },
    updateClient: function (token,input) { const item=demoDb.clients.find(function(row){return row.id===input.id;}); if(!item)throw new Error('No encontramos este cliente.'); Object.assign(item,{documento:String(input.documento),nombre:input.nombre,email:input.email||'',telefono:input.telefono||'',estado:input.estado||item.estado}); demoDb.version++;persistDemo();return {ok:true,record:Object.assign({},item)}; },
    deleteClient: function (token,id) { if(demoDb.contracts.some(function(row){return row.clienteId===id;}))throw new Error('Este cliente tiene contratos. Elimina primero esos contratos.'); demoDb.clients=demoDb.clients.filter(function(row){return row.id!==id;});demoDb.version++;persistDemo();return {ok:true,id:id}; },
    saveProperty: function (token, input) {
      demoDb.properties.push({ id: 'VIV-' + Date.now(), codigo: String(input.codigo).toUpperCase(), direccion: input.direccion, ciudad: input.ciudad, barrio: input.barrio || '', tipo: input.tipo || 'Apartamento', canon: Number(input.canon || 0), estado: 'DISPONIBLE', creadoEn: new Date().toISOString() }); demoDb.version++; persistDemo(); return { ok: true };
    },
    updateProperty: function (token,input) { const item=demoDb.properties.find(function(row){return row.id===input.id;});if(!item)throw new Error('No encontramos esta vivienda.');const linked=demoDb.contracts.some(function(row){return row.viviendaId===item.id&&row.estado==='ACTIVO';});Object.assign(item,{codigo:String(input.codigo).toUpperCase(),direccion:input.direccion,ciudad:input.ciudad,barrio:input.barrio||'',tipo:input.tipo||'Vivienda',canon:Number(input.canon||0),estado:linked?'OCUPADA':input.estado||item.estado});demoDb.version++;persistDemo();return {ok:true,record:Object.assign({},item)}; },
    deleteProperty: function (token,id) { if(demoDb.contracts.some(function(row){return row.viviendaId===id;}))throw new Error('Esta vivienda tiene contratos. Elimina primero esos contratos.');demoDb.properties=demoDb.properties.filter(function(row){return row.id!==id;});demoDb.version++;persistDemo();return {ok:true,id:id}; },
    saveContract: function (token, input) {
      const id = 'CV-' + new Date().getFullYear() + '-' + String(Math.floor(Math.random()*9000)+1000); const rent = Number(input.canonMensual);
      demoDb.contracts.push({ id: id, clienteId: input.clienteId, viviendaId: input.viviendaId, fechaInicio: input.fechaInicio, fechaFin: input.fechaFin, canonMensual: rent, estado: 'ACTIVO', deposito: Number(input.deposito || 0), creadoEn: new Date().toISOString() });
      const start = new Date(input.fechaInicio + 'T12:00:00'), end = new Date(input.fechaFin + 'T12:00:00'); let cursor = new Date(start.getFullYear(), start.getMonth(), 1); const names = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
      while (cursor <= end && demoDb.ledger.filter(function (item) { return item.contratoId === id; }).length < 120) { const y=cursor.getFullYear(), m=cursor.getMonth(); demoDb.ledger.push({ id:'CAR-'+Date.now()+'-'+m, contratoId:id, periodo:names[m]+' '+y, fechaVencimiento:y+'-'+String(m+1).padStart(2,'0')+'-'+String(input.diaVencimiento || 10).padStart(2,'0'), valorBase:rent, descuento:0, cargoExtra:0, observacion:'', estado:'PENDIENTE', valorPagado:0, pagoId:'', actualizadoEn:new Date().toISOString() }); cursor=new Date(y,m+1,1); }
      const property=demoDb.properties.find(function (item) { return item.id === input.viviendaId; }); if (property) property.estado='OCUPADA'; demoDb.version++; persistDemo(); return { ok:true,contractId:id };
    },
    updateContract: function (token,input) { const item=demoDb.contracts.find(function(row){return row.id===input.id;});if(!item)throw new Error('No encontramos este contrato.');const oldHome=item.viviendaId;Object.assign(item,{clienteId:input.clienteId,viviendaId:input.viviendaId,fechaInicio:input.fechaInicio,fechaFin:input.fechaFin,canonMensual:Number(input.canonMensual),deposito:Number(input.deposito||0),estado:input.estado||item.estado});demoDb.ledger.filter(function(row){return row.contratoId===item.id;}).forEach(function(row){row.valorBase=Number(input.canonMensual);});const previousHome=demoDb.properties.find(function(row){return row.id===oldHome;});const nextHome=demoDb.properties.find(function(row){return row.id===item.viviendaId;});if(previousHome&&oldHome!==item.viviendaId)previousHome.estado='DISPONIBLE';if(nextHome&&item.estado==='ACTIVO')nextHome.estado='OCUPADA';demoDb.version++;persistDemo();return {ok:true,record:Object.assign({},item)}; },
    deleteContract: function (token,id) { const item=demoDb.contracts.find(function(row){return row.id===id;});if(!item)throw new Error('No encontramos este contrato.');if(demoDb.payments.some(function(row){return row.contratoId===id&&row.estado==='APROBADO';}))throw new Error('Este contrato tiene pagos aprobados y debe conservarse como historial.');demoDb.contracts=demoDb.contracts.filter(function(row){return row.id!==id;});demoDb.ledger=demoDb.ledger.filter(function(row){return row.contratoId!==id;});demoDb.payments=demoDb.payments.filter(function(row){return row.contratoId!==id;});const home=demoDb.properties.find(function(row){return row.id===item.viviendaId;});if(home)home.estado='DISPONIBLE';demoDb.version++;persistDemo();return {ok:true,id:id}; },
    adjustLedgerItem: function (token, input) { const item=demoDb.ledger.find(function (row) { return row.id===input.id; }); Object.assign(item,{descuento:Number(input.descuento||0),cargoExtra:Number(input.cargoExtra||0),observacion:input.observacion||'',actualizadoEn:new Date().toISOString()}); demoDb.version++; persistDemo(); return {ok:true}; },
    registerManualPayment: function (token,input) {
      let remaining=Number(input.valor); const allocations=[]; (input.ledgerIds||[]).forEach(function (id) { const item=demoDb.ledger.find(function (row){return row.id===id;}); if(!item)return; const due=enrich(item).saldo, applied=Math.min(due,remaining); item.valorPagado=Number(item.valorPagado||0)+applied; if(enrich(item).saldo<=0)item.estado='PAGADO'; remaining-=applied; allocations.push({id:id,amount:applied}); });
      demoDb.payments.push({id:'PAG-'+Date.now(),contratoId:input.contratoId,clienteId:'',valor:Number(input.valor)-remaining,metodo:input.metodo,estado:'APROBADO',referencia:'MAN-'+Date.now(),transaccionId:'',detalleJson:JSON.stringify(allocations),creadoEn:new Date().toISOString(),pagadoEn:input.fecha,nota:input.nota||''}); demoDb.version++; persistDemo(); return {ok:true};
    },
    updateManualPayment: function (token,input) { const payment=demoDb.payments.find(function(row){return row.id===input.id;});if(!payment||String(payment.referencia).indexOf('MAN-')!==0||payment.transaccionId)throw new Error('Este pago no se puede editar.');const previous=demoAllocations(payment);let remaining=Number(input.valor);const next=[];(input.ledgerIds||[]).forEach(function(id){const row=demoDb.ledger.find(function(item){return item.id===id&&item.contratoId===input.contratoId;});if(!row)return;const old=previous.filter(function(item){return item.id===id;}).reduce(function(sum,item){return sum+Number(item.amount||0);},0);const available=enrich(row).saldo+old;const amount=Math.min(available,remaining);if(amount>0)next.push({id:id,amount:amount});remaining-=amount;});if(remaining>0)throw new Error('El valor supera lo que falta por pagar.');demoReplaceAllocations(previous,next);const contract=demoDb.contracts.find(function(row){return row.id===input.contratoId;})||{};Object.assign(payment,{contratoId:input.contratoId,clienteId:contract.clienteId||'',valor:Number(input.valor),metodo:input.metodo,detalleJson:JSON.stringify(next),pagadoEn:input.fecha,nota:input.nota||''});demoDb.version++;persistDemo();return {ok:true,record:Object.assign({},payment)}; },
    deleteManualPayment: function (token,id) { const payment=demoDb.payments.find(function(row){return row.id===id;});if(!payment||String(payment.referencia).indexOf('MAN-')!==0||payment.transaccionId)throw new Error('Este pago no se puede eliminar.');demoReplaceAllocations(demoAllocations(payment),[]);demoDb.payments=demoDb.payments.filter(function(row){return row.id!==id;});demoDb.version++;persistDemo();return {ok:true,id:id}; }
  };

  const SIMULATION_STORAGE_KEY = 'vitrinazo-transfer-simulation-v1';
  const simulationDb = (function () {
    try {
      const saved = JSON.parse(localStorage.getItem(SIMULATION_STORAGE_KEY) || 'null');
      if (saved && ['contracts', 'ledger', 'transfers', 'payments'].every(key => Array.isArray(saved[key]))) return saved;
    } catch (error) { /* comenzar con una simulación limpia */ }
    return { version: 1, contracts: [], ledger: [], transfers: [], payments: [] };
  }());
  function reloadSimulation() {
    try {
      const saved = JSON.parse(localStorage.getItem(SIMULATION_STORAGE_KEY) || 'null');
      if (saved && ['contracts', 'ledger', 'transfers', 'payments'].every(key => Array.isArray(saved[key]))) Object.assign(simulationDb, saved);
    } catch (error) { /* conservar la última lectura válida */ }
  }
  function persistSimulation() {
    const previous = localStorage.getItem(SIMULATION_STORAGE_KEY);
    const value = JSON.stringify(simulationDb);
    if (previous === value) return;
    localStorage.setItem(SIMULATION_STORAGE_KEY, value);
    let previousVersion = 0;
    try { previousVersion = Number(JSON.parse(previous || '{}').version || 0); } catch (error) { /* primera escritura */ }
    if (previousVersion !== Number(simulationDb.version || 0) && typeof window.dispatchEvent === 'function') window.dispatchEvent(new window.Event('vitrinazo-transfer-change'));
  }
  const simulatedTransfers = createTransferSimulation(simulationDb, persistSimulation);

  // La consulta sigue utilizando el backend existente. Los abonos de prueba se
  // proyectan únicamente sobre la vista local, sin escribir en la cartera real.
  function captureSimulationContract(contract) {
    return clientSimulationContract(contract, true);
  }
  function clientSimulationContract(contract, capture) {
    if (!contract || !Array.isArray(contract.cartera)) return contract;
    reloadSimulation();
    const index = simulationDb.contracts.findIndex(item => item.id === contract.id);
    const previous = simulationDb.contracts[index] || {};
    const snapshot = { ...previous, id: contract.id, estado: contract.estado || 'ACTIVO', ledgerSnapshotComplete: capture || previous.ledgerSnapshotComplete || false, customer: {
      ...previous.customer, id: contract.clienteId || contract.cliente?.id || previous.customer?.id || '',
      name: contract.cliente?.nombre || previous.customer?.name || '',
      document: contract.cliente?.documento || previous.customer?.document || ''
    } };
    if (index === -1) simulationDb.contracts.push(snapshot);
    else simulationDb.contracts[index] = snapshot;
    const rows = contract.cartera.map(item => ({ ...item, contratoId: contract.id }));
    if (capture) simulationDb.ledger = simulationDb.ledger.filter(item => item.contratoId !== contract.id);
    const incoming = capture ? rows : previous.ledgerSnapshotComplete ? [] : rows.filter(row => !simulationDb.ledger.some(item => item.id === row.id && item.contratoId === contract.id));
    rememberAdminLedger(incoming);
    const orders = activeSimulationOrders();
    const ledger = simulationDb.ledger.filter(row => row.contratoId === contract.id)
      .map(row => simulationLedgerView(row, orders))
      .sort((a, b) => String(a.fechaVencimiento).localeCompare(String(b.fechaVencimiento)));
    return { ...contract, cartera: ledger, resumen: { ...contract.resumen,
      saldo: ledger.reduce((sum, row) => sum + row.saldo, 0),
      vencidos: ledger.filter(row => row.estadoCalculado === 'VENCIDO').length,
      pendientes: ledger.filter(row => row.saldo > 0).length
    } };
  }
  function validSimulationAllocation(order) {
    return typeof order.contractId === 'string' && order.contractId.length > 0 && order.currency === 'COP' &&
      Number.isSafeInteger(order.amountInCents) && order.amountInCents > 0 && Array.isArray(order.months) && order.months.length > 0 &&
      new Set(order.months.map(month => month.id)).size === order.months.length &&
      order.months.every(month => typeof month.id === 'string' && month.id.length > 0 &&
        Number.isSafeInteger(month.amountInCents) && month.amountInCents > 0 && Number.isSafeInteger(month.beforePaidCents) && month.beforePaidCents >= 0 && Number.isSafeInteger(month.beforePaidCents + month.amountInCents)) &&
      order.months.reduce((sum, month) => sum + month.amountInCents, 0) === order.amountInCents;
  }
  function originalSimulationRow(row, database = simulationDb) {
    const base = { ...row, ...row.__simulationBase };
    delete base.__simulationBase;
    delete base.__simulation;
    // Compatibilidad con pruebas guardadas antes de compartirlas con admin.
    if (!row.__simulationBase) {
      const order = database.transfers.find(item => item.status === 'APROBADO' && item.contractId === row.contratoId && 'PAG-' + item.reference === row.pagoId);
      const month = order?.months.find(item => item.id === row.id);
      if (month && Math.round(Number(row.valorPagado || 0) * 100) === month.beforePaidCents + month.amountInCents) {
        base.valorPagado = month.beforePaidCents / 100; base.pagoId = ''; base.estado = 'PENDIENTE';
      }
    }
    return enrich(base);
  }
  function activeSimulationOrders(database = simulationDb) {
    const used = new Set();
    return database.transfers.filter(function (order) {
      if (order.status !== 'APROBADO' || order.success !== true || !validSimulationAllocation(order)) return false;
      if (order.months.some(month => used.has(JSON.stringify([order.contractId, month.id])))) return false;
      const valid = order.months.every(function (month) {
        const saved = database.ledger.find(row => row.id === month.id && row.contratoId === order.contractId);
        if (!saved) return false;
        const row = originalSimulationRow(saved, database);
        return Math.round(Number(row.valorPagado || 0) * 100) === month.beforePaidCents && Math.round(row.saldo * 100) === month.amountInCents;
      });
      if (valid) order.months.forEach(month => used.add(JSON.stringify([order.contractId, month.id])));
      return valid;
    });
  }
  function simulationLedgerView(row, orders) {
    const base = originalSimulationRow(row);
    const order = orders.find(item => item.contractId === base.contratoId && item.months.some(month => month.id === base.id));
    const month = order?.months.find(item => item.id === base.id);
    if (!month) return base;
    return enrich({ ...base, valorPagado: (month.beforePaidCents + month.amountInCents) / 100,
      estado: 'PAGADO', pagoId: 'PAG-' + order.reference, __simulation: true,
      __simulationBase: { valorPagado: base.valorPagado, estado: base.estado, pagoId: base.pagoId }
    });
  }
  function rememberAdminLedger(rows, contractId) {
    (rows || []).forEach(function (row) {
      const base = originalSimulationRow({ ...row, contratoId: row.contratoId || contractId });
      const index = simulationDb.ledger.findIndex(item => item.id === base.id && item.contratoId === base.contratoId);
      if (index === -1) simulationDb.ledger.push(base);
      else simulationDb.ledger[index] = base;
    });
    persistSimulation();
  }
  function simulationPageInfo(section, page, items) {
    const localCount = section === 'payments' ? items.filter(item => item.__simulation).length : 0;
    const total = Number(page.__simulationBaseTotal ?? page.total ?? 0);
    return { ...page, items, total: total + localCount, __simulationBaseTotal: total };
  }
  function projectAdminPage(section, page) {
    const projected = projectAdminSimulation({ [section]: page.items });
    return simulationPageInfo(section, page, projected[section]);
  }
  function projectAdminSimulation(data) {
    reloadSimulation();
    if (Array.isArray(data.ledger)) rememberAdminLedger(data.ledger);
    const contracts = data.contracts || [];
    contracts.forEach(function (contract) {
      const snapshot = simulationDb.contracts.find(item => item.id === contract.id);
      const customer = (data.clients || []).find(item => item.id === contract.clienteId) || (data.client?.id === contract.clienteId ? data.client : null);
      if (snapshot) snapshot.customer = { ...snapshot.customer, id: contract.clienteId || snapshot.customer?.id || '', name: customer?.nombre || contract.clienteNombre || snapshot.customer?.name || '' };
    });
    persistSimulation();
    const orders = activeSimulationOrders();
    const amounts = {};
    orders.forEach(order => { amounts[order.contractId] = Number(amounts[order.contractId] || 0) + order.amountInCents / 100; });
    const result = { ...data };
    if (Array.isArray(data.ledger)) result.ledger = data.ledger.map(row => simulationLedgerView(row, orders));
    if (Array.isArray(data.contracts)) result.contracts = contracts.map(function (contract) {
      const original = Number(contract.__simulationSaldo ?? contract.saldo ?? 0);
      return { ...contract, saldo: Math.max(0, original - Number(amounts[contract.id] || 0)), __simulationSaldo: original };
    });
    if (data.stats) {
      const original = data.stats.__simulationBase || { cartera: Number(data.stats.cartera || 0), recaudado: Number(data.stats.recaudado || 0) };
      const amount = orders.reduce((sum, order) => sum + order.amountInCents / 100, 0);
      result.stats = { ...data.stats, cartera: Math.max(0, original.cartera - amount), recaudado: original.recaudado + amount, __simulationBase: original };
    }
    if (Array.isArray(data.payments)) {
      const real = data.payments.filter(payment => !payment.__simulation);
      const existing = new Set(real.map(payment => payment.referencia));
      const scope = data.client ? new Set(contracts.map(contract => contract.id)) : null;
      const payments = orders.filter(order => (!scope || scope.has(order.contractId)) && !existing.has(order.reference)).map(function (order) {
        const payment = simulationDb.payments.find(item => item.referencia === order.reference);
        const contract = contracts.find(item => item.id === order.contractId);
        const customer = simulationDb.contracts.find(item => item.id === order.contractId)?.customer || order.customer || {};
        return { ...payment, id: payment?.id || 'PAG-' + order.reference, referencia: order.reference,
          contratoId: order.contractId, clienteId: contract?.clienteId || customer.id || '', clienteNombre: contract?.clienteNombre || customer.name || '',
          valor: order.amountInCents / 100, estado: 'APROBADO', metodo: 'TRANSFERENCIA_SIMULADA',
          meses: order.months.map(month => month.period), __simulation: true
        };
      });
      result.payments = payments.concat(real);
      if (data.pageInfo?.payments) result.pageInfo = { ...data.pageInfo, payments: simulationPageInfo('payments', data.pageInfo.payments, result.payments) };
    }
    return result;
  }
  function applyPaymentSimulation(result, method, args) {
    if (!TRANSFER_SIMULATION_ENABLED || !result || typeof result !== 'object') return result;
    reloadSimulation();
    if (method === 'getAdminDashboard' || method === 'getClientAccountForAdmin') return projectAdminSimulation(result);
    if (method === 'getContractLedgerForAdmin' && Array.isArray(result)) {
      rememberAdminLedger(result, args[1]);
      return result.map(row => simulationLedgerView(row, activeSimulationOrders()));
    }
    if (method === 'getAdminPage') return { ...result, page: projectAdminPage(result.section || args[1], result.page) };
    if (method === 'getAdminSync' && result.changed) {
      const snapshot = { stats: result.stats };
      Object.entries(result.sections || {}).forEach(([section, page]) => { snapshot[section] = page.items; });
      const projected = projectAdminSimulation(snapshot);
      const sections = {};
      Object.entries(result.sections || {}).forEach(([section, page]) => { sections[section] = simulationPageInfo(section, page, projected[section]); });
      return { ...result, stats: projected.stats, sections };
    }
    if (Array.isArray(result.contracts)) return { ...result, contracts: result.contracts.map(captureSimulationContract) };
    if (result.contract) return { ...result, contract: captureSimulationContract(result.contract) };
    return result;
  }

  const Backend = {
    isGas: false,
    isRemote: !DEMO_MODE,
    isLive: !DEMO_MODE,
    isTransferSimulation: DEMO_MODE || TRANSFER_SIMULATION_ENABLED,
    prepareTransferSimulation: function (contract) {
      return !DEMO_MODE && TRANSFER_SIMULATION_ENABLED ? clientSimulationContract(contract, false) : contract;
    },
    projectAdminSimulation: function (data) { return !DEMO_MODE && TRANSFER_SIMULATION_ENABLED ? projectAdminSimulation(data) : data; },
    resetTransferSimulation: function () {
      reloadSimulation();
      simulationDb.contracts = []; simulationDb.ledger = []; simulationDb.transfers = []; simulationDb.payments = [];
      simulationDb.version = Number(simulationDb.version || 0) + 1;
      persistSimulation();
    },
    call: function (method) {
      const args = Array.prototype.slice.call(arguments, 1);
      if (!DEMO_MODE && TRANSFER_SIMULATION_ENABLED && Object.prototype.hasOwnProperty.call(simulatedTransfers, method)) {
        return new Promise(function (resolve, reject) {
          setTimeout(function () { try { reloadSimulation(); resolve(simulatedTransfers[method].apply(simulatedTransfers, args)); } catch (error) { reject(error); } }, 180);
        });
      }
      if (!DEMO_MODE) {
        return fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          redirect: 'follow',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: method, args: args })
        }).then(function (response) {
          if (!response.ok) throw new Error('El servidor no respondió correctamente (' + response.status + ').');
          return response.json();
        }).then(function (payload) {
          if (!payload || payload.ok !== true) throw new Error(payload && payload.error ? payload.error : 'Respuesta inválida del servidor.');
          return applyPaymentSimulation(payload.data, method, args);
        }).catch(function (error) {
          if (error instanceof SyntaxError) throw new Error('La URL de Apps Script no devolvió JSON. Actualiza el despliegue del backend.');
          throw error;
        });
      }
      return new Promise(function (resolve, reject) {
        setTimeout(function () { try { resolve(MockApi[method].apply(MockApi, args)); } catch (error) { reject(error); } }, 180);
      });
    }
  };

  function applyAssets() {
    const assets = window.VITRINAZO_ASSETS || {};
    if (assets.logo) document.querySelectorAll('[data-brand-logo]').forEach(function (image) { image.src = assets.logo; });
    if (assets.logo) {
      const favicon = document.createElement('link');
      favicon.rel = 'icon'; favicon.type = 'image/png'; favicon.href = assets.logo;
      document.head.appendChild(favicon);
      const appleIcon = document.createElement('link');
      appleIcon.rel = 'apple-touch-icon'; appleIcon.href = assets.logo;
      document.head.appendChild(appleIcon);
    }
    const hero = document.querySelector('#heroMedia img');
    if (hero && assets.hero) hero.src = assets.hero;
    const login = document.querySelector('.admin-login__background');
    if (login && assets.hero) login.src = assets.hero;
    document.querySelectorAll('a[href^="?"], a[href=""]').forEach(function (link) {
      if (link.getAttribute('href').indexOf('page=admin') !== -1) link.href = 'admin.html';
    });

  }

applyAssets();

// Keep constraint validation accessible without browser-native popovers.
if (document.addEventListener) {
  document.addEventListener('invalid', function (event) {
    event.preventDefault();
    const field = event.target;
    field.setAttribute('aria-invalid', 'true');
    if (!field.form || field === field.form.querySelector('input:invalid,select:invalid,textarea:invalid')) {
      const label = field.labels?.[0]?.childNodes[0]?.textContent?.trim() || 'este campo';
      showToast(field.validity.valueMissing ? 'Completa ' + label.toLowerCase() + '.' : 'Revisa ' + label.toLowerCase() + '.', 'error');
      field.focus();
    }
  }, true);
  document.addEventListener('input', function (event) { event.target.removeAttribute?.('aria-invalid'); });
}

export { Backend, formatMoney, formatDate, formatRentalMonth, formatPaymentMethod, escapeHtml, initials, debounce, showToast, setBusy, setPageLoader };
