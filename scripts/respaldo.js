/**
 * VisitaFlow - Respaldo y restauracion de la base del sistema.
 *
 *   node scripts/respaldo.js                 (saca un respaldo)
 *   node scripts/respaldo.js --listar        (muestra los que hay)
 *   node scripts/respaldo.js --restaurar     (restaura el mas reciente)
 *   node scripts/respaldo.js --restaurar <archivo>
 *
 * POR QUE EXISTE
 * --------------
 * Antes de una operacion que borra datos (la prueba del primer arranque, por
 * ejemplo) hay que poder volver atras. Con la base como unica copia, un error
 * se lleva por delante meses de bitacora.
 *
 * La restauracion crea una base NUEVA con el contenido del respaldo y despues
 * renombra: no se sobrescribe la base en uso, que es justo lo que no se debe
 * hacer si el respaldo resulta estar mal.
 *
 * OJO: restaurar deja la base como estaba en el momento del respaldo. Todo lo
 * que se haya registrado despues se pierde. Se pide confirmacion.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const CARPETA = path.join(RAIZ, 'datos', 'respaldos');
const BASE = config.bd.sistema.database;

/** Nombre del respaldo: fecha y hora, para que se ordenen solos. */
function nombreRespaldo() {
  const d = new Date();
  const dos = (n) => String(n).padStart(2, '0');
  return (
    BASE + '-' + d.getFullYear() + dos(d.getMonth() + 1) + dos(d.getDate()) +
    '-' + dos(d.getHours()) + dos(d.getMinutes()) + dos(d.getSeconds()) + '.bak'
  );
}

/** Los respaldos que hay, del mas nuevo al mas viejo. */
function listar() {
  if (!fs.existsSync(CARPETA)) return [];
  return fs
    .readdirSync(CARPETA)
    .filter((f) => f.toLowerCase().endsWith('.bak'))
    .map((f) => {
      const p = path.join(CARPETA, f);
      return { archivo: f, ruta: p, kb: Math.round(fs.statSync(p).size / 1024), fecha: fs.statSync(p).mtime };
    })
    .sort((a, b) => b.fecha - a.fecha);
}

/** Saca un respaldo completo. */
async function respaldar() {
  fs.mkdirSync(CARPETA, { recursive: true });
  const nombre = nombreRespaldo();
  const destino = path.join(CARPETA, nombre);

  // BACKUP DATABASE no admite parametros en la ruta: se comprueba antes.
  if (!/^[A-Za-z]:\\[^'";]+\.bak$/.test(destino)) {
    throw new Error('La ruta del respaldo no es válida: ' + destino);
  }

  console.log('  Respaldando la base ' + BASE + '…');
  await bd.consultar(
    "BACKUP DATABASE [" + BASE + "] TO DISK = '" + destino + "' WITH INIT, COMPRESSION, CHECKSUM",
    undefined,
    { espera: 600000 }
  );

  const kb = Math.round(fs.statSync(destino).size / 1024);
  console.log('  Listo: ' + nombre + '  (' + (kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB') + ')');
  return destino;
}

/** Pide confirmacion por consola. */
function confirmar(pregunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  ' + pregunta + ' [escriba SI para continuar]: ', (respuesta) => {
      rl.close();
      resolve(String(respuesta).trim().toUpperCase() === 'SI');
    });
  });
}

/**
 * Restaura un respaldo.
 *
 * Se restaura con otro nombre y despues se renombra la base en uso, para no
 * quedarse sin nada si el respaldo esta corrupto.
 */
async function restaurar(ruta) {
  if (!fs.existsSync(ruta)) throw new Error('No existe el respaldo: ' + ruta);

  const pool = await bd.conectarSistema();

  // 1. Verificar el respaldo ANTES de tocar nada.
  console.log('  Verificando el respaldo…');
  const verif = await bd.consultar('RESTORE VERIFYONLY FROM DISK = @ruta', { ruta }, { tipos: { ruta: sql.NVarChar(400) }, espera: 600000 });
  console.log('  El respaldo es válido.');

  // 2. Mirar qué bases trae y de qué fecha es.
  const cabecera = await bd.consultar(
    'RESTORE HEADERONLY FROM DISK = @ruta',
    { ruta },
    { tipos: { ruta: sql.NVarChar(400) }, espera: 120000 }
  );
  const h = cabecera.recordset[0];
  console.log('  Base: ' + h.BackupDatabaseName + '   Fecha: ' + h.BackupFinishDate);

  // 3. Avisar de lo que se va a perder.
  const actuales = await bd.consultar('SELECT COUNT(*) AS n FROM dbo.vf_visitas').catch(() => ({ recordset: [{ n: 0 }] }));
  console.log('');
  console.log('  ATENCION: la base actual tiene ' + actuales.recordset[0].n + ' visita(s) registradas.');
  console.log('  Al restaurar se pierde todo lo registrado despues del respaldo.');
  console.log('');

  if (!(await confirmar('¿Restaurar de todas formas?'))) {
    console.log('  Cancelado. No se tocó nada.');
    return false;
  }

  // 4. Restaurar con otro nombre y renombrar. Asi, si el respaldo resulta estar
  //    mal, la base en uso sigue intacta hasta el ultimo momento. No mientras
  //    este proceso tenga la base abierta: se cierran los pools primero.
  await bd.cerrar();

  const maestra = await new sql.ConnectionPool({
    server: config.bd.sistema.server,
    port: config.bd.sistema.port,
    user: config.bd.sistema.user,
    password: config.bd.sistema.password,
    database: 'master',
    options: { encrypt: config.bd.sistema.encrypt, trustServerCertificate: config.bd.sistema.trustServerCertificate, enableArithAbort: true },
    connectionTimeout: 20000,
  }).connect();

  const temporal = BASE + '_restaurada';
  const dirDatos = (
    await maestra.request().query("SELECT SERVERPROPERTY('InstanceDefaultDataPath') AS d")
  ).recordset[0].d;

  console.log('  Restaurando en ' + temporal + '…');
  await maestra
    .request()
    .input('ruta', sql.NVarChar(400), ruta)
    .input('mdf', sql.NVarChar(400), dirDatos + temporal + '.mdf')
    .input('ldf', sql.NVarChar(400), dirDatos + temporal + '_log.ldf')
    .query(
      'IF DB_ID(@t) IS NOT NULL BEGIN ALTER DATABASE [' + temporal + '] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [' + temporal + ']; END; ' +
      "RESTORE DATABASE [" + temporal + "] FROM DISK = @ruta WITH MOVE '" + h.BackupDatabaseName + "' TO @mdf, MOVE '" + h.BackupDatabaseName + "_log' TO @ldf, REPLACE"
    )
    .catch(async (e) => {
      // El nombre logico del archivo de log puede no coincidir: se reintenta
      // averiguando los nombres reales del respaldo.
      const archivos = await maestra.request().input('ruta', sql.NVarChar(400), ruta).query('RESTORE FILELISTONLY FROM DISK = @ruta');
      const datos = archivos.recordset.find((f) => f.Type === 'D') || archivos.recordset[0];
      const log = archivos.recordset.find((f) => f.Type === 'L') || archivos.recordset[1];
      console.log('  (se reintenta con los nombres reales: ' + datos.LogicalName + ', ' + log.LogicalName + ')');

      await maestra
        .request()
        .input('ruta', sql.NVarChar(400), ruta)
        .input('mdf', sql.NVarChar(400), dirDatos + temporal + '.mdf')
        .input('ldf', sql.NVarChar(400), dirDatos + temporal + '_log.ldf')
        .query(
          'RESTORE DATABASE [' + temporal + '] FROM DISK = @ruta WITH MOVE @dn TO @mdf, MOVE @ln TO @ldf, REPLACE'
            .replace('@dn', "'" + datos.LogicalName + "'")
            .replace('@ln', "'" + log.LogicalName + "'")
        );
    });

  // 5. Cerrar la base en uso, apartar la vieja y poner la restaurada en su sitio.
  console.log('  Poniendo la base restaurada en su sitio…');
  await maestra.request().query(
    'IF DB_ID(@actual) IS NOT NULL BEGIN ALTER DATABASE [' + BASE + '] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; END; ' +
    "ALTER DATABASE [" + temporal + "] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; " +
    "ALTER DATABASE [" + temporal + "] MODIFY NAME = [" + BASE + "]; " +
    "ALTER DATABASE [" + BASE + "] SET MULTI_USER;"
      .replace('@actual', "N'" + BASE + "'")
  );

  await maestra.close();

  // 6. Comprobar que la base responde.
  await bd.conectarSistema();
  const visitas = await bd.consultar('SELECT COUNT(*) AS n FROM dbo.vf_visitas');
  console.log('');
  console.log('  Restauración completa. La base tiene ' + visitas.recordset[0].n + ' visita(s).');
  return true;
}

async function principal() {
  const args = process.argv.slice(2);
  const quiereListar = args.indexOf('--listar') !== -1;
  const quiereRestaurar = args.indexOf('--restaurar') !== -1;
  const archivo = args.find((a) => !a.startsWith('--'));

  console.log('');
  console.log('  VisitaFlow - respaldo de la base');
  console.log('  ' + '-'.repeat(60));
  console.log('  Base: ' + BASE);
  console.log('  Carpeta: ' + path.relative(RAIZ, CARPETA));
  console.log('');

  if (quiereListar) {
    const lista = listar();
    if (!lista.length) {
      console.log('  No hay respaldos todavía. Cree uno con:  npm run respaldo');
    } else {
      console.log('  Respaldos (' + lista.length + '):');
      for (const r of lista) {
        const mb = r.kb > 1024 ? (r.kb / 1024).toFixed(1) + ' MB' : r.kb + ' KB';
        console.log('    ' + r.archivo.padEnd(40) + mb.padStart(10) + '   ' + r.fecha.toLocaleString('es-DO'));
      }
      console.log('');
      console.log('  Para restaurar el más reciente:  npm run respaldo:restaurar');
    }
    console.log('');
    return;
  }

  if (quiereRestaurar) {
    const lista = listar();
    const objetivo = archivo
      ? path.isAbsolute(archivo) ? archivo : path.join(CARPETA, archivo)
      : (lista[0] && lista[0].ruta) || null;

    if (!objetivo) {
      console.log('  No hay ningún respaldo que restaurar.');
      console.log('  Cree uno con:  npm run respaldo');
      console.log('');
      process.exit(1);
    }

    console.log('  Restaurando: ' + path.basename(objetivo));
    console.log('');
    await restaurar(objetivo);
    console.log('');
    await bd.cerrar();
    return;
  }

  // Sin opciones: sacar un respaldo.
  const destino = await respaldar();
  console.log('');
  console.log('  Para restaurarlo más adelante:  npm run respaldo:restaurar');
  console.log('');
  await bd.cerrar();
}

principal().catch(async (e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  try { await bd.cerrar(); } catch (e2) { /* ya estaba cerrada */ }
  process.exit(1);
});
