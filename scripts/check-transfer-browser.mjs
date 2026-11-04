// Optional UI regression check. Start Vite on 5178 and an isolated Chromium
// with --remote-debugging-port=9338 before running this script with Node 22+.
// Uses only Node's built-in CDP/WebSocket support; never contacts the live API.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tabs = await (await fetch('http://127.0.0.1:9338/json/list')).json();
const socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let sequence = 0;
const pending = new Map(), errors = [], requests = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const task = pending.get(message.id); pending.delete(message.id);
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  if (message.method === 'Page.javascriptDialogOpening') { errors.push('Unexpected native dialog: ' + message.params.message); cdp('Page.handleJavaScriptDialog', { accept: false }); }
  if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
});
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + expression + '; page errors: ' + JSON.stringify(errors));
}
async function click(selector) {
  await wait(`Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function screenshot(name) {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(tmpdir(), name + '.png'), Buffer.from(shot.data, 'base64'));
}
function waitForLoad() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('Navigation timed out')); }, 12000);
    function listener(event) {
      if (JSON.parse(event.data).method !== 'Page.loadEventFired') return;
      clearTimeout(timer); socket.removeEventListener('message', listener); resolve();
    }
    socket.addEventListener('message', listener);
  });
}
async function reload() { const loaded = waitForLoad(); await cdp('Page.reload'); await loaded; }
async function upload() {
  const { root } = await cdp('DOM.getDocument');
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[name=receipt]' });
  await cdp('DOM.setFileInputFiles', { nodeId, files: [fileURLToPath(new URL('../assets/logo-vitrinazo.png', import.meta.url))] });
  await wait(`document.querySelector('.transfer-progress')?.hidden === false`);
}
try {
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  // The normal URL uses the existing lookup API while all transfer actions are
  // simulated locally, including when that backend predates Forttu support.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const contract = {
      id:'CONTRATO-CUALQUIERA', estado:'ACTIVO', fechaInicio:'2026-01-01', canonMensual:2450000,
      cliente:{nombre:'Persona de prueba', documento:'DOCUMENTO-PRUEBA'},
      vivienda:{codigo:'PRUEBA-001', tipo:'Apartamento', barrio:'Prueba', direccion:'Dirección de prueba', ciudad:'Bogotá'},
      resumen:{saldo:7315000},
      cartera:[
        {id:'CAR-DEMO-003',periodo:'2026-03-01T00:00:00.000Z',valorBase:2450000,descuento:120000,cargoExtra:0,valorPagado:0,saldo:2330000,estado:'PENDIENTE',fechaVencimiento:'2026-03-10'},
        {id:'CAR-DEMO-004',periodo:'ABR 2026',valorBase:2450000,descuento:0,cargoExtra:85000,valorPagado:0,saldo:2535000,estado:'PENDIENTE',fechaVencimiento:'2026-04-10'},
        {id:'CAR-DEMO-005',periodo:'MAY 2026',valorBase:2450000,descuento:0,cargoExtra:0,valorPagado:0,saldo:2450000,estado:'PENDIENTE',fechaVencimiento:'2026-05-10'}
      ]
    };
    const clients=[{id:'CLI-PRUEBA-1',nombre:'Persona de prueba',documento:'123456789',estado:'ACTIVO'},{id:'CLI-PRUEBA-2',nombre:'Otro cliente',documento:'987654321',estado:'ACTIVO'}];
    const contracts=[{id:contract.id,clienteId:clients[0].id,clienteNombre:clients[0].nombre,estado:'ACTIVO',saldo:7315000},{id:'OTRO-CONTRATO',clienteId:clients[1].id,clienteNombre:clients[1].nombre,estado:'ACTIVO',saldo:2000000}];
    const ledger=contract.cartera.map(row=>({...row,contratoId:contract.id})).concat([{id:'OTRO-MES',contratoId:'OTRO-CONTRATO',periodo:'2026-11-01T00:00:00Z',valorBase:2000000,valorPagado:0,saldo:2000000,estado:'PENDIENTE',fechaVencimiento:'2026-11-10'}]);
    const versions={clients:1,properties:1,contracts:1,ledger:1,payments:1};
    const snapshot={version:1,versions,clients,contracts,ledger,payments:[],properties:[],stats:{clientes:2,contratosActivos:2,cartera:9315000,recaudado:0},pageInfo:{}};
    for(const section of ['clients','properties','contracts','ledger','payments'])snapshot.pageInfo[section]={total:snapshot[section].length,offset:0,nextOffset:snapshot[section].length,limit:1000,hasMore:false};
    window.__backendActions=[];
    let adminProfile={id:'ADM-OWNER',nombre:'Administrador',usuario:'admin',email:'',telefono:''};
    let adminPin='1234', adminToken='simulation-admin-test';
    const originalFetch=window.fetch;
    window.fetch=function(input, options) {
      if (!String(input).startsWith('https://script.google.com/')) return originalFetch(input,options);
      const {action,args}=JSON.parse(options.body); window.__backendActions.push(action);
      let result=action==='lookupAccount'
        ? {ok:true,data:{found:true,version:1,contracts:[contract]}}
        : action==='syncAccount' ? {ok:true,data:{changed:false,version:1}}
        : {ok:false,error:'Acción no permitida.'};
      if(action==='adminLogin')result={ok:true,data:args[0]===adminPin?{ok:true,token:adminToken,admin:adminProfile}:{ok:false,message:'PIN incorrecto.'}};
      if(action==='getAdminProfile' && !window.__legacyAdmin)result={ok:true,data:{admin:adminProfile}};
      if(action==='updateAdminProfile'){
        const data=args[1],changing=Boolean(data.newPin);
        if(changing && data.currentPin!==adminPin)result={ok:false,error:'El PIN actual no es correcto.'};
        else {adminProfile={...adminProfile,nombre:data.nombre,usuario:data.usuario,email:data.email,telefono:data.telefono};if(changing){adminPin=data.newPin;adminToken='rotated-admin-test';}result={ok:true,data:{ok:true,admin:adminProfile,token:adminToken,pinChanged:changing}};}
      }
      if(action==='adminLogout')result={ok:true,data:{ok:true}};
      if(action==='getAdminDashboard')result={ok:true,data:snapshot};
      if(action==='getAdminSync')result={ok:true,data:{changed:false,version:1,versions,sections:{}}};
      if(action==='getClientAccountForAdmin'){
        const related=contracts.filter(row=>row.clienteId===args[1]);const ids=new Set(related.map(row=>row.id));
        result={ok:true,data:{client:clients.find(row=>row.id===args[1]),contracts:related,ledger:ledger.filter(row=>ids.has(row.contratoId)),payments:[]}};
      }
      const response=()=>new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
      if(action==='getAdminDashboard')return new Promise(resolve=>setTimeout(()=>resolve(response()),1500));
      return Promise.resolve(response());
    };
  })()` });
  const initialLoad = waitForLoad();
  await cdp('Page.navigate', { url: 'http://127.0.0.1:5178/' });
  await initialLoad;
  await wait(`document.getElementById('paymentSimulationHint')?.hidden === false`);
  const resetLoad = waitForLoad();
  await click('#resetPaymentSimulation');
  await resetLoad;
  await wait(`document.getElementById('paymentSimulationHint')?.hidden === false`);
  await evaluate(`document.getElementById('lookupInput').value='123456789';document.getElementById('lookupForm').requestSubmit()`);
  await wait(`document.querySelector('[data-ledger-check="CAR-DEMO-003"]')`);
  await click('[data-ledger-check="CAR-DEMO-003"]'); await click('[data-ledger-check="CAR-DEMO-004"]');
  assert.match(await evaluate(`document.getElementById('selectedTotal').textContent`), /4.865.000/);
  await click('#openPayment');
  await wait(`document.querySelector('.transfer-account-form')?.hidden === false`);
  await evaluate(`document.querySelector('select[name=accountId]').value='DEMO-B'`);
  await click('.transfer-account-form button');
  await wait(`document.querySelector('.transfer-receipt-form')?.hidden === false`);
  assert.match(await evaluate(`document.querySelector('.transfer-details').textContent`), /CUENTA-DEMO-002/);
  assert.match(await evaluate(`document.querySelector('.payment-summary__months').textContent`), /Marzo de 2026/);
  assert.equal(await evaluate(`document.querySelector('.payment-summary__months').textContent.includes('2026-03-01')`), false);
  await screenshot('vitrinazo-transfer-bank');
  const reference = await evaluate(`document.querySelector('.transfer-selection small').textContent`);
  await evaluate(`window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'));`);
  assert.equal(await evaluate(`document.querySelector('.transfer-selection small').textContent`), reference);
  await reload();
  await wait(`document.querySelector('.transfer-receipt-form')?.hidden === false`);
  assert.equal(await evaluate(`document.querySelector('.transfer-selection small').textContent`), reference);
  await upload();
  await reload();
  await wait(`document.querySelector('.transfer-progress')?.hidden === false`);
  assert.equal(await evaluate(`document.querySelector('.transfer-selection small').textContent`), reference);
  await wait(`document.querySelector('[data-ledger-id="CAR-DEMO-003"]')`);
  assert.equal(await evaluate(`document.querySelector('[data-ledger-id="CAR-DEMO-003"]').classList.contains('is-paid')`), false);
  await screenshot('vitrinazo-transfer-waiting');
  await wait(`document.querySelector('.transfer-success')?.hidden === false`);
  assert.equal(await evaluate(`document.querySelector('#transferSuccessTitle').textContent`), '¡Pago exitoso!');
  assert.ok(await evaluate(`document.querySelectorAll('.transfer-confetti > i').length > 0`));
  assert.equal(await evaluate(`document.querySelector('[data-simulate]')`), null);
  await wait(`document.querySelector('[data-ledger-id="CAR-DEMO-003"]')?.classList.contains('is-paid')`);
  assert.equal(await evaluate(`document.querySelector('[data-ledger-id="CAR-DEMO-005"]').classList.contains('is-paid')`), false);
  await new Promise(resolve => setTimeout(resolve, 500));
  await screenshot('vitrinazo-transfer-success');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot('vitrinazo-transfer-success-mobile');
  await click('.transfer-success [data-transfer-finish]');
  await wait(`!document.querySelector('.transfer-modal')`);
  assert.equal(await evaluate(`document.querySelector('[data-ledger-id="CAR-DEMO-003"] .badge').textContent`), 'PAGADO');
  assert.equal(await evaluate(`document.querySelector('[data-ledger-id="CAR-DEMO-004"] .badge').textContent`), 'PAGADO');
  // A fresh lookup after closing must retain the two simulated paid badges.
  await evaluate(`document.getElementById('lookupForm').requestSubmit()`);
  await wait(`document.querySelector('[data-ledger-id="CAR-DEMO-003"] .badge')?.textContent === 'PAGADO'`);
  // An admin window opened before the next payment must update from the
  // storage event, even though the server reports unchanged resource versions.
  await evaluate(`(()=>{const frame=document.createElement('iframe');frame.id='adminSimulationFrame';frame.src='/admin.html';frame.hidden=true;document.body.appendChild(frame);})()`);
  await wait(`document.getElementById('adminSimulationFrame')?.contentDocument?.getElementById('adminLoginForm') && document.getElementById('adminSimulationFrame').contentDocument.readyState === 'complete'`);
  await evaluate(`(()=>{const doc=document.getElementById('adminSimulationFrame').contentDocument;if(doc.getElementById('adminShell').hidden){doc.getElementById('adminPin').value='1234';doc.getElementById('adminLoginForm').requestSubmit();}})()`);
  await wait(`document.getElementById('adminSimulationFrame').contentDocument.getElementById('adminShell').hidden === false`);
  await wait(`document.getElementById('adminSimulationFrame').contentDocument.getElementById('statGrid').textContent.includes('4.450.000')`);
  // A second customer window has a warm cache and unchanged server version.
  // It must still receive the next local payment and show the same paid months.
  await evaluate(`(()=>{const frame=document.createElement('iframe');frame.id='customerObserverFrame';frame.src='/index.html';frame.hidden=true;document.body.appendChild(frame);})()`);
  await wait(`document.getElementById('customerObserverFrame')?.contentDocument?.getElementById('lookupForm') && document.getElementById('customerObserverFrame').contentDocument.readyState === 'complete'`);
  await evaluate(`(()=>{const doc=document.getElementById('customerObserverFrame').contentDocument;doc.getElementById('lookupInput').value='123456789';doc.getElementById('lookupForm').requestSubmit();})()`);
  await wait(`document.getElementById('customerObserverFrame').contentDocument.querySelectorAll('#ledgerList .is-paid').length === 2`);
  await evaluate(`window.__oldCustomerCache=sessionStorage.getItem('vitrinazo-last-account-v3-simulation')`);
  await click('[data-ledger-check="CAR-DEMO-005"]'); await click('#openPayment');
  await wait(`document.querySelector('.transfer-account-form')?.hidden === false`);
  await click('.transfer-account-form button');
  await wait(`document.querySelector('.transfer-receipt-form')?.hidden === false`);
  await screenshot('vitrinazo-transfer-upload-mobile');
  const invalidDocument = await cdp('DOM.getDocument');
  const invalidInput = await cdp('DOM.querySelector', { nodeId: invalidDocument.root.nodeId, selector: 'input[name=receipt]' });
  await cdp('DOM.setFileInputFiles', { nodeId: invalidInput.nodeId, files: [fileURLToPath(new URL('../package.json', import.meta.url))] });
  await wait(`document.querySelector('.transfer-feedback')?.classList.contains('is-error')`);
  assert.equal(await evaluate(`document.querySelector('.transfer-success').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('[data-ledger-id="CAR-DEMO-005"]').classList.contains('is-paid')`), false);
  await upload();
  await wait(`document.querySelector('.transfer-success')?.hidden === false`);
  await wait(`document.querySelector('[data-ledger-id="CAR-DEMO-005"]')?.classList.contains('is-paid')`);
  await wait(`document.getElementById('adminSimulationFrame').contentDocument.getElementById('statGrid').textContent.includes('2.000.000')`);
  await wait(`document.getElementById('customerObserverFrame').contentDocument.querySelectorAll('#ledgerList .is-paid').length === 3`);
  await evaluate(`sessionStorage.setItem('vitrinazo-last-account-v3-simulation',window.__oldCustomerCache);document.getElementById('customerObserverFrame').contentDocument.getElementById('lookupForm').requestSubmit()`);
  await wait(`document.getElementById('customerObserverFrame').contentWindow.__backendActions.includes('syncAccount')`);
  assert.equal(await evaluate(`document.getElementById('customerObserverFrame').contentDocument.querySelectorAll('#ledgerList .is-paid').length`), 3);
  assert.match(await evaluate(`document.getElementById('adminSimulationFrame').contentDocument.getElementById('statGrid').textContent`), /7.315.000/);
  assert.equal(await evaluate(`document.getElementById('customerObserverFrame').contentDocument.querySelector('.balance-card strong').textContent.replace(/[^0-9]/g,'')`), '0');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const layout = await evaluate(`(()=>{const dialog=document.querySelector('.transfer-modal');const surface=dialog.querySelector('.modal__surface');return {width:dialog.getBoundingClientRect().width,overflow:surface.scrollWidth>surface.clientWidth};})()`);
  assert.ok(layout.width <= 390); assert.equal(layout.overflow, false);
  await screenshot('vitrinazo-transfer-mobile');
  assert.equal(requests.filter(url => url.includes('script.google.com') || url.includes('script.googleusercontent.com')).length, 0);
  assert.equal(await evaluate(`location.search`), '');
  assert.equal(await evaluate(`window.__backendActions.some(action=> !['lookupAccount','syncAccount'].includes(action))`), false);
  // A slow connection and unavailable images must not show a broken logo or
  // push the loader card outside a narrow mobile viewport.
  await cdp('Network.setBlockedURLs', { urls: ['*logo-vitrinazo*'] });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 280, height: 800, deviceScaleFactor: 1, mobile: true });
  const adminLoad = waitForLoad();
  await cdp('Page.navigate', { url: 'http://127.0.0.1:5178/admin.html' });
  await adminLoad;
  await wait(`document.getElementById('experienceLoader')?.classList.contains('is-visible') && getComputedStyle(document.getElementById('experienceLoader')).opacity === '1'`);
  assert.equal(await evaluate(`document.querySelectorAll('.experience-loader__scene img').length`), 0);
  assert.ok(await evaluate(`document.querySelectorAll('.experience-loader__brand path').length >= 4`));
  const loaderLayout = await evaluate(`(()=>{const card=document.querySelector('.experience-loader__card');const bounds=card.getBoundingClientRect();return {left:bounds.left,right:bounds.right,overflow:card.scrollWidth>card.clientWidth};})()`);
  assert.ok(loaderLayout.left >= 0 && loaderLayout.right <= 280);
  assert.equal(loaderLayout.overflow, false);
  await screenshot('vitrinazo-loader-no-images-mobile');
  await cdp('Network.setBlockedURLs', { urls: [] });
  await evaluate(`Array.from(document.images).filter(image=>!image.naturalWidth).forEach(image=>{image.src=image.src;})`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await wait(`document.getElementById('adminShell')?.hidden === false`);
  await wait(`document.getElementById('experienceLoader')?.hidden === true`);
  await wait(`document.querySelectorAll('#paymentsTable [data-payment-id]').length === 2`);
  assert.match(await evaluate(`document.getElementById('statGrid').textContent`), /2.000.000/);
  assert.match(await evaluate(`document.getElementById('paymentsTable').textContent`), /Marzo de 2026/);
  assert.match(await evaluate(`document.getElementById('paymentsTable').textContent`), /Persona de prueba/);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('#paymentsTable .payment-reference')).every(item=>/^Pago #[A-Z0-9]{8}$/.test(item.textContent) && item.title.length > item.textContent.length)`), true);
  assert.equal(await evaluate(`document.querySelectorAll('#paymentsTable .protected-record.badge--paid svg').length`), 2);
  assert.equal(await evaluate(`(()=>{const row=document.querySelector('#paymentsTable tr');return getComputedStyle(row.querySelector('.protected-record')).backgroundColor===getComputedStyle(row.querySelector('td:nth-child(6) .badge')).backgroundColor;})()`), true);
  await evaluate(`(()=>{const input=document.querySelector('[data-table-search="payments"]');input.value=document.querySelector('#paymentsTable tr').dataset.searchReference.split(' · ')[0];input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(`Array.from(document.querySelectorAll('#paymentsTable tr')).filter(row=>!row.hidden).length === 1`);
  await evaluate(`(()=>{const input=document.querySelector('[data-table-search="payments"]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(`Array.from(document.querySelectorAll('#paymentsTable tr')).filter(row=>!row.hidden).length === 2`);
  await click('[data-client-account="CLI-PRUEBA-1"]');
  await wait(`document.querySelectorAll('#clientAccountMonths .badge--paid').length === 3`);
  assert.match(await evaluate(`document.getElementById('clientAccountMonths').textContent`), /Marzo de 2026/);
  assert.equal(await evaluate(`document.getElementById('clientAccountMonths').textContent.includes('2026-03-01T')`), false);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await screenshot('vitrinazo-admin-simulated-account');
  await click('#clientAccountDialog [data-dialog-close]');
  await click('[data-view="payments"]');
  await new Promise(resolve => setTimeout(resolve, 350));
  await screenshot('vitrinazo-admin-simulated-payments');
  assert.equal(await evaluate(`window.__backendActions.some(action=> !['adminLogin','getAdminProfile','getAdminDashboard','getAdminSync','getClientAccountForAdmin'].includes(action))`), false);
  // Profile opens synchronously, validates inline and uses real account APIs,
  // without being intercepted by the payment simulator.
  await click('#adminAccountToggle');
  assert.equal(await evaluate(`document.getElementById('adminAccountMenu').hidden`), false);
  await click('#editAdminProfile');
  assert.equal(await evaluate(`document.getElementById('adminProfileDialog').open`), true);
  await wait(`!document.getElementById('adminProfileFields').disabled`);
  await evaluate(`(()=>{const f=document.getElementById('adminProfileForm');f.elements.nombre.value='María López';f.elements.usuario.value='maria.admin';f.elements.email.value='incorrecto';f.requestSubmit();})()`);
  assert.match(await evaluate(`document.getElementById('adminProfileFeedback').textContent`), /correo/);
  await evaluate(`(()=>{const f=document.getElementById('adminProfileForm');f.elements.email.value='maria@example.com';f.elements.telefono.value='+57 300 123 4567';f.requestSubmit();})()`);
  await wait(`document.getElementById('adminProfileFeedback').classList.contains('is-success')`);
  assert.equal(await evaluate(`document.getElementById('adminAccountName').textContent`), 'María López');
  await evaluate(`(()=>{document.getElementById('adminPinDetails').open=true;const f=document.getElementById('adminProfileForm');f.elements.currentPin.value='0000';f.elements.newPin.value='5678';f.elements.confirmPin.value='5678';f.requestSubmit();})()`);
  await wait(`document.getElementById('adminProfileFeedback').textContent.includes('PIN actual no es correcto')`);
  assert.equal(await evaluate(`document.getElementById('adminProfileForm').elements.newPin.value`), '');
  await evaluate(`(()=>{const f=document.getElementById('adminProfileForm');f.elements.currentPin.value='1234';f.elements.newPin.value='5678';f.elements.confirmPin.value='5679';f.requestSubmit();})()`);
  assert.match(await evaluate(`document.getElementById('adminProfileFeedback').textContent`), /no coinciden/);
  await evaluate(`(()=>{const f=document.getElementById('adminProfileForm');f.elements.confirmPin.value='5678';f.requestSubmit();})()`);
  await wait(`document.getElementById('adminProfileFeedback').textContent.includes('PIN actualizado')`);
  assert.equal(await evaluate(`sessionStorage.getItem('vitrinazo-admin-token')`), 'rotated-admin-test');
  for (const width of [390, 280]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`document.getElementById('adminPinDetails').open=true`);
    const profileLayout = await evaluate(`(()=>{const d=document.getElementById('adminProfileDialog');const s=d.querySelector('.modal__surface');return {left:d.getBoundingClientRect().left,right:d.getBoundingClientRect().right,overflow:s.scrollWidth>s.clientWidth};})()`);
    assert.ok(profileLayout.left >= 0 && profileLayout.right <= width);
    assert.equal(profileLayout.overflow, false);
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot('vitrinazo-admin-profile-mobile');
  await click('#adminProfileDialog [data-dialog-close]');
  await click('#refreshAdmin');
  assert.equal(await evaluate(`document.getElementById('refreshAdmin').classList.contains('is-refreshing')`), true);
  assert.equal(await evaluate(`document.getElementById('experienceLoader').hidden`), true);
  await click('#adminAccountToggle');
  const menuBounds = await evaluate(`(()=>{const r=document.getElementById('adminAccountMenu').getBoundingClientRect();return {left:r.left,right:r.right};})()`);
  assert.ok(menuBounds.left >= 0 && menuBounds.right <= 390);
  await screenshot('vitrinazo-admin-account-menu-mobile');
  await click('#adminLogout');
  assert.equal(await evaluate(`document.getElementById('adminShell').hidden && !document.getElementById('adminLogin').hidden && !sessionStorage.getItem('vitrinazo-admin-token')`), true);
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(await evaluate(`document.getElementById('adminShell').hidden`), true);
  await evaluate(`document.getElementById('adminPin').value='1234';document.getElementById('adminLoginForm').requestSubmit()`);
  await wait(`document.getElementById('toast').textContent==='PIN incorrecto.'`);
  assert.equal(await evaluate(`document.getElementById('adminShell').hidden`), true);
  await evaluate(`document.getElementById('adminPin').value='5678';document.getElementById('adminLoginForm').requestSubmit()`);
  await wait(`!document.getElementById('adminShell').hidden && document.getElementById('experienceLoader').hidden`);
  // An older deployed backend must never pretend to change a real PIN locally.
  await click('#adminAccountToggle'); await click('#adminLogout');
  await evaluate(`window.__legacyAdmin=true;document.getElementById('adminPin').value='5678';document.getElementById('adminLoginForm').requestSubmit()`);
  await wait(`!document.getElementById('adminShell').hidden && document.getElementById('experienceLoader').hidden`);
  await click('#adminAccountToggle'); await click('#editAdminProfile');
  await wait(`document.getElementById('adminProfileStatus').textContent.includes('Publica la nueva versión')`);
  assert.equal(await evaluate(`document.getElementById('adminProfileSave').disabled`), true);
  await click('#adminProfileDialog [data-dialog-close]');
  await click('#adminAccountToggle'); await click('#adminLogout');
  await evaluate(`(()=>{const pin=document.getElementById('adminPin');pin.addEventListener('invalid',event=>window.__invalidCancelled=event.defaultPrevented,{once:true});document.getElementById('adminLoginForm').requestSubmit();})()`);
  assert.equal(await evaluate(`window.__invalidCancelled`), true);
  assert.match(await evaluate(`document.getElementById('toast').textContent`), /Completa/);
  assert.deepEqual(errors, []);
  console.log('PASS: payment parity, live updates, mobile loader without images, custom profile and PIN validation, token rotation, immediate logout during refresh, old-backend compatibility, no native dialogs, zero production writes.');
} finally { socket.close(); }
