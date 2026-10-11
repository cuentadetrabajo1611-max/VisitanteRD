# Límites y seguridad

Repositorio público: nunca incluir personas, documentos, secretos, claves privadas, MDF/LDF ni respaldos. Revisar antes de publicar; gitignore no es una garantía.

Configuración real requiere conexión SQL propia, token mínimo de 32 caracteres, archivos de licencia/claves y vinculación. Sin credencial: 401. Sin licencia válida/capacidad: 403. Modo demo explícito, en memoria, solo loopback y prohibido con NODE_ENV=production. Ambos servicios escuchan en loopback. No se modifica Dokploy, firewall ni servicios existentes.

Token compartido de API es provisional para integración, no autenticación de operadores. Web solo habilita acciones demo, sin secretos incrustados. Antes de personas reales: sesiones individuales, roles, TLS, controles contra abuso, auditoría sin documentos, respaldos/retención y revisión de dependencias.

SQL: cuentas independientes por responsabilidad, cifrado y certificados confiables, privilegios mínimos; no usar sa ni desactivar validación de certificados. Consulta de padrón y escrituras de visitas usan parámetros. Probar los permisos reales en entorno aislado.

Errores de arranque omiten configuración. Proxies futuros no deben registrar cuerpos ni cabeceras sensibles. Health indica estado del proceso; no es readiness de SQL ni prueba de licencia. Pruebas SQL reales pendientes.
