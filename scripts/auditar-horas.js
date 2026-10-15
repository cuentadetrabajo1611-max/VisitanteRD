/**
 * VisitaFlow - Auditoria de las horas de las visitas.
 *
 *   node scripts/auditar-horas.js
 *
 * Recorre las visitas guardadas y avisa de las que tienen la hora de entrada en
 * el futuro o duraciones imposibles. Es la comprobacion que dice, de un vistazo,
 * si las horas del sistema son de fiar.
 *
 * Tambien separa por antiguedad del registro: si solo estan mal las viejas, el
 * problema ya se corrigio y lo que queda son datos de antes del arreglo.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));

async function principal() {
  await bd.conectarSistema();

  console.log('');
  console.log('  VisitaFlow - auditoria de las horas');
  console.log('  ' + '='.repeat(78));

  const ahora = await bd.consultar(
    'SELECT CONVERT(varchar(40), SYSDATETIMEOFFSET(), 127) AS con_zona, ' +
    'CONVERT(varchar(40), SYSDATETIME(), 126) AS sin_zona'
  );
  console.log('  Hora del servidor (con zona): ' + ahora.recordset[0].con_zona);
  console.log('  Hora del servidor (sin zona): ' + ahora.recordset[0].sin_zona);
  console.log('  Hora del proceso Node       : ' + new Date().toISOString());
  console.log('');

  // Resumen general
  const resumen = await bd.consultar(
    'SELECT COUNT(*) AS total, ' +
    'SUM(CASE WHEN entrada > SYSDATETIMEOFFSET() THEN 1 ELSE 0 END) AS futuras, ' +
    'SUM(CASE WHEN salida IS NOT NULL AND salida < entrada THEN 1 ELSE 0 END) AS salida_antes, ' +
    'SUM(CASE WHEN creado > SYSDATETIMEOFFSET() THEN 1 ELSE 0 END) AS creado_futuro ' +
    'FROM vf_visitas'
  );
  const r = resumen.recordset[0];
  console.log('  Visitas en total            : ' + r.total);
  console.log('  Con entrada en el FUTURO    : ' + r.futuras + (r.futuras ? '   <-- MAL' : '   ok'));
  console.log('  Con salida antes de entrada : ' + r.salida_antes + (r.salida_antes ? '   <-- MAL' : '   ok'));
  console.log('  Con "creado" en el futuro   : ' + r.creado_futuro + (r.creado_futuro ? '   <-- MAL' : '   ok'));
  console.log('');

  // Las que estan mal, con su antiguedad
  const malas = await bd.consultar(
    'SELECT TOP 12 id, codigo, nombre_completo, ' +
    'CONVERT(varchar(30), entrada, 127) AS entrada_sql, entrada, creado, ' +
    'DATEDIFF(minute, entrada, SYSDATETIMEOFFSET()) AS minutos_desde_entrada, ' +
    'DATEDIFF(minute, creado, SYSDATETIMEOFFSET()) AS minutos_desde_creacion ' +
    'FROM vf_visitas WHERE entrada > SYSDATETIMEOFFSET() ORDER BY entrada DESC'
  );

  if (malas.recordset.length) {
    console.log('  --- visitas con la entrada en el futuro ---');
    console.log('  codigo              entrada (SQL)                  minutos   creada hace');
    console.log('  ' + '-'.repeat(78));
    for (const v of malas.recordset) {
      console.log(
        '  ' + String(v.codigo).padEnd(20) + String(v.entrada_sql).padEnd(30) +
        String(v.minutos_desde_entrada + ' min').padEnd(10) + v.minutos_desde_creacion + ' min'
      );
    }
    console.log('');
    // Si todas se crearon hace mucho, el arreglo ya surtio efecto.
    const recientes = malas.recordset.filter((v) => v.minutos_desde_creacion < 30).length;
    if (!recientes) {
      console.log('  Todas se crearon hace mas de media hora: son datos de ANTES del arreglo.');
      console.log('  Los registros nuevos estan bien. Para regenerar los de prueba:');
      console.log('      npm run limpiar  &&  npm run demo');
    } else {
      console.log('  ATENCION: hay ' + recientes + ' visita(s) reciente(s) mal fechada(s). El arreglo no esta surtiendo efecto.');
    }
    console.log('');
  } else {
    console.log('  Ninguna visita tiene la entrada en el futuro: las horas son correctas.');
    console.log('');
  }

  // Las ultimas 5, para ver que las nuevas estan bien
  const ultimas = await bd.consultar(
    'SELECT TOP 5 codigo, CONVERT(varchar(30), entrada, 127) AS entrada_sql, ' +
    'CONVERT(varchar(30), creado, 127) AS creado_sql, ' +
    'DATEDIFF(minute, entrada, SYSDATETIMEOFFSET()) AS min_entrada, ' +
    'DATEDIFF(minute, creado, SYSDATETIMEOFFSET()) AS min_creado ' +
    'FROM vf_visitas ORDER BY creado DESC'
  );

  console.log('  --- las 5 visitas mas recientes (por fecha de creacion) ---');
  console.log('  codigo              entrada (SQL)                  se creo hace');
  console.log('  ' + '-'.repeat(78));
  for (const v of ultimas.recordset) {
    const bien = v.min_entrada >= -1 && v.min_creado >= -1;
    console.log(
      '  ' + String(v.codigo).padEnd(20) + String(v.entrada_sql).padEnd(30) +
      v.min_creado + ' min' + (bien ? '   ok' : '   <-- MAL')
    );
  }
  console.log('');

  await bd.cerrar();
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
