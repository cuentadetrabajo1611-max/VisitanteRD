/**
 * VisitaFlow - Migracion de columnas de fecha a DATETIMEOFFSET.
 *
 *   node scripts\migrar-fechas.js
 *
 * POR QUE HACE FALTA
 * ------------------
 * Las columnas eran DATETIME2 y el sistema las llenaba con SYSDATETIME(), que
 * devuelve la hora LOCAL del servidor (sin decir a que zona pertenece). El
 * driver de SQL Server, al leer una DATETIME2, la interpreta como UTC. Resultado
 * medido en esta maquina (servidor en UTC-4):
 *
 *     SYSDATETIME()        -> el driver lo lee 4 horas atras   INCORRECTO
 *     SYSDATETIMEOFFSET()  -> el driver lo lee correcto
 *     SYSUTCDATETIME()     -> el driver lo lee correcto
 *
 * Con DATETIME2, cada visita quedaba 4 horas en el futuro para el navegador y
 * las duraciones salian NEGATIVAS.
 *
 * QUE HACE
 * --------
 * Convierte las columnas de fecha y hora a DATETIMEOFFSET(0), que guarda la
 * hora CON su zona y elimina la ambiguedad para siempre.
 *
 * Los datos que ya existian eran incorrectos (les faltaban 4 horas), asi que se
 * CORRIGEN en la misma pasada: se toma cada valor como si fuera UTC y se le
 * aplica el desfase del servidor. Sin eso, el historial quedaria desplazado.
 *
 * Es idempotente: si una columna ya es DATETIMEOFFSET, no la toca.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

async function principal() {
  console.log('');
  console.log('  VisitaFlow — migración de columnas de fecha');
  console.log('  ─────────────────────────────────────────────');

  const pool = await new sql.ConnectionPool({
    server: config.bd.sistema.server,
    port: config.bd.sistema.port,
    user: config.bd.sistema.user,
    password: config.bd.sistema.password,
    database: config.bd.sistema.database,
    options: { encrypt: config.bd.sistema.encrypt, trustServerCertificate: config.bd.sistema.trustServerCertificate, enableArithAbort: true },
    connectionTimeout: 20000,
  }).connect();

  // Desfase del servidor en minutos, para corregir los datos existentes.
  const off = await pool.request().query('SELECT DATEDIFF(minute, SYSUTCDATETIME(), SYSDATETIME()) AS desfase');
  const desfase = off.recordset[0].desfase;
  console.log('  Zona del servidor: ' + (desfase === 0 ? 'UTC' : 'UTC' + (desfase > 0 ? '+' : '') + (desfase / 60)));
  console.log('');

  // Todas las columnas datetime2 de las tablas del sistema.
  const columnas = await pool.request().query(`
    SELECT t.name AS tabla, c.name AS columna, ty.name AS tipo
      FROM sys.columns c
      JOIN sys.tables t ON t.object_id = c.object_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     WHERE t.name LIKE 'vf[_]%' AND ty.name IN ('datetime2', 'datetimeoffset')
     ORDER BY t.name, c.column_id`);

  const aMigrar = columnas.recordset.filter((c) => c.tipo === 'datetime2');
  const yaEstan = columnas.recordset.filter((c) => c.tipo === 'datetimeoffset');

  console.log('  Columnas ya en DATETIMEOFFSET: ' + yaEstan.length);
  console.log('  Columnas a migrar: ' + aMigrar.length);
  if (!aMigrar.length) {
    console.log('');
    console.log('  No hay nada que migrar. La base ya está al día.');
    console.log('');
    await pool.close();
    return;
  }
  console.log('');

  // El default hay que quitarlo antes de cambiar el tipo y volverlo a poner
  // despues, apuntando ahora a SYSDATETIMEOFFSET().
  let migradas = 0;
  let corregidas = 0;

  for (const c of aMigrar) {
    const tabla = 'dbo.[' + c.tabla + ']';
    let indicesGuardados = [];
    try {
      // 1. SQL Server no deja cambiar el tipo de una columna que participa en un
      //    indice. Se guarda la definicion de esos indices, se sueltan, se
      //    cambia el tipo y se vuelven a crear iguales.
      const idx = await pool
        .request()
        .input('tabla', sql.NVarChar(128), c.tabla)
        .input('columna', sql.NVarChar(128), c.columna)
        .query(`
          SELECT i.name AS indice, i.is_unique, i.type_desc,
                 STUFF((
                   SELECT ', [' + col.name + ']' + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE ' ASC' END
                     FROM sys.index_columns ic2
                     JOIN sys.columns col ON col.object_id = ic2.object_id AND col.column_id = ic2.column_id
                    WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0
                    ORDER BY ic2.key_ordinal
                    FOR XML PATH('')
                 ), 1, 2, '') AS columnas_clave,
                 STUFF((
                   SELECT ', [' + col.name + ']'
                     FROM sys.index_columns ic2
                     JOIN sys.columns col ON col.object_id = ic2.object_id AND col.column_id = ic2.column_id
                    WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 1
                    ORDER BY ic2.index_column_id
                    FOR XML PATH('')
                 ), 1, 2, '') AS columnas_incluidas
            FROM sys.indexes i
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
           WHERE i.object_id = OBJECT_ID(@tabla)
             AND col.name = @columna
             AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
             AND i.type > 0
           GROUP BY i.name, i.is_unique, i.type_desc, i.object_id, i.index_id`);

      for (const i of idx.recordset) {
        indicesGuardados.push(i);
        await pool.request().query('DROP INDEX [' + i.indice + '] ON ' + tabla);
      }

      // 2. Se sueltan las restricciones DEFAULT de esa columna.
      const defs = await pool
        .request()
        .input('tabla', sql.NVarChar(128), c.tabla)
        .input('columna', sql.NVarChar(128), c.columna)
        .query(`
          SELECT dc.name
            FROM sys.default_constraints dc
            JOIN sys.columns col ON col.object_id = dc.parent_object_id AND col.column_id = dc.parent_column_id
           WHERE dc.parent_object_id = OBJECT_ID(@tabla) AND col.name = @columna`);

      for (const d of defs.recordset) {
        await pool.request().query('ALTER TABLE ' + tabla + ' DROP CONSTRAINT [' + d.name + ']');
      }

      // 3. Se corrige lo que ya habia: el valor se guardo como hora local, pero
      //    el driver lo leyo como UTC. Se le quita el desfase para que quede el
      //    instante real.
      const esNulable = await pool
        .request()
        .input('tabla', sql.NVarChar(128), c.tabla)
        .input('columna', sql.NVarChar(128), c.columna)
        .query(`
          SELECT c.is_nullable
            FROM sys.columns c
           WHERE c.object_id = OBJECT_ID(@tabla) AND c.name = @columna`);
      const nulable = esNulable.recordset[0] && esNulable.recordset[0].is_nullable;

      const tipoNuevo = 'DATETIMEOFFSET(0)';
      await pool.request().query(
        'ALTER TABLE ' + tabla + ' ALTER COLUMN [' + c.columna + '] ' + tipoNuevo + (nulable ? ' NULL' : ' NOT NULL')
      );
      migradas++;

      // 4. Se reescribe el instante: si el desfase del servidor no es cero, los
      //    valores viejos estan corridos y hay que devolverlos a su sitio.
      if (desfase !== 0) {
        const r = await pool.request().query(
          'UPDATE ' + tabla + ' SET [' + c.columna + '] = DATEADD(minute, ' + desfase + ', [' + c.columna + ']) WHERE [' + c.columna + '] IS NOT NULL'
        );
        corregidas += r.rowsAffected[0] || 0;
      }

      // 5. Se vuelve a poner el default, ahora con la hora y su zona.
      const conDefault = ['creado', 'creada', 'emitido', 'activada', 'primera_vez', 'ultima_vez', 'entrada', 'vigente_desde'];
      if (conDefault.indexOf(c.columna) !== -1) {
        await pool.request().query(
          'ALTER TABLE ' + tabla + ' ADD CONSTRAINT [DF_' + c.tabla + '_' + c.columna + '_off] DEFAULT SYSDATETIMEOFFSET() FOR [' + c.columna + ']'
        ).catch(() => {
          /* si ya existia un default equivalente, no pasa nada */
        });
      }

      // 6. Se recrean los indices que se soltaron, tal como estaban.
      for (const i of indicesGuardados) {
        const incluidas = i.columnas_incluidas ? ' INCLUDE (' + i.columnas_incluidas + ')' : '';
        await pool.request().query(
          'CREATE ' + (i.is_unique ? 'UNIQUE ' : '') + 'INDEX [' + i.indice + '] ON ' + tabla +
          ' (' + i.columnas_clave + ')' + incluidas
        );
      }
      indicesGuardados = [];
    } catch (e) {
      console.log('  FALLO ' + c.tabla + '.' + c.columna + ' -> ' + e.message);
      // Si algo fallo a medias, se intentan devolver los indices de todas formas.
      for (const i of indicesGuardados) {
        const incluidas = i.columnas_incluidas ? ' INCLUDE (' + i.columnas_incluidas + ')' : '';
        try {
          await pool.request().query(
            'CREATE ' + (i.is_unique ? 'UNIQUE ' : '') + 'INDEX [' + i.indice + '] ON ' + tabla +
            ' (' + i.columnas_clave + ')' + incluidas
          );
        } catch (e2) {
          console.log('    (no se pudo recrear el índice ' + i.indice + ': ' + e2.message + ')');
        }
      }
    }
  }

  console.log('  ' + migradas + ' columna(s) convertidas a DATETIMEOFFSET');
  if (desfase !== 0) console.log('  ' + corregidas + ' valor(es) de fecha corregidos por el desfase de la zona');

  // Comprobacion: que una fecha nueva viaje bien.
  const prueba = await pool.request().query('SELECT SYSDATETIMEOFFSET() AS ahora');
  const dif = Math.round((new Date().getTime() - prueba.recordset[0].ahora.getTime()) / 1000);
  console.log('');
  console.log('  Comprobación: una fecha del servidor y la del proceso Node difieren en ' + dif + ' segundo(s)');
  console.log('  ' + (Math.abs(dif) <= 5 ? 'Correcto: las fechas ya viajan bien.' : 'ATENCION: revise la zona horaria del servidor.'));
  console.log('');

  await pool.close();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
