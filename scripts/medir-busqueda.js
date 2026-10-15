/**
 * VisitaFlow - Cuanto tarda de verdad buscar una cedula.
 *
 *   node scripts/medir-busqueda.js
 *
 * POR QUE
 * -------
 * En la documentacion se afirma que la vista dbo.CIUDADANOS baja la busqueda de una
 * cedula de 2,4 segundos a unos 10 milisegundos. Esa afirmacion decide si el sistema
 * se puede usar en una recepcion con gente esperando, asi que hay que medirla, no
 * repetirla.
 *
 * Se mide de las dos formas:
 *   - contra la TABLA (dbo.PADRON), recorriendo los 7,8 millones de registros
 *   - contra la VISTA (dbo.CIUDADANOS), que es la que usa el sistema
 *
 * Se miden varias busquedas y se da la mediana, no el promedio: una sola busqueda
 * lenta por la cache distorsiona el promedio y lo que importa es el caso normal.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const BASE = config.bd.padron.database;

function mediana(valores) {
  const o = valores.slice().sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : Math.round((o[m - 1] + o[m]) / 2);
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - velocidad de búsqueda en la base de cédulas');
  console.log('  ' + '='.repeat(64));
  console.log('  Base: ' + BASE + '   en ' + config.bd.padron.server + ':' + config.bd.padron.port);

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

  const cuantos = (await pool.request().query('SELECT COUNT(*) AS n FROM dbo.PADRON')).recordset[0].n;
  console.log('  Registros: ' + cuantos.toLocaleString('es-DO'));

  /* Cedulas de verdad, no inventadas: si no existen, la busqueda no recorre nada
     y la medicion no vale. */
  const muestra = (await pool.request().query(
    'SELECT TOP 25 Cedula FROM dbo.PADRON WHERE Cedula IS NOT NULL AND LEN(Cedula) >= 6 ORDER BY NEWID()'
  )).recordset.map((r) => String(r.Cedula).trim());

  if (!muestra.length) {
    console.log('');
    console.log('  No hay cédulas en la tabla; no se puede medir.');
    await pool.close();
    return;
  }
  console.log('  Cédulas de prueba: ' + muestra.length + ' (tomadas al azar de la tabla)');

  /* ------------------------------------------------------------------ */
  async function medir(etiqueta, tabla, cedulas) {
    const tiempos = [];

    /* Una primera pasada de calentamiento: la primera consulta paga la apertura de
       conexion y la carga de la cache, y no representa al caso normal. */
    try {
      await pool.request().input('c', sql.VarChar(20), cedulas[0])
        .query('SELECT TOP 1 * FROM ' + tabla + ' WHERE Cedula = @c');
    } catch (e) {
      return { etiqueta, error: e.message };
    }

    for (const c of cedulas) {
      const t0 = process.hrtime.bigint();
      try {
        await pool.request().input('c', sql.VarChar(20), c)
          .query('SELECT TOP 1 * FROM ' + tabla + ' WHERE Cedula = @c');
      } catch (e) {
        return { etiqueta, error: e.message };
      }
      tiempos.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }

    return {
      etiqueta,
      mediana: mediana(tiempos),
      minima: Math.min.apply(null, tiempos),
      maxima: Math.max.apply(null, tiempos),
    };
  }

  console.log('');
  console.log('  1. Buscar por CÉDULA (es lo que hace el recepcionista)');
  const conTabla = await medir('tabla dbo.PADRON', 'dbo.PADRON', muestra);
  const conVista = await medir('vista dbo.CIUDADANOS', 'dbo.CIUDADANOS', muestra);

  for (const r of [conTabla, conVista]) {
    if (r.error) {
      console.log('    ' + r.etiqueta.padEnd(22) + 'no se pudo medir: ' + r.error);
    } else {
      console.log('    ' + r.etiqueta.padEnd(22) +
        String(Math.round(r.mediana)).padStart(6) + ' ms   ' +
        '(mín ' + Math.round(r.minima) + ', máx ' + Math.round(r.maxima) + ')');
    }
  }

  if (!conTabla.error && !conVista.error && conVista.mediana > 0) {
    console.log('    ' + 'mejora'.padEnd(22) + String((conTabla.mediana / conVista.mediana).toFixed(1)).padStart(6) + ' veces más rápida la vista');
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('  2. Buscar por NOMBRE (cuando no traen la cédula)');

  /* Se busca un apellido real y frecuente. */
  const apellido = (await pool.request().query(
    "SELECT TOP 1 Apellido1 FROM dbo.PADRON WHERE Apellido1 IS NOT NULL AND LEN(Apellido1) > 4 GROUP BY Apellido1 ORDER BY COUNT(*) DESC"
  )).recordset[0];

  if (apellido) {
    const a = apellido.Apellido1;
    const t0 = process.hrtime.bigint();
    const r = await pool.request().input('a', sql.VarChar(60), a + '%').query(
      'SELECT TOP 20 Nombres, Apellido1, Apellido2, Cedula FROM dbo.CIUDADANOS WHERE Apellido1 LIKE @a'
    );
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    console.log('    apellido "' + a + '": ' + r.recordset.length + ' resultado(s) en ' + Math.round(ms) + ' ms');
    if (ms > 800) {
      console.log('    AVISO: es lento. El recepcionista lo va a notar al escribir.');
    }
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
