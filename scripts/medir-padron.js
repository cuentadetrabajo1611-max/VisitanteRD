/**
 * VisitaFlow - Cuanto ocupa la base de cedulas y cuanto tarda en subirse.
 *
 *   node scripts/medir-padron.js
 *
 * POR QUE ESTO IMPORTA ANTES DE DESPLEGAR
 * ---------------------------------------
 * La base de cedulas hay que SUBIRLA al VPS una vez, y es lo unico pesado del
 * despliegue. Si son 800 MB y la conexion sube a 2 Mbps, son casi dos horas: mas
 * vale saberlo antes de empezar un sabado por la tarde.
 *
 * Este script dice:
 *   - cuanto ocupan los datos y cuanto el registro de transacciones
 *   - cuanto ocupa el respaldo comprimido de verdad (se hace uno de prueba)
 *   - cuanto tardaria en subirse segun la velocidad de subida que le indique
 *
 * No toca nada: el respaldo de prueba se borra al terminar.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));
const { carpetaGuardada } = require('./probar-respaldo');

/* Velocidades de subida tipicas, en Mbps. Se puede cambiar por argumento:
   node scripts/medir-padron.js 20 */
const VELOCIDADES = process.argv[2]
  ? [Number(process.argv[2])]
  : [1, 2, 5, 10, 20, 50, 100];

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** Tiempo de subida en texto, para una velocidad en Mbps. */
function tiempoSubida(bytes, mbps) {
  const segundos = (bytes * 8) / (mbps * 1000 * 1000);
  if (segundos < 60) return Math.round(segundos) + ' s';
  if (segundos < 3600) return Math.round(segundos / 60) + ' min';
  const h = Math.floor(segundos / 3600);
  const m = Math.round((segundos % 3600) / 60);
  return h + ' h ' + m + ' min';
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - tamaño de la base de cédulas');
  console.log('  ' + '='.repeat(66));

  const pool = await new sql.ConnectionPool({
    server: config.bd.padron.server,
    port: config.bd.padron.port,
    user: config.bd.padron.user,
    password: config.bd.padron.password,
    // Se conecta A LA BASE DE CEDULAS, no a master: el conteo de filas tiene que
    // ejecutarse dentro de ella. Los tamaños de archivo se piden con nombre de
    // tres partes, que funciona desde cualquier base.
    database: config.bd.padron.database,
    options: { encrypt: config.bd.padron.encrypt, trustServerCertificate: config.bd.padron.trustServerCertificate, enableArithAbort: true },
    connectionTimeout: 20000,
  }).connect();

  const base = config.bd.padron.database;

  // 1. Tamaño en disco y filas.
  const info = await pool.request().input('n', sql.NVarChar(128), base).query(
    'SELECT mf.type, SUM(mf.size) * 8 AS kb ' +
    'FROM sys.master_files mf JOIN sys.databases d ON d.database_id = mf.database_id ' +
    'WHERE d.name = @n GROUP BY mf.type'
  );
  const datos = (info.recordset.find((f) => f.type === 0) || {}).kb || 0;
  const log = (info.recordset.find((f) => f.type === 1) || {}).kb || 0;

  // La cuenta de filas se pide contra la tabla real. sys.partitions a veces
  // devuelve 0 si las estadisticas no estan actualizadas, asi que se usa
  // COUNT_BIG, que en 7,8 millones de filas tarda menos de un segundo.
  const tabla = String(config.bd.padron.tabla || 'dbo.PADRON').replace(/[^A-Za-z0-9_.]/g, '');
  let filas = 0;
  try {
    const r = await pool.request().query('SELECT COUNT_BIG(*) AS n FROM ' + tabla);
    filas = Number(r.recordset[0].n);
  } catch (e) {
    // Si la tabla no existe con ese nombre, se intenta por particiones.
    const r = await pool.request().query(
      "SELECT SUM(p.rows) AS n FROM sys.partitions p JOIN sys.objects o ON o.object_id = p.object_id " +
      "WHERE o.name = 'PADRON' AND p.index_id IN (0, 1)"
    );
    filas = Number(r.recordset[0].n) || 0;
  }

  console.log('  Base de datos : ' + base);
  console.log('  Tabla         : ' + tabla);
  console.log('  Registros     : ' + filas.toLocaleString('es-DO'));
  console.log('  Datos en disco: ' + mb(datos * 1024));
  console.log('  Registro (log): ' + mb(log * 1024));

  /* El tamaño del ARCHIVO no es el tamaño de la tabla: el archivo puede tener
     espacio reservado sin usar. Y lo que se sube al VPS es el respaldo, que solo
     lleva los datos de verdad. Esta comprobación explica la diferencia, para que
     los números no parezcan contradictorios. */
  let datosReales = 0;
  try {
    const t = await pool.request().query(
      'SELECT SUM(a.total_pages) * 8 / 1024 AS reservado, ' +
      'SUM(a.data_pages) * 8 / 1024 AS datos_reales ' +
      'FROM sys.tables t ' +
      'JOIN sys.indexes i ON i.object_id = t.object_id ' +
      'JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id = i.index_id ' +
      'JOIN sys.allocation_units a ON a.container_id = p.partition_id ' +
      "WHERE t.name = 'PADRON'"
    );
    const f = t.recordset[0] || {};
    if (f.datos_reales) {
      datosReales = Number(f.datos_reales);
      console.log('');
      console.log('  De eso, la tabla PADRON ocupa de verdad: ' + Math.round(datosReales) + ' MB');
      console.log('  (el resto del archivo es espacio reservado sin usar)');
      if (filas) {
        console.log('  Sale a ' + Math.round((datosReales * 1024 * 1024) / filas) + ' bytes por registro:');
        console.log('  eso es lo que significa "sin fotos".');
      }
    }
  } catch (e) {
    /* si no se puede medir, no es grave: es informativo */
  }

  // 2. Respaldo comprimido de verdad: es lo que se sube.
  const carpeta = carpetaGuardada() || process.env.RESPALDO_CARPETA ||
    (process.platform === 'win32' ? 'C:\\TempSQL\\respaldos' : '/var/opt/mssql/backup');
  fs.mkdirSync(carpeta, { recursive: true });
  const destino = path.join(carpeta, 'visitaflow-medicion-padron.bak');

  console.log('  Haciendo un respaldo comprimido de prueba…');
  console.log('  (esto tarda; es lo que habrá que subir al VPS)');
  const t0 = Date.now();
  await pool.request().query(
    "BACKUP DATABASE [" + base + "] TO DISK = '" + destino + "' WITH INIT, COMPRESSION, CHECKSUM"
  );
  const segundos = Math.round((Date.now() - t0) / 1000);
  const bytes = fs.statSync(destino).size;

  console.log('');
  console.log('  ' + '-'.repeat(66));
  console.log('  Respaldo comprimido : ' + mb(bytes));
  console.log('  Tardó en generarse : ' + segundos + ' s');
  /* La compresión se mide contra los DATOS de la tabla, no contra el tamaño del
     archivo: el archivo tiene espacio reservado que no se respalda, y comparar
     contra él daría un porcentaje que no significa nada. */
  if (datosReales) {
    console.log('  Compresión          : ' + (100 - (bytes / (datosReales * 1024 * 1024)) * 100).toFixed(0) + '% sobre los datos de la tabla');
  }
  console.log('  ' + '-'.repeat(66));

  // 3. Cuanto tarda en subirse segun la conexion.
  console.log('');
  console.log('  Tiempo de subida al VPS segun la velocidad de SUBIDA:');
  console.log('');
  for (const v of VELOCIDADES) {
    console.log('    ' + String(v).padStart(4) + ' Mbps  ->  ' + tiempoSubida(bytes, v));
  }
  console.log('');
  console.log('  (la velocidad de subida suele ser bastante menor que la de bajada;');
  console.log('   mídala en https://fast.com o en su panel del proveedor)');

  // 4. Lo que se ahorra frente a subir la base con fotos.
  console.log('');
  console.log('  ' + '-'.repeat(66));
  console.log('  ESTA ES LA RAZÓN DE QUE LA BASE SEA "LIGERA"');
  console.log('');
  const conFotos = 86508; // MB, medido de la base original con fotos
  console.log('    Base original con fotos : ' + conFotos.toLocaleString('es-DO') + ' MB');
  console.log('    Base ligera (esta)      : ' + mb(bytes));
  console.log('    Ahorro                  : ' + (conFotos - bytes / 1024 / 1024).toFixed(0) + ' MB');
  console.log('');
  console.log('    Subir la original a 5 Mbps: ' + tiempoSubida(conFotos * 1024 * 1024, 5));
  console.log('    Subir esta a 5 Mbps       : ' + tiempoSubida(bytes, 5));
  console.log('');

  // Limpieza: el respaldo de prueba no se queda.
  try {
    fs.unlinkSync(destino);
    console.log('  (el respaldo de prueba se borró)');
  } catch (e) {
    console.log('  (no se pudo borrar el respaldo de prueba: ' + destino + ')');
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
