/**
 * VisitaFlow - Creacion de la base del sistema.
 *
 *   node sql/01-crear.js
 *
 * Crea la base (si no existe) y aplica sql/01-esquema.sql. Se puede ejecutar
 * varias veces: el esquema comprueba la existencia de cada objeto antes de
 * crearlo.
 *
 * Nunca toca la base del padron.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));

const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const BASE = config.bd.sistema.database;
const ESQUEMA = path.join(__dirname, '01-esquema.sql');

/** Parte un script T-SQL en lotes por los separadores GO. */
function lotes(texto) {
  return texto
    .split(/^\s*GO\s*$/gim)
    .map((l) => l.trim())
    .filter(Boolean);
}

async function principal() {
  if (!BASE) {
    console.error('Falta DB_DATABASE en el archivo .env');
    process.exit(1);
  }

  console.log('');
  console.log('  VisitaFlow — creación de la base');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Servidor : ' + config.bd.sistema.server + ':' + config.bd.sistema.port);
  console.log('  Base     : ' + BASE);
  console.log('');

  // 1. Conexion al master para crear la base.
  const maestro = await new sql.ConnectionPool({
    server: config.bd.sistema.server,
    port: config.bd.sistema.port,
    user: config.bd.sistema.user,
    password: config.bd.sistema.password,
    database: 'master',
    options: { encrypt: config.bd.sistema.encrypt, trustServerCertificate: config.bd.sistema.trustServerCertificate, enableArithAbort: true },
    connectionTimeout: 20000,
  }).connect();

  const existe = await maestro.request().input('nombre', sql.NVarChar(128), BASE).query('SELECT database_id FROM sys.databases WHERE name = @nombre');
  if (existe.recordset.length) {
    console.log('  La base ya existe.');
  } else {
    // El nombre se valida porque CREATE DATABASE no admite parametros.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(BASE)) {
      console.error('  El nombre de la base no es válido: ' + BASE);
      process.exit(1);
    }
    await maestro.request().query('CREATE DATABASE [' + BASE + ']');
    console.log('  Base creada.');
  }
  await maestro.close();

  // 2. Aplicar el esquema.
  const texto = fs.readFileSync(ESQUEMA, 'utf8');
  const lista = lotes(texto);
  console.log('  Aplicando el esquema (' + lista.length + ' lotes)...');

  const pool = await new sql.ConnectionPool({
    server: config.bd.sistema.server,
    port: config.bd.sistema.port,
    user: config.bd.sistema.user,
    password: config.bd.sistema.password,
    database: BASE,
    options: { encrypt: config.bd.sistema.encrypt, trustServerCertificate: config.bd.sistema.trustServerCertificate, enableArithAbort: true },
    connectionTimeout: 20000,
  }).connect();

  let n = 0;
  for (const lote of lista) {
    try {
      await pool.request().batch(lote);
      n++;
    } catch (e) {
      console.error('');
      console.error('  Error en el lote ' + (n + 1) + ':');
      console.error('  ' + e.message);
      console.error('');
      console.error('  --- lote que falló ---');
      console.error(lote.split('\n').slice(0, 20).join('\n'));
      await pool.close();
      process.exit(1);
    }
  }

  // 3. Comprobar que quedaron las tablas.
  const tablas = await pool.request().query("SELECT name FROM sys.tables WHERE name LIKE 'vf[_]%' ORDER BY name");
  await pool.close();

  console.log('');
  console.log('  Tablas creadas (' + tablas.recordset.length + '):');
  for (const t of tablas.recordset) console.log('    ' + t.name);
  console.log('');
  console.log('  Listo. Siguiente paso:  npm run db:licencia');
  console.log('');
}

principal().catch((e) => {
  console.error('');
  console.error('  No se pudo preparar la base: ' + e.message);
  console.error('');
  process.exit(1);
});
