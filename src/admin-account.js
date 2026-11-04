import { Backend, showToast, setBusy } from './common.js';

// Account edits always use the authenticated backend, including when payments
// are simulated. Never replace a real administrative PIN in browser storage.
export function setupAdminAccount({ getToken, setToken, onLogout, onSessionError }) {
  const toggle = document.getElementById('adminAccountToggle');
  const menu = document.getElementById('adminAccountMenu');
  const dialog = document.getElementById('adminProfileDialog');
  const form = document.getElementById('adminProfileForm');
  const fields = document.getElementById('adminProfileFields');
  const save = document.getElementById('adminProfileSave');
  const status = document.getElementById('adminProfileStatus');
  const feedback = document.getElementById('adminProfileFeedback');
  let profile = null, ready = false, loading = null, saving = false;

  function closeMenu() { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
  function paint() {
    document.getElementById('adminAccountName').textContent = profile?.nombre || 'Administrador';
    document.getElementById('adminAccountUser').textContent = profile?.usuario ? '@' + profile.usuario : 'Mi cuenta';
    for (const key of ['nombre', 'usuario', 'email', 'telefono']) form.elements[key].value = profile?.[key] || '';
    fields.disabled = !ready || saving;
    save.disabled = !ready || saving;
    status.textContent = ready ? 'Administra tus datos y tu acceso.' : 'Cargando tu información…';
  }
  function clearSecrets() {
    for (const key of ['currentPin', 'newPin', 'confirmPin']) form.elements[key].value = '';
  }
  function message(text, success = false) {
    feedback.textContent = text;
    feedback.hidden = !text;
    feedback.classList.toggle('is-success', success);
  }
  function invalid(key, text) {
    const input = form.elements[key];
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    message(text);
  }
  function load(admin) {
    if (admin) { profile = admin; ready = false; paint(); }
    if (loading) return loading;
    const token = getToken();
    const pending = Backend.call('getAdminProfile', token).then(result => {
      if (getToken() !== token) return;
      profile = result.admin;
      ready = true;
      paint();
    }).catch(error => {
      if (getToken() !== token) return;
      ready = false;
      fields.disabled = save.disabled = true;
      status.textContent = /Acción no permitida/i.test(error.message)
        ? 'Publica la nueva versión de Code.gs para habilitar la edición del perfil y del PIN.'
        : 'No pudimos cargar tu perfil. Cierra y vuelve a abrir esta ventana para reintentar.';
      if (/sesión|session/i.test(error.message)) onSessionError(error);
    }).finally(() => { if (loading === pending) loading = null; });
    loading = pending;
    return pending;
  }

  toggle.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
  });
  toggle.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); menu.querySelector('button').focus(); }
  });
  document.addEventListener('click', event => { if (!event.target.closest('.admin-account')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { closeMenu(); toggle.focus(); } });
  document.getElementById('editAdminProfile').addEventListener('click', () => {
    closeMenu();
    clearSecrets();
    message('');
    form.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
    paint();
    dialog.showModal(); // Open immediately; network never delays the click.
    if (!ready) load();
  });
  document.getElementById('adminLogout').addEventListener('click', () => {
    const token = getToken();
    closeMenu();
    onLogout();
    // Local access ends synchronously, even if the connection is unavailable.
    Backend.call('adminLogout', token).catch(() => {});
    showToast('Sesión cerrada.');
  });
  dialog.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
  dialog.addEventListener('close', clearSecrets);
  form.addEventListener('input', event => { event.target.removeAttribute('aria-invalid'); message(''); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!ready || save.disabled) return;
    form.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
    const data = Object.fromEntries(new FormData(form));
    for (const key of ['nombre', 'usuario', 'email', 'telefono']) data[key] = data[key].trim();
    if (data.nombre.length < 2 || data.nombre.length > 100 || /^[=+@-]/.test(data.nombre) || /[\r\n\t]/.test(data.nombre)) return invalid('nombre', 'Escribe un nombre válido de 2 a 100 caracteres.');
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{2,39}$/.test(data.usuario)) return invalid('usuario', 'Usa entre 3 y 40 letras, números, puntos o guiones. Empieza con una letra.');
    if (data.email && (data.email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))) return invalid('email', 'Revisa el correo electrónico.');
    if (data.telefono && !/^[+\d () .-]{5,30}$/.test(data.telefono)) return invalid('telefono', 'Revisa el número de teléfono.');
    if (data.currentPin || data.newPin || data.confirmPin) {
      if (!data.currentPin) return invalid('currentPin', 'Ingresa tu PIN actual.');
      if (!/^\d{4,12}$/.test(data.newPin)) return invalid('newPin', 'El nuevo PIN debe tener entre 4 y 12 números.');
      if (data.newPin !== data.confirmPin) return invalid('confirmPin', 'Los nuevos PIN no coinciden.');
    }
    const token = getToken();
    saving = true;
    setBusy(save, true, 'Guardando');
    fields.disabled = true;
    try {
      const result = await Backend.call('updateAdminProfile', token, data);
      if (getToken() !== token) { if (result.token) Backend.call('adminLogout', result.token).catch(() => {}); return; }
      if (!result.ok) throw new Error(result.message || 'No fue posible guardar los cambios.');
      setToken(result.token || token);
      profile = result.admin;
      clearSecrets();
      document.getElementById('adminPinDetails').open = false;
      paint();
      message(result.pinChanged ? 'PIN actualizado. Tus sesiones anteriores se cerraron.' : 'Tus datos se guardaron.', true);
      showToast(result.pinChanged ? 'PIN actualizado.' : 'Perfil actualizado.');
    } catch (error) {
      if (getToken() === token) { message(error.message); if (/sesión|session/i.test(error.message)) onSessionError(error); }
    } finally { saving = false; clearSecrets(); fields.disabled = !ready; setBusy(save, false); save.disabled = !ready; }
  });
  return {
    load,
    reset() { profile = null; ready = false; loading = null; closeMenu(); dialog.close(); clearSecrets(); form.reset(); paint(); }
  };
}
