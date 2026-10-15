/**
 * VisitaFlow - Prueba del PRIMER ARRANQUE.
 *
 *   node scripts/probar-primer-arranque.js
 *
 * POR QUE EXISTE ESTA PRUEBA
 * --------------------------
 * Un despliegue nuevo no tiene licencia, y sin licencia no hay institucion. Y
 * sin institucion no hay ningun usuario, asi que no hay forma de iniciar sesion.
 * Si activar la licencia exigiera sesion, el sistema quedaria bloqueado para
 * siempre: nadie podria activarlo. Eso es lo que se comprueba aqui.
 *
 * COMO LO HACE SIN PERDER DATOS
 * -----------------------------
 * Antes de tocar nada saca un RESPALDO COMPLETO a disco con BACKUP DATABASE. Esa
 * es la red de seguridad de verdad: si la restauracion fallara a medias (ya paso
 * una vez, por un IDENTITY_INSERT mal puesto), la base se recupera entera con el
 * .bak, que se deja en datos/ y se dice como restaurarlo.
 *
 * Ademas, copia a memoria todo lo que va a borrar, deja la base como una
 * instalacion nueva, prueba el flujo completo y despues restaura. Si algo falla,
 * la restauracion corre igual (esta en un bloque finally).
 *
 * La copia se hace con SELECT *, asi que no depende de que columnas hay: si el
 * esquema cambia, la prueba sigue sirviendo.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });




const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const sql = require(path.join(RAIZ, 'node_modules', 'mssql'));
const lic = require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));

const BASE = 'http://localhost:' + config.servidor.puerto;

/* Orden de borrado: de los hijos a los padres, para respetar las claves ajenas.
   El orden inverso es el de restauracion.

   OJO: al anadir una tabla al esquema hay que anadirla aqui, en su sitio. Si
   falta, la restauracion falla con un error de clave ajena y la base se queda a
   medias. Ya paso con vf_avisos, que se anadio despues que esta lista. */
const TABLAS = [
  'vf_avisos',
  'vf_vigilancia_avisos',
  'vf_gafetes',
  'vf_visitas',
  'vf_preregistros',
  'vf_vigilancia',
  'vf_visitantes',
  'vf_auditoria',
  'vf_licencias_revisiones',
  'vf_plantillas_gafete',
  'vf_personas',
  'vf_departamentos',
  'vf_motivos',
  'vf_categorias',
  'vf_sedes',
  'vf_ajustes',
  'vf_rol_permisos',
  'vf_licencias',
  'vf_instalaciones',
  'vf_usuarios',
  'vf_tenants',
];

/* La ruta del respaldo la decide scripts/probar-respaldo.js, que comprueba en
   qué carpeta puede escribir la cuenta de servicio de SQL Server. Aquí solo se
   recuerda la que se usó, para poder borrarla o decir dónde quedó. */
let rutaRespaldo = null;

let ok = 0;
let fallos = 0;
const detalle = [];
let respaldo = null;
let rutaLicenciaOriginal = null;
let textoLicenciaOriginal = null;

async function prueba(nombre, fn) {
  try {
    await fn();
    ok++;
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallos++;
    detalle.push(nombre + ' -> ' + e.message);
    console.log('  FALLO ' + nombre + '\n         -> ' + e.message);
  }
}

function esperar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje || 'condición no cumplida');
}

async function pedir(metodo, ruta, cuerpo, token) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (token) cabeceras.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos;
  try { datos = JSON.parse(texto); } catch (e) { datos = { crudo: texto.slice(0, 200) }; }
  return { estado: r.status, datos };
}

/** Copia una tabla a memoria. */
async function copiar(tabla) {
  const r = await bd.consultar('SELECT * FROM dbo.[' + tabla + ']');
  return r.recordset;
}

/**
 * Saca un respaldo completo de la base a disco.
 *
 * BACKUP DATABASE lo ejecuta SQL SERVER, no este proceso: el archivo lo escribe
 * la cuenta de servicio de SQL Server, que no puede escribir en el Escritorio
 * del usuario. Por eso se usa la carpeta que haya comprobado
 * scripts/probar-respaldo.js, y si no hay ninguna se prueba una por defecto.
 *
 * BACKUP DATABASE tampoco admite parametros en la ruta, asi que se comprueba
 * antes que la cadena no traiga comillas ni nada raro.
 */
async function respaldar() {
  const { carpetaGuardada } = require('./probar-respaldo');
  const carpeta =
    carpetaGuardada() ||
    process.env.RESPALDO_CARPETA ||
    (process.platform === 'win32' ? 'C:\\TempSQL\\respaldos' : '/var/opt/mssql/backup');

  fs.mkdirSync(carpeta, { recursive: true });
  const destino = path.join(carpeta, 'visitaflow-primer-arranque.bak');

  if (!/^[A-Za-z]:\\[^'";]+\.bak$|^\/[^'";]+\.bak$/.test(destino)) {
    throw new Error('La ruta del respaldo no es válida: ' + destino);
  }
  if (fs.existsSync(destino)) fs.unlinkSync(destino);

  await bd.consultar(
    "BACKUP DATABASE [" + config.bd.sistema.database + "] TO DISK = '" + destino + "' WITH INIT, COMPRESSION, CHECKSUM",
    undefined,
    { espera: 600000 }
  );
  const kb = Math.round(fs.statSync(destino).size / 1024);
  rutaRespaldo = destino;
  return { ruta: destino, kb };
}

/** Vacia una tabla. */
async function vaciar(tabla) {
  await bd.consultar('DELETE FROM dbo.[' + tabla + ']');
}

/**
 * Vuelve a meter las filas, respetando los valores de identidad.
 *
 * Dos detalles que costaron un susto:
 *
 *  1. SET IDENTITY_INSERT solo vale en tablas que TIENEN columna de identidad.
 *     En las que no la tienen (vf_rol_permisos, por ejemplo) SQL Server responde
 *     "Table does not have the identity property" y aborta la restauracion.
 *     Por eso se averigua antes cuales la tienen.
 *
 *  2. Cada valor se declara con un tipo explicito. Es necesario porque hay que
 *     devolver los nulos tal como estaban: si se deja que el driver los infiera,
 *     un null no tiene tipo y el INSERT falla.
 */
async function restaurar(tabla, filas) {
  const pool = await bd.bd();

  const conIdentidad = await bd.consultar(
    'SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID(@t) AND is_identity = 1',
    { t: 'dbo.' + tabla }
  );
  const tieneIdentidad = conIdentidad.recordset[0].n > 0;

  for (const fila of filas) {
    const columnas = Object.keys(fila);
    const peticion = pool.request();

    columnas.forEach((c, i) => {
      const v = fila[c];
      const nombre = 'c' + i;
      if (v === null || v === undefined) peticion.input(nombre, sql.NVarChar(sql.MAX), null);
      else if (typeof v === 'boolean') peticion.input(nombre, sql.Bit, v);
      else if (typeof v === 'number') peticion.input(nombre, sql.Int, Math.trunc(v));
      else if (v instanceof Date) peticion.input(nombre, sql.DateTimeOffset, v);
      else peticion.input(nombre, sql.NVarChar(sql.MAX), v);
    });

    const insertar =
      'INSERT INTO dbo.[' + tabla + '] ([' + columnas.join('], [') + ']) VALUES (' +
      columnas.map((c, i) => '@c' + i).join(', ') + ');';

    await peticion.query(
      tieneIdentidad
        ? 'SET IDENTITY_INSERT dbo.[' + tabla + '] ON; ' + insertar + ' SET IDENTITY_INSERT dbo.[' + tabla + '] OFF;'
        : insertar
    );
  }
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - prueba del primer arranque');
  console.log('  ' + '='.repeat(64));
  console.log('');

  // Comprobar que el servidor responde antes de tocar nada.
  try {
    const r = await fetch(BASE + '/api/salud');
    if (!r.ok) throw new Error('estado ' + r.status);
  } catch (e) {
    console.error('  El servidor no responde en ' + BASE);
    console.error('  Arránquelo con:  npm start');
    console.error('');
    process.exit(1);
  }

  await bd.conectarSistema();

  // 1. Guardar una licencia valida para la institucion de prueba.
  const texto = lic.firmar({
    tenant: 'zz-primer-arranque',
    cliente: 'Institución de Primer Arranque',
    desde: new Date().toISOString(),
    hasta: new Date(Date.now() + 30 * 86400000).toISOString(),
    tipo: 'prueba',
    limites: { usuarios: 3, instalaciones: 1, visitas_mes: 0 },
  });

  // 2. Guardar el estado actual y dejar la base como nueva.
  rutaLicenciaOriginal = config.licencia.archivo;
  textoLicenciaOriginal = fs.existsSync(rutaLicenciaOriginal) ? fs.readFileSync(rutaLicenciaOriginal, 'utf8') : null;

  respaldo = {};
  console.log('  --- respaldo completo a disco (red de seguridad) ---');
  try {
    const b = await respaldar();
    console.log('  ' + b.kb + ' KB en ' + path.relative(RAIZ, b.ruta));
    if (fallos === 0) console.log('  (se borra al terminar si todo sale bien)');
  } catch (e) {
    console.error('  No se pudo sacar el respaldo: ' + e.message);
    console.error('  La prueba NO se ejecuta para no arriesgar los datos.');
    await bd.cerrar();
    process.exit(1);
  }

  console.log('');
  console.log('  --- copiando el estado actual ---');
  let totalFilas = 0;
  for (const t of TABLAS) {
    respaldo[t] = await copiar(t);
    totalFilas += respaldo[t].length;
  }
  console.log('  ' + TABLAS.length + ' tablas, ' + totalFilas + ' filas copiadas');
  console.log('');

  try {
    for (const t of TABLAS) await vaciar(t);

    // Se quita la licencia de disco: un despliegue nuevo no la tiene.
    if (fs.existsSync(rutaLicenciaOriginal)) fs.unlinkSync(rutaLicenciaOriginal);

    console.log('  --- la instalación quedó vacía ---');
    console.log('');

    /* ---------------------------------------------------------------- */
    console.log('Lo que ve una instalación nueva');

    await prueba('el estado inicial dice que hay que activar', async () => {
      const r = await pedir('GET', '/api/licencia/estado-inicial');
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.primer_arranque === true, 'no se reconoce como primer arranque');
      esperar(r.datos.necesita_activacion === true, 'no pide activación');
    });

    await prueba('no hay ninguna institución para elegir al entrar', async () => {
      const r = await pedir('GET', '/api/acceso/instituciones');
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.instituciones.length === 0, 'debería estar vacío y hay ' + r.datos.instituciones.length);
    });

    await prueba('activar SIN sesión es posible (es lo único que se puede hacer)', async () => {
      // Sin token: exactamente lo que haria la pantalla de acceso.
      const r = await pedir('POST', '/api/licencia/activar', { texto });
      esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    });

    await prueba('la institución quedó creada a partir de la licencia', async () => {
      const r = await pedir('GET', '/api/acceso/instituciones');
      const t = r.datos.instituciones.find((x) => x.codigo === 'zz-primer-arranque');
      esperar(t, 'no se creó la institución');
      esperar(t.nombre === 'Institución de Primer Arranque', 'el nombre es ' + t.nombre);
    });

    await prueba('la licencia ya aparece como válida', async () => {
      const r = await pedir('GET', '/api/licencia/estado-inicial');
      esperar(r.datos.licencia.valida === true, 'la licencia no quedó válida: ' + r.datos.licencia.estado);
      esperar(r.datos.primer_arranque === false, 'ya no debería ser primer arranque');
    });

    /* ---------------------------------------------------------------- */
    console.log('');
    console.log('Y ahora la puerta se cierra');

    await prueba('una vez hay institución, activar SIN sesión ya NO se permite', async () => {
      const r = await pedir('POST', '/api/licencia/activar', { texto });
      esperar(r.estado === 401, 'debería responder 401 y respondió ' + r.estado);
    });

    await prueba('con un token inventado tampoco', async () => {
      const r = await pedir('POST', '/api/licencia/activar', { texto }, 'token-inventado');
      esperar(r.estado === 401, 'debería responder 401 y respondió ' + r.estado);
    });

    /* ---------------------------------------------------------------- */
    console.log('');
    console.log('Una licencia inválida no abre la puerta');

    await prueba('una licencia manipulada se rechaza aunque la instalación esté vacía', async () => {
      // Se vuelve a dejar la base vacía para probar el rechazo en primer arranque.
      for (const t of TABLAS) await vaciar(t);
      if (fs.existsSync(rutaLicenciaOriginal)) fs.unlinkSync(rutaLicenciaOriginal);

      const cuerpo = texto.replace(lic.CABECERA, '').replace(lic.PIE, '')
        .split('\n').map((l) => l.trim()).filter(Boolean).join('');
      const partes = cuerpo.split('.');
      const contenido = JSON.parse(lic.deBase64Url(partes[0]).toString('utf8'));
      contenido.hasta = new Date(Date.now() + 3650 * 86400000).toISOString();
      const falsa = lic.CABECERA + '\n' +
        lic.aBase64Url(Buffer.from(JSON.stringify(contenido), 'utf8')) + '.' + partes[1] +
        '\n' + lic.PIE + '\n';

      const r = await pedir('POST', '/api/licencia/activar', { texto: falsa });
      esperar(r.estado === 400, 'debería rechazarse y respondió ' + r.estado);
      esperar(/firma/i.test(r.datos.mensaje || ''), 'el motivo no menciona la firma: ' + r.datos.mensaje);
    });

    await prueba('un archivo sin formato se rechaza', async () => {
      const r = await pedir('POST', '/api/licencia/activar', { texto: 'esto no es una licencia' });
      esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
    });

    await prueba('sin texto se rechaza con un mensaje claro', async () => {
      const r = await pedir('POST', '/api/licencia/activar', {});
      esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
    });

    /* ---------------------------------------------------------------- */
    console.log('');
    console.log('Reactivación correcta tras los intentos fallidos');

    await prueba('la licencia buena sigue activándose en la instalación vacía', async () => {
      const r = await pedir('POST', '/api/licencia/activar', { texto });
      esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
      const t = await pedir('GET', '/api/acceso/instituciones');
      esperar(t.datos.instituciones.length === 1, 'debería haber una institución y hay ' + t.datos.instituciones.length);
    });
  } finally {
    /* ---------------------------------------------------------------- */
    console.log('');
    console.log('  --- restaurando el estado anterior ---');

    try {
      for (const t of TABLAS) await vaciar(t);

      // El orden inverso respeta las claves ajenas: primero los padres.
      for (const t of TABLAS.slice().reverse()) {
        if (respaldo[t] && respaldo[t].length) await restaurar(t, respaldo[t]);
      }

      // Y la licencia de la instalación, tal como estaba.
      if (textoLicenciaOriginal !== null) {
        fs.mkdirSync(path.dirname(rutaLicenciaOriginal), { recursive: true });
        fs.writeFileSync(rutaLicenciaOriginal, textoLicenciaOriginal, { mode: 0o600 });
      }

      let restauradas = 0;
      for (const t of TABLAS) restauradas += (await copiar(t)).length;
      console.log('  ' + restauradas + ' filas restauradas');

      // El respaldo solo se borra cuando la restauracion salio bien Y todas las
      // pruebas pasaron. Si algo quedo a medias, se deja y se dice como usarlo.
      if (restauradas > 0 && fallos === 0 && fs.existsSync(rutaRespaldo)) {
        fs.unlinkSync(rutaRespaldo);
      } else if (fs.existsSync(rutaRespaldo)) {
        console.log('');
        console.log('  El respaldo queda en: ' + rutaRespaldo);
        console.log('  Si algo no cuadra, se restaura con:');
        console.log('      npm run respaldo:restaurar');
      }

      if (restauradas === 0) {
        console.log('  ATENCION: la base quedó vacía. Restaure el respaldo.');
      }
    } catch (e) {
      console.error('  ERROR al restaurar: ' + e.message);
      if (fs.existsSync(rutaRespaldo)) {
        console.error('');
        console.error('  La base se puede recuperar entera con el respaldo:');
        console.error('      ' + rutaRespaldo);
        console.error('      npm run respaldo:restaurar');
      } else {
        console.error('  No hay respaldo en disco. Regenere los datos de prueba con:');
        console.error('      npm run demo');
      }
    }
  }

  await bd.cerrar();

  console.log('');
  console.log('  ' + '='.repeat(64));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(64));
  if (fallos) {
    console.log('');
    for (const d of detalle) console.log('    ' + d);
  }
  console.log('');
  process.exit(fallos ? 1 : 0);
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
