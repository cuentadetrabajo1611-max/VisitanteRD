# Ed25519 centralizado

Central NestJS separado en loopback puerto 3200. Variables: `ISSUER_ADMIN_TOKEN` (mínimo 32 caracteres), `ISSUER_KEY_ID`, `ISSUER_PRIVATE_KEY_FILE` (PKCS#8 PEM), `ISSUER_ENTITLEMENTS_FILE` (array JSON de derechos). Nunca distribuir clave privada ni token administrativo a clientes o navegador.

`POST /api/licenses/issue` con Authorization Bearer y `{licenseId}` emite únicamente derechos existentes en el catálogo. El cliente no puede elegir fechas, capacidades, tenant o instalación. La base usa un archivo como catálogo; persistencia, auditoría y administración individual quedan en fase 4.

Formato de derecho sintético (vencido intencionalmente; fechas Unix en segundos):

```json
{"version":1,"licenseId":"00000000-0000-4000-8000-000000000001","tenantId":"synthetic-tenant","installationId":"00000000-0000-4000-8000-000000000002","issuedAt":100,"notBefore":100,"expiresAt":200,"features":["visits","registry"]}
```

Sobre: `algorithm`, `keyId`, `payload`, `signature`. Se firman bytes UTF-8 de `VisitanteRD:license:v1:<keyId>:<payload>` donde payload es JSON base64url. La verificación comprueba bytes firmados, clave Ed25519 conocida, esquema estricto, intervalo de vigencia y vinculación tenant/instalación. Expiración exclusiva: a expiresAt ya es inválida. No hay gracia implícita.

Cliente: `LICENSE_FILE` apunta al sobre; `LICENSE_PUBLIC_KEYS_FILE` a JSON `{ "keyId": "PEM SPKI público" }`; `TENANT_ID` e `INSTALLATION_ID` deben coincidir. Reiniciar después de cambiar esos archivos en esta base. Las pruebas crean claves efímeras en memoria. La firma no cifra; no incluir información personal.

No hay activación automática, facturación, renovación, revocación inmediata ni defensa contra rollback del reloj. Offline una revocación solo tiene efecto con expiración/actualización. La vinculación compara configuración, no hardware confiable: un administrador local puede alterar configuración o código. Preparar TLS, ACL, rate limiting, catálogo persistente, auditoría y rotación antes de publicar.
