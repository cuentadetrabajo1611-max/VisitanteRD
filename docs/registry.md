# Contrato del padrón MDF

El esquema del MDF no fue suministrado ni inspeccionado. El adaptador no lee archivos MDF directamente, no adjunta, restaura ni cambia el original. Un administrador prepara una copia consistente en una instancia SQL Server aislada; un MDF suelto puede necesitar LDF o respaldo válido. No reconstruir logs ni adjuntar el original desde esta aplicación.

1. Conservar original y SHA-256; obtener respaldo/copia consistente y verificar versión SQL.
2. Restaurar SOLO en entorno aislado, sin reutilizar instancias o bases de otros servicios. Inspeccionar metadatos sin exportar personas.
3. Mapear en ESA COPIA una vista `dbo.VisitanteRegistryLookup` con `DocumentNumber` (varchar 11), `RegistryId` y `DisplayName`. No hay un script que suponga tablas del MDF real.
4. Cuenta exclusiva con SELECT solo en esa vista; sin db_owner, db_datawriter, attach ni privilegios de servidor. Probar que SQL deniega escritura: la garantía no depende solo del SELECT del código.
5. Verificar unicidad de documento o acordar tratamiento de duplicados antes de conectar; TOP (1) no resuelve ambigüedad. Estudiar índices solo en la copia.
6. Verificar otra vez hash del original. No subir MDF/LDF/backups ni datos personales al repositorio público.

La API usa POST para que el documento no aparezca en URLs. Normalización de 11 dígitos con guiones opcionales es un supuesto para documentos dominicanos, no comprobación de identidad ni dígito verificador. Devuelve solo identificador y nombre. No usar datos reales antes de sesiones, roles, límites y política de retención.

La base de visitas tiene una conexión/cuenta diferente. `database/001-visits.sql` se aplica manualmente en una base NUEVA de aplicación, jamás en el padrón. No hay migración automática.
