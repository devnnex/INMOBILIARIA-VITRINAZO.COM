import assert from 'node:assert/strict';
import test from 'node:test';
import { adminDay, adminMidnight, createAdminSession } from '../src/admin-session.js';

function harness() {
  let time = Date.parse('2026-11-05T04:59:50Z'), elapsed = 0, expired = 0, callback;
  const guard = createAdminSession({ now: () => time, monotonic: () => elapsed, onExpire: () => expired++, setTimer: fn => { callback = fn; return 1; }, clearTimer() {} });
  return { guard, expiryCount: () => expired, setTime: value => { time = Date.parse(value); }, advance: ms => { time += ms; elapsed += ms; }, advanceMonotonic: ms => { elapsed += ms; }, fire: () => callback() };
}

test('a fresh document always starts locked and dates use Colombia rather than the device timezone', () => {
  const h = harness();
  assert.equal(h.guard.check(), false);
  assert.equal(adminDay(Date.parse('2026-11-05T04:59:59Z')), '2026-11-04');
  assert.equal(adminMidnight(Date.parse('2026-11-05T04:59:59Z')), Date.parse('2026-11-05T05:00:00Z'));
});

test('midnight locks an open session once and another browser context receives no session', () => {
  const h = harness();
  assert.equal(h.guard.start(), true);
  assert.equal(harness().guard.check(), false);
  h.advance(9999);
  assert.equal(h.guard.check(), true);
  h.advance(1); h.fire();
  assert.equal(h.guard.check(), false);
  assert.equal(h.expiryCount(), 1);
  h.fire();
  assert.equal(h.expiryCount(), 1);
});

test('sleeping tabs are locked when checked after midnight even when timers were suspended', () => {
  const h = harness(); h.guard.start();
  h.advance(20000);
  assert.equal(h.guard.check(), false);
});

test('server expiry and server clock take priority over a wrongly set device clock', () => {
  const h = harness();
  h.setTime('2030-01-01T00:00:00Z');
  h.guard.start({ serverNow: Date.parse('2026-11-05T04:59:50Z'), expiresAt: Date.parse('2026-11-05T04:59:55Z') });
  h.advance(5000);
  assert.equal(h.guard.check(), false);
});

test('turning back the device clock cannot extend a session', () => {
  const h = harness(); h.guard.start();
  h.setTime('2025-01-01T00:00:00Z');
  h.advanceMonotonic(10000);
  assert.equal(h.guard.check(), false);
});

test('a cleared session stays locked and already expired server metadata never unlocks the panel', () => {
  const h = harness(); h.guard.start(); h.guard.clear();
  assert.equal(h.guard.check(), false);
  assert.equal(h.guard.start({ expiresAt: 1 }), false);
  assert.equal(h.guard.start({ expiresIn: 'invalid' }), false);
});
