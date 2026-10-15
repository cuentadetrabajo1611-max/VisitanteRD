/**
 * VisitaFlow - Cuanto cuesta cada decision de la busqueda por nombre.
 *
 *   node scripts/medir-consulta-nombre.js
 *
 * QUE COMPARA
 * -----------
 * La consulta de busqueda por nombre tiene tres decisiones que se pueden cambiar
 * una a una. Esta prueba las mide por separado para saber cual importa:
 *
 *   A. Como esta hoy:  UPPER(col) LIKE '%t%'  ...  ORDER BY Apellido1, Apellido2, Nombres
 *   B. Sin el UPPER:   col LIKE '%t%'         ...  ORDER BY ...
 *   C. Sin el ORDER:   col LIKE '%t%'         ...  (sin ordenar)
 *
 * POR QUE IMPORTA EL UPPER
 * ------------------------
 * Envolver una columna en una funcion (UPPER, LTRIM, CONVERT...) impide que SQL Server
 * use cualquier indice sobre esa columna: tiene que calcular la funcion fila por fila,
 * sobre los 7,8 millones. Y aqui es innecesario, porque la intercalacion del padron
 * (SQL_AltDiction_CP850_CI_AI) ya distingue sin mirar mayusculas: "rodriguez" y
 * "RODRIGUEZ" coinciden igual. El CI del final quiere decir Case Insensitive.
 *
 * POR QUE IMPORTA EL ORDER
 * ------------------------
 * ORDER BY se aplica a TODAS las filas que pasan el WHERE, y solo despues se queda
 * con las 20 primeras. Si el WHERE deja pasar 80.000 filas, se ordenan 80.000 para
 * tirar 79.980.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

function ms(t0) { return Math.round(Number(process.hrtime.bigint() - t0) / 1e6); }

async function principal() {
  console.log('');
  console.log('  VisitaFlow - qué cuesta cada decisión de la búsqueda por nombre');
  console.log('  ' + '='.repeat(66));

  const pool = await new sql.ConnectionPool({
    server: config.bd.padron.server,
    port: config.bd.padron.port,
    user: config.bd.padron.user,
    password: config.bd.padron.password,
    database: config.bd.padron.database,
    options: {
      encrypt: config.bd.padron.encrypt,
      trustServerCertificate: config.bd.padron.trustServerCertificate,
      enableArithAbort: true,
    },
    connectionTimeout: 20000,
  }).connect();

  /* La intercalacion de la tabla, para confirmar que es insensible a mayusculas. */
  const col = (await pool.request().query(
    "SELECT collation_name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PADRON') AND name = 'Apellido1'"
  )).recordset[0];
  console.log('  Intercalación de Apellido1: ' + col.collation_name);
  console.log('  (el CI del final = Case Insensitive: distingue sin mirar mayúsculas)');
  console.log('');

  /* Un apellido frecuente para que el WHERE deje pasar muchas filas. */
  const ap = (await pool.request().query(
    "SELECT TOP 1 Apellido1 FROM dbo.PADRON WHERE Apellido1 IS NOT NULL AND LEN(Apellido1) > 4 GROUP BY Apellido1 ORDER BY COUNT(*) DESC"
  )).recordset[0].Apellido1.trim();

  const cuantas = (await pool.request().query(
    "SELECT COUNT(*) AS n FROM dbo.PADRON WHERE Apellido1 = '" + ap.replace(/'/g, "''") + "'"
  )).recordset[0].n;

  console.log('  Apellido: "' + ap + '"  (' + cuantas.toLocaleString('es-DO') + ' personas)');
  console.log('');

  const COLS = 'Cedula, Nombres, Apellido1, Apellido2';

  const consultas = [
    {
      etiqueta: 'A. como está hoy (UPPER + ORDER BY)',
      sql: `SELECT TOP 20 ${COLS} FROM dbo.PADRON
             WHERE (UPPER(Nombres) LIKE @t0 OR UPPER(Apellido1) LIKE @t0 OR UPPER(Apellido2) LIKE @t0)
             ORDER BY Apellido1, Apellido2, Nombres`,
    },
    {
      etiqueta: 'B. sin UPPER, con ORDER BY',
      sql: `SELECT TOP 20 ${COLS} FROM dbo.PADRON
             WHERE (Nombres LIKE @t0 OR Apellido1 LIKE @t0 OR Apellido2 LIKE @t0)
             ORDER BY Apellido1, Apellido2, Nombres`,
    },
    {
      etiqueta: 'C. sin UPPER y sin ORDER BY',
      sql: `SELECT TOP 20 ${COLS} FROM dbo.PADRON
             WHERE (Nombres LIKE @t0 OR Apellido1 LIKE @t0 OR Apellido2 LIKE @t0)`,
    },
    {
      etiqueta: 'D. solo el apellido, sin UPPER ni ORDER',
      sql: `SELECT TOP 20 ${COLS} FROM dbo.PADRON WHERE Apellido1 LIKE @t0`,
    },
  ];

  const resultados = [];

  for (const q of consultas) {
    /* Se mide tres veces con la cache vacia y se toma la menor: la primera consulta
       de cada forma paga la compilacion del plan, y lo que interesa es el coste
       estable, no el arranque. */
    let mejor = null;
    for (let intento = 0; intento < 3; intento++) {
      await pool.request().batch('DBCC DROPCLEANBUFFERS WITH NO_INFOMSGS');
      const t0 = process.hrtime.bigint();
      const r = await pool.request().input('t0', sql.VarChar(60), '%' + ap + '%').query(q.sql);
      const t = ms(t0);
      q.filas = r.recordset.length;
      if (mejor === null || t < mejor) mejor = t;
    }
    q.ms = mejor;
    resultados.push(q);
    console.log('    ' + q.etiqueta.padEnd(38) + String(mejor).padStart(7) + ' ms   ' + q.filas + ' filas');
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('  ' + '-'.repeat(64));

  const a = resultados[0].ms;
  const b = resultados[1].ms;
  const c = resultados[2].ms;

  console.log('');
  if (b < a * 0.8) {
    console.log('  Quitar el UPPER ahorra ' + Math.round(a - b) + ' ms de ' + a + ' (' +
      Math.round((1 - b / a) * 100) + '%).');
    console.log('  Es seguro: la intercalación ' + col.collation_name + ' ya ignora mayúsculas.');
  } else {
    console.log('  El UPPER no es lo que más cuesta aquí.');
  }

  if (c < b * 0.8) {
    console.log('  Quitar el ORDER BY ahorra otros ' + Math.round(b - c) + ' ms.');
    console.log('  Se puede ordenar en el servidor de la aplicación, sobre 20 filas, en vez');
    console.log('  de ordenar decenas de miles en la base para quedarse con 20.');
  } else {
    console.log('  El ORDER BY no es lo que más cuesta aquí.');
  }

  console.log('');
  console.log('  La más rápida: ' + resultados.slice().sort((x, y) => x.ms - y.ms)[0].etiqueta);

  await pool.close();
  console.log('');
  console.log('  ' + '='.repeat(66));
  console.log('');
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exitCode = 1;
});
