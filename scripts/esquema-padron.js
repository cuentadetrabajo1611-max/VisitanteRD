/**
 * VisitaFlow - Volcado del esquema de la base de cedulas.
 *
 *   node scripts\esquema-padron.js
 *
 * Imprime todas las tablas con sus columnas y tipos, y una fila de muestra de
 * cada catalogo. Sirve para ajustar la vista dbo.CIUDADANOS cuando el padron
 * viene con nombres de columna distintos.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

async function principal() {
  const cfg = config.bd.padron;
  const pool = await new sql.ConnectionPool({
    server: cfg.server,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate, enableArithAbort: true },
    connectionTimeout: 20000,
  }).connect();

  const tablas = await pool.request().query(`
    SELECT t.name AS tabla,
           SUM(p.rows) AS filas
      FROM sys.tables t
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
     GROUP BY t.name
     ORDER BY t.name`);

  const vistas = await pool.request().query("SELECT name FROM sys.views ORDER BY name");

  console.log('');
  console.log('  Base: ' + cfg.database);
  console.log('');
  console.log('  === TABLAS Y COLUMNAS ===');
  console.log('');

  for (const t of tablas.recordset) {
    console.log('  ' + t.tabla + '  (' + t.filas + ' filas)');
    const cols = await pool
      .request()
      .input('tabla', sql.NVarChar(128), t.tabla)
      .query(`
        SELECT c.name, ty.name AS tipo, c.max_length, c.is_nullable, c.is_identity
          FROM sys.columns c
          JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         WHERE c.object_id = OBJECT_ID(@tabla)
         ORDER BY c.column_id`);
    for (const c of cols.recordset) {
      const largo = ['varchar', 'char', 'nvarchar', 'nchar', 'varbinary'].includes(c.tipo) ? '(' + (c.max_length < 0 ? 'MAX' : c.max_length) + ')' : '';
      console.log('      ' + c.name.padEnd(24) + (c.tipo + largo).padEnd(18) + (c.is_nullable ? 'NULL' : 'NOT NULL') + (c.is_identity ? ' IDENTITY' : ''));
    }

    // Muestra solo de los catalogos pequenos.
    if (t.filas > 0 && t.filas < 1000) {
      const m = await pool.request().query('SELECT TOP 2 * FROM dbo.[' + t.tabla + ']');
      for (const fila of m.recordset) {
        console.log('      muestra: ' + JSON.stringify(fila));
      }
    }
    console.log('');
  }

  if (vistas.recordset.length) {
    console.log('  === VISTAS ===');
    for (const v of vistas.recordset) console.log('    ' + v.name);
    console.log('');
  }

  await pool.close();
}

principal().catch((e) => {
  console.error('Error: ' + e.message);
  process.exit(1);
});
