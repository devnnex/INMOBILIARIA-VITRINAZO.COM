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
        {id:'CAR-DEMO-003',periodo:'MAR 2026',valorBase:2450000,descuento:120000,cargoExtra:0,valorPagado:0,saldo:2330000,estado:'PENDIENTE',fechaVencimiento:'2026-03-10'},
        {id:'CAR-DEMO-004',periodo:'ABR 2026',valorBase:2450000,descuento:0,cargoExtra:85000,valorPagado:0,saldo:2535000,estado:'PENDIENTE',fechaVencimiento:'2026-04-10'},
        {id:'CAR-DEMO-005',periodo:'MAY 2026',valorBase:2450000,descuento:0,cargoExtra:0,valorPagado:0,saldo:2450000,estado:'PENDIENTE',fechaVencimiento:'2026-05-10'}
      ]
    };
    window.__backendActions=[];
    const originalFetch=window.fetch;
    window.fetch=function(input, options) {
      if (!String(input).startsWith('https://script.google.com/')) return originalFetch(input,options);
      const {action}=JSON.parse(options.body); window.__backendActions.push(action);
      const result=action==='lookupAccount'
        ? {ok:true,data:{found:true,version:1,contracts:[contract]}}
        : action==='syncAccount' ? {ok:true,data:{changed:false,version:1}}
        : {ok:false,error:'Acción no permitida.'};
      return Promise.resolve(new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}}));
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
  await evaluate(`document.getElementById('lookupInput').value='CONTRATO-CUALQUIERA';document.getElementById('lookupForm').requestSubmit()`);
  await wait(`document.querySelector('[data-ledger-check="CAR-DEMO-003"]')`);
  await click('[data-ledger-check="CAR-DEMO-003"]'); await click('[data-ledger-check="CAR-DEMO-004"]');
  assert.match(await evaluate(`document.getElementById('selectedTotal').textContent`), /4.865.000/);
  await click('#openPayment');
  await wait(`document.querySelector('.transfer-account-form')?.hidden === false`);
  await evaluate(`document.querySelector('select[name=accountId]').value='DEMO-B'`);
  await click('.transfer-account-form button');
  await wait(`document.querySelector('.transfer-receipt-form')?.hidden === false`);
  assert.match(await evaluate(`document.querySelector('.transfer-details').textContent`), /CUENTA-DEMO-002/);
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const layout = await evaluate(`(()=>{const dialog=document.querySelector('.transfer-modal');const surface=dialog.querySelector('.modal__surface');return {width:dialog.getBoundingClientRect().width,overflow:surface.scrollWidth>surface.clientWidth};})()`);
  assert.ok(layout.width <= 390); assert.equal(layout.overflow, false);
  await screenshot('vitrinazo-transfer-mobile');
  assert.equal(requests.filter(url => url.includes('script.google.com') || url.includes('script.googleusercontent.com')).length, 0);
  assert.equal(await evaluate(`location.search`), '');
  assert.equal(await evaluate(`window.__backendActions.some(action=> !['lookupAccount','syncAccount'].includes(action))`), false);
  assert.deepEqual(errors, []);
  console.log('PASS: Spanish upload, invalid-file rejection, automatic submission and approval, confetti, paid badges, reload recovery, second payment, mobile width, zero production payment API requests.');
} finally { socket.close(); }
