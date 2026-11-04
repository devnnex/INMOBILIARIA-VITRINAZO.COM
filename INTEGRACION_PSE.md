# Integración PSE para Vitrinazo

Revisión del código local y de fuentes oficiales: 28 de octubre de 2026.

Estado: diagnóstico y diseño propuesto. Este documento no habilita pagos reales ni acredita una certificación de ACH Colombia. No se ha verificado el despliegue remoto ni la existencia de convenios, credenciales o transacciones en curso.

## Requisito del negocio

El cliente elige uno o varios meses de un contrato, paga por PSE y vuelve al portal. El servidor confirma el resultado por un mecanismo autenticado y aplica el dinero exactamente a las obligaciones guardadas al crear la orden. El portal muestra el resultado confirmado y el estado de cuenta actualizado.

La confirmación y aplicación deben funcionar aunque el cliente cierre el navegador, pierda internet o no regrese desde el banco. Quien paga puede ser distinto del arrendatario: el contrato beneficiario se determina por la orden persistida, nunca por el nombre o correo que regrese del formulario.

## Modalidades oficiales que cumplen la preferencia de evitar Wompi

| Modalidad | Qué ofrece | Qué hay que confirmar |
| --- | --- | --- |
| Conexión directa con PSE | El comercio desarrolla la comunicación segura con ACH. | Vinculación, especificación técnica vigente, autenticación, conectividad, ambientes y certificación exigidos. |
| Pasarela propia de ACH Colombia | Ofrece formulario, carga de facturas y conexión en línea, entre otras funcionalidades. | Modalidad que permita conservar la referencia, controlar el importe, consultar o recibir un resultado verificable y retornar al portal. |

La pasarela de ACH es una candidata para reducir el desarrollo. No se puede asegurar todavía que una modalidad particular satisfaga todo el flujo de Vitrinazo. Un enlace genérico de pago o un formulario que solo envíe un comprobante no prueban que exista integración automática con la cartera.

La conexión directa exige cuenta de ahorros o corriente con convenio de recaudo, página web, empresa legalmente constituida e infraestructura tecnológica. La vinculación empieza por la entidad financiera. Según PSE, el abono a las cuentas recaudadoras depende de las políticas y horarios del banco; no se debe diseñar una billetera con retiros como requisito de esta integración. Las tarifas se deben cotizar, no inferir.

Fuentes: [conexión directa](https://www.pse.com.co/conexi%C3%B3n-directa), [pasarela propia](https://www.pse.com.co/pasarela-de-pagos), [conexión en línea](https://www.pse.com.co/conexi%C3%B3n-en-l%C3%ADnea), [centro de ayuda](https://www.pse.com.co/empresa-centro-de-ayuda).

## Hallazgos del código actual

| Ubicación | Comportamiento observado | Consecuencia |
| --- | --- | --- |
| `index.html`, `src/client.js`, `Code.gs:createWompiCheckout` | Ambas opciones de pago crean un enlace a `checkout.wompi.co`. | Actualmente no hay integración directa con ACH ni con su pasarela propia. |
| `Code.gs:createWompiCheckout` | Recalcula el saldo de los meses del contrato y guarda sus asignaciones en `detalleJson`. | Es una base útil para relacionar un pago con obligaciones concretas. |
| `Code.gs:processWompiEvent_` | Procesa un evento y firma con formato específico de Wompi. | No sirve como receptor de confirmaciones de PSE sin conocer el protocolo contratado. |
| `Code.gs:updatePaymentFromGateway_` | Guarda `APROBADO` antes de aplicar la cartera; los reintentos salen si ya está aprobado. | Un fallo entre ambas operaciones puede dejar un pago aprobado con meses sin actualizar. |
| `Code.gs:applyPaymentAllocations_` | Suma al valor pagado, limita el resultado con `Math.min` y omite obligaciones inexistentes. | Puede ocultar un excedente o una asignación incompleta si cambió la deuda o desapareció una fila. |
| `Code.gs:createWompiCheckout` | Deja de bloquear intentos pendientes después de 20 minutos, sin consultar su resultado bancario. | Un segundo intento puede coexistir con uno que después resulte aprobado. |
| `Code.gs:updatePaymentFromGateway_` | Compara importes redondeados al peso y no comprueba moneda en esa función. | Hay que validar importe en unidades menores, moneda, comercio e identidad de la transacción contra la orden. |
| `src/client.js:handlePaymentReturn` | Consulta hasta diez veces y muestra un aviso temporal cuando encuentra aprobación. | Falta el modal de resultado solicitado y una recuperación persistente de operaciones pendientes. |

El bloqueo de Apps Script evita algunas ejecuciones concurrentes, pero no convierte las escrituras independientes de las hojas en una transacción con reversión automática. Intercambiar el nombre del proveedor no corrige estos problemas.

## Flujo propuesto

1. El backend valida contrato, obligaciones, saldos y la posibilidad de iniciar otro intento. Recalcula el total sin aceptar el monto del navegador.
2. Persiste una orden con referencia impredecible, cliente y contrato beneficiarios, importe, moneda y asignación por obligación. Conserva una clave para que reintentar la misma solicitud no cree otro cobro.
3. Inicia el pago mediante el protocolo oficial contratado. Guarda el identificador externo y entrega únicamente la dirección autorizada de pago. Ante un timeout, conserva el estado incierto y reconcilia antes de crear otro intento.
4. El cliente autoriza en el banco. Vitrinazo no recibe claves bancarias.
5. Una notificación autenticada o una consulta del servidor confirma la operación, según el manual vigente. El retorno del navegador solo permite localizar y consultar la orden; no modifica saldos.
6. El backend verifica referencia, comercio, identificador, importe y moneda. Registra la evidencia y aplica las asignaciones una sola vez mediante una operación recuperable. Un mensaje repetido no vuelve a descontar.
7. El portal consulta el resultado persistido y carga la cartera actualizada. Muestra un modal de éxito cuando la aprobación está verificada y la aplicación terminó; conserva estados separados para pendiente, rechazo, cancelación y aprobación con aplicación por resolver.
8. Una tarea de conciliación revisa intentos sin estado final y aplicaciones incompletas, aunque nadie tenga abierta la página. Los reembolsos o reversos se registran como movimientos nuevos y auditables.

No liberar meses para un nuevo cobro solamente por tiempo transcurrido. Si hubo un pago manual, un ajuste o dos pagos bancarios reales sobre la misma deuda, el dinero debe quedar explicado: aplicar lo que corresponda y registrar el excedente o una incidencia. No borrarlo mediante un límite numérico.

## Persistencia e infraestructura

Para el núcleo monetario recomiendo un backend con una base de datos que soporte transacciones, restricciones únicas y un registro de movimientos por obligación. La orden, la confirmación y sus asignaciones deben poder recuperarse tras una interrupción. Sheets puede conservarse como reporte; si se cambia la fuente de verdad de cartera, también los pagos manuales y ajustes deberán pasar por el mismo núcleo para evitar dos saldos diferentes.

Es una recomendación de arquitectura basada en los fallos observados, no un requisito confirmado de ACH para este convenio. Antes de elegir hosting se debe contrastar su manual con las capacidades disponibles. La interfaz documentada de las web apps de Apps Script no expone cabeceras HTTP arbitrarias y `UrlFetchApp` usa infraestructura de red de Google. Si ACH exige autenticación en cabeceras entrantes, certificados de cliente, IP dedicada o conectividad privada, hay que validar cada requisito antes de comprometer Apps Script como integrador.

Referencias de Google: [eventos de las web apps](https://developers.google.com/apps-script/guides/web), [UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app).

## Información pendiente

- Banco recaudador y existencia de convenio PSE o vinculación con ACH.
- Si recauda la inmobiliaria en una cuenta propia o si cada propietario recibe en una cuenta distinta. No son diseños intercambiables y se debe validar su tratamiento con banco y ACH.
- Modalidad ofrecida y manual técnico vigente: creación, consulta, autenticación de avisos si existen, referencias, estados, retornos, conciliación y reversos.
- Ambientes de prueba y producción, proceso de certificación y condiciones comerciales.
- Existencia de pagos Wompi pendientes antes de retirar su receptor de eventos. Los registros históricos se conservan; cualquier transición necesita conciliación de operaciones en curso.

No compartir secretos en el chat ni incorporarlos al frontend o al repositorio. Los endpoints, campos y mecanismos de autenticación se implementarán a partir de la documentación entregada para el convenio; este diagnóstico no los presupone.

## Criterios de aceptación de la integración

- Un pago aprobado de varios meses aplica exactamente su importe al contrato guardado en la orden.
- Rechazos, cancelaciones y resultados inciertos no descuentan cartera.
- Manipular la URL de regreso, importe o identificadores del navegador no aprueba pagos ni cambia el beneficiario.
- Confirmaciones repetidas, tardías o fuera de orden y solicitudes simultáneas no duplican asignaciones.
- Un timeout al crear el pago se resuelve sin originar inadvertidamente otro cobro.
- Una interrupción entre confirmar y aplicar se recupera sin perder ni duplicar dinero.
- Un pago confirmado sin retorno del usuario actualiza la cartera igualmente.
- Un ajuste o pago manual durante la operación no elimina ni oculta un excedente.
- El modal de éxito muestra el resultado confirmado; una aplicación incompleta tiene un mensaje específico y queda en conciliación.
- Las pruebas oficiales y la certificación que correspondan al convenio se completan antes de activar dinero real.
