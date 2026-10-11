# Fases y aceptación

La conversación recuperada no contiene el diseño previo completo. El flujo de recepción y la vista del padrón son contratos provisionales de esta base, no una reproducción del sistema acordado.

| Fase | Resultado y criterio |
| --- | --- |
| 1: este PR | Monorepo React/TypeScript, NestJS, contratos, demostración, repositorio SQL, lector del padrón, firma Ed25519, emisor central y pruebas/CI |
| 2: SQL y padrón | Confirmar campos/flujo; inspeccionar metadatos de una copia aislada; mapear vista; pruebas reales de SELECT, escrituras denegadas, persistencia y concurrencia |
| 3: recepción real | Sesiones individuales, roles, auditoría, retención, paginación, rate limiting, reportes y pruebas end-to-end sintéticas. La web no usa el token compartido de integración |
| 4: licencias operativas | Persistencia central de derechos, activación, renovación, revocación, rotación de claves, auditoría y TLS; definir conducta offline |
| 5: instalador/despliegue | Instalador firmado probado en VM; antes de Dokploy, inventario, respaldo, aislamiento, puertos, TLS, secretos y plan de reversión; autorización explícita posterior a la verificación |

No desplegar ni operar con personas reales hasta completar las fases correspondientes. No hay cambios en Dokploy en este PR.
