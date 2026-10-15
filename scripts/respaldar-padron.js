/**
 * VisitaFlow - Respaldo de la base de cedulas y comprobacion de que se puede restaurar.
 *
 *   node scripts/respaldar-padron.js                  (respalda, verifica y restaura de prueba)
 *   node scripts/respaldar-padron.js --solo-verificar (no gasta 1,5 GB: se salta la restauracion)
 *   node scripts/respaldar-padron.js --rehacer        (repite el respaldo aunque ya exista)
 *   node scripts/respaldar-padron.js --checkdb        (ademas pasa DBCC CHECKDB a la copia)
 *
 * POR QUE EXISTE
 * --------------
 * PadronLigero son 1,5 GB en disco y 7,8 millones de cedulas. El VPS la recibe
 * como un .bak que se sube una sola vez: si el archivo esta truncado o el
 * respaldo no se puede restaurar, el problema aparece a 2000 km de aqui, despues
 * de haber subido 274 MB. Sale mucho mas barato descubrirlo en esta maquina.
 *
 * Por eso el script no se conforma con RESTORE VERIFYONLY: restaura de verdad en
 * una base desechable, cuenta las filas y despues la borra.
 *
 * DOS DETALLES QUE IMPORTAN
 * -------------------------
 * 1. PadronLigero es de SOLO LECTURA para este script. Lo unico que se le hace es
 *    BACKUP y un COUNT. Nada de escritura.
 *
 * 2. La restauracion lleva MOVE a C:\TempSQL. En esta maquina los archivos de
 *    PadronLigero viven ahi, pero la carpeta de datos por defecto de la instancia
 *    es C:\Program Files\Microsoft SQL Server\MSSQL16.MSSQLSERVER\MSSQL\DATA. Sin
 *    MOVE, SQL Server dejaria 1,9 GB de copia de prueba dentro de Archivos de
 *    programa y el DROP no siempre se los lleva. Ademas es lo que hace el VPS, que
 *    tambien necesita MOVE para escribir en /var/opt/mssql/data.
 *
 * El respaldo se escribe con la cuenta de servicio de SQL Server, no con la del
 * usuario. Si C:\TempSQL no le deja escribir, el script lo reintenta en
 * C:\TempSQL\respaldos, que es la carpeta que probar-respaldo.js deja comprobada.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const BASE = config.bd.padron.database || 'PadronLigero';
const CARPETA = 'C:\\TempSQL';
const ARCHIVO = path.join(CARPETA, 'PadronLigero.bak');
const ARCHIVO_ALTERNO = path.join(CARPETA, 'respaldos', 'PadronLigero.bak');
const PRUEBA = 'PadronLigero_PruebaRestore';
const ESPERA = 3600000;

// El nombre de la base desechable es lo unico que separa un DROP inocente de uno
// que se lleva por delante la base buena. Se comprueba una vez, al arrancar.
if (PRUEBA === BASE || !PRUEBA.endsWith('_PruebaRestore')) {
  throw new Error('El nombre de la base de prueba no es seguro: ' + PRUEBA);
}

/** Un pool por base: las consultas al padron necesitan su propio contexto. */
function opciones(database) {
  return {
    server: config.bd.padron.server,
    port: config.bd.padron.port,
    user: config.bd.padron.user,
    password: config.bd.padron.password,
    database: database,
    options: {
      encrypt: config.bd.padron.encrypt,
      trustServerCertificate: config.bd.padron.trustServerCertificate,
      enableArithAbort: true,
    },
    connectionTimeout: 30000,
    requestTimeout: ESPERA,
  };
}

function mb(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function seg(ms) {
  if (ms < 1000) return Math.round(ms) + ' ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + ' s';
  return Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s';
}

/**
 * Ejecuta una instruccion y devuelve el resultado, los avisos y lo que tardo.
 *
 * SQL Server manda el avance y el veredicto por mensajes INFO, no por filas: sin
 * escucharlos, un BACKUP de 1,5 GB parece colgado y RESTORE VERIFYONLY no dice
 * nada. STATS solo agrega avisos: el archivo sale igual.
 */
async function ejecutar(pool, texto, avisar) {
  const req = pool.request();
  const avisos = [];
  req.on('info', (m) => {
    const t = m.message || '';
    avisos.push(t);
    const p = /(\d+)\s*percent/i.exec(t);
    if (avisar && p && Number(p[1]) % 25 === 0) console.log('      ' + p[1] + '%');
  });
  const t0 = process.hrtime.bigint();
  const r = await req.query(texto);
  return { r, avisos, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

/** La tabla que guarda las cedulas. La vista CIUDADANOS se apoya en ella. */
async function tablaBase(pool) {
  const porNombre = await pool.request().query(
    "SELECT s.name + '.' + t.name AS nombre FROM sys.tables t " +
    "JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.name = 'PADRON'"
  );
  if (porNombre.recordset.length) return porNombre.recordset[0].nombre;

  // Si el padron viniera con otro nombre, la tabla gorda es la de las cedulas.
  const gorda = await pool.request().query(
    'SELECT TOP 1 s.name + ' + "'.'" + ' + t.name AS nombre ' +
    'FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id ' +
    'JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) ' +
    'WHERE t.is_ms_shipped = 0 GROUP BY s.name, t.name ORDER BY SUM(p.rows) DESC'
  );
  return gorda.recordset[0].nombre;
}

/** Borra la base de prueba y los archivos que hubiera dejado. */
async function borrarPrueba(maestra) {
  console.log('');
  console.log('  Borrando la base de prueba...');

  const id = (
    await maestra.request().input('n', sql.NVarChar(200), PRUEBA).query('SELECT DB_ID(@n) AS id')
  ).recordset[0].id;

  if (id) {
    await maestra.request().query(
      'ALTER DATABASE [' + PRUEBA + '] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ' +
      'DROP DATABASE [' + PRUEBA + '];'
    );
  }

  // El DROP suelta los archivos, pero si algo los dejo tomados quedan huerfanos
  // ocupando 1,9 GB. Se borran solo si estan en C:\TempSQL y son de la prueba.
  const huerfanos = [PRUEBA + '.mdf', PRUEBA + '_log.ldf']
    .map((n) => path.resolve(CARPETA, n))
    .filter((f) => path.dirname(f) === path.resolve(CARPETA))
    .filter((f) => fs.existsSync(f));

  for (const f of huerfanos) fs.unlinkSync(f);

  const quedan = (
    await maestra.request().input('n', sql.NVarChar(200), PRUEBA).query('SELECT DB_ID(@n) AS id')
  ).recordset[0].id;
  const archivos = [PRUEBA + '.mdf', PRUEBA + '_log.ldf']
    .map((n) => path.join(CARPETA, n))
    .filter((f) => fs.existsSync(f));

  console.log('  Base de prueba: ' + (quedan ? 'TODAVIA EXISTE (revisar)' : 'borrada'));
  console.log('  Archivos de la prueba en disco: ' + (archivos.length ? archivos.join(', ') : 'ninguno'));

  return !quedan && !archivos.length;
}

/** Saca el respaldo, o reutiliza el que ya hay. */
async function respaldar(maestra, rehacer) {
  if (fs.existsSync(ARCHIVO) && !rehacer) {
    const f = fs.statSync(ARCHIVO);
    console.log('  Ya existe un respaldo; no se repite.');
    console.log('  Archivo: ' + ARCHIVO);
    console.log('  Tamano:  ' + mb(f.size) + '  (' + f.size.toLocaleString('es-DO') + ' bytes)');
    console.log('  Fecha:   ' + f.mtime.toLocaleString('es-DO'));
    console.log('  Para rehacerlo:  node scripts/respaldar-padron.js --rehacer');
    return { ruta: ARCHIVO, ms: null, reutilizado: true };
  }

  fs.mkdirSync(CARPETA, { recursive: true });

  // Primero el destino pedido. Si SQL Server no puede escribir ahi, se usa la
  // carpeta que probar-respaldo.js dejo comprobada.
  const intentos = [ARCHIVO, ARCHIVO_ALTERNO];
  let ultimoError = null;

  for (const destino of intentos) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    console.log('  Respaldando ' + BASE + ' en ' + destino + ' ...');
    console.log('  (comprimido; lo escribe la cuenta de servicio de SQL Server)');
    console.log('');

    try {
      const r = await ejecutar(
        maestra,
        "BACKUP DATABASE [" + BASE + "] TO DISK = N'" + destino + "' WITH COMPRESSION, INIT, STATS = 25",
        true
      );
      const f = fs.statSync(destino);
      console.log('');
      console.log('  BACKUP terminado en ' + seg(r.ms));
      return { ruta: destino, ms: r.ms, reutilizado: false, tamano: f.size };
    } catch (e) {
      ultimoError = e;
      console.log('  Fallo: ' + e.message.split('\n')[0].slice(0, 160));
      const dispositivo = /backup device|access is denied|operating system error/i.test(e.message);
      if (!dispositivo || destino === intentos[intentos.length - 1]) throw e;
      console.log('  Se reintenta en otra carpeta...');
      console.log('');
    }
  }

  throw ultimoError;
}

async function principal() {
  const args = process.argv.slice(2);
  const rehacer = args.indexOf('--rehacer') !== -1;
  const soloVerificar = args.indexOf('--solo-verificar') !== -1;
  const conCheckdb = args.indexOf('--checkdb') !== -1;
  const estado = args.indexOf('--estado') !== -1;

  console.log('');
  console.log('  VisitaFlow - respaldo de la base de cedulas');
  console.log('  ' + '='.repeat(64));
  console.log('  Base:    ' + BASE + '   (solo lectura)');
  console.log('  Archivo: ' + ARCHIVO);
  console.log('');

  const maestra = await new sql.ConnectionPool(opciones('master')).connect();
  const padron = await new sql.ConnectionPool(opciones(BASE)).connect();
  const marcas = {};

  try {
    // --- Solo con --estado: que bases y que archivos hay, sin tocar nada ----
    if (estado) {
      const bases = (
        await maestra.request().query(
          "SELECT name, state_desc FROM sys.databases WHERE name LIKE 'Padron%' ORDER BY name"
        )
      ).recordset;
      console.log('  Bases que empiezan por Padron:');
      for (const b of bases) console.log('    ' + b.name.padEnd(32) + b.state_desc);
      console.log('');
      console.log('  Archivos en ' + CARPETA + ':');
      for (const a of fs.readdirSync(CARPETA)) {
        const p = path.join(CARPETA, a);
        const info = fs.statSync(p);
        console.log('    ' + a.padEnd(32) + (info.isDirectory() ? '<carpeta>' : mb(info.size)));
      }
      console.log('');
      const sobra = bases.filter((b) => b.name !== BASE);
      console.log('  Sobra de pruebas: ' + (sobra.length ? sobra.map((b) => b.name).join(', ') : 'nada'));
      console.log('');
      return;
    }

    // --- 0. Con que SQL Server y con cuanto disco se cuenta ------------------
    const srv = (
      await maestra.request().query(
        "SELECT CONVERT(varchar(80), SERVERPROPERTY('ProductVersion')) AS version, " +
        "CONVERT(varchar(120), SERVERPROPERTY('Edition')) AS edicion, " +
        "CONVERT(varchar(300), SERVERPROPERTY('InstanceDefaultDataPath')) AS datos"
      )
    ).recordset[0];
    console.log('  SQL Server ' + srv.version + ' (' + srv.edicion + ')');
    // Si esta carpeta es C:\TempSQL, restaurar sin MOVE seria pisar la base viva.
    console.log('  Carpeta de datos de la instancia: ' + srv.datos);

    const pruebaPrevia = (
      await maestra.request().input('n', sql.NVarChar(200), PRUEBA).query('SELECT DB_ID(@n) AS id')
    ).recordset[0].id;
    if (pruebaPrevia && !soloVerificar) {
      console.log('  Quedo una base de prueba de una corrida anterior: se borra.');
      await borrarPrueba(maestra);
    }

    // --- 1. Cuantas cedulas hay en el original ------------------------------
    const tabla = await tablaBase(padron);
    const origen = await ejecutar(padron, 'SELECT COUNT_BIG(*) AS n FROM ' + tabla);
    const filasOrigen = Number(origen.r.recordset[0].n);
    const vista = (
      await padron.request().query("SELECT OBJECT_ID('dbo.CIUDADANOS') AS id")
    ).recordset[0].id;
    console.log('  Original: ' + tabla + ' con ' + filasOrigen.toLocaleString('es-DO') + ' registros');
    console.log('  Vista dbo.CIUDADANOS: ' + (vista ? 'presente' : 'NO EXISTE (el sistema no encontrara cedulas)'));
    console.log('');

    // --- 2. El respaldo -----------------------------------------------------
    const marca = await respaldar(maestra, rehacer);
    marcas.backup = marca.ms;

    const f = fs.statSync(marca.ruta);
    console.log('');
    console.log('  Tamano real del archivo: ' + mb(f.size) + '  (' + f.size.toLocaleString('es-DO') + ' bytes)');
    console.log('');

    // --- 3. RESTORE VERIFYONLY ---------------------------------------------
    console.log('  Verificando el respaldo (RESTORE VERIFYONLY)...');
    const verif = await ejecutar(
      maestra,
      "RESTORE VERIFYONLY FROM DISK = N'" + marca.ruta + "'",
      true
    );
    marcas.verify = verif.ms;
    // El veredicto llega como aviso INFO, no como fila del resultado.
    const mensaje = verif.avisos.filter((m) => !/percent/i.test(m)).join(' ').trim();
    console.log('  Respaldo valido. (' + seg(verif.ms) + ')');
    if (mensaje) console.log('  ' + mensaje);
    console.log('');

    // --- 4. Que trae dentro -------------------------------------------------
    const cab = (
      await maestra.request()
        .input('ruta', sql.NVarChar(400), marca.ruta)
        .query('RESTORE HEADERONLY FROM DISK = @ruta')
    ).recordset[0];

    const archivos = (
      await maestra.request()
        .input('ruta', sql.NVarChar(400), marca.ruta)
        .query('RESTORE FILELISTONLY FROM DISK = @ruta')
    ).recordset;

    const datos = archivos.find((x) => x.Type === 'D');
    const bitacora = archivos.find((x) => x.Type === 'L');

    // OJO: la columna de RESTORE HEADERONLY es DatabaseName. BackupDatabaseName
    // existe en msdb.backupset, no aqui, y sale como undefined sin avisar.
    console.log('  Contenido del respaldo:');
    console.log('    Base:            ' + cab.DatabaseName);
    console.log('    Terminado:       ' + cab.BackupFinishDate);
    console.log('    Tamano sin comprimir: ' + mb(cab.BackupSize));
    console.log('    Tamano comprimido:    ' + mb(cab.CompressedBackupSize));
    console.log('    Nombres logicos: ' + archivos.map((x) => x.LogicalName + ' (' + x.Type + ')').join(', '));
    console.log('');

    // DESPLIEGUE.md restaura con MOVE 'PadronLigero' y 'PadronLigero_log'. Si los
    // nombres logicos reales no son esos, el comando del VPS falla tal cual esta.
    if (datos.LogicalName !== 'PadronLigero' || bitacora.LogicalName !== 'PadronLigero_log') {
      console.log('  OJO: DESPLIEGUE.md usa MOVE \'PadronLigero\' y \'PadronLigero_log\' y los');
      console.log('  nombres reales son otros. Hay que corregir el comando del VPS.');
      console.log('');
    }

    if (soloVerificar) {
      console.log('  --solo-verificar: no se restaura. Fin.');
      console.log('');
      return;
    }

    // --- 5. La prueba de verdad: restaurar y contar -------------------------
    const mdf = path.join(CARPETA, PRUEBA + '.mdf');
    const ldf = path.join(CARPETA, PRUEBA + '_log.ldf');
    fs.mkdirSync(CARPETA, { recursive: true });

    console.log('  Restaurando en ' + PRUEBA + ' (con MOVE a ' + CARPETA + ')...');
    const restore = await ejecutar(
      maestra,
      'RESTORE DATABASE [' + PRUEBA + '] FROM DISK = N\'' + marca.ruta + '\' WITH ' +
      "MOVE N'" + datos.LogicalName + "' TO N'" + mdf + "', " +
      "MOVE N'" + bitacora.LogicalName + "' TO N'" + ldf + "', " +
      'REPLACE, RECOVERY, STATS = 25',
      true
    );
    marcas.restore = restore.ms;
    console.log('');
    console.log('  RESTORE terminado en ' + seg(restore.ms));

    const copia = await new sql.ConnectionPool(opciones(PRUEBA)).connect();
    try {
      const destino = await ejecutar(copia, 'SELECT COUNT_BIG(*) AS n FROM ' + tabla);
      const filasCopia = Number(destino.r.recordset[0].n);
      const vistaCopia = (
        await copia.request().query("SELECT OBJECT_ID('dbo.CIUDADANOS') AS id")
      ).recordset[0].id;

      marcas.conteo = destino.ms;

      console.log('');
      console.log('  Original:  ' + filasOrigen.toLocaleString('es-DO') + ' registros');
      console.log('  Restaurada: ' + filasCopia.toLocaleString('es-DO') + ' registros');
      console.log('  Vista dbo.CIUDADANOS en la copia: ' + (vistaCopia ? 'presente' : 'NO EXISTE'));
      console.log('');

      const cuadra = filasCopia === filasOrigen && filasCopia > 0;
      console.log('  ' + (cuadra ? 'CUADRA: el respaldo se restaura y trae todo.' : 'NO CUADRA: el respaldo no trae lo mismo.'));

      if (conCheckdb) {
        console.log('');
        console.log('  DBCC CHECKDB (solo fisico) sobre la copia...');
        const check = await ejecutar(copia, 'DBCC CHECKDB([' + PRUEBA + ']) WITH PHYSICAL_ONLY, NO_INFOMSGS');
        console.log('  CHECKDB sin errores. (' + seg(check.ms) + ')');
        marcas.checkdb = check.ms;
      }

      if (!cuadra) throw new Error('La copia restaurada no tiene los mismos registros que el original.');
    } finally {
      await copia.close();
    }

    // --- 6. No debe quedar nada --------------------------------------------
    const limpio = await borrarPrueba(maestra);

    console.log('');
    console.log('  ' + '-'.repeat(64));
    console.log('  Tiempos de esta maquina:');
    if (marcas.backup !== null && marcas.backup !== undefined) {
      console.log('    BACKUP             ' + seg(marcas.backup));
    }
    console.log('    RESTORE VERIFYONLY ' + seg(marcas.verify));
    console.log('    RESTORE            ' + seg(marcas.restore));
    console.log('    COUNT en la copia  ' + seg(marcas.conteo));
    if (marcas.checkdb) console.log('    DBCC CHECKDB       ' + seg(marcas.checkdb));
    console.log('');
    console.log('  Archivo listo para subir al VPS:');
    console.log('    ' + marca.ruta + '   ' + mb(f.size));
    console.log('');
    if (!limpio) process.exitCode = 1;
  } finally {
    await padron.close().catch(() => {});
    await maestra.close().catch(() => {});
  }
}

principal().catch(async (e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
