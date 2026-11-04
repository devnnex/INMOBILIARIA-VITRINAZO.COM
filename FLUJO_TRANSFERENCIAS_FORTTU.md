# Transferencias de arriendo con comprobante y Forttu

Alcance confirmado por el usuario: el cliente elige uno o varios meses, consulta las cuentas bancarias registradas en Forttu, transfiere desde su banco y sube un comprobante a Vitrinazo. El servidor envía ese comprobante a Forttu y consulta su verificación. Solo una confirmación válida del abono permite actualizar los meses y mostrar el éxito.

Estado de entrega: simulación de pagos activa por defecto en la URL normal, para cualquier contrato consultado, con pruebas automatizadas. No requiere parámetros ni datos de un contrato de demostración. Las consultas siguen usando el backend existente; las transferencias se simulan en el navegador. Solo la aprobación exacta actualiza la vista local de los meses seleccionados del contrato correspondiente. Recargar conserva ese resultado y **Reiniciar pagos simulados** restaura los saldos del servidor. **El adaptador oficial de Forttu sigue pendiente y los pagos reales están desactivados.** No se ha publicado el backend ni se ha realizado una transferencia real. El conector GET de consultas generales es independiente de este flujo.

La constante `TRANSFER_SIMULATION_ENABLED = true` de `src/common.js` mantiene la simulación incluso con un backend configurado o anterior a las transferencias. Al conectar Forttu, implementar y probar los dos métodos del adaptador, actualizar Apps Script y su configuración, y cambiar esa constante a `false`. La caché y las capacidades de las transferencias reales usan claves diferentes; los abonos locales dejan de proyectarse al desactivar la simulación. El recorrido y la persistencia del servidor descritos a continuación corresponden a esa integración real.

## Recorrido preparado

1. El cliente selecciona meses de un contrato en el estado de cuenta y pulsa **Continuar al pago**, que abre directamente la transferencia bancaria. PSE y Wompi se retiraron de la interfaz y la creación de nuevos checkouts de la API pública; se conserva el procesamiento histórico de eventos.
2. Vitrinazo obtiene del servidor las cuentas disponibles para ese contrato. El cliente selecciona la cuenta.
3. El backend recalcula los saldos y guarda una solicitud con referencia única, contrato beneficiario, cliente, cuenta, moneda, total en centavos y asignación por mes. Los datos bancarios de la solicitud son una copia de la respuesta del servidor; el navegador no puede reemplazarlos.
4. El portal muestra el importe exacto, los meses, la referencia, banco, titular, documento, tipo y número de cuenta, con botones para copiar. Indica expresamente que el cliente debe transferir desde su banco, volver a esta misma pantalla y adjuntar el pantallazo. Cambiar de aplicación o pestaña no cierra el modal ni cambia la solicitud.
5. El cliente sube PDF, JPG o PNG de hasta 4 MiB. El backend comprueba tamaño, contenido inicial y tipo, guarda el archivo en una carpeta privada de Drive y registra su hash. El comprobante no se convierte en un enlace público ni se guarda en el navegador.
6. La solicitud pasa a **Pendiente de verificación**. La carga del archivo no marca meses como pagados.
7. El modal permanece en espera y consulta `refreshTransferOrder` aproximadamente cada diez segundos, y al volver a la pestaña. La consulta autentica la capacidad y procesa únicamente esa solicitud, con un intervalo mínimo de ocho segundos entre intentos interactivos. Un trigger cada minuto respalda el envío y consulta aunque el usuario cierre el navegador. Ambos caminos comparten el mismo bloqueo y la misma lógica de conciliación. El adaptador debe resolver envíos y reintentos por referencia sin duplicarlos.
8. El servidor valida el resultado autenticado, referencia, cuenta, moneda, importe e identidad única de la transacción bancaria. Si coinciden y el abono está confirmado, aplica la solicitud. Si la deuda cambió, otro pago la cubrió o la transacción ya se utilizó, conserva el caso en revisión.
9. Después de aplicar todos los meses, el portal muestra **Pago realizado exitosamente** en el mismo modal y obtiene un estado de cuenta fresco, sin reutilizar la caché anterior al pago. Recargar mientras se espera el archivo o la respuesta recupera automáticamente la solicitud en la misma pestaña. Si el modal se cierra expresamente, **Revisar mi transferencia** permite retomarlo en el mismo navegador. Una aprobación elimina el acceso pendiente del navegador para permitir un pago posterior, conservando el historial en el servidor.

No se solicita al usuario la clave de su banco. La recuperación conserva en almacenamiento local la referencia y una capacidad de acceso a la solicitud por contrato, sin el comprobante. Esa capacidad es sensible: no debe registrarse en logs, compartirse ni añadirse a una URL. Si el navegador elimina sus datos, la inmobiliaria deberá localizar la solicitud por su referencia; el autoservicio de recuperación entre dispositivos queda pendiente del modelo de autenticación que se acuerde.

## Estados de la solicitud

| Estado | Significado | ¿Puede mostrarse éxito? |
| --- | --- | --- |
| `ESPERANDO_COMPROBANTE` | Solicitud creada; falta subir el archivo. | No |
| `PENDIENTE_VERIFICACION` | Archivo guardado; falta respuesta válida de Forttu. | No |
| `VERIFICADO` | Evidencia validada y persistida; falta aplicar. | No |
| `APLICANDO` | Se están actualizando los meses; admite recuperación. | No |
| `APROBADO` | Todos los meses aplicados y pago registrado. | Sí |
| `RECHAZADO` | Respuesta autenticada de rechazo del comprobante. | No |
| `EN_REVISION` | Hay una discrepancia que necesita conciliación. | No |

Una solicitud pendiente no se libera por tiempo transcurrido. Los meses quedan bloqueados para crear otra transferencia mientras exista una solicitud no rechazada que los incluya. Los pagos manuales y ajustes existentes pueden producir una discrepancia; se detecta antes de aplicar la transferencia y se deriva a revisión. El flujo de cancelación, sustitución de comprobantes y atención de solicitudes abandonadas requiere una política acordada con el ingeniero; no se ha supuesto que no hubo un abono solo porque pasó tiempo.

## Persistencia y recuperación

`APP.schemaVersion` pasa a `5`. La inicialización crea `TRANSFERENCIAS` sin modificar las columnas de las tablas anteriores. Esta tabla conserva la solicitud, cuenta, asignaciones, comprobante privado, evidencia normalizada y estado. La referencia se guarda también en `PAGOS` al aplicar, usando `metodo=TRANSFERENCIA_FORTTU`.

Cada asignación guarda el importe previo pagado y el importe final esperado. Al aplicar, se valida el conjunto completo antes de escribir. Cada fila escribe el importe final y el marcador del pago en una sola operación. Un reintento omite las filas ya aplicadas que coincidan exactamente; no suma nuevamente el dinero. Si hubo una edición o un pago distinto, se detiene en revisión. El éxito de la solicitud se guarda después de aplicar la cartera y actualizar las versiones que consulta el portal.

Sheets no ofrece una transacción que abarque todas estas filas y tablas: durante una interrupción puede haber meses parcialmente actualizados mientras la solicitud sigue en `APLICANDO`. Las pruebas cubren recuperación bajo las escrituras previstas por el servicio. Las ediciones directas de la hoja, las reglas de negocio y las pruebas reales del despliegue deben revisarse antes de producción. Si se requiere atomicidad estricta o mayor concurrencia, trasladar la misma operación a almacenamiento transaccional.

Los errores de transporte conservan la solicitud pendiente, sin aprobarla ni liberar los meses. No se guardan mensajes privados del proveedor. Un resultado pendiente no crea un pago aprobado. Se deduplican el hash del comprobante y la identidad de la transacción bancaria entre solicitudes.

## Contrato interno del adaptador para el ingeniero

Implementar **`forttuTransferAdapter_()` en `Code.gs`**. Actualmente devuelve `ready: false` y sus métodos rechazan cualquier uso. Establecer una propiedad por sí sola no lo activa.

### `listBankAccounts(contract)`

Debe consultar las cuentas de Forttu autorizadas para el contrato. Devuelve una lista, máximo veinte cuentas, con estos campos de texto:

```js
{
  id, bankName, holderName, holderDocument, accountType, accountNumber
}
```

Estos son nombres **internos de Vitrinazo**, no nombres confirmados de la API externa. El adaptador traduce los campos reales. Los números de cuenta e identificaciones deben conservarse como texto.

### `reconcileReceipt(order, receiptBlob)`

Recibe una solicitud persistida y el archivo privado. Debe enviar el archivo según el protocolo real, consultar el resultado y resolver reintentos usando `order.id` como referencia e idempotencia. Si la API devuelve un identificador de envío necesario para consultas posteriores, persistirlo de forma recuperable; no depender de memoria de ejecución. Un timeout no autoriza reenviar como si fuera otro pago.

Devuelve este contrato **interno**:

```js
{
  status: 'PENDING', // o 'REJECTED' o 'VERIFIED'
  authenticated: true,
  reference: order.id,
  // Obligatorios para VERIFIED:
  settled: true,
  accountId: 'identificador-de-la-cuenta-de-destino',
  currency: 'COP',
  amountInCents: 1234500,
  transactionId: 'identidad-unica-estable-del-abono-bancario',
  verificationId: 'identificador-de-la-verificacion'
}
```

`authenticated` significa que el adaptador validó una respuesta de servidor según el protocolo oficial. `settled` debe significar que Forttu confirma el abono real en la cuenta de destino. **La extracción de texto, legibilidad o autenticidad aparente de un comprobante no acredita por sí sola el abono.** Si Forttu no ofrece esa confirmación o una identidad bancaria que permita deduplicar, se debe acordar conciliación adicional antes de automatizar la aprobación.

No establecer `VERIFIED` porque el envío del archivo obtuvo HTTP 200. La respuesta de recepción del archivo puede ser solo un acuse. El navegador no suministra ni puede invocar estos resultados internos. Los webhooks, si existen, necesitarán autenticación conforme a su documentación; no se incluye un receptor supuesto.

La identidad bancaria interna debe ser única y estable en el ámbito del proveedor, comenzando por una letra o número y usando solo letras ASCII, números, `_`, `.`, `:`, `/` o `-`, con máximo 200 caracteres. El adaptador debe normalizar otros formatos sin colisiones y conservar su correspondencia externa. Esta restricción también evita almacenar fórmulas como identificadores en Sheets. `verificationId` tiene un máximo de 200 caracteres.

## Configuración y activación posteriores

| Propiedad del script | Uso |
| --- | --- |
| `FORTTU_TRANSFER_ENABLED` | Ausente o `false` mantiene la opción desactivada. `true` requiere además un adaptador implementado con `ready: true`. |
| `FORTTU_API_TOKEN` | Credencial del servidor si el protocolo real la utiliza; adaptar autenticación según documentación. |
| `FORTTU_RECEIPTS_FOLDER_ID` | Carpeta dedicada de Mi unidad, privada y sin espectadores, editores adicionales ni acceso por enlace. El backend comprueba estos permisos antes de crear archivos. |
| `FORTTU_ORDER_ACCESS_SECRET` | Clave generada automáticamente al crear la primera solicitud, bajo bloqueo. No cambiarla: invalida las capacidades emitidas. No publicarla. |

El conector administrativo GET usa `FORTTU_ENABLED` y `FORTTU_CONFIG_JSON`; esas propiedades no activan transferencias. El adaptador puede reutilizar el transporte GET si el contrato lo permite, pero el envío de archivos, autenticación y consultas específicas deben implementarse según el manual.

Secuencia de entrega:

1. Obtener el manual, ambientes, credenciales y ejemplos reales: cuentas, envío de comprobantes, consulta, estados y autenticación.
2. Confirmar qué prueba Forttu con su verificación, cómo identifica un abono único, si verifica moneda/importe/cuenta y cómo relaciona la referencia de Vitrinazo.
3. Implementar y probar los dos métodos del adaptador y su idempotencia. Definir atención de rechazos, revisión, pagos parciales, excedentes, comprobantes reemplazados y solicitudes sin archivo.
4. Preparar la carpeta privada y la política de conservación de comprobantes. Usar un despliegue y credenciales de pruebas.
5. Actualizar `Code.gs` en Apps Script y crear una versión del despliegue. Autorizar los permisos nuevos de Drive que Google solicite. Publicar también el frontend actualizado.
6. Con el adaptador probado, poner `FORTTU_TRANSFER_ENABLED=true` y ejecutar `setupForttuTransferReconciliation()` desde el editor. Instala una sola tarea cada minuto. Si ya se instaló una tarea con la versión anterior cada cinco minutos, eliminar ese trigger y ejecutar de nuevo la función. Revisar sus ejecuciones y cuotas.
7. Probar el recorrido real completo, incluida la recuperación sin navegador, antes de configurar producción.

Desactivar la propiedad detiene nuevas solicitudes, cargas y la tarea de conciliación. La consulta de una solicitud existente sigue disponible con su capacidad. Desactivar no cancela transferencias bancarias ya realizadas ni elimina solicitudes; se debe atender la conciliación pendiente.

## API pública de Vitrinazo

Se conserva el sobre POST `{ action, args }` del backend actual:

| Acción | Argumentos | Resultado |
| --- | --- | --- |
| `getTransferAvailability` | `[]` | Disponibilidad y restricciones del comprobante, sin secretos. |
| `getTransferBankAccounts` | `[contractId]` | Cuentas de destino válidas para el contrato. |
| `createTransferOrder` | `[contractId, ledgerIds, accountId, requestId]` | Solicitud con referencia y capacidad de acceso. El servidor calcula el total. |
| `submitTransferReceipt` | `[reference, accessToken, { mimeType, base64 }]` | Estado persistido; cargar un archivo no aprueba. |
| `getTransferOrder` | `[reference, accessToken]` | Estado, meses, importe y cuenta; sin archivo, hash ni evidencia privada. |
| `refreshTransferOrder` | `[reference, accessToken]` | La misma consulta autenticada; además impulsa la verificación y aplicación de esa solicitud cuando corresponde. No acepta resultados de aprobación del navegador. |

La creación exige una clave aleatoria de solicitud de entre 20 y 80 caracteres. El portal utiliza UUID y conserva esa clave antes de enviar; repetir la misma solicitud devuelve la misma referencia y capacidad. Cambiar sus meses, cuenta o contrato con la misma clave se rechaza. La capacidad evita que conocer solo una referencia permita subir o consultar comprobantes. El portal existente consulta contratos por documento o código; antes de activar recaudos, el ingeniero debe revisar el modelo de identidad del cliente, los permisos, las cuotas y la recuperación entre dispositivos para el uso real previsto.

## Pruebas

`npm test` verifica el aislamiento de contratos, autorización de las solicitudes, totales del servidor, duplicados, archivos, cuentas privadas, estados, comprobantes rechazados, respuestas no autenticadas, importe/moneda/cuenta incorrectos, recuperación de escrituras y cambios de cartera durante la verificación. Incluye el modo demo, su persistencia al recargar y su aislamiento de la URL real. El adaptador en estas pruebas es ficticio, sin red ni dinero real.

Para demostrar el flujo completo al ingeniero, seguir los pasos de [README.md](./README.md#simular-el-flujo-completo-de-transferencia). Mientras `TRANSFER_SIMULATION_ENABLED` está activo, seleccionar o arrastrar un comprobante inicia el envío; la consulta local completa automáticamente la verificación simulada tras un breve intervalo y muestra un modal de éxito con confeti. La fecha de verificación se persiste para recuperarse al recargar. Antes de aprobar se vuelven a comparar los importes de los meses. Los resultados de rechazo y discrepancia se conservan como casos de pruebas automatizadas, sin controles de aprobación manual en la interfaz. Este comportamiento automático pertenece exclusivamente al simulador: al desactivarlo, solo el resultado autenticado del servidor puede aprobar. Apps Script no expone `simulateTransferVerification` ni los métodos internos de conciliación.

Referencias de infraestructura: [carpetas de Drive en Apps Script](https://developers.google.com/apps-script/reference/drive/folder), [UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app) y [web apps](https://developers.google.com/apps-script/guides/web). No documentan capacidades de Forttu.
