/**
 * VisitaFlow - Saca un respaldo de la base y dice donde puede escribir.
 *
 *   node scripts/probar-respaldo.js
 *
 * POR QUE HACE FALTA
 * ------------------
 * BACKUP DATABASE lo ejecuta SQL SERVER, no este proceso. Escribe el archivo la
 * cuenta de servicio de SQL Server (en Windows, "NT Service\\MSSQLSERVER"), que
 * NO tiene permiso para escribir en el Escritorio del usuario ni dentro de la
 * carpeta del proyecto.
 *
 * Por eso hay que buscar una carpeta donde esa cuenta si pueda escribir. Este
 * script prueba varias, dice cual funciona y deja el resultado en
 * datos/respaldo-config.json para que los demas scripts lo usen.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));

const BASE = config.bd.sistema.database;
const CONFIG = path.join(RAIZ, 'datos', 'respaldo-config.json');

/** Rutas candidatas, en orden de preferencia. */
function candidatas() {
  const lista = [];

  // 1. Lo que diga la configuracion, si viene por variable de entorno.
  if (process.env.RESPALDO_CARPETA) lista.push(process.env.RESPALDO_CARPETA);

  if (process.platform === 'win32') {
    // C:\TempSQL ya existe en esta maquina y SQL Server suele poder escribir ahi.
    lista.push('C:\\TempSQL\\respaldos');
    lista.push('C:\\TempSQL');
    // La carpeta de datos por defecto de la instancia suele tener permisos.
    lista.push('C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Backup');
  } else {
    lista.push('/var/opt/mssql/backup');
    lista.push('/tmp/visitaflow-respaldos');
  }

  return lista;
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - dónde puede respaldar SQL Server');
  console.log('  ' + '='.repeat(64));
  console.log('  Base: ' + BASE);
  console.log('');

  const pool = await new sql.ConnectionPool({
    server: config.bd.sistema.server,
    port: config.bd.sistema.port,
    user: config.bd.sistema.user,
    password: config.bd.sistema.password,
    database: BASE,
    options: {
      encrypt: config.bd.sistema.encrypt,
      trustServerCertificate: config.bd.sistema.trustServerCertificate,
      enableArithAbort: true,
    },
    connectionTimeout: 20000,
  }).connect();

  // Cuenta con la que corre SQL Server, util para explicar el problema.
  const cuenta = await pool.request().query(
    "SELECT CONVERT(varchar(200), SERVERPROPERTY('InstanceDefaultDataPath')) AS datos, " +
    "CONVERT(varchar(200), SERVICE_NAME) AS servicio"
  ).catch(() => null);
  if (cuenta && cuenta.recordset.length) {
    console.log('  Carpeta de datos de la instancia: ' + cuenta.recordset[0].datos);
  }
  console.log('  (el archivo del respaldo lo escribe la cuenta de servicio de SQL Server)');
  console.log('');

  let elegida = null;

  console.log('  Probando carpetas:');
  console.log('  ' + '-'.repeat(64));

  for (const carpeta of candidatas()) {
    const prueba = path.join(carpeta, 'visitaflow-prueba-' + Date.now() + '.bak');
    let resultado = '';

    try {
      // Se crea desde Node; si SQL Server puede escribir ahi, el BACKUP pasa.
      fs.mkdirSync(carpeta, { recursive: true });
    } catch (e) {
      resultado = 'no se pudo crear la carpeta (' + e.code + ')';
      console.log('  [ ] ' + carpeta);
      console.log('      ' + resultado);
      continue;
    }

    try {
      await pool.request().query(
        "BACKUP DATABASE [" + BASE + "] TO DISK = '" + prueba + "' WITH INIT, COMPRESSION, COPY_ONLY"
      );
      const kb = Math.round(fs.statSync(prueba).size / 1024);
      resultado = 'FUNCIONA (' + (kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB') + ')';
      console.log('  [X] ' + carpeta);
      console.log('      ' + resultado);
      if (!elegida) elegida = carpeta;
    } catch (e) {
      resultado = e.message.split('\n')[0].slice(0, 90);
      console.log('  [ ] ' + carpeta);
      console.log('      ' + resultado);
    }

    try {
      if (fs.existsSync(prueba)) fs.unlinkSync(prueba);
    } catch (e) {
      /* si no se puede borrar, da igual: es un archivo de prueba */
    }
  }

  console.log('  ' + '-'.repeat(64));

  if (!elegida) {
    console.log('');
    console.log('  NINGUNA carpeta funcionó. Para habilitar los respaldos, dé permiso');
    console.log('  a la cuenta de servicio de SQL Server sobre una carpeta. Por ejemplo,');
    console.log('  en PowerShell COMO ADMINISTRADOR:');
    console.log('');
    console.log('      New-Item -ItemType Directory -Force -Path C:\\TempSQL\\respaldos');
    console.log('      icacls C:\\TempSQL\\respaldos /grant "NT SERVICE\\MSSQLSERVER:(OI)(CI)M"');
    console.log('');
    console.log('  Y después vuelva a ejecutar este script.');
    console.log('');
    await pool.close();
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ carpeta: elegida, comprobado: new Date().toISOString() }, null, 2));
  console.log('');
  console.log('  Carpeta elegida: ' + elegida);
  console.log('  Guardada en: ' + path.relative(RAIZ, CONFIG));
  console.log('');
  console.log('  Los respaldos quedarán ahí. En el VPS, dentro del contenedor, la ruta');
  console.log('  es /var/opt/mssql/backup, que es parte del volumen de datos.');
  console.log('');

  await pool.close();
}

/** Lee la carpeta de respaldo ya comprobada, si existe. */
function carpetaGuardada() {
  try {
    if (fs.existsSync(CONFIG)) return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).carpeta || null;
  } catch (e) {
    /* si el archivo esta roto, se ignora */
  }
  return null;
}

module.exports = { carpetaGuardada, CONFIG };

if (require.main === module) {
  principal().catch((e) => {
    console.error('');
    console.error('  Error: ' + e.message);
    console.error('');
    process.exit(1);
  });
}
