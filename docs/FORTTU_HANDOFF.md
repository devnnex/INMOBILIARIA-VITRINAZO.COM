# Continuidad de pagos e integración con Forttu

Acuerdo confirmado por el propietario el 4 de noviembre de 2026: el flujo
actual le gusta y debe conservarse al conectar la API. La integración sustituye
la verificación simulada por la respuesta real de Forttu; no implica rediseñar
el portal ni volver a introducir pasarelas PSE o Wompi.

## Experiencia que debe conservarse

1. El cliente consulta por cédula o contrato y elige los meses pendientes.
2. El portal muestra el total correspondiente a esos meses y permite elegir la
   cuenta bancaria y copiar los datos de transferencia.
3. El cliente paga desde su banco, vuelve al sitio y adjunta el comprobante.
   Cambiar de aplicación no cierra la solicitud. Recargar recupera el paso.
4. El selector está en español, permite elegir o arrastrar un archivo y comienza
   el envío automáticamente. La verificación ocurre en el mismo modal.
5. Una aprobación por el importe exacto muestra el éxito con confeti. Al cerrar,
   únicamente los meses de esa solicitud y de ese contrato quedan pagados.
6. Admin refleja el saldo reducido, meses pagados, cliente y movimiento asociado,
   tanto en el resumen como en contratos, cuenta del cliente e historial.
7. Los períodos se muestran como «Noviembre de 2026» en el portal, el modal y
   admin. Las fechas ISO e identificadores de cartera permanecen sin cambios
   para cálculos, relaciones y solicitudes a la API.

## Simulación actual

`TRANSFER_SIMULATION_ENABLED` en `src/common.js` controla los pagos de prueba.
Está activo por defecto, sin parámetros de URL. Se consultan los clientes y
contratos existentes; los pagos simulados y sus efectos se conservan en
`localStorage`, en `vitrinazo-transfer-simulation-v1`.

Portal y admin usan la misma proyección local. Una aprobación actualiza los
saldos y movimientos mostrados; volver a consultar o abrir otra pestaña del
mismo origen y navegador mantiene los resultados. Admin abierto recibe los
cambios del almacenamiento compartido. «Reiniciar» elimina los abonos de prueba
y restaura la vista de los saldos reales, sin borrar datos del servidor.

Los registros simulados no escriben pagos reales en Sheets. No se comparten
entre equipos, navegadores u orígenes diferentes: localhost y GitHub Pages
tienen almacenamientos independientes. Para una demostración, usar portal y
admin en el mismo navegador y dirección de publicación.

Los saldos y estadísticas deben poder proyectarse repetidamente sin descontar
dos veces. Conservar las bases originales de filas, saldos y contadores al
actualizar la vista y al reiniciar. Los pagos de otro contrato no deben verse
afectados, aunque coincidan el cliente, el período o un identificador de fila.

## Conexión real pendiente

No se dispone todavía de documentación, credenciales ni contrato oficial de
Forttu. No inventar rutas, estados externos, firmas o nombres de sus campos.
Los nombres que siguen son internos de Vitrinazo.

La frontera de integración está en `forttuTransferAdapter_()` en `Code.gs`:

- `listBankAccounts(contract)` devuelve las cuentas autorizadas para el contrato.
- `reconcileReceipt(order, receiptBlob, context)` envía el comprobante y obtiene
  su verificación, con reintentos idempotentes por referencia.

`transferProviderContext_(order)` prepara el tercer argumento exclusivamente en
el servidor. Resuelve el cliente a partir del contrato y la solicitud guardada:

```js
{
  reference, contractId,
  customer: { id, document, fullName },
  expectedPayment: {
    amountInCents, currency, accountId,
    months: [{ id, period, amountInCents }]
  }
}
```

El navegador no elige el beneficiario ni suministra la cédula definitiva o el
monto a acreditar. Una consulta por cédula puede devolver varios contratos:
el pago siempre debe tomar el contrato activo y sus meses seleccionados.

El adaptador debe devolver el resultado interno documentado en
[FLUJO_TRANSFERENCIAS_FORTTU.md](../FLUJO_TRANSFERENCIAS_FORTTU.md). Un código de
éxito de Forttu no basta si no coincide la referencia, cuenta, moneda y cantidad.
También debe confirmar el abono y aportar una identidad única de transacción
para impedir reutilizar el mismo pago. El OCR o la recepción de una imagen no
constituyen confirmación del dinero.

Tras una verificación válida, conservar la aplicación existente a cartera,
registro de pago y notificación al portal/admin. El servidor ya dispone de
asignaciones por mes, bloqueo, deduplicación y recuperación de escrituras.

## Pasos para retomar

1. Obtener la documentación oficial y confirmar qué evidencia bancaria valida
   Forttu, cómo identifica una transacción y cómo consulta estados pendientes.
2. Implementar ambos métodos del adaptador, incluyendo el mapeo del contexto
   interno y la autenticación de sus respuestas.
3. Probar aprobación exacta, importe distinto, rechazo, duplicado, interrupción,
   cambio de cartera, recuperación al volver y actualización de admin.
4. Actualizar y autorizar Apps Script, su carpeta privada, propiedades y trigger
   según la guía. Publicar una versión nueva del backend.
5. Cambiar `TRANSFER_SIMULATION_ENABLED` a `false` únicamente con la conexión
   lista y probada. El portal debe conservar exactamente la misma experiencia;
   la cartera e historial pasarán a proceder de la aprobación real del servidor.
6. Publicar el frontend y comprobar el sitio público, además de las pruebas y
   la compilación. Actualizar este documento con las decisiones de la API real.
