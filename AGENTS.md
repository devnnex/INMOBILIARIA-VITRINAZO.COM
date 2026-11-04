# Contexto de Vitrinazo

Antes de cambiar pagos, simulación, cartera o su futura integración, leer
[docs/FORTTU_HANDOFF.md](docs/FORTTU_HANDOFF.md).

## Decisiones del propietario

- Conservar el flujo y el diseño de pago actuales al integrar Forttu: meses,
  cuenta bancaria, comprobante, espera, éxito con confeti y meses pagados.
- No volver a introducir PSE o Wompi como opciones de pago.
- La simulación funciona en la URL normal y con cualquier contrato consultado
  por código o cédula. También debe reflejarse en admin en el mismo navegador.
- Mantener `TRANSFER_SIMULATION_ENABLED = true` hasta conectar y probar la API
  oficial. Una imagen válida solo autoriza éxito en el simulador; en producción
  se exige la confirmación autenticada del abono por el importe exacto.
- Asociar los pagos mediante contrato y cliente, nunca mediante el texto de la
  búsqueda o solamente el nombre de un mes.
- Mostrar los períodos con `formatRentalMonth`, por ejemplo «Noviembre de 2026».
  Conservar los identificadores y valores canónicos en almacenamiento y API.

## Arquitectura y comprobación

- Frontend: Vite multipágina, `src/client.js`, `src/admin.js`, `src/transfer.js`.
- API y persistencia real: Google Apps Script en `Code.gs` y Google Sheets.
- Simulador y proyección compartida portal/admin: `src/common.js`.
- Ejecutar `npm test` y `npm run build` para cambios de pagos. La comprobación
  opcional de navegador está en `scripts/check-transfer-browser.mjs`.
- GitHub Pages publica `dist` mediante `.github/workflows/deploy-pages.yml`.
  Su configuración utiliza GitHub Actions; no habilitar simultáneamente la
  publicación directa desde la rama.
- Actualizar el código del repositorio no actualiza el despliegue de Apps Script.
