# VisitanteRD

Base de desarrollo del sistema de visitantes. **No está lista para operar con personas reales.** El alcance y los siguientes hitos están en [docs/roadmap.md](docs/roadmap.md). El diseño y flujo son provisionales porque el historial recuperado no contiene el acuerdo completo.

## Componentes

| Ruta | Función |
| --- | --- |
| apps/web | Recepción React/TypeScript en español, entradas y salidas demo |
| apps/api | NestJS, visitas SQL Server, consulta del padrón y control de licencia |
| apps/licensing | Emisor central NestJS/Ed25519 separado del cliente |
| packages/core | Contratos estrictos y firma/verificación |
| database | Migración manual para una base nueva de aplicación |
| tests | Pruebas sintéticas, sin SQL real ni archivos MDF |
| installer/windows | Contrato del futuro instalador, todavía sin MSI/EXE |

## Demostración local Windows

Node.js 22.12 o superior compatible con Vite (recomendado Node 22 LTS actualizado) y npm. Desde la raíz:

```powershell
npm.cmd ci
npm.cmd run check
$env:DEMO_MODE = 'true'
npm.cmd run dev:api
```

En otra ventana, desde la misma carpeta:

```powershell
npm.cmd run dev:web
```

Abre http://127.0.0.1:5173. Datos únicamente ficticios; se guardan en memoria y desaparecen al reiniciar. Demo se activa expresamente, escucha en loopback y está prohibido con NODE_ENV=production. No conecta el padrón ni SQL.

## API

| Método/ruta | Función |
| --- | --- |
| GET /api/health | Salud del proceso y modo; no readiness SQL |
| GET /api/visits | Visitas activas; TOP 200 con SQL |
| POST /api/visits | {visitorLabel, destination, purpose} |
| POST /api/visits/:id/checkout | Cierra visita activa; 404 al repetir |
| POST /api/registry/lookup | {document}; 503 si padrón no configurado |
| POST /api/licenses/issue | Emisor central puerto 3200; {licenseId} autenticado |

Configuración real: APP_SQL_CONNECTION, API_ACCESS_TOKEN (32 caracteres mínimo), TENANT_ID, INSTALLATION_ID, LICENSE_FILE y LICENSE_PUBLIC_KEYS_FILE. REGISTRY_SQL_CONNECTION es opcional y diferente de la base de aplicación. Ver .env.example; es una referencia y NO se carga automáticamente. Suministrar variables al proceso.

Visitas y padrón requieren Authorization Bearer y una licencia válida con la capacidad correspondiente. El token es provisional de integración; no sustituye sesiones y roles. La web solo permite operaciones demo y no incrusta secretos.

Leer [padrón](docs/registry.md), [licencias](docs/licensing.md) y [seguridad](docs/security.md). Aplicar database/001-visits.sql manualmente solo a una base NUEVA de aplicación. No hay attach, restore, migraciones automáticas ni despliegue.

## Validación

npm run check compila todo y ejecuta pruebas. CI repite en Linux. Pruebas SQL contra una instancia aislada, sesiones de operador, auditoría, renovación de licencia e instalador siguen pendientes. Nunca subir datos personales, secretos o MDF/LDF al repositorio público.
