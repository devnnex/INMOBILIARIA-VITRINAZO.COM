# Perfil, PIN y cierre de sesión

El botón «VI» del panel abre el menú de cuenta. «Mi perfil y seguridad» permite
editar nombre, usuario, correo, teléfono y PIN. El ingreso sigue siendo por PIN;
el usuario es información del perfil. El PIN nuevo debe contener de 4 a 12 números
y exige el PIN actual. No se guarda el PIN en el navegador.

La web abre el formulario inmediatamente y obtiene el perfil en segundo plano
al entrar al panel. Guardar requiere respuesta del servidor; un fallo conserva
los datos editados y muestra el error dentro del formulario. Los campos del PIN
se limpian al terminar o cerrar la ventana. No se muestran alertas nativas.

## Publicar en Google Apps Script

1. Copiar el contenido completo de `Code.gs` al proyecto de Apps Script existente
   y guardar. Conservar sus propiedades y su hoja de cálculo actual.
2. Ir a **Implementar → Gestionar implementaciones → Editar** (el lápiz).
3. Seleccionar **Nueva versión → Implementar** en la implementación web existente.
   Mantener la misma URL `/exec` y las opciones de acceso actuales.
4. Recargar `admin.html`, iniciar sesión con el PIN actual y abrir «VI».
5. Guardar el perfil, cambiar el PIN y comprobar que el PIN anterior ya no permite
   entrar después de cerrar sesión. No ejecutar `resetAdminPin` para actualizar.

Solo guardar en el editor no actualiza la aplicación web desplegada. Hasta
publicar la nueva versión, la web muestra que la edición requiere actualizar
`Code.gs`; el cierre local de sesión continúa funcionando.

## Persistencia y seguridad

- APIs autenticadas: `getAdminProfile(token)`, `updateAdminProfile(token, input)`.
  `adminLogout(token)` revoca únicamente el token recibido y es idempotente.
- Nombre/usuario se guardan en las columnas existentes de `ADMINISTRADORES`.
  Correo/teléfono usan la propiedad `ADMIN_PROFILE_ADM-OWNER`; no cambia el esquema.
- PIN con sal nueva y SHA-256, compatible con la autenticación existente.
  La respuesta pública nunca incluye PIN, hash ni sal.
- El cambio de PIN incrementa `ADMIN_SESSION_VERSION`, invalida las sesiones
  anteriores y entrega un token nuevo a la sesión que hizo el cambio. Las otras
  pestañas salen al volver a consultar el servidor.
- Login y actualización se serializan con el bloqueo del script para impedir
  que una entrada con el PIN anterior compita con su cambio.
- Cerrar sesión oculta el panel y borra el token local inmediatamente; la
  revocación remota se solicita en segundo plano. Sin conexión, el token remoto
  conserva su vencimiento original de seis horas.
- La simulación de pagos no intercepta estas APIs ni altera las credenciales.

Pruebas: `tests/admin-account.test.js` y `scripts/check-transfer-browser.mjs`.
