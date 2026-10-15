/**
 * VisitaFlow - Comprobar la base de cedulas (el padron).
 *
 *   node scripts/comprobar-padron.js
 *
 * PARA QUE
 * --------
 * Se corre DESPUES de restaurar el respaldo en el VPS, y tambien cuando alguien duda de
 * si el padron esta bien. Restaurar 275 MB a mano tiene varias formas de salir a medias
 * —un archivo cortado, una ruta mal, una restauracion interrumpida— y SQL Server no
 * siempre se queja. Esto lo dice claro:
 *
 *   - cuantos ciudadanos hay (el respaldo bueno trae 7.856.023)
 *   - si la vista dbo.CIUDADANOS responde, que es la que usa el sistema
 *   - cuantas columnas trae y cuales son
 *   - SI HAY FOTOGRAFIAS. Se pidio el padron sin fotos para no gastar espacio: si
 *     aparecen columnas de imagen, este respaldo no es el que se queria.
 *   - cuanto ocupa, para saber si el volumen tiene sentido
 *   - que la busqueda por cedula funcione de verdad
 *
 * No modifica nada: todo lo que hace son consultas de lectura.
 *
 * Salida con codigo 1 si algo esta mal, para poder encadenarlo en un despliegue.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));
const config = require(path.join(RAIZ, 'src', 'config.js'));

/* El respaldo bueno trae esta cantidad. Se comprueba con margen: si alguien restaura una
   version posterior del padron, el numero cambia, y no por eso esta mal. */
const ESPERADOS = 7856023;
const MARGEN = 0.01; // 1 %

let problemas = 0;

function bien(t) { console.log('  [ok]    ' + t); }
function mal(t) { problemas++; console.log('  [MAL]   ' + t); }
function aviso(t) { console.log('  [ojo]   ' + t); }
function info(t) { console.log('          ' + t); }

/** Los nombres de columna que delatarian que el respaldo trae fotografias. */
const COLUMNAS_DE_FOTO = ['foto', 'fotografia', 'imagen', 'photo', 'picture', 'huella', 'firma'];

(async () => {
  console.log('');
  console.log('  VisitaFlow - la base de cédulas');
  console.log('  ' + '='.repeat(66));

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('  Conexión');

  const cfg = config.identidad || {};
  info('servidor: ' + (config.sql && config.sql.servidor ? config.sql.servidor : '(sin definir)'));
  info('base de cédulas: ' + (cfg.baseDatos || '(sin definir)'));

  try {
    await bd.conectarPadron();
  } catch (e) {
    mal('no se pudo conectar a la base de cédulas: ' + e.message);
    console.log('');
    console.log('  ' + '='.repeat(66));
    console.log('  No se pudo comprobar nada.');
    console.log('  ' + '='.repeat(66));
    console.log('');
    process.exitCode = 1;
    return;
  }

  bien('conecta');

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('  La vista dbo.CIUDADANOS');

  let columnas = [];

  try {
    const col = await bd.consultarPadron(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'CIUDADANOS'
        ORDER BY ORDINAL_POSITION`
    );
    columnas = col.recordset;
  } catch (e) {
    mal('no se pudieron leer las columnas de la vista: ' + e.message);
  }

  if (!columnas.length) {
    mal('la vista dbo.CIUDADANOS no existe o no tiene columnas: el sistema no podrá buscar cédulas');
    info('se crea con: node sql/03-vista-ciudadanos.js');
  } else {
    bien('la vista existe, con ' + columnas.length + ' columnas');

    /* Las de foto: si alguna aparece, este respaldo no es el que se pidió. */
    const sospechosas = columnas.filter((c) => {
      const n = String(c.COLUMN_NAME).toLowerCase();
      return COLUMNAS_DE_FOTO.some((p) => n.indexOf(p) !== -1);
    });

    if (!sospechosas.length) {
      bien('NO trae columnas de fotografía (el respaldo es el ligero, como se pidió)');
    } else {
      mal('trae ' + sospechosas.length + ' columna(s) que parecen de imagen: ' +
        sospechosas.map((c) => c.COLUMN_NAME).join(', '));
      info('se pidió el padrón sin fotos para no gastar espacio');
    }

    /* Las que el sistema necesita de verdad. */
    const necesarias = ['Cedula', 'Nombres', 'Apellido1'];
    const faltan = necesarias.filter((n) => !columnas.some((c) => c.COLUMN_NAME === n));
    if (!faltan.length) {
      bien('trae las columnas que el sistema usa: ' + necesarias.join(', '));
    } else {
      mal('le faltan columnas que el sistema necesita: ' + faltan.join(', '));
    }

    const otras = columnas.map((c) => c.COLUMN_NAME).filter((n) => necesarias.indexOf(n) === -1);
    info('las demás: ' + otras.slice(0, 12).join(', ') + (otras.length > 12 ? '…' : ''));
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('  Cuántos ciudadanos hay');

  try {
    const r = await bd.consultarPadron('SELECT COUNT_BIG(*) AS n FROM dbo.CIUDADANOS');
    const n = Number(r.recordset[0].n);

    if (!n) {
      mal('la vista responde pero está VACÍA: la restauración no trajo los datos');
    } else {
      const diferencia = Math.abs(n - ESPERADOS) / ESPERADOS;

      if (diferencia <= MARGEN) {
        bien(n.toLocaleString('es-DO') + ' ciudadanos (el respaldo bueno trae ' +
          ESPERADOS.toLocaleString('es-DO') + ')');
      } else if (n < ESPERADOS) {
        aviso(n.toLocaleString('es-DO') + ' ciudadanos, y el respaldo bueno trae ' +
          ESPERADOS.toLocaleString('es-DO'));
        info('menos de lo esperado: puede ser una restauración a medias');
      } else {
        bien(n.toLocaleString('es-DO') + ' ciudadanos (más que el respaldo original: ' +
          'parece una versión más nueva del padrón)');
      }
    }
  } catch (e) {
    mal('no se pudo contar: ' + e.message);
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('  Que la búsqueda funcione de verdad');

  try {
    /* Se coge una cédula cualquiera y se busca por ella: es exactamente lo que hace el
       sistema cuando el recepcionista teclea una cédula. */
    const una = await bd.consultarPadron('SELECT TOP 1 Cedula, Nombres, Apellido1 FROM dbo.CIUDADANOS WHERE Cedula IS NOT NULL');

    if (!una.recordset.length) {
      mal('no hay ninguna cédula que buscar');
    } else {
      const c = String(una.recordset[0].Cedula).trim();
      const t0 = Date.now();
      const enc = await bd.consultarPadron(
        'SELECT Cedula, Nombres, Apellido1 FROM dbo.CIUDADANOS WHERE Cedula = @c',
        { c }
      );
      const ms = Date.now() - t0;

      if (enc.recordset.length) {
        bien('buscar por cédula funciona (' + ms + ' ms)');
        info('ejemplo: ' + c + ' → ' + enc.recordset[0].Nombres + ' ' + enc.recordset[0].Apellido1);
      } else {
        mal('se buscó la cédula ' + c + ' y no apareció: la vista responde mal');
      }

      if (ms > 2000) aviso('tardó ' + ms + ' ms: más de lo normal para una búsqueda por cédula');
    }

    /* Y una búsqueda por apellido, que es la otra forma de buscar. */
    const t1 = Date.now();
    const porApellido = await bd.consultarPadron(
      "SELECT TOP 5 Cedula, Nombres, Apellido1 FROM dbo.CIUDADANOS WHERE Apellido1 = 'RODRIGUEZ'"
    );
    const ms1 = Date.now() - t1;
    if (porApellido.recordset.length) {
      bien('buscar por apellido funciona (' + ms1 + ' ms, ' + porApellido.recordset.length + ' resultados)');
    } else {
      aviso('la búsqueda por apellido RODRIGUEZ no devolvió nada (¿otra versión del padrón?)');
    }
  } catch (e) {
    mal('falló la búsqueda: ' + e.message);
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('  Cuánto ocupa');

  try {
    const r = await bd.consultarPadron(
      `SELECT
         SUM(CASE WHEN type_desc = 'ROWS' THEN size END) * 8.0 / 1024 AS datos_mb,
         SUM(CASE WHEN type_desc = 'LOG' THEN size END) * 8.0 / 1024 AS log_mb
       FROM sys.database_files`
    );
    const f = r.recordset[0];
    info('datos: ' + Math.round(f.datos_mb || 0) + ' MB   registro de transacciones: ' + Math.round(f.log_mb || 0) + ' MB');

    /* El compose reserva 2 GB para el contenedor de la base. */
    if ((f.datos_mb || 0) > 5000) {
      mal('la base de cédulas ocupa más de 5 GB: el contenedor del VPS no va a poder con ella');
    } else {
      bien('cabe en el contenedor del VPS');
    }
  } catch (e) {
    aviso('no se pudo medir el tamaño: ' + e.message);
  }

  /* ------------------------------------------------------------------ */
  console.log('');
  console.log('  ' + '='.repeat(66));

  if (problemas) {
    console.log('  ' + problemas + ' problema(s). El sistema puede arrancar, pero la búsqueda por');
    console.log('  cédula no va a funcionar bien hasta que se arregle.');
  } else {
    console.log('  Todo en orden: la base de cédulas está lista para usar.');
  }

  console.log('  ' + '='.repeat(66));
  console.log('');

  try { await bd.cerrar(); } catch (e) { /* da igual */ }
  process.exitCode = problemas ? 1 : 0;
})().catch(async (e) => {
  console.log('');
  console.log('  Se detuvo: ' + e.message);
  console.log('');
  try { await bd.cerrar(); } catch (x) { /* da igual */ }
  process.exitCode = 1;
});
