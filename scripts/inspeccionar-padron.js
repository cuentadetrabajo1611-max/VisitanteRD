/**
 * VisitaFlow - Inspeccion de la base de cedulas (solo lectura).
 *
 *   node scripts/inspeccionar-padron.js
 *
 * Sirve para comprobar que la base del padron ligero quedo bien: que tablas
 * tiene, cuantas filas, que columnas y como se ven los datos reales.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

async function principal() {
  const cfg = config.bd.padron;
  console.log('');
  console.log('  Base de cedulas: ' + cfg.server + '/' + cfg.database);
  console.log('  Tabla configurada: ' + config.bd.tablaPadron);
  console.log('');

  const pool = await new sql.ConnectionPool({
    server: cfg.server,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate, enableArithAbort: true },
    connectionTimeout: 20000,
  }).connect();

  // Tamano de la base
  const tam = await pool
    .request()
    .query("SELECT SUM(size) * 8 / 1024 AS mb FROM sys.master_files WHERE database_id = DB_ID(@base)")
    .catch(() => null);
  if (tam && tam.recordset.length) {
    console.log('  Tamano total de la base: ' + Number(tam.recordset[0].mb).toFixed(1) + ' MB');
    console.log('');
  }

  // Tablas y filas
  const tablas = await pool.request().query(`
    SELECT s.name AS esquema, t.name AS tabla, SUM(p.rows) AS filas
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
     GROUP BY s.name, t.name
     ORDER BY SUM(p.rows) DESC`);

  console.log('  Tablas (' + tablas.recordset.length + '):');
  for (const t of tablas.recordset) {
    console.log('    ' + (t.esquema + '.' + t.tabla).padEnd(32) + String(t.filas).padStart(12) + ' filas');
  }
  console.log('');

  // Columnas de la tabla configurada
  const [esquema, tabla] = config.bd.tablaPadron.split('.');
  const columnas = await pool
    .request()
    .input('tabla', sql.NVarChar(128), tabla)
    .input('esquema', sql.NVarChar(128), esquema)
    .query(`
      SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH AS largo, c.IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS c
        JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
       WHERE c.TABLE_NAME = @tabla AND c.TABLE_SCHEMA = @esquema
       ORDER BY c.ORDINAL_POSITION`);

  if (!columnas.recordset.length) {
    console.log('  La tabla ' + config.bd.tablaPadron + ' NO existe en esta base.');
    console.log('');
    await pool.close();
    process.exit(1);
  }

  console.log('  Columnas de ' + config.bd.tablaPadron + ':');
  for (const c of columnas.recordset) {
    const tipo = c.DATA_TYPE + (c.largo && c.largo > 0 ? '(' + c.largo + ')' : '');
    console.log('    ' + c.COLUMN_NAME.padEnd(22) + tipo.padEnd(18) + (c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'));
  }
  console.log('');

  // Indices
  const indices = await pool
    .request()
    .input('tabla', sql.NVarChar(128), tabla)
    .query(`
      SELECT i.name, i.type_desc, i.is_primary_key, i.is_unique
        FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
       WHERE t.name = @tabla AND i.name IS NOT NULL
       ORDER BY i.is_primary_key DESC, i.name`);
  console.log('  Indices (' + indices.recordset.length + '):');
  for (const i of indices.recordset) {
    console.log('    ' + i.name.padEnd(40) + i.type_desc + (i.is_primary_key ? ' [PK]' : '') + (i.is_unique ? ' [UNIQUE]' : ''));
  }
  console.log('');

  // Muestra de datos reales
  const muestra = await pool.request().query('SELECT TOP 3 * FROM ' + config.bd.tablaPadron);
  console.log('  Muestra de 3 filas:');
  console.log(JSON.stringify(muestra.recordset, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
  console.log('');

  // Una consulta de prueba, como la que hace el sistema
  const primera = await pool.request().query('SELECT TOP 1 Cedula FROM ' + config.bd.tablaPadron);
  if (primera.recordset.length) {
    const cedula = primera.recordset[0].Cedula;
    const inicio = Date.now();
    const busqueda = await pool
      .request()
      .input('cedula', sql.VarChar(11), String(cedula).replace(/\D/g, '').slice(0, 11))
      .query('SELECT Cedula, Nombres, Apellido1, Apellido2, FechaNacimiento FROM ' + config.bd.tablaPadron + ' WHERE Cedula = @cedula');
    const ms = Date.now() - inicio;
    console.log('  Consulta de prueba por cedula: ' + ms + ' ms -> ' + (busqueda.recordset.length ? 'encontrada' : 'no encontrada'));
    if (busqueda.recordset.length) {
      const f = busqueda.recordset[0];
      console.log('    ' + f.Cedula + ' | ' + f.Nombres + ' ' + f.Apellido1 + ' ' + f.Apellido2 + ' | ' + String(f.FechaNacimiento).slice(0, 10));
    }
  }
  console.log('');

  await pool.close();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
