/**
 * VisitaFlow - El instalador para clientes, ejecutado de verdad.
 *
 *   node scripts/probar-instalador.js
 *
 * POR QUE
 * -------
 * `instalar-cliente.js` es la herramienta que va a usar quien ponga el sistema en el
 * servidor de un cliente, y no se habia ejecutado nunca de principio a fin. Una
 * herramienta de instalacion que no se ha probado es peor que no tenerla: da
 * confianza y falla en el peor momento.
 *
 * Como funciona esta prueba
 * -------------------------
 * El instalador lee las respuestas de la entrada estandar, asi que se le pueden dar
 * por tuberia y se ejecuta como lo haria una persona: de verdad, en una carpeta
 * temporal, y comprobando lo que deja escrito.
 *
 * Se prueban los caminos que importan:
 *   1. Instalacion con ID de licencia (el camino normal, con Internet).
 *   2. Instalacion SIN salida a Internet (con el archivo .vflow).
 *   3. Que NO pise un .env que ya existe.
 *   4. Que se niegue si la clave de SQL no cumple la politica.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));

const INSTALADOR = path.join(RAIZ, 'scripts', 'instalar-cliente.js');
const LICENCIAS = 'http://localhost:' + (process.env.PUERTO_LICENCIAS || 4100);
const TOKEN_ADMIN = (process.env.ADMIN_TOKEN || config.adminToken || '').trim();

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

/** Un ID de licencia real, de un cliente que ya existe. */
async function unIdDeLicencia() {
  const r = await fetch(LICENCIAS + '/api/admin/clientes', {
    headers: { Authorization: 'Bearer ' + TOKEN_ADMIN },
  });
  const j = await r.json();
  if (!Array.isArray(j.clientes)) throw new Error('no se pudo leer la lista de clientes');
  const c = j.clientes.find((x) => x.activa && !x.vencida);
  if (!c) throw new Error('no hay ningún cliente activo');
  return c;
}

/**
 * Ejecuta el instalador con unas respuestas dadas.
 *
 * Las respuestas van por la entrada estandar, en orden, una por linea. Es
 * exactamente lo que teclearia una persona.
 *
 * Se le pasa `--carpeta` a proposito: sin eso el instalador escribe en la raiz del
 * proyecto, que es lo correcto cuando lo usa el dueno de la maquina (el .env de al
 * lado), pero en una prueba dejaria el proyecto lleno de archivos y ademas chocaria
 * con su propio .env.
 */
function ejecutar(respuestas, carpeta, extra) {
  const r = spawnSync(process.execPath, [INSTALADOR, '--carpeta', carpeta].concat(extra || []), {
    cwd: RAIZ,
    input: respuestas.join('\n') + '\n',
    encoding: 'utf8',
    timeout: 90000,
  });

  return {
    codigo: r.status,
    salida: (r.stdout || '') + (r.stderr || ''),
  };
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - el instalador para clientes');
  console.log('  ' + '='.repeat(66));

  paso('0. El servidor de licencias tiene que estar en marcha');
  let cliente = null;
  try {
    cliente = await unIdDeLicencia();
    bien('el servidor de licencias responde; se usará el ID ' + cliente.licencia_id);
  } catch (e) {
    mal('el servidor de licencias no responde en ' + LICENCIAS + ': ' + e.message);
    info('arránquelo con:  npm run licencias');
    throw new Error('sin servidor de licencias no se puede probar la instalación');
  }

  /* ------------------------------------------------------------------ */
  paso('1. Instalación con ID de licencia (el camino normal)');

  const carpeta1 = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-inst-'));
  try {
    /* Las respuestas van en el orden en que las pide:
     *   1. Tipo de instalación: 1 = cliente, 2 = proveedor.  -> 1
     *   2. ¿Hay salida a Internet para activar con el ID?    -> sí
     *   3. El ID de la licencia
     *   4. La dirección del servidor de licencias del proveedor
     *   5. ¿En qué dominio o dirección va a quedar?          -> una dirección de prueba
     *   6. La contraseña de SQL                              -> vacío, que la genere
     *   7. ¿Tiene el archivo del padrón?                     -> no
     *   8. Si ya existe un .env, ¿sobrescribir?              -> no hay, así que da igual
     */
    const r = ejecutar([
      '1',                          // instalación de cliente
      's',                          // ¿tiene salida a Internet?
      cliente.licencia_id,          // el ID
      LICENCIAS,                    // el servidor de licencias del proveedor
      'http://127.0.0.1:3311',      // la dirección donde queda el sistema
      '',                           // la clave de SQL: que la genere
      'n',                          // ¿tiene el archivo del padrón?
      's',                          // si preguntara por sobrescribir: sí (la carpeta está vacía)
    ], carpeta1);

    const env = path.join(carpeta1, '.env');
    const instrucciones = path.join(carpeta1, 'INSTALACION.txt');

    if (fs.existsSync(env)) bien('generó el archivo .env');
    else {
      mal('NO generó el .env (código ' + r.codigo + ')');
      info(r.salida.split('\n').filter(Boolean).slice(-6).join('\n          '));
    }

    if (fs.existsSync(instrucciones)) bien('generó el archivo INSTALACION.txt');
    else mal('NO generó el INSTALACION.txt');

    if (fs.existsSync(env)) {
      const texto = fs.readFileSync(env, 'utf8');

      /* Lo que tiene que traer el .env, comprobado de verdad. */
      const esperadas = [
        ['DB_DATABASE', /^DB_DATABASE=\S+/m],
        ['DB_PASSWORD', /^DB_PASSWORD=\S+/m],
        ['CLAVE_SQL', /^CLAVE_SQL=\S+/m],
        ['JWT_SECRET', /^JWT_SECRET=.{24,}$/m],
        ['ADMIN_TOKEN', /^ADMIN_TOKEN=.{20,}$/m],
        ['NODE_ENV', /^NODE_ENV=production$/m],
      ];

      const faltan = esperadas.filter(([, re]) => !re.test(texto)).map(([n]) => n);
      if (faltan.length) mal('al .env le falta o está mal: ' + faltan.join(', '));
      else bien('el .env trae las ' + esperadas.length + ' variables clave, bien puestas');

      /* Los secretos tienen que ser distintos entre si y propios de esta
         instalacion: si se repitieran, una instalacion podria firmar sesiones de
         otra. */
      const m = (n) => (new RegExp('^' + n + '=(.*)$', 'm').exec(texto) || [])[1];
      const jwt = m('JWT_SECRET');
      const adm = m('ADMIN_TOKEN');
      const sql = m('DB_PASSWORD');

      if (jwt && adm && sql && jwt !== adm && jwt !== sql && adm !== sql) {
        bien('los tres secretos son distintos entre sí');
      } else {
        mal('hay secretos repetidos en el .env');
      }

      /* Y la clave de SQL tiene que cumplir la política, o el contenedor de la base
         se muere en bucle sin decir por qué. */
      const fallosSql = [];
      if (!sql || sql.length < 8) fallosSql.push('corta');
      if (sql && !/[A-Z]/.test(sql)) fallosSql.push('sin mayúscula');
      if (sql && !/[a-z]/.test(sql)) fallosSql.push('sin minúscula');
      if (sql && !/[0-9]/.test(sql)) fallosSql.push('sin número');
      if (sql && !/[^A-Za-z0-9]/.test(sql)) fallosSql.push('sin símbolo');

      if (fallosSql.length) mal('la clave de SQL generada no la aceptaría SQL Server: ' + fallosSql.join(', '));
      else bien('la clave de SQL generada cumple la política de complejidad');

      /* Sin ninguna variable del .env de esta maquina colada dentro. */
      if (/localhost:1433/.test(texto) && !/DB_SERVER=bd-sistema/.test(texto)) {
        info('la base apunta a localhost (puede ser lo correcto si no usa Docker)');
      }
    }

    if (fs.existsSync(instrucciones)) {
      const t = fs.readFileSync(instrucciones, 'utf8');
      if (t.indexOf(cliente.licencia_id) !== -1) {
        bien('las instrucciones llevan SU id de licencia, no una plantilla');
      } else {
        mal('las instrucciones no mencionan el ID de licencia que se le dio');
      }
    }
  } finally {
    fs.rmSync(carpeta1, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------ */
  paso('2. Instalación SIN salida a Internet (con archivo .vflow)');

  const carpeta2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-inst-'));
  try {
    /* Se le dice que NO tiene salida a Internet, así que no puede consultar al
       servidor y la activación será con el archivo .vflow. El ID se pide igual,
       porque es lo que identifica su licencia. */
    /* Sin salida a Internet: en vez del servidor de licencias se le pide la ruta
       del archivo .vflow, que es lo que va a usar para activar. */
    const r = ejecutar([
      '1',                          // instalación de cliente
      'n',                          // ¿tiene salida a Internet? NO
      cliente.licencia_id,          // el ID
      '',                           // ruta del .vflow: no lo tiene a mano ahora
      'http://127.0.0.1:3312',      // la dirección donde queda el sistema
      '',                           // la clave de SQL: que la genere
      'n',                          // ¿tiene el archivo del padrón?
      's',                          // si preguntara por sobrescribir (la carpeta está vacía)
      'n',
    ], carpeta2);

    const env = path.join(carpeta2, '.env');
    if (fs.existsSync(env)) {
      bien('también genera el .env cuando no hay salida a Internet');
      const texto = fs.readFileSync(env, 'utf8');
      if (!/LICENCIA_SERVIDOR=http/.test(texto)) {
        bien('en ese caso no le pone servidor de licencias (se activará con el archivo)');
      } else {
        info('le puso servidor de licencias; tendrá que activarse con el archivo igual');
      }
    } else {
      mal('sin salida a Internet NO generó el .env (código ' + r.codigo + ')');
      info(r.salida.split('\n').filter(Boolean).slice(-6).join('\n          '));
    }
  } finally {
    fs.rmSync(carpeta2, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------ */
  paso('3. NO debe pisar un .env que ya existe');

  const carpeta3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-inst-'));
  try {
    const env = path.join(carpeta3, '.env');
    fs.writeFileSync(env, 'DB_PASSWORD=la-que-ya-estaba-puesta\n');

    /* A la pregunta de sobrescribir se responde que NO. */
    const r = ejecutar([
      '1',                          // instalación de cliente
      's',                          // ¿tiene salida a Internet?
      cliente.licencia_id,
      'http://127.0.0.1:3313',
      '',                           // clave generada
      'n',                          // sin padrón
      'n',                          // ¿sobrescribir el .env que ya existe? NO
    ], carpeta3);

    const texto = fs.readFileSync(env, 'utf8');
    if (/la-que-ya-estaba-puesta/.test(texto)) {
      bien('respetó el .env que ya existía');
    } else {
      mal('PISÓ un .env que ya existía: se puede perder la configuración de producción de alguien');
    }
  } finally {
    fs.rmSync(carpeta3, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------ */
  paso('4. Se niega si la clave de SQL no cumple la política');

  const carpeta4 = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-inst-'));
  try {
    /* Tres intentos con una clave mala: al tercero tiene que rendirse SIN dejar un
       .env a medias. Un .env con una clave que SQL Server rechaza es peor que no
       tener nada: el contenedor arranca y se muere en bucle sin decir por qué. */
    const r = ejecutar([
      '1',                          // instalación de cliente
      's',                          // ¿tiene salida a Internet?
      cliente.licencia_id,
      'http://127.0.0.1:3314',
      'corta',      // clave mala
      'corta',
      'corta',
    ], carpeta4);

    const env = path.join(carpeta4, '.env');
    if (!fs.existsSync(env)) {
      bien('no dejó un .env a medias con una clave que SQL Server rechazaría');
    } else {
      mal('dejó un .env con una clave inválida: el contenedor de la base moriría en bucle');
    }

    if (/no la acepta SQL Server|no cumple|política/i.test(r.salida)) {
      bien('explicó por qué la rechaza');
    } else {
      info('no dijo claramente por qué la rechazaba');
    }
  } finally {
    fs.rmSync(carpeta4, { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------ */
  paso('5. El comprobador de instalación existe y sabe explicarse');

  const comprobador = path.join(RAIZ, 'scripts', 'comprobar-instalacion.js');
  if (fs.existsSync(comprobador)) {
    const r = spawnSync(process.execPath, [comprobador], {
      cwd: RAIZ,
      encoding: 'utf8',
      timeout: 60000,
      env: Object.assign({}, process.env, { URL_PUBLICA: 'http://127.0.0.1:3399' }),
    });
    const salida = (r.stdout || '') + (r.stderr || '');

    /* Aquí no hay nada levantado en ese puerto, así que tiene que FALLAR y decir
       qué hacer. Un comprobador que dice "todo bien" sin comprobar nada no sirve. */
    if (r.status !== 0) bien('detecta que no hay nada instalado en esa dirección');
    else mal('dijo que todo estaba bien sin haber nada levantado');

    if (/no responde|arranque|levante|docker/i.test(salida)) {
      bien('dice qué hacer para arreglarlo');
    } else {
      info('no da una instrucción concreta para arreglarlo');
    }
  } else {
    mal('no existe scripts/comprobar-instalacion.js');
  }
}

let error = null;

async function correr() {
  try {
    await principal();
  } catch (e) {
    error = e;
  }

  console.log('');
  console.log('  ' + '='.repeat(66));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(66));
  if (error) console.log('  Se detuvo: ' + error.message);
  if (detalles.length) {
    console.log('');
    for (const d of detalles) console.log('    ' + d);
  }
  console.log('');

  process.exitCode = (fallos || error) ? 1 : 0;
}

correr();
