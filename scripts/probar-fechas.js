/**
 * VisitaFlow - Comprobacion del viaje de una fecha por SQL Server.
 *
 *   node scripts/probar-fechas.js
 *
 * Las columnas de fecha del sistema son DATETIMEOFFSET. Enviar un objeto Date
 * de JavaScript como parametro es delicado: si el driver lo manda como
 * DATETIME2, SQL Server lo interpreta en la zona del servidor y el instante se
 * corre tantas horas como el desfase. Este script mide cada forma de enviarlo y
 * dice cual es la correcta.
 *
 * Deja una tabla temporal en la base del sistema y la borra al terminar.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const TABLA = 'zz_prueba_fechas';

async function principal() {
  const pool = await new sql.ConnectionPool({
    server: config.bd.sistema.server,
    port: config.bd.sistema.port,
    user: config.bd.sistema.user,
    password: config.bd.sistema.password,
    database: config.bd.sistema.database,
    options: { encrypt: config.bd.sistema.encrypt, trustServerCertificate: config.bd.sistema.trustServerCertificate, enableArithAbort: true },
  }).connect();

  console.log('');
  console.log('  VisitaFlow - viaje de una fecha por SQL Server');
  console.log('  ' + '='.repeat(74));

  const info = await pool.request().query(
    'SELECT CONVERT(varchar(40), SYSDATETIMEOFFSET(), 127) AS con_zona, ' +
    'CONVERT(varchar(40), SYSDATETIME(), 126) AS sin_zona, ' +
    'DATEDIFF(minute, SYSUTCDATETIME(), SYSDATETIME()) AS desfase'
  );
  const f = info.recordset[0];
  console.log('  Hora del servidor con zona : ' + f.con_zona);
  console.log('  Hora local sin zona        : ' + f.sin_zona);
  console.log('  Desfase de la zona         : ' + f.desfase + ' minutos');
  console.log('  Hora UTC del proceso Node  : ' + new Date().toISOString());
  console.log('');

  // Tabla temporal de verdad: cada peticion puede ir por otra conexion del pool.
  await pool.request().query(
    'IF OBJECT_ID(\'dbo.' + TABLA + '\', \'U\') IS NOT NULL DROP TABLE dbo.' + TABLA + '; ' +
    'CREATE TABLE dbo.' + TABLA + ' (id INT IDENTITY, forma VARCHAR(60), momento DATETIMEOFFSET(0) NULL);'
  );

  const ahora = new Date();

  /** Envia la fecha de una forma concreta y la vuelve a leer. */
  async function probar(forma, enviar) {
    const req = pool.request();
    // @forma se declara en la peticion; pasarlo a query() como segundo
    // argumento no lo declara y SQL Server responde "Must declare the scalar
    // variable".
    req.input('forma', sql.VarChar(60), forma);
    enviar(req);
    await req.query('INSERT INTO dbo.' + TABLA + ' (forma, momento) VALUES (@forma, @momento)');

    const r = await pool.request()
      .input('forma', sql.VarChar(60), forma)
      .query('SELECT TOP 1 momento, CONVERT(varchar(40), momento, 127) AS texto FROM dbo.' + TABLA + ' WHERE forma = @forma ORDER BY id DESC');

    const leido = r.recordset[0].momento;
    const dif = Math.round((leido.getTime() - ahora.getTime()) / 1000);
    return { forma, texto: r.recordset[0].texto, leido, dif };
  }

  const resultados = [];

  // A. Sin declarar el tipo (el driver lo infiere del valor).
  resultados.push(await probar('A. Date sin tipo declarado', (req) => {
    req.input('momento', ahora);
  }));

  // B. Declarado como DateTime2.
  resultados.push(await probar('B. Date como DateTime2', (req) => {
    req.input('momento', sql.DateTime2, ahora);
  }));

  // C. Declarado como DateTimeOffset.
  resultados.push(await probar('C. Date como DateTimeOffset', (req) => {
    req.input('momento', sql.DateTimeOffset, ahora);
  }));

  // D. Como texto ISO con la Z (UTC explicito).
  resultados.push(await probar('D. Texto ISO con Z', (req) => {
    req.input('momento', sql.VarChar(30), ahora.toISOString());
  }));

  // E. Como texto ISO con el desfase del servidor.
  const conDesfase = new Date(ahora.getTime() - ahora.getTimezoneOffset() * 60000)
    .toISOString().replace('Z', '+00:00');
  resultados.push(await probar('E. Texto ISO con +00:00', (req) => {
    req.input('momento', sql.VarChar(30), conDesfase);
  }));

  console.log('  forma                              SQL lo ve                  diferencia');
  console.log('  ' + '-'.repeat(74));
  for (const r of resultados) {
    const estado = Math.abs(r.dif) <= 1 ? 'correcta' : r.dif + ' s (' + Math.round(r.dif / 60) + ' min)  <-- MAL';
    console.log('  ' + r.forma.padEnd(33) + String(r.texto).padEnd(27) + estado);
  }

  // Y lo mismo midiendo con DATEDIFF, que es como lo hace el sistema.
  console.log('');
  console.log('  --- lo mismo, medido con DATEDIFF contra la hora del servidor ---');
  console.log('  ' + '-'.repeat(74));
  const dd = await pool.request().query(
    'SELECT forma, ' +
    'DATEDIFF(minute, momento, SYSDATETIMEOFFSET()) AS con_offset, ' +
    'DATEDIFF(minute, momento, SYSDATETIME()) AS sin_offset ' +
    'FROM dbo.' + TABLA + ' ORDER BY id'
  );
  console.log('  forma                              con SYSDATETIMEOFFSET  con SYSDATETIME');
  for (const r of dd.recordset) {
    console.log('  ' + String(r.forma).padEnd(33) + String(r.con_offset + ' min').padEnd(23) + r.sin_offset + ' min');
  }
  console.log('');
  console.log('  (lo correcto es ~0 minutos en la columna "con SYSDATETIMEOFFSET")');

  await pool.request().query('DROP TABLE dbo.' + TABLA);
  await pool.close();
  console.log('');
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
