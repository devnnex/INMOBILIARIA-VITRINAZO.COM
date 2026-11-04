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
    loader.innerHTML = '<div class="experience-loader__card"><div class="experience-loader__scene" aria-hidden="true"><span class="experience-loader__orbit experience-loader__orbit--one"></span><span class="experience-loader__orbit experience-loader__orbit--two"></span><img src="./assets/logo-vitrinazo.png" alt=""><i></i></div><p class="kicker">Vitrinazo</p><strong data-loader-title>Preparando tu información</strong><p data-loader-message>Organizando los datos más recientes…</p><div class="experience-loader__progress" aria-hidden="true"><span></span><span></span><span></span></div></div>';
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
    requestAnimationFrame(function () { loader.classList.add('is-visible'); });
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
        contractId, account, months, amountInCents: months.reduce((sum, month) => sum + month.amountInCents, 0),
        currency: 'COP', status: 'ESPERANDO_COMPROBANTE', receiptUploaded: false, success: false, demo: true };
      database.transfers.push(order); persist();
      return structuredClone(order);
    },
    getTransferOrder: function (reference, accessToken) {
      const order = database.transfers.find(order => order.reference === reference && order.accessToken === accessToken);
      if (!order) throw new Error('No fue posible acceder a esta solicitud.');
      return structuredClone(order);
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
      if (outcome === 'APPROVED') {
        const rows = order.months.map(month => database.ledger.find(row => row.id === month.id && row.contratoId === order.contractId));
        if (rows.some((row, index) => !row || Math.round(enrich(row).saldo * 100) !== order.months[index].amountInCents)) order.status = 'EN_REVISION';
        else {
          rows.forEach((row, index) => { row.valorPagado = Number(row.valorPagado || 0) + order.months[index].amountInCents / 100; row.estado = 'PAGADO'; row.pagoId = 'PAG-' + reference; });
          database.payments.push({ id: 'PAG-' + reference, contratoId: order.contractId, valor: order.amountInCents / 100,
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
  function persistSimulation() { localStorage.setItem(SIMULATION_STORAGE_KEY, JSON.stringify(simulationDb)); }
  const simulatedTransfers = createTransferSimulation(simulationDb, persistSimulation);

  // La consulta sigue utilizando el backend existente. Los abonos de prueba se
  // proyectan únicamente sobre la vista local, sin escribir en la cartera real.
  function captureSimulationContract(contract) {
    if (!contract || !Array.isArray(contract.cartera)) return contract;
    const index = simulationDb.contracts.findIndex(item => item.id === contract.id);
    const snapshot = { id: contract.id, estado: contract.estado || 'ACTIVO' };
    if (index === -1) simulationDb.contracts.push(snapshot);
    else simulationDb.contracts[index] = snapshot;
    const rows = contract.cartera.map(item => ({ ...item, contratoId: contract.id }));
    simulationDb.transfers.filter(order => order.contractId === contract.id && order.status === 'APROBADO').forEach(function (order) {
      order.months.forEach(function (month) {
        const row = rows.find(item => item.id === month.id);
        if (row && Math.round(Number(row.valorPagado || 0) * 100) === month.beforePaidCents && Math.round(enrich(row).saldo * 100) === month.amountInCents) {
          row.valorPagado = (month.beforePaidCents + month.amountInCents) / 100;
          row.estado = 'PAGADO'; row.pagoId = 'PAG-' + order.reference;
        }
      });
    });
    simulationDb.ledger = simulationDb.ledger.filter(item => item.contratoId !== contract.id).concat(rows);
    persistSimulation();
    const ledger = rows.map(enrich);
    return { ...contract, cartera: ledger, resumen: { ...contract.resumen,
      saldo: ledger.reduce((sum, row) => sum + row.saldo, 0),
      vencidos: ledger.filter(row => row.estadoCalculado === 'VENCIDO').length,
      pendientes: ledger.filter(row => row.saldo > 0).length
    } };
  }
  function applyPaymentSimulation(result) {
    if (!TRANSFER_SIMULATION_ENABLED || !result || typeof result !== 'object') return result;
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
      return !DEMO_MODE && TRANSFER_SIMULATION_ENABLED ? captureSimulationContract(contract) : contract;
    },
    resetTransferSimulation: function () {
      simulationDb.contracts = []; simulationDb.ledger = []; simulationDb.transfers = []; simulationDb.payments = [];
      persistSimulation();
    },
    call: function (method) {
      const args = Array.prototype.slice.call(arguments, 1);
      if (!DEMO_MODE && TRANSFER_SIMULATION_ENABLED && Object.prototype.hasOwnProperty.call(simulatedTransfers, method)) {
        return new Promise(function (resolve, reject) {
          setTimeout(function () { try { resolve(simulatedTransfers[method].apply(simulatedTransfers, args)); } catch (error) { reject(error); } }, 180);
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
          return applyPaymentSimulation(payload.data);
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

export { Backend, formatMoney, formatDate, escapeHtml, initials, debounce, showToast, setBusy, setPageLoader };
