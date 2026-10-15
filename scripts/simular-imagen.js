/**
 * VisitaFlow - Simulacion de la imagen.
 *
 *   node scripts/simular-imagen.js
 *
 * Docker no esta instalado en esta maquina, asi que no se puede construir la
 * imagen. Lo que SI se puede hacer es reproducir el sistema de archivos que
 * tendria la imagen y arrancar los dos servidores ahi dentro.
 *
 * Eso caza el tipo de fallo que solo aparece en el contenedor y no en local:
 * rutas relativas que apuntan fuera del proyecto, archivos que el Dockerfile no
 * copia y que el codigo necesita, carpetas de escritura que no existen.
 *
 * Pasos:
 *   1. Copia a tmp/simulacion-imagen/ exactamente lo que el Dockerfile copia,
 *      saltandose lo que excluye el .dockerignore.
 *   2. Enlaza node_modules desde el proyecto (en la imagen vienen de la etapa
 *      de dependencias; aqui no hace falta copiarlos).
 *   3. Arranca cada servidor en un puerto aparte y comprueba que responda.
 *   4. Borra la simulacion.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const SIMULACION = path.join(RAIZ, 'tmp', 'simulacion-imagen');

/* Lo mismo que copia el Dockerfile. Si alla cambia, aqui hay que cambiarlo. */
const COPIAR = [
  'package.json',
  'server.js',
  'server-licencias.js',
  'src',
  'sql',
  'scripts',
  'public',
  'public-licencias',
];

/* Lo que excluye el .dockerignore. */
const EXCLUIR = [
  '.env',
  'node_modules',
  'tmp',
  'datos',
  'capturas',
  'docs',
  'licencias-keys',
  'licencia.vflow',
  'PRODUCT.md',
  'DESIGN.md',
];

const PUERTO_APP = 3210;
const PUERTO_LIC = 4210;

let fallos = 0;

function error(t) { fallos++; console.log('  [X] ' + t); }
function bien(t) { console.log('  [ok] ' + t); }
function info(t) { console.log('      ' + t); }

/** Copia un archivo o carpeta respetando las exclusiones. */
function copiar(origen, destino) {
  const nombre = path.basename(origen);
  if (EXCLUIR.indexOf(nombre) !== -1) return 0;

  const st = fs.statSync(origen);
  if (st.isDirectory()) {
    fs.mkdirSync(destino, { recursive: true });
    let n = 0;
    for (const e of fs.readdirSync(origen)) {
      n += copiar(path.join(origen, e), path.join(destino, e));
    }
    return n;
  }

  // Los archivos con estos sufijos nunca entran en la imagen.
  if (/\.(pem|key|vflow|bak|mdf|ldf|log)$/.test(nombre)) return 0;

  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.copyFileSync(origen, destino);
  return 1;
}

/** Espera a que una direccion responda. */
async function esperar(url, intentos) {
  for (let i = 0; i < (intentos || 30); i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch (e) {
      /* todavia no arranca */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Lee las llaves locales y las devuelve en base64, como en el VPS. */
function llavesEnBase64() {
  const carpeta = path.join(RAIZ, 'licencias-keys');
  const leerB64 = (archivo) => {
    const p = path.join(carpeta, archivo);
    return fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : '';
  };
  return {
    publica: leerB64('publica.pem'),
    privada: leerB64('privada.pem'),
  };
}

/**
 * Arranca un servidor con el entorno equivalente al del contenedor.
 *
 * En la imagen NO existe el archivo .env ni la carpeta licencias-keys: toda la
 * configuracion llega por variables de entorno, igual que las pone el Compose.
 * Para que la simulacion sea fiel, aqui se pasan las variables a mano: los
 * datos de conexion se leen del .env local (para poder usar la base real de
 * esta maquina) y las llaves se convierten a base64 desde los archivos.
 */
function arrancar(script, puerto) {
  try {
    require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });
  } catch (e) {
    /* si no hay .env local, se sigue con lo que haya en el entorno */
  }

  const llaves = llavesEnBase64();

  const entorno = Object.assign({}, process.env, {
    NODE_ENV: 'production',
    PORT: String(puerto),
    PUERTO_LICENCIAS: String(puerto),
    HOST: '0.0.0.0',
    DETRAS_DE_PROXY: '1',
    URL_PUBLICA: 'http://localhost:' + puerto,

    // Base del sistema
    DB_SERVER: process.env.DB_SERVER || 'localhost',
    DB_PORT: process.env.DB_PORT || '1433',
    DB_USER: process.env.DB_USER || 'sa',
    DB_PASSWORD: process.env.DB_PASSWORD || '',
    DB_DATABASE: process.env.DB_DATABASE || 'VisitaFlow',

    // Base de cedulas
    PADRON_ACTIVO: '1',
    PADRON_DB_SERVER: process.env.PADRON_DB_SERVER || process.env.DB_SERVER || 'localhost',
    PADRON_DB_USER: process.env.PADRON_DB_USER || 'sa',
    PADRON_DB_PASSWORD: process.env.PADRON_DB_PASSWORD || process.env.DB_PASSWORD || '',
    PADRON_DATABASE: process.env.PADRON_DATABASE || 'PadronLigero',
    PADRON_TABLA: 'dbo.CIUDADANOS',

    // Secretos: en el contenedor vienen de las variables del Compose.
    JWT_SECRET: 'simulacion-de-imagen-no-usar-en-produccion',
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'simulacion',

    // Las llaves por variable de entorno, que es como viajan al VPS.
    LICENCIA_LLAVE_PUBLICA_B64: llaves.publica,
    LICENCIA_LLAVE_PRIVADA_B64: llaves.privada,
    // Y las rutas de archivo apuntan a donde no hay nada, para comprobar que
    // las variables de entorno bastan.
    LICENCIA_LLAVE_PUBLICA_ARCHIVO: path.join(SIMULACION, 'no-existe-publica.pem'),
    LICENCIA_LLAVE_PRIVADA_ARCHIVO: path.join(SIMULACION, 'no-existe-privada.pem'),

    // En la imagen NO hay licencia.vflow.
    LICENCIA_ARCHIVO: path.join(SIMULACION, 'datos', 'licencia.vflow'),
    ARCHIVOS_CARPETA: path.join(SIMULACION, 'datos', 'archivos'),
    LICENCIAS_REGISTRO: path.join(SIMULACION, 'datos', 'licencias-emitidas.json'),
    TZ: process.env.TZ || 'America/Santo_Domingo',
  });

  const p = spawn(process.execPath, [script], {
    cwd: SIMULACION,
    env: entorno,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let salida = '';
  p.stdout.on('data', (d) => { salida += d.toString(); });
  p.stderr.on('data', (d) => { salida += d.toString(); });
  p.obtenerSalida = () => salida;
  return p;
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - simulacion de la imagen');
  console.log('  ' + '='.repeat(62));
  console.log('');

  // 1. Reconstruir el sistema de archivos de la imagen.
  if (fs.existsSync(SIMULACION)) fs.rmSync(SIMULACION, { recursive: true, force: true });
  fs.mkdirSync(SIMULACION, { recursive: true });

  let copiados = 0;
  for (const c of COPIAR) {
    const origen = path.join(RAIZ, c);
    if (!fs.existsSync(origen)) {
      error('El Dockerfile copia "' + c + '" pero no existe en el proyecto');
      continue;
    }
    copiados += copiar(origen, path.join(SIMULACION, c));
  }
  console.log('  --- sistema de archivos de la imagen ---');
  bien(copiados + ' archivos copiados (sin .env, sin llaves, sin datos)');

  // Comprobaciones de que no se coló nada que no debe.
  const prohibidos = ['.env', 'licencias-keys', 'licencia.vflow', 'node_modules'];
  for (const p of prohibidos) {
    if (fs.existsSync(path.join(SIMULACION, p))) {
      error('La imagen contendria "' + p + '", que NO debe ir dentro');
    }
  }
  if (fs.existsSync(path.join(SIMULACION, 'datos'))) {
    error('La imagen contendria la carpeta "datos" con informacion de ejecucion');
  } else {
    bien('no se colaron secretos ni datos de ejecucion');
  }

  // En la imagen, node_modules viene de la etapa de dependencias: se enlaza.
  fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(SIMULACION, 'node_modules'), 'junction');
  bien('node_modules enlazado desde el proyecto (como en la imagen)');

  // 2. Arrancar el servidor de licencias, que no necesita base de datos.
  console.log('');
  console.log('  --- servidor de licencias dentro de la imagen ---');
  const lic = arrancar('server-licencias.js', PUERTO_LIC);

  let respuesta = await esperar('http://localhost:' + PUERTO_LIC + '/api/salud');
  if (!respuesta) {
    error('No arrancó. Salida del proceso:');
    info(lic.obtenerSalida().split('\n').slice(0, 14).join('\n      '));
  } else {
    bien('arrancó y responde en el puerto ' + PUERTO_LIC);
    const salud = await (await fetch('http://localhost:' + PUERTO_LIC + '/api/salud')).json();
    if (salud.llave && salud.llave.disponible) bien('encontró la llave privada (por variable de entorno)');
    else error('no encontró la llave privada: ' + ((salud.llave || {}).motivo || 'sin motivo'));
  }
  lic.kill();

  // 3. Arrancar el servidor del sistema, que sí necesita la base.
  console.log('');
  console.log('  --- servidor del sistema dentro de la imagen ---');
  const app = arrancar('server.js', PUERTO_APP);

  respuesta = await esperar('http://localhost:' + PUERTO_APP + '/api/salud', 40);
  if (!respuesta) {
    error('No arrancó. Salida del proceso:');
    info(app.obtenerSalida().split('\n').slice(0, 18).join('\n      '));
  } else {
    bien('arrancó y responde en el puerto ' + PUERTO_APP);
    const salud = await (await fetch('http://localhost:' + PUERTO_APP + '/api/salud')).json();

    // En el contenedor no hay .env ni licencia.vflow: lo que importa es que el
    // servidor ARRANQUE y diga con claridad lo que le falta, en vez de morir.
    if (salud.base_datos && salud.base_datos.disponible) bien('se conectó a la base del sistema');
    else info('base del sistema no disponible (esperado sin licencia/bóveda): ' + ((salud.base_datos || {}).motivo || '—'));

    if (salud.cedulas && salud.cedulas.disponible) bien('se conectó a la base de cédulas');
    else info('base de cédulas no disponible: ' + ((salud.cedulas || {}).motivo || '—'));

    // Que la interfaz se sirva bien es la prueba de que public/ llegó completa.
    const html = await fetch('http://localhost:' + PUERTO_APP + '/');
    const texto = await html.text();
    if (html.status === 200 && texto.indexOf('id="app"') !== -1) bien('sirve la interfaz web');
    else error('no sirve la interfaz (estado ' + html.status + ')');

    const css = await fetch('http://localhost:' + PUERTO_APP + '/app.css');
    if (css.status === 200) bien('sirve los estilos');
    else error('no sirve los estilos (estado ' + css.status + ')');

    const js = await fetch('http://localhost:' + PUERTO_APP + '/paginas.js');
    if (js.status === 200) bien('sirve el JavaScript de las pantallas');
    else error('no sirve el JavaScript (estado ' + js.status + ')');
  }
  app.kill();

  // 4. Limpieza.
  await new Promise((r) => setTimeout(r, 400));
  try {
    fs.rmSync(SIMULACION, { recursive: true, force: true });
  } catch (e) {
    info('no se pudo borrar la simulación: ' + e.message);
  }

  console.log('');
  console.log('  ' + '='.repeat(62));
  console.log('  ' + (fallos ? fallos + ' problema(s)' : 'Sin problemas: la imagen arrancaría bien'));
  console.log('');

  process.exit(fallos ? 1 : 0);
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
