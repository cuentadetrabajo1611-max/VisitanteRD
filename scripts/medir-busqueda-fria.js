/**
 * VisitaFlow - Medir la busqueda con la cache FRIA.
 *
 *   node scripts/medir-busqueda-fria.js
 *
 * POR QUE HACE FALTA ESTO
 * -----------------------
 * Medir con la cache caliente no dice nada util: si los 427 MB del padron ya estan
 * en memoria, cualquier consulta es instantanea y no se distingue la tabla de la
 * vista. Eso fue exactamente lo que paso en la primera medicion: 3 ms en las dos.
 *
 * La pregunta que importa es otra: que pasa cuando la cache NO tiene los datos. Es
 * el caso real en el VPS, donde SQL Server Express topa en 1410 MB y el padron ocupa
 * 427 MB: con las visitas del dia compitiendo por memoria, las paginas del padron se
 * van de la cache.
 *
 * Para reproducirlo se usa DBCC DROPCLEANBUFFERS, que vacia la cache de datos del
 * servidor. OJO: afecta a TODO el servidor, no solo a esta base. En una maquina de
 * desarrollo es aceptable; en produccion NO se debe ejecutar.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const BASE = config.bd.padron.database;

async function principal() {
  console.log('');
  console.log('  VisitaFlow - búsqueda con la caché FRÍA');
  console.log('  ' + '='.repeat(64));
  console.log('  Esto vacía la caché del servidor SQL. Es una máquina de desarrollo:');
  console.log('  no lo ejecute en el servidor de un cliente.');
  console.log('');

  const pool = await new sql.ConnectionPool({
    server: config.bd.padron.server,
    port: config.bd.padron.port,
    user: config.bd.padron.user,
    password: config.bd.padron.password,
    database: BASE,
    options: {
      encrypt: config.bd.padron.encrypt,
      trustServerCertificate: config.bd.padron.trustServerCertificate,
      enableArithAbort: true,
    },
    connectionTimeout: 20000,
  }).connect();

  const muestra = (await pool.request().query(
    'SELECT TOP 8 Cedula FROM dbo.PADRON WHERE Cedula IS NOT NULL AND LEN(Cedula) >= 6 ORDER BY NEWID()'
  )).recordset.map((r) => String(r.Cedula).trim());

  const memoria = await pool.request().query(
    "SELECT physical_memory_in_use_kb / 1024 AS mb FROM sys.dm_os_process_memory"
  );
  console.log('  Memoria del proceso de SQL Server: ' + memoria.recordset[0].mb + ' MB');

  async function medirConFrio(etiqueta, tabla) {
    const tiempos = [];
    for (const c of muestra) {
      // Se vacia la cache ANTES de cada consulta: asi ninguna se aprovecha de la
      // anterior. Es lo que hace que la medicion signifique algo.
      await pool.request().batch('DBCC DROPCLEANBUFFERS WITH NO_INFOMSGS');

      const t0 = process.hrtime.bigint();
      await pool.request().input('c', sql.VarChar(20), c)
        .query('SELECT TOP 1 * FROM ' + tabla + ' WHERE Cedula = @c');
      tiempos.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }

    const o = tiempos.slice().sort((a, b) => a - b);
    return {
      etiqueta,
      mediana: o[Math.floor(o.length / 2)],
      minima: o[0],
      maxima: o[o.length - 1],
      todas: tiempos,
    };
  }

  console.log('');
  console.log('  Consultando con la caché vacía cada vez (' + muestra.length + ' cédulas al azar):');
  console.log('');

  const tabla = await medirConFrio('tabla dbo.PADRON', 'dbo.PADRON');
  const vista = await medirConFrio('vista dbo.CIUDADANOS', 'dbo.CIUDADANOS');

  for (const r of [tabla, vista]) {
    console.log('    ' + r.etiqueta.padEnd(22) + String(Math.round(r.mediana)).padStart(7) + ' ms   ' +
      '(mín ' + Math.round(r.minima) + ', máx ' + Math.round(r.maxima) + ')');
  }

  console.log('');
  if (vista.mediana > 0 && tabla.mediana > 0) {
    const veces = tabla.mediana / vista.mediana;
    console.log('    la vista es ' + veces.toFixed(1) + ' veces más rápida con la caché fría');
  }

  /* ------------------------------------------------------------------ */
  /* El tiempo que de verdad importa: lo que espera el recepcionista.    */
  console.log('');
  console.log('  Y una búsqueda por APELLIDO con la caché fría (lo peor que puede pasar):');

  const ap = await pool.request().query(
    "SELECT TOP 1 Apellido1 FROM dbo.PADRON WHERE Apellido1 IS NOT NULL AND LEN(Apellido1) > 4 GROUP BY Apellido1 ORDER BY COUNT(*) DESC"
  );
  const a = ap.recordset[0].Apellido1;

  await pool.request().batch('DBCC DROPCLEANBUFFERS WITH NO_INFOMSGS');
  const t0 = process.hrtime.bigint();
  const r = await pool.request().input('a', sql.VarChar(60), a + '%').query(
    'SELECT TOP 20 Nombres, Apellido1, Apellido2, Cedula FROM dbo.CIUDADANOS WHERE Apellido1 LIKE @a'
  );
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  console.log('    apellido "' + a + '": ' + r.recordset.length + ' resultado(s) en ' + Math.round(ms) + ' ms');
  if (ms > 1500) {
    console.log('');
    console.log('    AVISO: más de un segundo y medio. El recepcionista lo nota, y hay');
    console.log('    que decírselo al cliente o buscar por cédula en vez de por nombre.');
  }

  await pool.close();
  console.log('');
  console.log('  ' + '='.repeat(64));
  console.log('');
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exitCode = 1;
});
