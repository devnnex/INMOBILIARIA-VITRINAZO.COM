const MAX_SESSION_MS = 6 * 60 * 60 * 1000;
const colombiaDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });

export function adminDay(time) { return colombiaDay.format(new Date(time)); }
export function adminMidnight(time) { return Date.parse(adminDay(time) + 'T00:00:00-05:00') + 86400000; }

// Tokens live only in this document. Reload, tab duplication and other browsers
// start without a session. The server independently checks every admin request.
export function createAdminSession({ onExpire, now = Date.now, monotonic = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let session = null, timer = null;
  function clear() { session = null; clearTimer(timer); timer = null; }
  function check() {
    if (!session) return false;
    const time = Math.max(now() + session.offset, session.serverNow + Math.max(0, monotonic() - session.monotonic));
    if (time >= session.expiresAt || adminDay(time) !== session.day) {
      clear();
      onExpire();
      return false;
    }
    return true;
  }
  function start(metadata = {}) {
    clear();
    const localNow = now();
    const serverNow = Number.isFinite(metadata.serverNow) ? metadata.serverNow : localNow;
    // Older deployed backends receive the same conservative browser limit.
    const advertised = Number.isFinite(metadata.expiresAt) ? metadata.expiresAt : serverNow + Math.max(0, Number(metadata.expiresIn ?? 21600)) * 1000;
    const expiresAt = Math.min(Number.isFinite(advertised) ? advertised : serverNow, adminMidnight(serverNow), serverNow + MAX_SESSION_MS);
    session = { serverNow, expiresAt, offset: serverNow - localNow, monotonic: monotonic(), day: adminDay(serverNow) };
    timer = setTimer(check, Math.max(0, expiresAt - serverNow));
    return check();
  }
  return { start, check, clear };
}
