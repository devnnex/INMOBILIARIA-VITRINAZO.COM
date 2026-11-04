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
async function upload() {
  const { root } = await cdp('DOM.getDocument');
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[name=receipt]' });
  await cdp('DOM.setFileInputFiles', { nodeId, files: [fileURLToPath(new URL('../assets/logo-vitrinazo.png', import.meta.url))] });
  await click('.transfer-receipt-form button');
  await wait(`document.querySelector('.transfer-progress')?.hidden === false`);
}
try {
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:5178/?demo=1' });
  await wait(`document.getElementById('demoHint')?.hidden === false`);
  await click('#resetDemo');
  await wait(`document.getElementById('demoHint')?.hidden === false`);
  await click('[data-demo-query="CV-2026-0042"]');
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
  await cdp('Page.reload');
  await wait(`document.querySelector('.transfer-receipt-form')?.hidden === false`);
  assert.equal(await evaluate(`document.querySelector('.transfer-selection small').textContent`), reference);
  await upload();
  await cdp('Page.reload');
  await wait(`document.querySelector('.transfer-progress')?.hidden === false`);
  assert.equal(await evaluate(`document.querySelector('.transfer-selection small').textContent`), reference);
  await wait(`document.querySelector('[data-ledger-id="CAR-DEMO-003"]')`);
  assert.equal(await evaluate(`document.querySelector('[data-ledger-id="CAR-DEMO-003"]').classList.contains('is-paid')`), false);
  await screenshot('vitrinazo-transfer-waiting');
  await click('[data-simulate=APPROVED]');
  await wait(`document.querySelector('#transferTitle')?.textContent === 'Pago realizado exitosamente'`);
  await wait(`document.querySelector('[data-ledger-id="CAR-DEMO-003"]')?.classList.contains('is-paid')`);
  assert.equal(await evaluate(`document.querySelector('[data-ledger-id="CAR-DEMO-005"]').classList.contains('is-paid')`), false);
  await screenshot('vitrinazo-transfer-success');
  await click('[data-transfer-finish]');
  await wait(`!document.querySelector('.transfer-modal')`);
  await click('[data-ledger-check="CAR-DEMO-005"]'); await click('#openPayment');
  await wait(`document.querySelector('.transfer-account-form')?.hidden === false`);
  await click('.transfer-account-form button');
  await wait(`document.querySelector('.transfer-receipt-form')?.hidden === false`);
  await upload(); await click('[data-simulate=WRONG_AMOUNT]');
  await wait(`document.querySelector('.transfer-feedback')?.textContent.includes('no coinciden')`);
  assert.equal(await evaluate(`document.querySelector('[data-ledger-id="CAR-DEMO-005"]').classList.contains('is-paid')`), false);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const layout = await evaluate(`(()=>{const dialog=document.querySelector('.transfer-modal');const surface=dialog.querySelector('.modal__surface');return {width:dialog.getBoundingClientRect().width,overflow:surface.scrollWidth>surface.clientWidth};})()`);
  assert.ok(layout.width <= 390); assert.equal(layout.overflow, false);
  await screenshot('vitrinazo-transfer-mobile');
  assert.equal(requests.filter(url => url.includes('script.google.com') || url.includes('script.googleusercontent.com')).length, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: bank choice, total, app return, reload before/after receipt, pending without credit, exact approval, second order, amount mismatch, mobile width, zero production API requests.');
} finally { socket.close(); }
