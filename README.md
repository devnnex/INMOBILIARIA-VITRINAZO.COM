# Vitrinazo Inmobiliaria

Aplicación inmobiliaria multipágina con frontend moderno, backend en Google Apps Script, persistencia en Google Sheets y transferencias bancarias con comprobante, preparada para integrar Forttu.

## Arquitectura

```text
index.html                  Portal público
admin.html                  Panel administrativo
src/styles.css              Sistema visual responsive
src/common.js               API, utilidades y entorno demo
src/client.js               Flujo de consulta y pagos
src/transfer.js             Transferencias, comprobantes y seguimiento
src/admin.js                Gestión administrativa
Code.gs                     Backend, Sheets, cartera y verificación de transferencias
assets/                     Logo e imagen del hero
dist/                       Build web optimizado de Vite
```

El desarrollo usa Vite 8 como servidor y compilador multipágina. El frontend y el backend están completamente separados: Apps Script contiene exclusivamente `Code.gs`, mientras que las páginas, estilos e imágenes permanecen en este proyecto.

## Desarrollo local

```powershell
npm install
npm run dev
```

Vite mostrará la URL local. Las rutas principales son:

- `/index.html`
- `/admin.html`

También puedes abrir `index.html` directamente para revisar el diseño, porque el CSS y los assets usan rutas reales. Para que funcionen todos los módulos JavaScript utiliza el servidor de Vite.

Datos de demostración:

- Cédula: `1020304050`
- Contrato: `CV-2026-0042`
- PIN administrativo: `1234`

## Frontend listo para producción

La carpeta `dist/` ya contiene el sitio preparado para subir a un hosting estático. El servidor de producción no necesita Node.js, npm ni ejecutar comandos: solamente sirve esos archivos.

El siguiente comando es una herramienta opcional para el desarrollador cuando modifica el código fuente; no se ejecuta manualmente en producción:

```powershell
npm run build
```

El panel administrativo queda en `admin.html` y el portal de clientes en `index.html`.

### GitHub Pages

El proyecto incluye `.github/workflows/deploy-pages.yml`. Al subir cambios a las ramas `main` o `master`, GitHub prepara y publica el sitio automáticamente. No tienes que abrir una terminal en producción.

En el repositorio de GitHub solo debes seleccionar **Settings → Pages → Source → GitHub Actions**. Después, cada `push` actualiza el sitio.

### Otros hostings

Puedes subir directamente el contenido actual de `dist/`. Si el hosting está conectado al repositorio y ofrece compilación automática, configura `dist` como directorio de publicación; el proceso queda automatizado por la plataforma.

## Backend: un solo archivo en Apps Script

1. Crea o abre el proyecto de Google Apps Script.
2. Reemplaza el contenido del archivo predeterminado `Code.gs` con el [Code.gs](./Code.gs) de este proyecto. No agregues archivos HTML, JavaScript, CSS ni imágenes.
3. Despliega como **Aplicación web**, ejecutando como propietario y con acceso para cualquier usuario que usará el portal.
4. Copia la URL terminada en `/exec` y colócala en `APPS_SCRIPT_URL`, al inicio de [src/common.js](./src/common.js).
5. Publica el frontend mediante GitHub Pages o sube la carpeta `dist/` ya preparada.

La primera llamada del frontend inicializa automáticamente la hoja de cálculo, todas las tablas, el administrador y los triggers. No es necesario ejecutar `setupProject`; queda disponible solamente para diagnóstico o reparación. Al abrir directamente la URL `/exec` se obtiene una respuesta JSON que confirma que la API está lista.

Google puede solicitar al propietario una autorización cuando se despliega por primera vez o cambian los permisos utilizados. Esa confirmación de seguridad es el único paso que Apps Script no permite automatizar.

Para restaurar el PIN de pruebas a `1234`, ejecuta `resetAdminPin`. Esto invalida automáticamente las sesiones anteriores.

## Simular el flujo completo de transferencia

1. Ejecuta `npm run dev` y abre la URL que muestre Vite con `/?demo=1` (por ejemplo, `http://127.0.0.1:5173/?demo=1`). En el servidor local de esta sesión: `http://127.0.0.1:5178/?demo=1`.
2. Pulsa el contrato de demostración `CV-2026-0042`, selecciona los meses y pulsa **Continuar al pago**.
3. Elige una cuenta ficticia y confírmala. Aparecerán el total, los meses, los datos bancarios con botones **Copiar** y las instrucciones para regresar y adjuntar el comprobante.
4. Cambia de aplicación o recarga la página: se recupera la solicitud y el paso donde estabas. Si cierras el modal, usa **Revisar mi transferencia** para retomarlo.
5. Sube cualquier PNG/JPG o PDF de prueba válido, de máximo 4 MB. Puedes usar `assets/logo-vitrinazo.png`. Aparecerá la espera de verificación en el mismo modal; todavía no se pagan los meses.
6. Usa los botones **Aprobar monto exacto**, **Monto incorrecto** o **Rechazar comprobante** para simular la respuesta de Forttu. Solo la aprobación exacta muestra **Pago realizado exitosamente** y paga los meses seleccionados.
7. Pulsa **Reiniciar simulación** en el recuadro de demo para probar otro escenario. El panel de prueba está en `/admin.html?demo=1`, con PIN `1234`, y muestra los pagos simulados.

`?demo=1` utiliza exclusivamente datos locales ficticios, sin llamadas al Apps Script configurado y sin movimientos de dinero. Las solicitudes y la caché del modo real están separadas de la simulación. El archivo del comprobante no se conserva en el navegador; la demo solo persiste que se recibió. No hay aprobación automática por subir un archivo o esperar unos segundos.

PSE y Wompi ya no aparecen en el portal y no se permite iniciar nuevos checkouts por la API pública. Se conserva el código de eventos históricos para las transacciones que pudieran estar en curso en un despliegue anterior.

## Preparación de integración con Forttu

El flujo de transferencia con comprobante está listo para simular: el cliente selecciona meses, elige cuenta, copia los datos, transfiere desde su banco y vuelve a subir el archivo. La pantalla mantiene la espera, consulta automáticamente la verificación y actualiza la cartera solo después de la confirmación del servidor. La consulta autenticada impulsa la conciliación de esa solicitud; una tarea cada minuto sirve de respaldo si el cliente cierra el navegador. La conexión real permanece desactivada hasta que el ingeniero implemente el adaptador oficial y pruebe la API de Forttu. En modo real, el botón explica la indisponibilidad sin ofrecer otros proveedores ni mostrar cuentas ficticias.

La guía principal para el ingeniero es [FLUJO_TRANSFERENCIAS_FORTTU.md](./FLUJO_TRANSFERENCIAS_FORTTU.md). Describe estados, solicitudes persistidas, comprobantes privados, recuperación, pruebas y los dos métodos que conectarán con el proveedor. Es necesario actualizar Apps Script y el frontend para publicar estos cambios; no se ha modificado el despliegue remoto.

También se conserva un conector administrativo GET de solo lectura para diagnóstico y mapeos configurables. Su guía independiente es [INTEGRACION_FORTTU.md](./INTEGRACION_FORTTU.md), con plantilla en [config/forttu.example.json](./config/forttu.example.json). Sus consultas requieren sesión administrativa y no activan el flujo de transferencias.

Ejecutar las pruebas locales del conector con `npm test`.

## Datos

- `CLIENTES`: identificación y contacto.
- `VIVIENDAS`: inventario inmobiliario.
- `CONTRATOS`: relación cliente–vivienda y vigencia.
- `CARTERA`: mensualidades, descuentos, cargos, observaciones y pagos.
- `PAGOS`: transferencias verificadas, pagos manuales e historial de otros medios.
- `ADMINISTRADORES`: cuenta administrativa, hash y salt del PIN.
- `TRANSFERENCIAS`: solicitudes de transferencia, meses, cuenta, estado de verificación y referencias a comprobantes privados.

Cada recurso mantiene una versión independiente en Propiedades del script. El panel precarga hasta 1.000 registros por recurso, conserva el estado en memoria y consulta solamente esas versiones. Si algo cambia, descarga y renderiza en segundo plano únicamente la sección afectada. Los siguientes bloques de 1.000 registros se cargan con **Ver 1.000 más**.

Los triggers instalables de edición y cambio detectan también modificaciones manuales, filas insertadas o eliminadas directamente en Google Sheets. Apps Script no ofrece WebSockets ni SSE persistentes; por eso la sincronización usa comprobaciones adaptativas de bajo costo: más rápidas cuando hay pagos pendientes, pausadas cuando la pestaña no está visible y coordinadas entre pestañas del navegador.

## PWA

La versión web incluye manifiesto, icono, modo standalone, áreas seguras móviles y controles de 16 px para evitar el zoom automático. El frontend se aloja como sitio estático y Apps Script permanece exclusivamente como API.
