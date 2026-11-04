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

La simulación de pagos está activada por defecto en la dirección normal del sitio, para cualquier contrato consultado. No necesita parámetros en la URL ni un contrato de demostración. Las consultas de clientes, contratos y cartera siguen usando el backend configurado; las solicitudes, comprobantes recibidos y abonos de prueba se gestionan en el navegador.

1. Abre [el portal](https://devnnex.github.io/INMOBILIARIA-VITRINAZO.COM/) o ejecuta `npm run dev` y abre la URL que indique Vite. En el servidor local de esta sesión: `http://127.0.0.1:5178/`.
2. Consulta cualquier cédula o contrato registrado, selecciona meses pendientes y pulsa **Continuar al pago**.
3. Elige una cuenta ficticia y confírmala. Aparecerán el total de esos meses, la referencia, los datos para copiar y las instrucciones para regresar y adjuntar el comprobante.
4. Cambia de aplicación o recarga la página: se recupera la solicitud y el paso donde estabas. Si cierras el modal, usa **Revisar mi transferencia** para retomarlo.
5. Sube un PNG/JPG o PDF de prueba válido, de máximo 4 MB. Puedes usar `assets/logo-vitrinazo.png`. Aparecerá la espera de verificación en el mismo modal; todavía no se pagan los meses.
6. Usa **Aprobar monto exacto**, **Monto incorrecto** o **Rechazar comprobante**. Solo la aprobación exacta muestra **Pago realizado exitosamente** y actualiza los meses seleccionados de ese contrato con badge **PAGADO** y saldo cero en la vista local.
7. Cierra el modal: los otros meses y contratos mantienen sus saldos. Recargar o volver a consultar conserva los abonos simulados en ese navegador. **Reiniciar pagos simulados** descarta las pruebas y recupera los saldos del servidor.

El aviso **Simulación de pagos activa** identifica este comportamiento. Las acciones de transferencia no llaman a las funciones todavía inexistentes del backend publicado. Los abonos simulados no escriben en Google Sheets ni en el historial administrativo real, y no se cobran fondos. El comprobante no se almacena en el navegador: solo se conserva que fue recibido. Las solicitudes y la caché de simulación están separadas de los pagos reales.

Para conectar Forttu, implementar y probar el adaptador del backend según la guía de integración y después cambiar `TRANSFER_SIMULATION_ENABLED` a `false` en `src/common.js`. Al desactivar esa constante, las transferencias usan la API real y no se proyectan los abonos de prueba sobre la cartera.
PSE y Wompi ya no aparecen en el portal y no se permite iniciar nuevos checkouts por la API pública. Se conserva el código de eventos históricos para las transacciones que pudieran estar en curso en un despliegue anterior.

## Preparación de integración con Forttu

El flujo completo funciona actualmente con simulación de pagos por defecto para cualquier contrato. La conexión real permanece desactivada hasta que el ingeniero implemente el adaptador oficial y pruebe la API de Forttu. Una vez integrado y desactivada la simulación del frontend, la consulta autenticada impulsará la conciliación de la solicitud y una tarea cada minuto servirá de respaldo si el cliente cierra el navegador.

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
