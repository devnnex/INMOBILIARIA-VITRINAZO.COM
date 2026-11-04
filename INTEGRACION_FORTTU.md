# Preparación de la integración con Forttu

Fecha: 29 de octubre de 2026.

Estado: base implementada en el código local, desactivada por defecto. No se ha conectado a Forttu ni actualizado el despliegue remoto de Apps Script. No se dispone todavía de su documentación, rutas ni credenciales. Los nombres de parámetros de este documento pertenecen a Vitrinazo; no describen una API oficial de Forttu.

**Alcance aclarado:** el cliente transfiere desde su banco, sube un comprobante y Forttu verifica el abono antes de actualizar los meses. El flujo específico preparado, sus estados y el contrato que debe implementar el ingeniero están en [FLUJO_TRANSFERENCIAS_FORTTU.md](./FLUJO_TRANSFERENCIAS_FORTTU.md). El resto de este documento describe el conector administrativo GET, que permanece disponible como herramienta independiente.

## Qué se entrega

El conector vive en `Code.gs`, conservando el despliegue del backend en un único archivo. El portal continúa utilizando su API actual.

```text
Portal / panel → API de Vitrinazo → conector Forttu → API autorizada del proveedor
                     ↓
               Sheets actual
```

El conector permite diagnosticar la configuración, probar una ruta GET y obtener una vista previa de un recurso. Solo las sesiones administrativas válidas pueden ejecutar esas acciones. Las credenciales se leen de las Propiedades del script, nunca del navegador.

Las consultas no guardan datos en Sheets, no generan contratos, no modifican cartera y no aprueban pagos. `imported: false` identifica esta fase. Se mantiene el flujo existente de Wompi: el conector no lo sustituye.

## Configuración del servidor

En Google Apps Script → Configuración del proyecto → Propiedades del script:

| Propiedad | Valor |
| --- | --- |
| `FORTTU_ENABLED` | `false` o ausente durante la preparación. Solo el texto exacto `true` permite consultas externas. |
| `FORTTU_CONFIG_JSON` | JSON de configuración técnica descrito abajo. |
| `FORTTU_API_TOKEN` | Credencial de servidor entregada para el ambiente elegido. No incluirla en el JSON, frontend, repositorio ni documentación. |

Copiar como punto de partida [config/forttu.example.json](./config/forttu.example.json). Es una plantilla deliberadamente incompleta: no contiene un dominio ni rutas supuestas de Forttu. Su copia por sí sola no habilita una conexión.

Contrato de configuración de Vitrinazo:

| Campo JSON | Significado |
| --- | --- |
| `baseUrl` | URL HTTPS final autorizada, con prefijo de API opcional, sin barra final. No admite credenciales, query, fragmentos, direcciones IP ni puertos personalizados. |
| `auth.type` | `bearer` para `Authorization: Bearer …`, o `apiKey` para enviar la credencial en una cabecera. Debe coincidir con la documentación recibida. |
| `auth.header` | Solo para `apiKey`: nombre real de la cabecera del proveedor. |
| `testPath` | Ruta GET relativa autorizada para verificar conectividad. Debe devolver JSON y tener acceso con la credencial configurada. Puede omitirse si solo se probarán recursos. |
| `resources` | Recursos habilitados explícitamente, inicialmente `{}`. No se deducen endpoints. |

Si Forttu exige OAuth con renovación, firmas, certificados u otro mecanismo, el ingeniero deberá adaptar `forttuConfig_` y `forttuGet_`. No se ha confirmado qué autenticación utiliza. Separar credenciales y despliegues de pruebas y producción; no activar producción para probar.

## Configurar recursos y mapeos

Las claves admitidas son `clients`, `properties`, `contracts`, `ledger` y `payments`. Son posibilidades del modelo local, pendientes de confirmar según el alcance acordado. Ningún recurso viene activado.

Cada entrada de `resources` debe incluir:

| Campo | Descripción |
| --- | --- |
| `path` | Ruta GET relativa, por ejemplo `/ruta_confirmada`. Solo segmentos con letras, números, `_` y `-`; sin URL completa, parámetros, variables ni `..`. Otras convenciones requieren adaptar la validación. |
| `itemsPath` | Ruta de la lista en el JSON, por ejemplo `data.items`, o `""` si la respuesta raíz es una lista. |
| `fields` | Mapa de campo local → ruta del campo remoto. Solo se devuelven los campos mapeados. `id` es obligatorio. |
| `query` | Opcional: mapa de `page`, `limit`, `cursor` a los nombres oficiales de los parámetros GET. No se envían parámetros no configurados. |
| `nextCursorPath` | Opcional: ruta del siguiente cursor en la respuesta. No se sigue automáticamente. |

Ejemplo **ficticio** de una entrada `clients`, que se debe reemplazar según la documentación del proveedor:

```json
{
  "path": "/ruta_confirmada_de_clientes",
  "itemsPath": "data.items",
  "fields": {
    "id": "identificador_externo",
    "documento": "identificacion.numero",
    "nombre": "nombre_completo"
  },
  "query": {
    "page": "parametro_de_pagina",
    "limit": "parametro_de_tamano",
    "cursor": "parametro_de_cursor"
  },
  "nextCursorPath": "data.siguiente_cursor"
}
```

Los destinos admitidos están definidos por `APP.headers` en `Code.gs`:

| Recurso | Modelo local | Campos principales de destino |
| --- | --- | --- |
| `clients` | `CLIENTES` | `id`, `documento`, `nombre`, `email`, `telefono`, `estado`, `creadoEn` |
| `properties` | `VIVIENDAS` | `id`, `codigo`, `direccion`, `ciudad`, `barrio`, `tipo`, `canon`, `estado`, `creadoEn` |
| `contracts` | `CONTRATOS` | `id`, `clienteId`, `viviendaId`, `fechaInicio`, `fechaFin`, `canonMensual`, `estado`, `deposito`, `creadoEn` |
| `ledger` | `CARTERA` | `id`, `contratoId`, `periodo`, `fechaVencimiento`, `valorBase`, `descuento`, `cargoExtra`, `observacion`, `estado`, `valorPagado`, `pagoId`, `actualizadoEn` |
| `payments` | `PAGOS` | `id`, `contratoId`, `clienteId`, `valor`, `metodo`, `estado`, `referencia`, `transaccionId`, `detalleJson`, `creadoEn`, `pagadoEn`, `nota` |

Las rutas de campos usan nombres separados por puntos. Los valores deben ser escalares; transformar arreglos u objetos requiere un adaptador específico. Se conservan identificadores y documentos como texto, incluidos sus ceros iniciales. Se rechazan identificadores numéricos fuera del rango entero seguro y registros sin `id` o con `id` repetido dentro de la muestra. Los tipos, relaciones, estados, fechas e importes todavía requieren validación de negocio antes de importar.

El `id` de la vista previa pertenece al sistema externo. Antes de persistir, implementar una tabla de equivalencias `(proveedor, recurso, idExterno) → idLocal`, con unicidad. No sobrescribir los identificadores actuales ni tratar referencias externas como identificadores locales de contratos o clientes.

## Acciones disponibles en la API actual

Se llaman por POST a la URL `/exec` de Vitrinazo, usando el sobre existente `{ action, args }`. Todas requieren el token de una sesión administrativa vigente como primer argumento.

| Acción | `args` | Resultado |
| --- | --- | --- |
| `getForttuStatus` | `[token]` | Configuración y activación; no hace consultas externas ni revela el secreto. `configured` indica validación local; no confirma conectividad. |
| `testForttuConnection` | `[token]` | Ejecuta un GET a `testPath`. `reachable: true` significa respuesta HTTP 2xx con JSON válido; no certifica permisos sobre todos los recursos ni la integración completa. |
| `previewForttuResource` | `[token, recurso, opciones]` | Obtiene una página y devuelve registros mapeados, sin importar. |

Ejemplo para el ingeniero desde la consola del panel con sesión iniciada; reemplazar la URL por la del despliegue actualizado:

```js
const apiUrl = 'PEGAR_URL_APPS_SCRIPT_TERMINADA_EN_EXEC';
async function forttu(action, ...args) {
  const token = sessionStorage.getItem('vitrinazo-admin-token');
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, args: [token, ...args] })
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error);
  return payload.data;
}

await forttu('getForttuStatus');
// Después de configurar y habilitar el ambiente de prueba:
await forttu('testForttuConnection');
// Solo si clients y su parámetro limit ya fueron configurados:
await forttu('previewForttuResource', 'clients', { limit: 50 });
```

La vista previa devuelve un máximo de 100 registros y marca `truncated` cuando la página recibida excede ese límite. En ese caso se debe reducir el tamaño de página antes de implementar una sincronización; no avanzar el cursor ignorando los registros omitidos. `received` cuenta la página recibida, no el total de la base. La página puede empezar en 0 o 1, según el proveedor; el conector no lo presupone. No hay recorrido automático de páginas, sincronización programada ni política de reintentos.

Las redirecciones HTTP se rechazan para evitar reenviar la credencial a otro destino. Los errores HTTP incluyen solo el código y una orientación general; no devuelven cuerpos del proveedor ni excepciones de transporte. Los fallos no se reintentan automáticamente. El tamaño de respuesta JSON admitido es de hasta un millón de caracteres, comprobado después de la descarga. No se registra el contenido de las respuestas.

## Entrega al ingeniero

1. Usar [FLUJO_TRANSFERENCIAS_FORTTU.md](./FLUJO_TRANSFERENCIAS_FORTTU.md) para el alcance confirmado de transferencia y comprobante. Las consultas generales de este documento son opcionales para el ingeniero.
2. Obtener manual técnico vigente, dominio autorizado, autenticación, credenciales de pruebas, permisos, rutas, ejemplos de JSON, filtros, paginación y límites de consulta.
3. Actualizar `Code.gs` en Apps Script y crear una nueva versión del despliegue. El código local no actualiza por sí solo el backend publicado.
4. Configurar las propiedades del ambiente de pruebas y comprobar primero `getForttuStatus`. Activar `FORTTU_ENABLED=true` solo cuando estén listas las consultas.
5. Ejecutar la prueba de conexión y las vistas previas. Verificar identificadores, caracteres, documentos, relaciones, estados, fechas, moneda y unidad monetaria con datos conocidos.
6. Diseñar e implementar la persistencia con equivalencias de identificadores, deduplicación, reglas de conflicto, auditoría, bajas y recuperación tras interrupciones. Solo entonces habilitar sincronización. Las escrituras a Sheets deben actualizar las versiones locales mediante `markDataChanged_`.
7. Para pagos, completar el adaptador oficial del flujo preparado en [FLUJO_TRANSFERENCIAS_FORTTU.md](./FLUJO_TRANSFERENCIAS_FORTTU.md) y validar su operación real. Una fila remota con texto `APROBADO` no basta para acreditar cartera. [INTEGRACION_PSE.md](./INTEGRACION_PSE.md) conserva el diagnóstico anterior de alternativas PSE; no define este flujo de transferencia con comprobante.
8. Si Forttu envía webhooks, verificar su protocolo antes de añadir un receptor. El evento documentado de web apps de Apps Script no expone cabeceras HTTP arbitrarias; si la firma requiere esas cabeceras u otras capacidades no disponibles, usar un servicio receptor adecuado. No habilitar un webhook genérico sin validación.
9. Validar el intercambio completo en pruebas antes de configurar producción. Para deshabilitar nuevas consultas, establecer `FORTTU_ENABLED=false`; no elimina datos ni revoca solicitudes ya enviadas.

Referencias de infraestructura: [UrlFetchApp](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app) y [eventos y despliegues de web apps](https://developers.google.com/apps-script/guides/web). Estas fuentes describen Google Apps Script, no el contrato de Forttu.

## Verificación local

```powershell
npm test
npm run build
```

Las pruebas ejecutan el backend en un entorno simulado sin red ni acceso a Sheets. Cubren autenticación, desactivación, configuración, mapeos, paginación, identificadores, errores, límites y protección de credenciales. No certifican conectividad ni compatibilidad con una API real de Forttu.
