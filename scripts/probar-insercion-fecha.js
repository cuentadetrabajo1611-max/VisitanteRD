/**
 * VisitaFlow - Comprobacion del camino de insercion de fechas.
 *
 *   node scripts/probar-insercion-fecha.js
 *
 * Compara la fecha que se guarda al insertar de TRES formas distintas, usando
 * exactamente las mismas funciones que usa el sistema (bd.consultar y
 * bd.transaccion), para localizar en cual de ellas se desvia la hora.
 *
 * Deja y borra su propia tabla de prueba.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));
const util = require(path.join(RAIZ, 'src', 'util.js'));

const TABLA = 'zz_prueba_insercion';

async function principal() {
  await bd.conectarSistema();

  await bd.consultar(
    'IF OBJECT_ID(\'dbo.' + TABLA + '\', \'U\') IS NOT NULL DROP TABLE dbo.' + TABLA + '; ' +
    'CREATE TABLE dbo.' + TABLA + ' (id INT IDENTITY, forma VARCHAR(60), momento DATETIMEOFFSET(0) NULL);'
  );

  const ahora = new Date();

  console.log('');
  console.log('  VisitaFlow - camino de insercion de fechas');
  console.log('  ' + '='.repeat(70));
  console.log('  Hora real (Node): ' + ahora.toISOString());
  console.log('');

  /** Lee de vuelta y mide la diferencia en minutos. */
  async function medir(forma) {
    const r = await bd.consultar(
      'SELECT TOP 1 momento, CONVERT(varchar(40), momento, 127) AS texto, ' +
      'DATEDIFF(minute, momento, SYSDATETIMEOFFSET()) AS dif ' +
      'FROM dbo.' + TABLA + ' WHERE forma = @f ORDER BY id DESC',
      { f: forma }
    );
    const f = r.recordset[0];
    const difDriver = Math.round((f.momento.getTime() - ahora.getTime()) / 60000);
    return { forma, texto: f.texto, difSql: f.dif, difDriver };
  }

  const resultados = [];

  // 1. Insertando con bd.consultar y un parametro Date.
  await bd.consultar(
    'INSERT INTO dbo.' + TABLA + ' (forma, momento) VALUES (@f, @m)',
    { f: '1. bd.consultar con Date', m: ahora }
  );
  resultados.push(await medir('1. bd.consultar con Date'));

  // 2. Insertando dentro de una transaccion, como hace el registro de visitas.
  await bd.transaccion(async (tx) => {
    await tx.consultar(
      'INSERT INTO dbo.' + TABLA + ' (forma, momento) VALUES (@f, @m)',
      { f: '2. transaccion con Date', m: ahora }
    );
  });
  resultados.push(await medir('2. transaccion con Date'));

  // 3. Dejando que lo ponga el servidor.
  await bd.consultar(
    'INSERT INTO dbo.' + TABLA + ' (forma, momento) VALUES (@f, SYSDATETIMEOFFSET())',
    { f: '3. SYSDATETIMEOFFSET()' }
  );
  resultados.push(await medir('3. SYSDATETIMEOFFSET()'));

  // 4. Con el tipo declarado a mano, como hace el sistema.
  await bd.consultar(
    'INSERT INTO dbo.' + TABLA + ' (forma, momento) VALUES (@f, @m)',
    { f: '4. tipo declarado explicito', m: ahora },
    { tipos: { m: bd.tipos.fechaHora } }
  );
  resultados.push(await medir('4. tipo declarado explicito'));

  console.log('  forma                                SQL lo ve                DATEDIFF   driver');
  console.log('  ' + '-'.repeat(70));
  for (const r of resultados) {
    const estado = r.difSql === 0 ? 'ok' : 'MAL';
    console.log(
      '  ' + r.forma.padEnd(36) + String(r.texto).padEnd(24) +
      String(r.difSql + ' min').padEnd(11) + r.difDriver + ' min   ' + estado
    );
  }

  // Que tipo esta infiriendo el sistema para un Date.
  console.log('');
  console.log('  --- que tipo infiere el sistema para un objeto Date ---');
  const tipo = util.inferirTipo ? util.inferirTipo(ahora) : null;
  console.log('  util.inferirTipo expuesto: ' + (util.inferirTipo ? 'sí' : 'no'));
  console.log('  bd.tipos.fechaHora       : ' + (bd.tipos.fechaHora ? bd.tipos.fechaHora.name || 'definido' : 'indefinido'));
  console.log('  bd.tipos.dateTime2       : ' + (bd.tipos.dateTime2 ? bd.tipos.dateTime2.name || 'definido' : 'indefinido'));

  await bd.consultar('DROP TABLE dbo.' + TABLA);
  await bd.cerrar();
  console.log('');
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
