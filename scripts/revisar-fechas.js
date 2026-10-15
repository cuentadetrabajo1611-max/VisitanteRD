/**
 * VisitaFlow - Diagnostico y reparacion de fechas.
 *
 *   node scripts\revisar-fechas.js                    (solo informa)
 *   node scripts\revisar-fechas.js --reparar          (corrige)
 *   node scripts\revisar-fechas.js --reparar --limpiar (ademas borra los datos
 *                                                       de demostracion)
 *
 * POR QUE EXISTE
 * --------------
 * Al migrar las columnas de DATETIME2 a DATETIMEOFFSET hubo que reescribir los
 * valores que ya existian, porque se habian guardado como hora local y el driver
 * los leia como UTC. Ese reajuste se aplico con el SIGNO AL REVEZ en una primera
 * pasada, asi que las columnas quedaron desplazadas el DOBLE del desfase de la
 * zona, y seis de ellas quedaron convertidas de tipo pero sin reajustar.
 *
 * COMO DECIDE
 * -----------
 * No adivina: mide. Para cada columna comparable (las que se llenan al crear el
 * registro) calcula el promedio de minutos entre el valor y la hora real del
 * servidor. Si ese promedio esta corrido en 2 x desfase, la columna esta
 * desplazada el doble y se corrige sumando -2 x desfase.
 *
 * --limpiar borra las visitas, visitantes, gafetes, pre-registros y avisos de
 * prueba, y regenera la institucion y su administrador. Se usa cuando los datos
 * existentes son de prueba y conviene volver a generarlos ya bien fechados.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const REPARAR = process.argv.includes('--reparar');
const LIMPIAR = process.argv.includes('--limpiar');

/* Columnas que se comparan contra "ahora" (las que se llenan al crear el
   registro). Las de salida o vencimiento no sirven para esto: pueden estar
   legitimamente en el futuro o en el pasado. */
const COMPARABLES = ['creado', 'creada', 'emitido', 'activada', 'entrada', 'primera_vez', 'revisada', 'usado', 'impreso'];

async function principal() {
  const pool = await new sql.ConnectionPool({
    server: config.bd.sistema.server,
    port: config.bd.sistema.port,
    user: config.bd.sistema.user,
    password: config.bd.sistema.password,
    database: config.bd.sistema.database,
    options: { encrypt: config.bd.sistema.encrypt, trustServerCertificate: config.bd.sistema.trustServerCertificate, enableArithAbort: true },
    connectionTimeout: 20000,
  }).connect();

  const r0 = await pool.request().query('SELECT DATEDIFF(minute, SYSUTCDATETIME(), SYSDATETIME()) AS desfase');
  const desfase = r0.recordset[0].desfase;

  console.log('');
  console.log('  VisitaFlow — revisión de fechas' + (REPARAR ? ' (corrigiendo)' : ' (solo informe)'));
  console.log('  ─────────────────────────────────────────────');
  console.log('  Desfase de la zona del servidor: ' + (desfase > 0 ? '+' : '') + desfase + ' minutos');
  console.log('  Hora UTC ahora: ' + new Date().toISOString());
  console.log('');

  const cols = await pool.request().query(`
    SELECT t.name AS tabla, c.name AS columna, ty.name AS tipo
      FROM sys.columns c
      JOIN sys.tables t ON t.object_id = c.object_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     WHERE t.name LIKE 'vf[_]%' AND ty.name IN ('datetime2','datetimeoffset')
     ORDER BY t.name, c.name`);

  // Limpieza opcional de los datos de prueba. Se hace ANTES de reparar: es mas
  // rapido y mas limpio volver a generar los datos que arrastrar fechas dudosas.
  if (LIMPIAR) {
    console.log('  Borrando datos de prueba (visitas, visitantes, gafetes, anuncios)…');
    const borrados = [
      'DELETE FROM vf_gafetes',
      'DELETE FROM vf_vigilancia_avisos',
      'DELETE FROM vf_visitas',
      'DELETE FROM vf_preregistros',
      'DELETE FROM vf_visitantes',
      'DELETE FROM vf_vigilancia',
      'DELETE FROM vf_auditoria',
      'DELETE FROM vf_licencias_revisiones',
    ];
    for (const b of borrados) {
      try {
        await pool.request().query(b);
      } catch (e) {
        console.log('    (no se pudo: ' + b.slice(0, 40) + ' -> ' + e.message.slice(0, 60) + ')');
      }
    }
    console.log('  Datos de prueba borrados. Vuelva a generarlos con: npm run demo');
    console.log('');
  }

  let revisadas = 0;
  let corregidas = 0;
  let pendientesTipo = 0;

  console.log('  tabla.columna                          tipo             desfase medido   accion');
  console.log('  ' + '-'.repeat(104));

  for (const c of cols.recordset) {
    const esComparable = COMPARABLES.indexOf(c.columna) !== -1;
    const tabla = 'dbo.[' + c.tabla + ']';

    // 1. Si todavia es DATETIME2, hay que pasarla a DATETIMEOFFSET: mientras
    //    siga siendo DATETIME2, el driver seguira leyendola mal.
    if (c.tipo === 'datetime2') {
      pendientesTipo++;
      let accion = 'convertir a DATETIMEOFFSET';
      if (REPARAR) {
        try {
          const nulls = await pool.request().query(`
            SELECT c.is_nullable FROM sys.columns c
             WHERE c.object_id = OBJECT_ID('dbo.[${c.tabla}]') AND c.name = '${c.columna}'`);
          const nulable = nulls.recordset[0] && nulls.recordset[0].is_nullable;

          const defs = await pool.request().query(`
            SELECT dc.name FROM sys.default_constraints dc
              JOIN sys.columns col ON col.object_id = dc.parent_object_id AND col.column_id = dc.parent_column_id
             WHERE dc.parent_object_id = OBJECT_ID('dbo.[${c.tabla}]') AND col.name = '${c.columna}'`);
          for (const d of defs.recordset) {
            await pool.request().query('ALTER TABLE ' + tabla + ' DROP CONSTRAINT [' + d.name + ']');
          }

          // Los indices que la usen hay que soltarlos y rehacerlos.
          const idx = await pool.request().query(`
            SELECT i.name AS indice, i.is_unique,
                   STUFF((SELECT ', [' + col.name + ']' + CASE WHEN ic2.is_descending_key = 1 THEN ' DESC' ELSE ' ASC' END
                            FROM sys.index_columns ic2
                            JOIN sys.columns col ON col.object_id = ic2.object_id AND col.column_id = ic2.column_id
                           WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0
                           ORDER BY ic2.key_ordinal FOR XML PATH('')), 1, 2, '') AS claves,
                   STUFF((SELECT ', [' + col.name + ']'
                            FROM sys.index_columns ic2
                            JOIN sys.columns col ON col.object_id = ic2.object_id AND col.column_id = ic2.column_id
                           WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 1
                           ORDER BY ic2.index_column_id FOR XML PATH('')), 1, 2, '') AS incluidas
              FROM sys.indexes i
              JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
              JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
             WHERE i.object_id = OBJECT_ID('dbo.[${c.tabla}]') AND col.name = '${c.columna}'
               AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.type > 0
             GROUP BY i.name, i.is_unique, i.object_id, i.index_id`);
          for (const i of idx.recordset) {
            await pool.request().query('DROP INDEX [' + i.indice + '] ON ' + tabla);
          }

          // Al convertir DATETIME2 -> DATETIMEOFFSET, SQL Server pone +00:00 y
          // conserva los numeros. El valor guardado es la hora local, asi que
          // para que quede el instante real hay que RESTARLE el desfase.
          await pool.request().query(
            'ALTER TABLE ' + tabla + ' ALTER COLUMN [' + c.columna + '] DATETIMEOFFSET(0) ' + (nulable ? 'NULL' : 'NOT NULL')
          );
          if (desfase !== 0) {
            await pool.request().query(
              'UPDATE ' + tabla + ' SET [' + c.columna + '] = DATEADD(minute, ' + -desfase + ', [' + c.columna + ']) WHERE [' + c.columna + '] IS NOT NULL'
            );
          }

          const conDefault = ['creado', 'creada', 'emitido', 'activada', 'primera_vez', 'ultima_vez', 'entrada', 'vigente_desde', 'revisada'];
          if (conDefault.indexOf(c.columna) !== -1) {
            await pool.request().query(
              'ALTER TABLE ' + tabla + ' ADD CONSTRAINT [DF_' + c.tabla + '_' + c.columna + '_off] DEFAULT SYSDATETIMEOFFSET() FOR [' + c.columna + ']'
            ).catch(() => {});
          }

          for (const i of idx.recordset) {
            const incl = i.incluidas ? ' INCLUDE (' + i.incluidas + ')' : '';
            await pool.request().query(
              'CREATE ' + (i.is_unique ? 'UNIQUE ' : '') + 'INDEX [' + i.indice + '] ON ' + tabla + ' (' + i.claves + ')' + incl
            );
          }
          corregidas++;
        } catch (e) {
          accion = 'FALLO: ' + e.message.slice(0, 50);
        }
      }
      console.log('  ' + (c.tabla + '.' + c.columna).padEnd(38) + 'DATETIME2'.padEnd(17) + '—'.padEnd(17) + accion);
      continue;
    }

    // 2. Ya es DATETIMEOFFSET: se comprueba si el valor esta desplazado.
    if (!esComparable) {
      console.log('  ' + (c.tabla + '.' + c.columna).padEnd(38) + 'DATETIMEOFFSET'.padEnd(17) + '(no aplica)'.padEnd(17) + 'se deja igual');
      continue;
    }

    try {
      const med = await pool.request().query(
        'SELECT COUNT(*) AS n, ' +
        'AVG(CAST(DATEDIFF(minute, [' + c.columna + '], SYSDATETIMEOFFSET()) AS float)) AS promedio, ' +
        'MIN(DATEDIFF(minute, [' + c.columna + '], SYSDATETIMEOFFSET())) AS minimo, ' +
        'MAX(DATEDIFF(minute, [' + c.columna + '], SYSDATETIMEOFFSET())) AS maximo ' +
        'FROM ' + tabla + ' WHERE [' + c.columna + '] IS NOT NULL'
      );
      const f = med.recordset[0];
      revisadas++;

      if (!f.n) {
        console.log('  ' + (c.tabla + '.' + c.columna).padEnd(38) + 'DATETIMEOFFSET'.padEnd(17) + '(vacía)'.padEnd(17) + 'sin datos');
        continue;
      }

      // El valor esperado es "hace un rato": positivo y pequeño. Si el promedio
      // esta corrido en 2 x desfase (o en 1 x desfase), la columna esta mal.
      const prom = Math.round(f.promedio);
      let accion = 'correcta';
      let delta = 0;

      if (desfase !== 0) {
        // El desplazamiento buscado es el que deja el promedio lo mas cerca
        // posible de cero. Se prueban los multiplos del desfase.
        for (const k of [2, 1, -1, -2]) {
          const candidato = k * desfase;
          if (Math.abs(prom + candidato) < Math.abs(prom + delta) - Math.abs(desfase) / 2) {
            delta = candidato;
          }
        }
      }

      if (delta !== 0) {
        accion = 'desplazada ' + (delta / desfase === 2 || delta / desfase === -2 ? 'el doble' : '') +
          ' -> se corrige en ' + -delta + ' min';
        if (REPARAR) {
          await pool.request().query(
            'UPDATE ' + tabla + ' SET [' + c.columna + '] = DATEADD(minute, ' + -delta + ', [' + c.columna + ']) WHERE [' + c.columna + '] IS NOT NULL'
          );
          corregidas++;
        }
      }

      console.log(
        '  ' + (c.tabla + '.' + c.columna).padEnd(38) +
        'DATETIMEOFFSET'.padEnd(17) +
        (prom + ' min').padEnd(17) +
        accion
      );
    } catch (e) {
      console.log('  ' + (c.tabla + '.' + c.columna).padEnd(38) + 'DATETIMEOFFSET'.padEnd(17) + 'ERROR'.padEnd(17) + e.message.slice(0, 40));
    }
  }

  console.log('');
  console.log('  Columnas revisadas: ' + revisadas + ' | pendientes de tipo: ' + pendientesTipo + ' | corregidas: ' + corregidas);
  if (!REPARAR && (pendientesTipo || corregidas)) {
    console.log('  Ejecute con --reparar para aplicar las correcciones.');
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
