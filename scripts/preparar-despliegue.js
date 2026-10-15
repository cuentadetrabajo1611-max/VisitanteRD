/**
 * VisitaFlow - Preparar el despliegue en el VPS con Dokploy.
 *
 *   npm run desplegar:preparar
 *
 * QUE HACE
 * --------
 * Comprueba que este todo lo que hace falta ANTES de tocar el servidor, y
 * genera los valores que hay que pegar en Dokploy (las llaves en base64 y los
 * secretos). Si algo falta, lo dice y no sigue: es mejor descubrirlo aqui que a
 * medio despliegue.
 *
 * NO despliega nada por si solo. Al final imprime los pasos exactos con los
 * valores ya rellenados.
 *
 * POR QUE NO LO HACE TODO SOLO
 * ----------------------------
 * Porque desplegar necesita acceso al VPS, y ese acceso lo tiene su dueno. Este
 * script deja todo preparado y verificado; los ultimos pasos los da quien tenga
 * el acceso.
 *
 * POR QUE ESTA EN NODE Y NO EN POWERSHELL
 * ---------------------------------------
 * Se intento primero en PowerShell y Windows lo bloqueo: "el archivo no esta
 * firmado digitalmente". Node esta instalado para el propio proyecto y funciona
 * igual en Windows, en Linux y en el VPS.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');

let problemas = 0;

const C = {
  reset: '\u001b[0m',
  gris: '\u001b[90m',
  rojo: '\u001b[31m',
  verde: '\u001b[32m',
  ambar: '\u001b[33m',
  cian: '\u001b[36m',
  blanco: '\u001b[97m',
};

function titulo(t) {
  console.log('');
  console.log('  ' + C.cian + t + C.reset);
  console.log('  ' + C.gris + '-'.repeat(62) + C.reset);
}

function bien(t) { console.log('  ' + C.verde + '[ok]' + C.reset + '    ' + t); }
function falta(t) { problemas++; console.log('  ' + C.rojo + '[FALTA]' + C.reset + ' ' + t); }
function aviso(t) { console.log('  ' + C.ambar + '[aviso]' + C.reset + ' ' + t); }
function dato(k, v) { console.log('    ' + C.blanco + k.padEnd(30) + C.reset + v); }

/* ------------------------------------------------------------------ */

console.log('');
console.log('  ' + C.blanco + 'VisitaFlow - preparar el despliegue' + C.reset);
console.log('  ' + C.gris + '='.repeat(62) + C.reset);

/* 1. Los archivos que hay que subir. */
titulo('1. Archivos que hacen falta');

for (const f of ['Dockerfile', 'docker-compose.yml', '.dockerignore', '.env.example']) {
  if (fs.existsSync(path.join(RAIZ, f))) bien(f);
  else falta(f + ' (no existe)');
}

/* 2. Lo que NO debe subirse. */
titulo('2. Lo que NO debe subirse');

const dockerignore = fs.existsSync(path.join(RAIZ, '.dockerignore'))
  ? fs.readFileSync(path.join(RAIZ, '.dockerignore'), 'utf8')
  : '';

for (const s of [
  { ruta: '.env', porQue: 'tiene las claves de esta maquina' },
  { ruta: 'licencias-keys', porQue: 'es la llave privada del licenciamiento' },
  { ruta: 'datos', porQue: 'tiene la licencia y las credenciales de esta maquina' },
]) {
  const existe = fs.existsSync(path.join(RAIZ, s.ruta));
  if (!existe) continue;
  if (dockerignore.indexOf(s.ruta) === -1) {
    falta(s.ruta + ' existe y el .dockerignore NO lo excluye (' + s.porQue + ')');
  } else {
    bien(s.ruta + ' queda fuera de la imagen');
  }
}

/* 3. Las llaves del licenciamiento. */
titulo('3. Las llaves del licenciamiento');

const privada = path.join(RAIZ, 'licencias-keys', 'privada.pem');
const publica = path.join(RAIZ, 'licencias-keys', 'publica.pem');

let b64Privada = null;
let b64Publica = null;

if (!fs.existsSync(privada) || !fs.existsSync(publica)) {
  falta('No hay par de llaves. Genérelas con:  npm run keys:gen');
} else {
  bien('par de llaves presente');
  b64Privada = fs.readFileSync(privada).toString('base64');
  b64Publica = fs.readFileSync(publica).toString('base64');
  bien('llave privada en base64 (' + b64Privada.length + ' caracteres)');
  bien('llave pública en base64 (' + b64Publica.length + ' caracteres)');
}

/* 4. Secretos nuevos, para no reusar los de desarrollo. */
titulo('4. Secretos que hay que inventar');

/**
 * Una clave de SQL Server que COMPLECE la politica de complejidad.
 *
 * La version anterior tomaba 36 bytes al azar en base64 y les quitaba los
 * caracteres + / = para que no rompieran el archivo .env. El efecto era que
 * NUNCA quedaba ningun simbolo: de 2000 claves generadas, 2000 salieron sin
 * simbolo. Y SQL Server exige un simbolo entre sus requisitos: la rechaza, el
 * contenedor de la base arranca y se muere en bucle, y el sintoma que se ve es
 * que la aplicacion no conecta, que apunta a otro sitio.
 *
 * Ahora se arma por partes: se garantiza que haya mayuscula, minuscula, numero y
 * simbolo, y solo despues se rellena el resto al azar. Los simbolos son los que no
 * rompen nada: ni comillas (romperian el .env y la linea de comandos), ni la barra
 * invertida ni el dolar (los interpreta el shell al pasarlos a un comando docker).
 */
function nuevaClaveSql() {
  const MAYUS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const MINUS = 'abcdefghijkmnopqrstuvwxyz';
  const NUMS = '23456789';
  const SIMB = '!@#%^*-_=+';

  const todos = MAYUS + MINUS + NUMS + SIMB;
  const elegir = (juego) => juego[crypto.randomInt(juego.length)];

  const parte = [
    elegir(MAYUS), elegir(MINUS), elegir(NUMS), elegir(SIMB),
    elegir(MAYUS), elegir(MINUS), elegir(NUMS), elegir(SIMB),
  ];
  while (parte.length < 32) parte.push(elegir(todos));

  // Se mezcla, para que los cuatro primeros no sean siempre del mismo tipo.
  for (let i = parte.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = parte[i]; parte[i] = parte[j]; parte[j] = t;
  }

  return parte.join('');
}

/** Un secreto largo y al azar, para JWT_SECRET y ADMIN_TOKEN. */
function nuevoSecreto() {
  return crypto.randomBytes(36).toString('base64').replace(/[+/=]/g, '');
}

/** Lee el .env, si existe, como objeto {CLAVE: valor}. */
function leerEnv() {
  const ruta = path.join(RAIZ, '.env');
  const salida = {};
  if (!fs.existsSync(ruta)) return salida;

  for (const l of fs.readFileSync(ruta, 'utf8').split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.indexOf('=');
    if (p > 0) salida[t.slice(0, p)] = t.slice(p + 1);
  }
  return salida;
}

/**
 * Guarda en el .env los valores que falten, SIN tocar los que ya esten.
 *
 * POR QUE ESTO ES IMPORTANTE
 * --------------------------
 * El script de despliegue manda a Dokploy las variables que encuentre en el .env. Si la
 * clave de SQL o las llaves no estan ahi, se manda un compose al que le faltan variables
 * OBLIGATORIAS: el despliegue "funciona" y despues el contenedor de la base no arranca,
 * sin decir por que. Guardandolas aqui, el despliegue las manda solo.
 *
 * Y LOS VALORES QUE YA EXISTEN NO SE TOCAN, con una excepcion: los que se pasan en
 * `reemplazar`. Antes se generaba una clave de SQL nueva en CADA corrida: si ya habia
 * desplegado, la clave que se le ensenaba no era la que la base tiene de verdad, y el
 * contenedor de SQL Server no arrancaba. Un valor que ya sirvio no se cambia nunca por
 * volver a ejecutar esto.
 *
 * La excepcion son los secretos de desarrollo: el .env de la maquina local tiene un JWT
 * que empieza por "dev-" y un token de administracion descriptivo, comodos para trabajar
 * aqui. Si no se reemplazaran, ESOS serian los que acabarian en el VPS.
 */
function guardarEnv(nuevos, reemplazar) {
  const ruta = path.join(RAIZ, '.env');
  const actual = fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8') : '';
  const lineas = actual ? actual.split('\n') : [];
  const forzar = reemplazar || [];
  const guardados = [];

  for (const [clave, valor] of Object.entries(nuevos)) {
    if (!valor) continue;

    const i = lineas.findIndex((l) => l.trim().startsWith(clave + '='));
    if (i !== -1) {
      const puesto = lineas[i].trim().slice(clave.length + 1);
      /* Se rellena si esta vacio, o si se pidio reemplazarlo. */
      if (!puesto || forzar.indexOf(clave) !== -1) {
        lineas[i] = clave + '=' + valor;
        guardados.push(clave);
      }
      continue;
    }

    lineas.push(clave + '=' + valor);
    guardados.push(clave);
  }

  if (guardados.length) {
    fs.writeFileSync(ruta, lineas.join('\n'));
  }
  return guardados;
}

/* Los valores que ya esten en el .env SE REUTILIZAN. Generar otros nuevos en cada
   corrida rompe lo que ya funciona: la clave de SQL de un despliegue hecho no se puede
   cambiar sin recrear la base, y las llaves de licencia no se pueden cambiar sin
   invalidar todas las licencias emitidas. */
const envActual = leerEnv();

/**
 * Un secreto que NO sirve para producción.
 *
 * El .env de la maquina de desarrollo tiene valores comodos para trabajar en local: un
 * JWT que empieza por "dev-", un ADMIN_TOKEN que se llama "visitaflow_admin_local". Si
 * se reutilizan tal cual, ESOS son los que acaban en el VPS: el mismo JWT que cualquiera
 * que haya visto el proyecto puede firmar, y un token de administracion adivinable.
 *
 * No basta con que la variable exista: tiene que valer. Aqui se detectan los de
 * ejemplo, los de desarrollo y los demasiado cortos, y se generan nuevos.
 */
function esDebil(valor) {
  if (!valor) return true;
  const v = String(valor);
  if (/^(dev|test|local|cambie|ejemplo|secreto|changeme|password)/i.test(v)) return true;
  if (/^visitaflow_?(admin|dev|local)/i.test(v)) return true;
  if (/cambie|change.?me|ejemplo/i.test(v)) return true;
  return v.length < 32;
}

const debiles = [];
const claveSql = envActual.CLAVE_SQL || nuevaClaveSql();

let jwt = envActual.JWT_SECRET;
if (esDebil(jwt)) { debiles.push('JWT_SECRET'); jwt = nuevoSecreto(); }

let adminToken = envActual.ADMIN_TOKEN;
if (esDebil(adminToken)) { debiles.push('ADMIN_TOKEN'); adminToken = nuevoSecreto(); }

/* El token que comparten el servidor de licencias y cada instalacion. Sin el, las
   rutas de renovacion y de aviso quedan cerradas. */
const tokenActivacion = envActual.LICENCIA_TOKEN_ACTIVACION || 'act-' + nuevoSecreto();

if (envActual.CLAVE_SQL) bien('se reutiliza la clave de SQL que ya estaba en el .env');
else bien('clave de SQL generada');

if (debiles.length) {
  /* Se dice claro: son los que se van a mandar al VPS, y los de desarrollo no valen. */
  aviso(debiles.join(' y ') + ' del .env eran de desarrollo, de ejemplo o demasiado cortos.');
  console.log('          Se generaron nuevos para el VPS: los de local no sirven en producción.');
} else {
  bien('se reutilizan el JWT y el token de administración que ya estaban');
}

bien('secretos listos');

/* 5. Comprobaciones finales. */
titulo('5. Comprobaciones finales');

const bakPadron = 'C:\\TempSQL\\PadronLigero.bak';
if (fs.existsSync(bakPadron)) {
  bien('el respaldo de cédulas ya está (' + Math.round(fs.statSync(bakPadron).size / 1024 / 1024) + ' MB)');
} else {
  aviso('falta el respaldo de cédulas, que hay que subir al VPS una vez:');
  console.log('           sqlcmd -S localhost -U sa -P "SU_CLAVE" -C -Q ' +
    '"BACKUP DATABASE PadronLigero TO DISK = \'C:\\TempSQL\\PadronLigero.bak\' WITH COMPRESSION"');
}

/* Que el proyecto pase sus propias comprobaciones.
 *
 * Se comprueban aqui los dos archivos clave en vez de lanzar "npm run
 * verificar" como un proceso aparte: lanzar procesos con la salida capturada no
 * funciona en todos los entornos (en Windows, dentro de segun que terminales,
 * falla sin decir por que). Comprobar los archivos directamente es mas simple y
 * no depende de nada. */
console.log('');
console.log('  ' + C.gris + 'Comprobando el proyecto…' + C.reset);

let comprobaciones = 0;

/* El Dockerfile tiene que copiar todo lo que el codigo necesita en ejecucion. */
try {
  const dockerfile = fs.readFileSync(path.join(RAIZ, 'Dockerfile'), 'utf8');
  const necesarios = ['server.js', 'server-licencias.js', 'src', 'public', 'public-licencias', 'sql', 'scripts'];
  const ausentes = necesarios.filter((n) => dockerfile.indexOf(n) === -1);

  if (ausentes.length) {
    falta('el Dockerfile no copia: ' + ausentes.join(', '));
  } else {
    bien('el Dockerfile copia todo lo necesario (' + necesarios.length + ' entradas)');
    comprobaciones++;
  }

  /* Y NO tiene que copiar los secretos. */
  if (dockerfile.indexOf('licencias-keys') !== -1 || /COPY\s+\.env\b/.test(dockerfile)) {
    falta('el Dockerfile copia secretos dentro de la imagen');
  } else {
    bien('el Dockerfile no copia secretos');
    comprobaciones++;
  }
} catch (e) {
  falta('no se pudo leer el Dockerfile: ' + e.message);
}

/* El Compose tiene que tener los tres servicios y exigir lo obligatorio. */
try {
  const compose = fs.readFileSync(path.join(RAIZ, 'docker-compose.yml'), 'utf8');
  const servicios = ['bd-sistema', 'licencias', 'app'];
  const faltantes = servicios.filter((s) => compose.indexOf('\n  ' + s + ':') === -1);

  if (faltantes.length) falta('el Compose no tiene: ' + faltantes.join(', '));
  else {
    bien('el Compose tiene los tres servicios');
    comprobaciones++;
  }

  // Las variables sin valor por defecto hacen que el despliegue falle al
  // arrancar diciendo cual falta, en vez de arrancar con un secreto vacio.
  const exigidas = (compose.match(/\$\{[A-Z_]+:\?/g) || []).length;
  if (exigidas) {
    bien(exigidas + ' variables son obligatorias (el despliegue avisa si falta alguna)');
    comprobaciones++;
  }
} catch (e) {
  falta('no se pudo leer el docker-compose.yml: ' + e.message);
}

/* La sintaxis de todo el codigo del servidor.
 *
 * Se envuelve el archivo en una funcion antes de compilarlo, que es lo que hace
 * Node al cargar un modulo: sin eso, un "return" de nivel superior (que en un
 * modulo es valido) daria un error de sintaxis que no existe. */
try {
  const archivos = [];
  (function recorrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tmp', 'datos', '.git', 'capturas'].indexOf(e.name) !== -1) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.js')) archivos.push(p);
    }
  })(RAIZ);

  let malos = 0;
  for (const a of archivos) {
    try {
      new (require('vm').Script)(
        '(function (exports, require, module, __filename, __dirname) {' +
        fs.readFileSync(a, 'utf8') +
        '\n})',
        { filename: a }
      );
    } catch (e) {
      malos++;
      falta('error de sintaxis en ' + path.relative(RAIZ, a) + ': ' + e.message);
    }
  }
  if (!malos) {
    bien(archivos.length + ' archivos de código sin errores de sintaxis');
    comprobaciones++;
  }
} catch (e) {
  aviso('no se pudo revisar la sintaxis: ' + e.message);
}

/* El repositorio tiene que estar limpio. */
try {
  const git = execFileSync('git', ['status', '--porcelain'], { cwd: RAIZ, stdio: 'pipe' }).toString().trim();
  if (git) aviso('hay cambios sin comprometer en el repositorio');
  else bien('el repositorio está limpio');
} catch (e) {
  aviso('no se pudo comprobar el estado del repositorio');
}

/* ------------------------------------------------------------------ */

console.log('');
console.log('  ' + C.gris + '='.repeat(62) + C.reset);

if (problemas) {
  console.log('  ' + C.rojo + problemas + ' problema(s). Resuélvalos y vuelva a ejecutar.' + C.reset);
  console.log('');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Se guardan en el .env los valores OBLIGATORIOS que falten.
 *
 * Esto es lo que hace que el despliegue funcione de una tirada: el script de despliegue
 * manda a Dokploy las variables que encuentre en el .env, asi que las obligatorias
 * tienen que estar ahi. Antes no se guardaban, y el resultado era un despliegue que
 * "salia bien" y luego no arrancaba porque al compose le faltaba la clave de SQL o las
 * llaves.
 *
 * El .env esta ignorado por git, asi que nada de esto acaba en el repositorio. */
const guardados = guardarEnv({
  CLAVE_SQL: claveSql,
  JWT_SECRET: jwt,
  ADMIN_TOKEN: adminToken,
  LICENCIA_TOKEN_ACTIVACION: tokenActivacion,
  LICENCIA_LLAVE_PRIVADA_B64: b64Privada,
  LICENCIA_LLAVE_PUBLICA_B64: b64Publica,
}, debiles);

if (guardados.length) {
  console.log('');
  bien('guardados en .env (el despliegue los manda solo): ' + guardados.join(', '));
}

if (b64Privada) {
  /* La privada tambien va en el .env para que el despliegue la mande, pero ADEMAS se
     imprime: el servicio "licencias" la necesita en su propio entorno dentro de Dokploy,
     y el .env es local, no viaja al servidor. */
  console.log('  ' + C.gris + '  (la privada va en .env y además se pega en Dokploy, ver abajo)' + C.reset);
}

console.log('');
console.log('  ' + C.verde + 'Todo listo. Estos son los valores para Dokploy:' + C.reset);

console.log('');
console.log('  ' + C.cian + '--- Environment (pestaña Environment de la aplicación) ---' + C.reset);
console.log('');
console.log('  ' + C.gris + '# Base de datos' + C.reset);
dato('CLAVE_SQL=', claveSql);
console.log('  ' + C.gris + '# Sesiones y administración' + C.reset);
dato('JWT_SECRET=', jwt);
dato('ADMIN_TOKEN=', adminToken);
console.log('  ' + C.gris + '# El token que comparten el servidor de licencias y cada cliente' + C.reset);
console.log('  ' + C.gris + '# (el MISMO valor en este servidor y en la instalación de cada cliente)' + C.reset);
dato('LICENCIA_TOKEN_ACTIVACION=', tokenActivacion);
console.log('  ' + C.gris + '# Direcciones públicas (cámbielas por sus dominios)' + C.reset);
console.log('    URL_PUBLICA=https://visitas.su-dominio.com');
console.log('    LICENCIA_SERVIDOR_URL=https://licencias.su-dominio.com');

console.log('');
console.log('  ' + C.cian + '--- Llaves del licenciamiento (base64) ---' + C.reset);
console.log('');
if (b64Privada) {
  /* La privada se imprime ENTERA a proposito, y no es un descuido.
   *
   * El .env esta ignorado por git, asi que no viaja al servidor: la unica forma de que
   * el servicio "licencias" tenga su llave es pegarla a mano en el entorno de Dokploy.
   * Si no se pega, ese contenedor NO arranca (el servidor se niega a firmar sin llave,
   * a proposito) y el sintoma que se ve desde fuera es "el despliegue falla", que no
   * dice nada de la causa. Por eso va aqui, copiable, y con el aviso delante. */
  console.log('  ' + C.ambar + '  IMPORTANTE: la privada hay que pegarla en Dokploy. Sin ella el' + C.reset);
  console.log('  ' + C.ambar + '  servicio "licencias" NO arranca (se niega a firmar sin su llave).' + C.reset);
  console.log('  ' + C.gris + '# Solo el servicio "licencias" la necesita. NO la ponga tambien en "app".' + C.reset);
  dato('LICENCIA_LLAVE_PRIVADA_B64=', '');
  console.log('    ' + b64Privada);
  console.log('');
  console.log('  ' + C.gris + '# La publica la usan la app y el servidor de licencias.' + C.reset);
  dato('LICENCIA_LLAVE_PUBLICA_B64=', '');
  console.log('    ' + b64Publica);
} else {
  console.log('  ' + C.ambar + '  (genere las llaves primero con: npm run keys:gen)' + C.reset);
}

console.log('');
console.log('  ' + C.cian + '--- Pasos en Dokploy ---' + C.reset);
console.log('');
console.log('   1. Projects -> Create Project (por ejemplo "visitaflow")');
console.log('   2. Create Service -> Docker Compose');
console.log('   3. Conecte el repositorio y elija la rama');
console.log('   4. Compose Path: docker-compose.yml');
console.log('   5. Environment: pegue los valores de arriba');
console.log('   6. Domains: solo el servicio "app", puerto 3000');
console.log('   7. Deploy');
console.log('');
console.log('  ' + C.ambar + 'La llave privada NO va en el servicio "app": solo el de licencias' + C.reset);
console.log('  ' + C.ambar + 'la necesita. El compose ya lo tiene separado.' + C.reset);
console.log('');
console.log('  Guía completa, paso a paso: ' + C.blanco + 'DESPLIEGUE.md' + C.reset);
console.log('');
