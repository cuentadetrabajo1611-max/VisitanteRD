/**
 * VisitaFlow - Instalacion en el servidor de un cliente.
 *
 *   npm run instalar:cliente
 *
 * QUE HACE
 * --------
 * Pregunta lo minimo (la licencia, la direccion, la clave de SQL Server y si
 * tiene el archivo de cedulas), comprueba de verdad lo que se puede comprobar
 * antes de escribir nada, y deja dos archivos:
 *
 *   .env             configuracion completa, con secretos nuevos y aleatorios
 *   INSTALACION.txt  los pasos que quedan, ya rellenados con los datos de ESTE
 *                    cliente: no es una plantilla, es su instalacion
 *
 * POR QUE EXISTE
 * --------------
 * Poner el sistema a mano eran una docena de variables, cada una una ocasion de
 * equivocarse, y quien lo hace no es quien escribio el sistema: es el cliente o
 * un tecnico que no lo conoce. Lo que se puede automatizar se automatiza; lo que
 * no (levantar Docker, restaurar las cedulas) sale escrito con SUS datos.
 *
 * POR QUE NO ESCRIBE UN .ENV A MEDIAS
 * -----------------------------------
 * Si falta la llave publica, si el ID no existe en el servidor de licencias o si
 * la clave de SQL no cumple la politica de SQL Server, se dice y no se escribe
 * nada. Un .env a medias se descubre mucho despues, con el sistema arrancando a
 * medias, y entonces cuesta diez veces mas encontrar el motivo.
 *
 * LAS DOS ACTIVACIONES
 * --------------------
 *   - Con el ID (LIC-XXXXXXXX): el sistema le pregunta al servidor de licencias
 *     del proveedor. Necesita salida a Internet.
 *   - Con el archivo .vflow: es el camino de una institucion sin Internet. El
 *     archivo se le pide al proveedor y se pega en la pantalla de activacion.
 * Los dos caminos se comprueban aqui antes de dar la instalacion por preparada.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');

/* Valor que lleva la llave privada en una instalacion de cliente. El Compose
   exige que la variable no este vacia para poder arrancar, pero el servidor de
   licencias de un cliente es el del proveedor: ese servicio no se usa aqui. */
const SIN_LLAVE_PRIVADA = 'sin-llave-privada-en-una-instalacion-de-cliente';

/* Variables que docker-compose.yml exige sin valor por defecto y que este
   asistente tiene que dejar puestas si o si. */
const COMPOSE_OBLIGATORIAS = [
  'CLAVE_SQL',
  'JWT_SECRET',
  'ADMIN_TOKEN',
  'URL_PUBLICA',
  'LICENCIA_LLAVE_PUBLICA_B64',
];

const C = {
  reset: '\u001b[0m',
  gris: '\u001b[90m',
  rojo: '\u001b[31m',
  verde: '\u001b[32m',
  ambar: '\u001b[33m',
  cian: '\u001b[36m',
  blanco: '\u001b[97m',
};

let problemas = 0;

function titulo(t) {
  console.log('');
  console.log('  ' + C.cian + t + C.reset);
  console.log('  ' + C.gris + '-'.repeat(66) + C.reset);
}

function bien(t) { console.log('  ' + C.verde + '[ok]' + C.reset + '    ' + t); }
function falta(t) { problemas++; console.log('  ' + C.rojo + '[FALTA]' + C.reset + ' ' + t); }
function aviso(t) { console.log('  ' + C.ambar + '[aviso]' + C.reset + ' ' + t); }
function dato(k, v) { console.log('    ' + C.blanco + String(k).padEnd(24) + C.reset + v); }
function nota(t) { console.log('  ' + C.gris + t + C.reset); }

/* ------------------------------------------------------------------ */
/* Preguntas                                                           */
/* ------------------------------------------------------------------ */

/**
 * Lector de linea a linea.
 *
 * Se lee con un iterador en vez de rl.question porque asi funciona igual
 * escribiendo a mano que con la entrada por tuberia, que es como se prueba este
 * archivo sin nadie delante.
 */
function crearLector() {
  /* Para la clave de SQL: lo que se escribe no debe quedar en pantalla ni en el
     historial de la consola. Se filtra la salida del readline mientras dura la
     pregunta, en vez de leer sin eco a mano. */
  const oculto = { activo: false };
  const salida = new Writable({
    write(trozo, codificacion, siguiente) {
      if (!oculto.activo) process.stdout.write(trozo);
      siguiente();
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: salida,
    terminal: Boolean(process.stdin.isTTY),
  });

  const lineas = rl[Symbol.asyncIterator]();

  async function siguienteLinea() {
    const r = await lineas.next();
    return r.done ? null : String(r.value);
  }

  /** Pregunta y devuelve el texto. Devuelve el valor por defecto si se pulsa Enter. */
  async function preguntar(texto, porDefecto) {
    process.stdout.write(texto);
    const bruto = await siguienteLinea();
    if (!rl.terminal) process.stdout.write('\n');

    if (bruto === null) {
      if (porDefecto !== undefined) return porDefecto;
      throw new Error('se acabo la entrada y faltaban respuestas por escribir');
    }
    const limpio = bruto.trim();
    if (!limpio && porDefecto !== undefined) return porDefecto;
    return limpio;
  }

  async function preguntarOculto(texto) {
    if (!rl.terminal) return preguntar(texto);
    oculto.activo = true;
    process.stdout.write(texto);
    try {
      const bruto = await siguienteLinea();
      process.stdout.write('\n');
      if (bruto === null) throw new Error('se acabo la entrada antes de la clave de SQL Server');
      return bruto.trim();
    } finally {
      oculto.activo = false;
    }
  }

  async function siNo(texto, porDefectoSi) {
    const marca = porDefectoSi ? ' [S/n] ' : ' [s/N] ';
    const r = await preguntar(texto + marca, porDefectoSi ? 's' : 'n');
    return /^s/i.test(r);
  }

  return {
    preguntar,
    preguntarOculto,
    siNo,
    /* Al cerrar hay que soltar tambien la entrada. Si no, con respuestas metidas
       por tuberia el proceso se queda con lineas sin leer y no termina nunca. */
    cerrar: () => {
      try { rl.close(); } catch (e) { /* ya estaba cerrado */ }
      try { process.stdin.pause(); } catch (e) { /* da igual */ }
      if (!process.stdin.isTTY) {
        try { process.stdin.destroy(); } catch (e) { /* da igual */ }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

/** 36 bytes al azar en base64, sin los caracteres que rompen un .env. */
function nuevoSecreto() {
  return crypto.randomBytes(36).toString('base64').replace(/[+/=]/g, '');
}

/** Direccion con esquema. Un dominio publico lleva HTTPS; un nombre de red no. */
function normalizarDireccion(valor) {
  const t = String(valor || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;

  /* Sin esquema: se decide por la pinta del nombre. Un dominio publico detras de
     Traefik/Dokploy tiene certificado (https); una IP, un nombre de la red local
     o un puerto escrito a mano no lo tienen. */
  const soloHost = t.split('/')[0];
  const esRedLocal = /^(localhost|127\.0\.0\.1|\[?::1\]?)/i.test(soloHost) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(soloHost) ||
    soloHost.indexOf(':') !== -1 ||
    soloHost.indexOf('.') === -1;
  return (esRedLocal ? 'http://' : 'https://') + t;
}

/** ¿Es una direccion de verdad? Un pegado a mano puede traer cualquier cosa, y
    URL_PUBLICA termina en los enlaces que se mandan por correo. */
function direccionValida(direccion) {
  try {
    const u = new URL(direccion);
    if (!/^https?:$/.test(u.protocol)) return false;
    return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(u.hostname);
  } catch (e) {
    return false;
  }
}

/** GET/POST con espera maxima: sin esto, un servidor que no contesta cuelga el asistente. */
async function pedirJson(url, opciones, msEspera) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), msEspera || 8000);
  try {
    const r = await fetch(url, Object.assign({ signal: control.signal }, opciones || {}));
    const texto = await r.text();
    let datos = null;
    try { datos = JSON.parse(texto); } catch (e) { /* respuesta que no es JSON */ }
    return { estado: r.status, ok: r.ok, datos, texto };
  } finally {
    clearTimeout(reloj);
  }
}

/**
 * Las formas en que puede llegar una llave publica, SIN tocarle los bytes.
 *
 * El key_id del licenciamiento es el hash del texto del PEM tal cual, con su
 * salto de linea final incluido. Recortarlo cambia el hash, y entonces el
 * sistema rechaza una licencia perfectamente valida diciendo que es de otra
 * llave. Por eso aqui se devuelven las variantes posibles y despues se elige la
 * que cuadra con la licencia, en vez de "limpiar" el texto.
 *
 * Las variantes salen del mismo texto que se lee de un archivo, del que manda el
 * servidor de licencias y de un pegado a mano (que suele perder el salto final,
 * o llegar en base64, que es como viaja dentro del .env).
 */
function variantesLlave(texto) {
  const bruto = String(texto || '');
  const candidatas = [];

  candidatas.push(bruto);

  const sinComillas = bruto.replace(/^\s*["']/, '').replace(/["']\s*$/, '').replace(/^\s+/, '');
  candidatas.push(sinComillas);
  candidatas.push(sinComillas.replace(/\s+$/, '\n'));

  try {
    const decodificado = Buffer.from(bruto.trim(), 'base64').toString('utf8');
    if (decodificado.indexOf('-----BEGIN') !== -1) {
      candidatas.push(decodificado);
      candidatas.push(decodificado.replace(/\s+$/, '\n'));
    }
  } catch (e) { /* no venia en base64 */ }

  const salida = [];
  for (const c of candidatas) {
    if (!c || c.indexOf('-----BEGIN') === -1) continue;
    if (salida.indexOf(c) === -1) salida.push(c);
  }
  return salida;
}

/** Comprueba que la llave publica se puede usar de verdad. */
function llaveUtil(pem) {
  try {
    crypto.createPublicKey(pem);
    return true;
  } catch (e) {
    return false;
  }
}

/** El key_id que lleva dentro una licencia, sin necesidad de verificarla. */
function keyIdDeLicencia(texto) {
  try {
    const contenido = moduloLicencias().desarmar(texto).contenido;
    return contenido && contenido.key_id ? String(contenido.key_id) : null;
  } catch (e) {
    return null;
  }
}

/**
 * De todas las variantes, la que corresponde a la licencia que se va a instalar.
 * Devuelve tambien si cuadra o no: una llave que no es la de la licencia deja la
 * instalacion sin poder activarse, y eso hay que decirlo antes de escribir nada.
 */
function elegirLlave(candidatas, keyIdBuscado) {
  const lic = moduloLicencias();
  const usables = candidatas.filter(llaveUtil);
  if (!usables.length) return null;

  if (keyIdBuscado) {
    const exacta = usables.filter((c) => lic.keyId(c) === keyIdBuscado)[0];
    if (exacta) return { pem: exacta, cuadra: true };
    return { pem: usables[0], cuadra: false, buscado: keyIdBuscado, tiene: lic.keyId(usables[0]) };
  }
  return { pem: usables[0], cuadra: null };
}

/** La llave publica, para incrustarla en el .env, tal como la lee el sistema. */
function llaveEnBase64(pem) {
  return Buffer.from(pem, 'utf8').toString('base64');
}

/* ------------------------------------------------------------------ */
/* Plantilla del .env                                                  */
/* ------------------------------------------------------------------ */

/**
 * Lee .env.example como lista de comprobacion: las variables que hay que dejar
 * puestas son exactamente las que estan ahi. Si manana se anade una al ejemplo,
 * este asistente la incluye sin que nadie se acuerde de tocar este archivo.
 */
function leerPlantilla() {
  const ruta = path.join(RAIZ, '.env.example');
  const texto = fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
  const lineas = texto.split('\n');

  // El encabezado del ejemplo ("copie este archivo como .env") no va en un .env
  // ya generado: se empieza despues del primer bloque de comentarios.
  let desde = 0;
  for (let i = 0; i < lineas.length; i++) {
    if (lineas[i].trim() === '') { desde = i + 1; break; }
  }

  return { lineas: lineas.slice(desde) };
}

/** Las variables que docker-compose.yml lee del .env.
 *
 * Se saltan las lineas comentadas: los comentarios del Compose explican el
 * formato con ejemplos ("${VAR:?...}") que no son variables de verdad. */
function variablesDelCompose() {
  const ruta = path.join(RAIZ, 'docker-compose.yml');
  if (!fs.existsSync(ruta)) return [];
  const encontradas = new Set();
  for (const linea of fs.readFileSync(ruta, 'utf8').split('\n')) {
    if (/^\s*#/.test(linea)) continue;
    const patron = /\$\{([A-Z][A-Z0-9_]*)/g;
    let m;
    while ((m = patron.exec(linea)) !== null) encontradas.add(m[1]);
  }
  return Array.from(encontradas);
}

/**
 * Arma el texto del .env: recorre el ejemplo en orden, cambia el valor de las
 * variables que este asistente conoce y respeta el resto (los valores por
 * defecto del ejemplo ya son los buenos). Las que el ejemplo trae comentadas
 * pero el sistema necesita activas se descomentan aqui.
 */
function generarEnv(plantilla, valores, encabezado) {
  const salida = [];
  const puestas = new Set();

  for (const linea of plantilla.lineas) {
    const activa = linea.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (activa && Object.prototype.hasOwnProperty.call(valores, activa[1])) {
      salida.push(activa[1] + '=' + valores[activa[1]]);
      puestas.add(activa[1]);
      continue;
    }
    /* Solo las declaraciones comentadas del ejemplo ("# CLAVE=valor"), no las
       lineas de los comentarios largos, que van con mas sangria. */
    const comentada = linea.match(/^# ?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (comentada && Object.prototype.hasOwnProperty.call(valores, comentada[1])) {
      salida.push(comentada[1] + '=' + valores[comentada[1]]);
      puestas.add(comentada[1]);
      continue;
    }
    salida.push(linea);
  }

  /* Lo que necesita docker-compose.yml y no aparece ni en el ejemplo: sin esto
     el despliegue se detiene diciendo que falta una variable. */
  const extras = Object.keys(valores).filter((k) => !puestas.has(k));
  if (extras.length) {
    salida.push('');
    salida.push('# --- Variables que lee docker-compose.yml ------------------------------');
    for (const k of extras) {
      salida.push(k + '=' + valores[k]);
      puestas.add(k);
    }
  }

  return encabezado.concat(salida).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

/** Lineas de un .env ya escrito: { CLAVE: valor }. */
function leerEnv(ruta) {
  const valores = {};
  if (!fs.existsSync(ruta)) return valores;
  for (const linea of fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const m = linea.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) valores[m[1]] = m[2];
  }
  return valores;
}

/* ------------------------------------------------------------------ */
/* Comprobaciones previas                                              */
/* ------------------------------------------------------------------ */

function comprobarNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 20) {
    falta('Node ' + process.versions.node + ': el sistema necesita Node 20 o superior');
    nota('Instale la version LTS desde https://nodejs.org y vuelva a ejecutar esto.');
    return false;
  }
  bien('Node ' + process.versions.node);
  return true;
}

function comprobarArchivos() {
  const necesarios = [
    ['server.js', 'el servidor del sistema'],
    ['src/config.js', 'la configuracion'],
    ['sql/01-crear.js', 'crear la base del sistema'],
    ['sql/03-vista-ciudadanos.js', 'la vista de cedulas'],
    ['docker-compose.yml', 'el despliegue con Docker'],
    ['Dockerfile', 'la imagen'],
    ['.env.example', 'la lista de variables'],
    ['package.json', 'los comandos'],
  ];

  let faltan = 0;
  for (const [archivo, paraQue] of necesarios) {
    if (fs.existsSync(path.join(RAIZ, archivo))) continue;
    faltan++;
    falta(archivo + ' (hace falta para ' + paraQue + ')');
  }
  if (!faltan) bien('los ' + necesarios.length + ' archivos del sistema estan completos');

  if (!fs.existsSync(path.join(RAIZ, 'node_modules', 'mssql'))) {
    aviso('no estan las dependencias (node_modules): hacen falta solo si va a');
    nota('ejecutar los scripts en este servidor sin Docker. Se instalan con: npm install');
  }

  return faltan === 0;
}

/** Docker no es obligatorio (se puede correr con Node a pelo), pero conviene saberlo. */
function comprobarDocker() {
  try {
    const v = execFileSync('docker', ['--version'], { stdio: 'pipe' }).toString().trim();
    bien(v);
    return true;
  } catch (e) {
    aviso('no se encontro Docker en este servidor');
    nota('Si va a instalar con Docker, instalelo antes de seguir. Si va a correr');
    nota('el sistema con Node directamente, ignore este aviso.');
    return false;
  }
}

/**
 * Lo que exige SQL Server de verdad: ocho caracteres y caracteres de TRES de los
 * cuatro tipos (mayuscula, minuscula, numero y simbolo). Se comprueba aqui
 * porque, si no los cumple, el contenedor de la base se muere en bucle sin decir
 * cual es el motivo, y eso se busca a ciegas.
 */
function revisarClaveSql(clave) {
  const fallos = [];
  if (clave.length < 8) fallos.push('menos de 8 caracteres');
  if (/["']/.test(clave)) fallos.push('con comillas (rompen el .env y los comandos)');

  const tipos = [
    ['mayuscula', /[A-Z]/],
    ['minuscula', /[a-z]/],
    ['numero', /[0-9]/],
    ['simbolo', /[^A-Za-z0-9]/],
  ];
  const faltan = tipos.filter((t) => !t[1].test(clave)).map((t) => t[0]);
  if (faltan.length > 1) {
    fallos.push('necesita tres de los cuatro tipos y le faltan: ' + faltan.join(', '));
  }
  return fallos;
}

/* ------------------------------------------------------------------ */
/* Licencia                                                            */
/* ------------------------------------------------------------------ */

function moduloLicencias() {
  return require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));
}

/** El servidor de licencias del proveedor, con su salud y su llave publica. */
async function comprobarServidorLicencias(direccion) {
  const base = direccion.replace(/\/+$/, '');
  let salud;
  try {
    salud = await pedirJson(base + '/api/salud', null, 8000);
  } catch (e) {
    falta('el servidor de licencias ' + base + ' no responde (' + e.message + ')');
    nota('Compruebe la direccion y que este servidor tenga salida a Internet.');
    nota('Si la institucion no tiene Internet, active con el archivo .vflow.');
    return null;
  }

  if (!salud.ok || !salud.datos || !/licencias/i.test(String(salud.datos.servicio || ''))) {
    falta('en ' + base + ' no hay un servidor de licencias de VisitaFlow (respuesta ' + salud.estado + ')');
    return null;
  }

  const emitidas = Number(salud.datos.licencias_emitidas);
  bien('servidor de licencias en ' + base +
    (Number.isFinite(emitidas) ? ' (' + emitidas + ' licencias emitidas)' : ''));
  if (salud.datos.llave && salud.datos.llave.disponible === false) {
    aviso('ese servidor no tiene su llave privada cargada: no podra emitir ni activar');
  }

  let llave = null;
  try {
    const r = await pedirJson(base + '/api/llave-publica', null, 8000);
    if (r.ok && r.datos && r.datos.llave_publica) llave = String(r.datos.llave_publica);
  } catch (e) { /* sin llave publica: se pedira a mano */ }

  return {
    base: base,
    llavePublica: llave,
    keyId: salud.datos.llave && salud.datos.llave.key_id ? String(salud.datos.llave.key_id) : null,
  };
}

/**
 * Activar por ID... pero aqui, antes de instalar nada. Es la comprobacion que
 * mas disgustos ahorra: si el ID esta mal escrito, es de otro cliente, esta
 * suspendido o ya vencio, se sabe AHORA y no cuando el cliente mira la pantalla
 * de activacion con el sistema ya levantado.
 */
async function comprobarId(base, id) {
  let r;
  try {
    r = await pedirJson(
      base + '/api/licencia/activar-por-id',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licencia_id: id }) },
      10000
    );
  } catch (e) {
    falta('no se pudo preguntar por el ID ' + id + ': ' + e.message);
    return null;
  }

  if (!r.ok || !r.datos || !r.datos.licencia) {
    const motivo = (r.datos && (r.datos.mensaje || r.datos.motivo)) || ('respuesta ' + r.estado);
    falta('el servidor no acepta el ID ' + id + ': ' + motivo);
    return null;
  }

  bien('el ID ' + id + ' existe y esta activo' +
    (r.datos.cliente ? ': ' + r.datos.cliente : '') +
    (r.datos.hasta ? ', vence el ' + String(r.datos.hasta).slice(0, 10) : ''));
  if (Array.isArray(r.datos.modulos) && r.datos.modulos.length) {
    nota('modulos: ' + r.datos.modulos.join(', '));
  }
  return r.datos;
}

/** Lee un archivo .vflow y comprueba su firma con la llave publica. */
function comprobarVflow(ruta, pem) {
  if (!fs.existsSync(ruta)) {
    falta('no existe el archivo ' + ruta);
    return null;
  }
  const texto = fs.readFileSync(ruta, 'utf8');
  const revision = moduloLicencias().evaluar(texto, { llavePublica: pem });
  if (!revision.contenido) {
    falta('el archivo ' + path.basename(ruta) + ' no sirve: ' + revision.motivo);
    return null;
  }
  if (!revision.valida) {
    aviso('el archivo ' + path.basename(ruta) + ' tiene la firma bien pero: ' + revision.motivo);
  } else {
    bien('el archivo ' + path.basename(ruta) + ' es valido: ' +
      revision.contenido.cliente + ' (' + revision.contenido.tenant + '), vence el ' +
      String(revision.contenido.hasta).slice(0, 10));
  }
  return { texto: texto, revision: revision };
}

/**
 * La llave publica: primero la que trae la carpeta, despues la que anuncia el
 * servidor de licencias, y si no hay ninguna, se le pide a quien instala. En los
 * tres casos se elige la variante que cuadra con la licencia: una llave de otra
 * pareja deja el sistema sin poder activarse.
 */
async function obtenerLlavePublica(lector, servidor, textoLicencia) {
  const candidatas = [];
  let origen = null;

  const archivo = path.join(RAIZ, 'licencias-keys', 'publica.pem');
  if (fs.existsSync(archivo)) {
    candidatas.push(fs.readFileSync(archivo, 'utf8'));
    origen = 'licencias-keys/publica.pem';
  }
  if (servidor && servidor.llavePublica) {
    for (const c of variantesLlave(servidor.llavePublica)) candidatas.push(c);
    if (!origen) origen = 'el servidor de licencias';
  }

  const buscado = keyIdDeLicencia(textoLicencia) || (servidor ? servidor.keyId : null);
  let eleccion = elegirLlave(candidatas, buscado);

  if (eleccion && eleccion.cuadra === false) {
    /* El fallo mas caro de todos: se instala todo, el cliente escribe su ID y el
       sistema dice que la licencia es de otra llave. */
    falta('la llave publica de ' + origen + ' no es la de esta licencia');
    nota('la licencia es de la llave ' + eleccion.buscado + ' y esa llave es la ' + eleccion.tiene);
    nota('Pida al proveedor la llave publica que corresponde a su servidor de licencias.');
    eleccion = null;
  }

  if (eleccion && eleccion.pem) {
    const id = moduloLicencias().keyId(eleccion.pem);
    if (eleccion.cuadra === true) bien('llave publica de ' + origen + ' comprobada (key_id ' + id + ')');
    else bien('llave publica de ' + origen + ' (key_id ' + id + ')');
    return eleccion.pem;
  }

  aviso('no hay ninguna llave publica que sirva para esta instalacion');
  nota('Es la llave con la que el sistema comprueba que su licencia es autentica.');
  nota('Pida al proveedor el archivo publica.pem, o pegue su contenido aqui.');

  for (let intento = 0; intento < 3; intento++) {
    const pegado = await lector.preguntar('  Pegue la llave publica (empieza por -----BEGIN): ');
    const intento2 = elegirLlave(variantesLlave(pegado), buscado);
    if (intento2 && intento2.pem && intento2.cuadra !== false) {
      bien('llave publica aceptada (key_id ' + moduloLicencias().keyId(intento2.pem) + ')');
      return intento2.pem;
    }
    if (intento2 && intento2.cuadra === false) {
      falta('esa llave es la ' + intento2.tiene + ' y la licencia es de la ' + intento2.buscado);
      continue;
    }
    falta('eso no es una llave publica valida');
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* INSTALACION.txt                                                     */
/* ------------------------------------------------------------------ */

/** Fecha y hora de este servidor, para que el documento diga cuando se hizo. */
function fechaLocal() {
  const ahora = new Date();
  const dos = (n) => String(n).padStart(2, '0');
  return ahora.getFullYear() + '-' + dos(ahora.getMonth() + 1) + '-' + dos(ahora.getDate()) +
    ' ' + dos(ahora.getHours()) + ':' + dos(ahora.getMinutes());
}

function textoInstalacion(datos) {
  const L = [];
  const app = 'visitaflow-app';
  const bd = 'visitaflow-bd';

  L.push('VisitaFlow - instalacion en este servidor');
  L.push('='.repeat(64));
  L.push('');
  L.push('  Cliente      : ' + (datos.cliente || '(se vera al activar)'));
  L.push('  Institucion  : ' + (datos.tenant || '(se crea al activar)'));
  L.push('  Direccion    : ' + datos.urlPublica);
  L.push('  Instalacion  : ' + (datos.esProveedor
    ? 'del proveedor (este servidor tambien emite licencias)'
    : 'de cliente (el servidor de licencias es el del proveedor)'));
  L.push('  Licencia     : ' + datos.licencia);
  L.push('  Base sistema : ' + datos.baseDatos + ' (usuario sa)');
  L.push('  Cedulas      : ' + datos.cedulas);
  L.push('');
  L.push('  Preparado el ' + new Date().toLocaleString('es-DO') + ' por scripts/instalar-cliente.js');
  L.push('');
  L.push('  El archivo .env de esta carpeta ya tiene TODOS los valores, incluidos los');
  L.push('  secretos. NO hace falta editar nada. Nadie mas deberia ver ese archivo.');
  L.push('');

  L.push('-'.repeat(64));
  L.push('PASO 1 - Levantar el sistema');
  L.push('-'.repeat(64));
  L.push('');
  if (datos.esProveedor) {
    L.push('  docker compose up -d');
  } else {
    L.push('  docker compose up -d bd-sistema app --no-deps');
    L.push('');
    L.push('  El "licencias" no se levanta: en una instalacion de cliente el servidor de');
    L.push('  licencias es el del proveedor. El --no-deps evita que Docker lo arranque.');
  }
  L.push('');
  L.push('  La primera vez tarda un par de minutos: SQL Server tiene que arrancar.');
  L.push('  Espere a que la base conteste antes de seguir (repita el comando hasta que');
  L.push('  devuelva un 1):');
  L.push('');
  L.push('    docker exec -it ' + bd + ' /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "' +
    datos.claveSql + '" -C -Q "SELECT 1"');
  L.push('');

  L.push('-'.repeat(64));
  L.push('PASO 2 - Crear la base del sistema (tarda unos segundos)');
  L.push('-'.repeat(64));
  L.push('');
  L.push('  docker exec -it ' + app + ' node sql/01-crear.js');
  L.push('');

  if (datos.bakPadron) {
    L.push('-'.repeat(64));
    L.push('PASO 3 - Las cedulas (la parte pesada, se hace una sola vez)');
    L.push('-'.repeat(64));
    L.push('');
    L.push('  docker cp "' + datos.bakPadron + '" ' + bd + ':/var/opt/mssql/backup/PadronLigero.bak');
    L.push('');
    L.push('  docker exec -it ' + bd + ' /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "' +
      datos.claveSql + '" -C -Q "RESTORE DATABASE PadronLigero FROM DISK = ' +
      "'/var/opt/mssql/backup/PadronLigero.bak' WITH MOVE 'PadronLigero' TO " +
      "'/var/opt/mssql/data/PadronLigero.mdf', MOVE 'PadronLigero_log' TO " +
      '\'/var/opt/mssql/data/PadronLigero_log.ldf\', REPLACE"');
    L.push('');
    L.push('  docker exec -it ' + app + ' node sql/03-vista-ciudadanos.js');
    L.push('');
    L.push('  Sin la vista del ultimo comando, buscar una cedula tarda segundos en vez');
    L.push('  de milisegundos.');
    L.push('');
  } else {
    L.push('-'.repeat(64));
    L.push('PASO 3 - Las cedulas (no las tiene en este servidor)');
    L.push('-'.repeat(64));
    L.push('');
    L.push('  El sistema queda configurado con PADRON_ACTIVO=0: funciona igual, pero');
    L.push('  los nombres no se rellenan solos al escribir la cedula.');
    L.push('');
    L.push('  Cuando tenga el respaldo (PadronLigero.bak, unos 274 MB), dejelo en esta');
    L.push('  carpeta y ejecute estos cuatro comandos, en este orden:');
    L.push('');
    L.push('    1. Ponga PADRON_ACTIVO=1 en el archivo .env de esta carpeta');
    L.push('    2. docker cp PadronLigero.bak ' + bd + ':/var/opt/mssql/backup/PadronLigero.bak');
    L.push('    3. docker exec -it ' + bd + ' /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "' +
      datos.claveSql + '" -C -Q "RESTORE DATABASE PadronLigero FROM DISK = ' +
      "'/var/opt/mssql/backup/PadronLigero.bak' WITH MOVE 'PadronLigero' TO " +
      "'/var/opt/mssql/data/PadronLigero.mdf', MOVE 'PadronLigero_log' TO " +
      '\'/var/opt/mssql/data/PadronLigero_log.ldf\', REPLACE"');
    L.push('    4. docker exec -it ' + app + ' node sql/03-vista-ciudadanos.js');
    L.push('       docker compose restart app');
    L.push('');
    L.push('  Si su respaldo trae otros nombres de archivo logicos, cambie los dos ultimos');
    L.push('  valores del MOVE. Los ve con: RESTORE FILELISTONLY FROM DISK = ...');
    L.push('');
  }

  L.push('-'.repeat(64));
  L.push('PASO 4 - Reiniciar para que arranque con todo listo');
  L.push('-'.repeat(64));
  L.push('');
  L.push('  docker compose restart app');
  L.push('');
  L.push('  En este arranque el sistema crea su institucion, sus catalogos y el');
  L.push('  administrador. Si no lo hace, revise los avisos con:');
  L.push('  docker compose logs app');
  L.push('');

  L.push('-'.repeat(64));
  L.push('PASO 5 - Activar la licencia');
  L.push('-'.repeat(64));
  L.push('');
  if (datos.id) {
    L.push('  Abra ' + datos.urlPublica + ' y escriba el ID cuando lo pida:');
    L.push('');
    L.push('      ' + datos.id);
    L.push('');
    L.push('  Solo hace falta la primera vez.');
  } else if (datos.rutaVflow) {
    L.push('  Active con el archivo que le entrego el proveedor:');
    L.push('');
    L.push('      docker cp "' + datos.rutaVflow + '" ' + app + ':/app/datos/licencia.vflow');
    L.push('      docker compose restart app');
    L.push('');
    L.push('  (Tambien puede abrir ' + datos.urlPublica + ' y pegar el contenido del');
    L.push('  archivo .vflow en la pantalla de activacion).');
  } else {
    L.push('  Abra ' + datos.urlPublica + '. Como no hay licencia, el sistema muestra la');
    L.push('  pantalla de activacion: pegue ahi el contenido del archivo .vflow que le');
    L.push('  entrego el proveedor y pulse Activar.');
    L.push('');
    L.push('  Si prefiere dejarlo en el servidor, para que se active solo al arrancar:');
    L.push('');
    L.push('      docker cp licencia.vflow ' + app + ':/app/datos/licencia.vflow');
    L.push('      docker compose restart app');
  }
  L.push('');

  L.push('-'.repeat(64));
  L.push('PASO 6 - La clave del administrador');
  L.push('-'.repeat(64));
  L.push('');
  L.push('  docker exec -it ' + app + ' cat /app/datos/CLAVE-ADMINISTRADOR.txt');
  L.push('');
  L.push('  Anotela, entre al sistema y cambiela (Usuarios). Despues borre ese archivo.');
  L.push('  Si se pierde, se restablece con:');
  L.push('  docker exec -it ' + app + ' node scripts/restablecer-admin.js');
  L.push('');

  L.push('-'.repeat(64));
  L.push('PASO 7 - Comprobar que quedo bien');
  L.push('-'.repeat(64));
  L.push('');
  L.push('  npm run comprobar:instalacion');
  L.push('');
  L.push('  Dice si responde la aplicacion, si estan la base y las cedulas, si la');
  L.push('  licencia esta activa y si hay administrador. Cada fallo trae su arreglo.');
  L.push('');

  L.push('-'.repeat(64));
  L.push('EL DOMINIO');
  L.push('-'.repeat(64));
  L.push('');
  L.push('  El sistema escucha en el puerto 3000. Para que se llegue a el desde');
  L.push('  ' + datos.urlPublica + ', ponga delante un proxy con HTTPS (Dokploy + Traefik');
  L.push('  lo hace solo) apuntando al puerto 3000, y apunte el DNS a la IP de este');
  L.push('  servidor.');
  if (!/^https:/.test(datos.urlPublica)) {
    L.push('');
    L.push('  Cuando tenga el certificado, cambie URL_PUBLICA en el .env a la direccion');
    L.push('  con https:// y ejecute: docker compose restart app');
  }
  L.push('');

  if (!datos.esProveedor) {
    L.push('-'.repeat(64));
    L.push('SI ALGO VA MAL');
    L.push('-'.repeat(64));
    L.push('');
    L.push('  - El contenedor "' + app + '" se reinicia: docker compose logs app');
    L.push('  - El contenedor "visitaflow-licencias" se reinicia: NO se usa en una');
    L.push('    instalacion de cliente. Parese con: docker compose stop licencias');
    L.push('  - La activacion dice que no hay servidor de licencias: revise');
    L.push('    LICENCIA_SERVIDOR en el .env (es la direccion publica del proveedor).');
    L.push('  - Sin Internet: active con el archivo .vflow que le entrego el proveedor.');
    L.push('');
  }

  L.push('-'.repeat(64));
  L.push('LO QUE NO SE PUEDE PERDER');
  L.push('-'.repeat(64));
  L.push('');
  L.push('  - El archivo .env: tiene los secretos de esta instalacion.');
  L.push('  - El volumen datos-sql: es la base de datos entera.');
  L.push('  - El volumen datos-app: la licencia y las credenciales del administrador.');
  L.push('');
  L.push('  Copia de seguridad de la base del sistema:');
  L.push('    docker exec -it ' + bd + ' /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "' +
    datos.claveSql + '" -C -Q "BACKUP DATABASE ' + datos.baseDatos +
    " TO DISK = '/var/opt/mssql/backup/" + datos.baseDatos + ".bak' WITH COMPRESSION\"");
  L.push('    docker cp ' + bd + ':/var/opt/mssql/backup/' + datos.baseDatos + '.bak .');
  L.push('');
  L.push('  Y bajela a otra maquina: un respaldo que solo vive en este servidor no es');
  L.push('  un respaldo, es el mismo disco.');
  L.push('');

  L.push('-'.repeat(64));
  L.push('SI NO VA A USAR DOCKER EN ESTE SERVIDOR');
  L.push('-'.repeat(64));
  L.push('');
  L.push('  El sistema tambien corre directamente con Node, contra un SQL Server que');
  L.push('  ya tenga instalado (el .env apunta a localhost:1433):');
  L.push('');
  L.push('    npm install');
  L.push('    npm run db:crear');
  L.push('    npm start');
  L.push('');
  L.push('  Guia completa, paso a paso: DESPLIEGUE.md');
  L.push('');

  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* Principal                                                           */
/* ------------------------------------------------------------------ */

function imprimirAyuda() {
  console.log('');
  console.log('  VisitaFlow - instalacion en el servidor de un cliente');
  console.log('  ' + '='.repeat(66));
  console.log('');
  console.log('    npm run instalar:cliente');
  console.log('');
  console.log('  Pregunta lo indispensable y deja el .env y el INSTALACION.txt listos.');
  console.log('');
  console.log('  Opciones (ninguna hace falta para una instalacion normal):');
  console.log('    --carpeta <ruta>     donde dejar el .env y el INSTALACION.txt');
  console.log('                         (por defecto, esta misma carpeta)');
  console.log('    --basedatos <nombre> nombre de la base del sistema (por defecto VisitaFlow)');
  console.log('    --ayuda              esto mismo');
  console.log('');
}

function analizarArgumentos(lista) {
  const a = { carpeta: null, basedatos: null, ayuda: false };
  for (let i = 0; i < lista.length; i++) {
    const x = lista[i];
    if (x === '--ayuda' || x === '--help' || x === '-h') a.ayuda = true;
    else if (x === '--carpeta') a.carpeta = lista[++i];
    else if (x === '--basedatos') a.basedatos = lista[++i];
    else throw new Error('opcion desconocida: ' + x + ' (vea --ayuda)');
  }
  if (a.carpeta === undefined || a.carpeta === null) a.carpeta = null;
  if (a.basedatos === undefined || a.basedatos === null) a.basedatos = null;
  if (lista.indexOf('--carpeta') !== -1 && !a.carpeta) throw new Error('--carpeta necesita una ruta');
  if (lista.indexOf('--basedatos') !== -1 && !a.basedatos) throw new Error('--basedatos necesita un nombre');
  if (a.basedatos && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(a.basedatos)) {
    throw new Error('el nombre de la base solo admite letras, numeros y guion bajo');
  }
  return a;
}

async function principal() {
  const args = analizarArgumentos(process.argv.slice(2));
  if (args.ayuda) { imprimirAyuda(); return 0; }

  const lector = crearLector();
  const carpeta = args.carpeta ? path.resolve(args.carpeta) : RAIZ;
  const baseDatos = args.basedatos || 'VisitaFlow';

  console.log('');
  console.log('  ' + C.blanco + 'VisitaFlow - instalar en el servidor' + C.reset);
  console.log('  ' + C.gris + '='.repeat(66) + C.reset);
  console.log('  ' + C.gris + 'Son cuatro cosas: la licencia, la direccion, la clave de SQL Server' + C.reset);
  console.log('  ' + C.gris + 'y si tiene el archivo de cedulas. Todo lo demas lo hace este programa:' + C.reset);
  console.log('  ' + C.gris + 'los secretos se inventan y el .env se escribe completo.' + C.reset);

  if (carpeta !== RAIZ) nota('El .env y el INSTALACION.txt se van a escribir en: ' + carpeta);

  /* 1. Lo que se puede saber sin preguntar nada. */
  titulo('1. Este servidor');
  const nodeOk = comprobarNode();
  const archivosOk = comprobarArchivos();
  comprobarDocker();

  if (!nodeOk || !archivosOk) {
    console.log('');
    console.log('  ' + C.rojo + 'No se puede seguir: falta algo de lo de arriba.' + C.reset);
    console.log('  ' + C.rojo + 'No se ha escrito ningun archivo.' + C.reset);
    lector.cerrar();
    return 1;
  }

  /* 2. Que se instala y como se activa. */
  titulo('2. Tipo de instalacion');

  const hayPrivada = fs.existsSync(path.join(RAIZ, 'licencias-keys', 'privada.pem'));
  const tipo = await lector.preguntar(
    '  ¿Esta instalacion es de un CLIENTE (1) o del PROVEEDOR, que ademas emite\n' +
    '  licencias (2)?' + (hayPrivada ? ' [2] ' : ' [1] '),
    hayPrivada ? '2' : '1'
  );
  const esProveedor = tipo.trim() === '2';

  if (esProveedor && !hayPrivada) {
    falta('no hay llave privada en licencias-keys/privada.pem');
    nota('Solo el servidor del proveedor emite licencias. Copie ahi el par de llaves');
    nota('(npm run keys:gen) o instale como cliente.');
    lector.cerrar();
    return 1;
  }
  bien(esProveedor ? 'instalacion del proveedor (emite licencias)' : 'instalacion de cliente');

  titulo('3. La licencia');

  const conInternet = await lector.siNo(
    '  ¿Este servidor tiene salida a Internet, para activar con el ID?',
    true
  );

  let servidor = null;
  let id = null;
  let licenciaTexto = null;
  let datosLicencia = null;
  let rutaVflow = null;

  if (!conInternet) {
    /* Sin Internet no hay servidor que consultar: el unico camino es el archivo. */
    for (let intento = 0; intento < 3 && !rutaVflow; intento++) {
      const r = await lector.preguntar('  Ruta del archivo .vflow que le entrego el proveedor: ');
      if (!r) {
        aviso('sin archivo: la activacion se hara pegando el .vflow en la pantalla del sistema');
        break;
      }
      const candidato = path.resolve(r.replace(/^"|"$/g, ''));
      if (!fs.existsSync(candidato)) {
        falta('no existe ' + candidato);
        continue;
      }
      rutaVflow = candidato;
      /* Se lee ya, antes de la llave publica: dentro del archivo esta el key_id
         que dice CUAL llave publica hace falta. Sin eso habria que adivinar. */
      licenciaTexto = fs.readFileSync(candidato, 'utf8');
    }
  } else {
    for (let intento = 0; intento < 3; intento++) {
      const idEscrito = (await lector.preguntar('  ID de licencia (LIC-XXXXXXXX): ')).toUpperCase();
      if (!/^LIC-[A-Z0-9]{4,16}$/.test(idEscrito)) {
        falta('"' + idEscrito + '" no tiene el formato de un ID (LIC- seguido de letras y numeros)');
        continue;
      }
      id = idEscrito;
      break;
    }

    for (let intento = 0; intento < 3 && !servidor; intento++) {
      const direccion = await lector.preguntar(
        '  Direccion del servidor de licencias del proveedor (ej: https://licencias.su-proveedor.com): '
      );
      if (!/^https?:\/\/.+/i.test(direccion)) {
        falta('escriba la direccion completa, con http:// o https://');
        continue;
      }
      servidor = await comprobarServidorLicencias(direccion);
    }

    if (servidor && id) {
      datosLicencia = await comprobarId(servidor.base, id);
      if (datosLicencia) {
        licenciaTexto = datosLicencia.licencia;
      } else {
        /* Un ID que el servidor no acepta deja la instalacion sin activar. Mejor
           parar aqui que entregar un sistema que no va a poder activarse. */
        console.log('');
        console.log('  ' + C.rojo + 'Con ese ID el sistema no se podria activar.' + C.reset);
        console.log('  ' + C.rojo + 'Pida al proveedor un ID valido y vuelva a ejecutar esto.' + C.reset);
        lector.cerrar();
        return 1;
      }
    }

    /* Sin ID comprobado o sin servidor de licencias, la activacion por Internet
       no puede funcionar: es justo lo que hay que descubrir antes de instalar,
       no despues, con el cliente mirando la pantalla de activacion. */
    if (!id || !servidor) {
      console.log('');
      console.log('  ' + C.rojo + 'Sin un ID valido y su servidor de licencias no se puede activar.' + C.reset);
      console.log('  ' + C.rojo + 'Vuelva a ejecutar esto, y si la institucion no tiene Internet,' + C.reset);
      console.log('  ' + C.rojo + 'active con el archivo .vflow que le entregue el proveedor.' + C.reset);
      lector.cerrar();
      return 1;
    }
  }

  /* 4. La llave publica: sin ella el sistema no acepta ninguna licencia. */
  const pem = await obtenerLlavePublica(lector, servidor, licenciaTexto);
  if (!pem) {
    console.log('');
    console.log('  ' + C.rojo + 'Sin la llave publica del proveedor no se puede instalar.' + C.reset);
    console.log('  ' + C.rojo + 'Pidala (es el archivo publica.pem) y vuelva a ejecutar esto.' + C.reset);
    lector.cerrar();
    return 1;
  }

  /* Y ahora que hay llave, se comprueba la licencia de verdad: la firma tiene que
     cuadrar con ESTA llave. Es el fallo que nadie ve hasta que el cliente intenta
     activar: llave publica de una pareja y licencia firmada con otra. */
  if (licenciaTexto) {
    const revision = moduloLicencias().evaluar(licenciaTexto, { llavePublica: pem });
    if (!revision.contenido) {
      falta('la licencia del servidor no cuadra con esa llave publica: ' + revision.motivo);
      nota('Pida al proveedor la llave publica que corresponde a su servidor de licencias.');
      lector.cerrar();
      return 1;
    }
    bien('la licencia y la llave publica son de la misma pareja' +
      (revision.valida ? '' : ' (atencion: ' + revision.motivo + ')'));
  }
  if (rutaVflow) {
    const leida = comprobarVflow(rutaVflow, pem);
    if (!leida) {
      lector.cerrar();
      return 1;
    }
    licenciaTexto = leida.texto;
    datosLicencia = { cliente: leida.revision.contenido.cliente, tenant: leida.revision.contenido.tenant, hasta: leida.revision.contenido.hasta };
  }

  /* 5. Donde va a quedar y con que clave. */
  titulo('4. La direccion y la base de datos');

  let urlPublica = 'http://localhost:3000';
  for (let intento = 0; intento < 3; intento++) {
    const escrita = await lector.preguntar(
      '  ¿En que dominio o direccion va a quedar el sistema? (ej: https://visitas.junta-los-prados.org): '
    );
    if (!escrita) {
      aviso('sin direccion, el sistema solo sera alcanzable desde este servidor');
      nota('Cuando la tenga, cambie URL_PUBLICA en el .env y reinicie: docker compose restart app');
      break;
    }
    const candidata = normalizarDireccion(escrita);
    if (!direccionValida(candidata)) {
      falta('"' + escrita + '" no parece una direccion (ej: https://visitas.junta-los-prados.org)');
      continue;
    }
    urlPublica = candidata;
    break;
  }
  bien('direccion publica: ' + urlPublica);
  if (/^http:\/\//.test(urlPublica) && !/localhost|127\.0\.0\.1/.test(urlPublica)) {
    aviso('sin HTTPS: las contrasenas viajan sin cifrar. El certificado lo pone el');
    nota('proxy (Dokploy + Traefik). Cuando lo tenga, ponga la direccion con https://');
    nota('en URL_PUBLICA y reinicie: docker compose restart app');
  }

  let claveSql = '';
  for (let intento = 0; intento < 3; intento++) {
    claveSql = await lector.preguntarOculto(
      '  Contrasena para SQL Server (usuario sa, al menos 8 caracteres y tres de\n' +
      '  estos cuatro tipos: mayuscula, minuscula, numero y simbolo): '
    );
    const fallos = revisarClaveSql(claveSql);
    if (!fallos.length) break;
    falta('esa contrasena no la acepta SQL Server: ' + fallos.join(', '));
    /* SQL Server se muere en bucle si la clave no cumple su politica y no dice
       cual es el motivo: por eso se insiste aqui. */
    if (intento === 2) {
      console.log('');
      console.log('  ' + C.rojo + 'Sin una contrasena valida, la base no arrancaria.' + C.reset);
      lector.cerrar();
      return 1;
    }
  }
  bien('contrasena de SQL Server aceptada (no se muestra, queda en el .env)');

  /* 6. El padron. */
  titulo('5. La base de cedulas');

  let bakPadron = null;
  const tienePadron = await lector.siNo(
    '  ¿Tiene en este servidor el archivo del padron de cedulas (PadronLigero.bak, unos 274 MB)?',
    false
  );

  if (tienePadron) {
    for (let intento = 0; intento < 3; intento++) {
      const escrita = await lector.preguntar('  Ruta del archivo .bak: ');
      const candidato = path.resolve(String(escrita || '').replace(/^"|"$/g, ''));
      if (!fs.existsSync(candidato)) {
        falta('no existe ' + candidato);
        continue;
      }
      const mb = Math.round(fs.statSync(candidato).size / 1024 / 1024);
      if (mb < 1) {
        falta('ese archivo pesa ' + mb + ' MB: no parece un respaldo de la base');
        continue;
      }
      if (mb < 100) aviso('el respaldo pesa ' + mb + ' MB; el padron completo son unos 274 MB');
      else bien('respaldo de cedulas: ' + mb + ' MB');
      bakPadron = candidato;
      break;
    }
    if (!bakPadron) {
      aviso('sin respaldo: el sistema se instala sin cedulas (PADRON_ACTIVO=0)');
      nota('Se pueden anadir despues: vea el PASO 3 del INSTALACION.txt');
    }
  } else {
    aviso('sin cedulas: el sistema funciona, pero los nombres no se rellenan solos');
  }

  /* 7. Lo que se va a escribir. */
  titulo('6. Resumen');

  const secretos = { jwt: nuevoSecreto(), admin: nuevoSecreto() };
  const licenciaResumen = id
    ? 'ID ' + id + ' contra ' + (servidor ? servidor.base : '(servidor de licencias)')
    : (rutaVflow ? 'archivo ' + path.basename(rutaVflow) : 'se pega el .vflow en la pantalla de activacion');

  dato('Se instala', esProveedor ? 'el sistema y el servidor de licencias' : 'el sistema de visitantes');
  dato('Se activa con', licenciaResumen);
  if (datosLicencia && datosLicencia.cliente) dato('Cliente', datosLicencia.cliente);
  if (datosLicencia && datosLicencia.tenant) dato('Institucion', datosLicencia.tenant);
  if (datosLicencia && datosLicencia.hasta) dato('Vence', String(datosLicencia.hasta).slice(0, 10));
  dato('Direccion', urlPublica);
  dato('Base del sistema', baseDatos + ' en localhost:1433 (usuario sa)');
  dato('Cedulas', bakPadron ? 'si: ' + bakPadron : 'no (PADRON_ACTIVO=0)');
  dato('Archivos', path.join(carpeta, '.env') + '  y  INSTALACION.txt');

  const seguir = await lector.siNo('  ¿Escribo estos archivos?', true);
  if (!seguir) {
    console.log('  ' + C.ambar + 'Cancelado. No se ha escrito nada.' + C.reset);
    lector.cerrar();
    return 1;
  }

  /* 8. Escribir. El .env puede tener la configuracion de produccion de alguien:
     nunca se pisa sin preguntar. */
  const rutaEnv = path.join(carpeta, '.env');
  if (fs.existsSync(rutaEnv)) {
    const antes = leerEnv(rutaEnv);
    console.log('');
    aviso('ya existe un .env en ' + carpeta);
    nota('  Direccion que tiene ahora : ' + (antes.URL_PUBLICA || '(sin definir)'));
    nota('  Base que tiene ahora      : ' + (antes.DB_SERVER || 'localhost') + ' / ' + (antes.DB_DATABASE || '(sin definir)'));
    nota('  Si es la configuracion de produccion de este servidor, NO la pise:');
    nota('  se perderia la clave de SQL y habria que volver a crear la base.');
    const pisar = await lector.siNo('  ¿Seguro que quiere sobrescribir ese .env?', false);
    if (!pisar) {
      console.log('');
      console.log('  ' + C.ambar + 'No se toco el .env. No se ha escrito nada.' + C.reset);
      lector.cerrar();
      return 1;
    }
    fs.copyFileSync(rutaEnv, rutaEnv + '.antes-de-instalar');
    nota('  Se guardo copia en .env.antes-de-instalar');
  }

  fs.mkdirSync(carpeta, { recursive: true });

  const datos = path.join(carpeta, 'datos');
  const rutaDatos = (nombre) => (carpeta === RAIZ ? './datos/' + nombre : path.join(datos, nombre));

  const valores = {
    PORT: '3000',
    HOST: '0.0.0.0',
    NODE_ENV: 'production',
    DETRAS_DE_PROXY: '1',
    URL_PUBLICA: urlPublica,

    DB_SERVER: 'localhost',
    DB_PORT: '1433',
    DB_USER: 'sa',
    DB_PASSWORD: claveSql,
    DB_DATABASE: baseDatos,
    DB_ENCRYPT: '0',
    DB_TRUST_CERT: '1',
    CLAVE_SQL: claveSql,

    PADRON_ACTIVO: bakPadron ? '1' : '0',
    PADRON_DB_SERVER: 'localhost',
    PADRON_DB_PORT: '1433',
    PADRON_DB_USER: 'sa',
    PADRON_DB_PASSWORD: claveSql,
    PADRON_DATABASE: 'PadronLigero',
    PADRON_TABLA: 'dbo.CIUDADANOS',
    PADRON_MS_ESPERA: '15000',

    IDENTIDAD_MOSTRAR_NOMBRES: '1',
    IDENTIDAD_MOSTRAR_FECHA_NACIMIENTO: '1',
    IDENTIDAD_MOSTRAR_SEXO: '1',
    IDENTIDAD_MOSTRAR_MUNICIPIO: '1',
    IDENTIDAD_EXIGIR_EN_PADRON: '0',
    IDENTIDAD_EDAD_MINIMA: '0',

    JWT_SECRET: secretos.jwt,
    JWT_EXPIRA: '12h',
    SESION_MINUTOS_INACTIVIDAD: '0',
    ADMIN_TOKEN: secretos.admin,

    LICENCIA_ARCHIVO: rutaDatos('licencia.vflow'),
    LICENCIA_DIAS_AVISO: '30',
    LICENCIA_SERVIDOR: servidor ? servidor.base : '',
    LICENCIA_SERVIDOR_URL: servidor ? servidor.base : '',
    LICENCIA_TOKEN_ACTIVACION: '',
    LICENCIA_HORAS_SIN_SERVIDOR: '72',
    LICENCIA_LLAVE_PUBLICA_B64: llaveEnBase64(pem),

    ARCHIVOS_CARPETA: rutaDatos('archivos'),
    ARCHIVOS_MAX_LOGO_BYTES: '2097152',

    CORREO_ACTIVO: '0',
    MAIL_FROM: 'VisitaFlow <no-responder@visitaflow.local>',
    AUDITORIA_ACTIVA: '1',
    AUDITORIA_DIAS_RETENCION: '730',
  };

  if (carpeta !== RAIZ) valores.DATOS_CARPETA = datos;

  /* La llave privada solo va en el servidor del proveedor. En el de un cliente,
     la variable lleva un texto que deja claro que ahi no hay llave: el Compose
     la exige para arrancar, pero ese servicio no se usa. */
  if (esProveedor) {
    valores.LICENCIA_LLAVE_PRIVADA_B64 = fs
      .readFileSync(path.join(RAIZ, 'licencias-keys', 'privada.pem'))
      .toString('base64');
  } else {
    valores.LICENCIA_LLAVE_PRIVADA_B64 = SIN_LLAVE_PRIVADA;
  }

  const encabezado = [
    '# ============================================================================',
    '# VisitaFlow - configuracion de esta instalacion',
    '# ============================================================================',
    '# Escrito por: npm run instalar:cliente   (' + fechaLocal() + ')',
    '# Instalacion: ' + (esProveedor ? 'del proveedor (emite licencias)' : 'de cliente'),
    '# Activacion : ' + licenciaResumen,
    '#',
    '# Este archivo tiene los secretos de ESTA instalacion: no lo suba a ningun',
    '# repositorio ni lo mande por correo. Los pasos que quedan por dar estan en',
    '# INSTALACION.txt, en esta misma carpeta.',
  ];

  if (!esProveedor) {
    /* Quien mire el archivo va a ver un texto raro en la llave privada: mejor
       explicarlo aqui que dejar que lo "arregle". */
    encabezado.push('#');
    encabezado.push('# En una instalacion de cliente el servidor de licencias es el del');
    encabezado.push('# proveedor, asi que aqui NO hay llave privada: el servicio "licencias"');
    encabezado.push('# del docker-compose.yml no se usa y no hay que levantarlo.');
  }
  encabezado.push('');

  const plantilla = leerPlantilla();
  const textoEnv = generarEnv(plantilla, valores, encabezado);

  /* Antes de escribir: nada de valores de ejemplo, ni una variable obligatoria
     sin poner. Un .env a medias se descubre con el sistema a medio arrancar. */
  const escritas = {};
  for (const linea of textoEnv.split('\n')) {
    const m = linea.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) escritas[m[1]] = m[2];
  }

  const enBlanco = COMPOSE_OBLIGATORIAS.filter((k) => !escritas[k]);
  const deEjemplo = Object.keys(escritas).filter((k) => /cambie|cambiar_en_el_vps/i.test(escritas[k]));
  const delCompose = variablesDelCompose().filter((k) => !Object.prototype.hasOwnProperty.call(escritas, k));

  if (enBlanco.length || deEjemplo.length || delCompose.length) {
    if (enBlanco.length) falta('.env sin estas variables obligatorias: ' + enBlanco.join(', '));
    if (deEjemplo.length) falta('.env con valores de ejemplo en: ' + deEjemplo.join(', '));
    if (delCompose.length) {
      /* Se avisa en vez de fallar: el Compose tiene valores por defecto para
         varias de ellas, asi que no todas impiden arrancar. */
      aviso('docker-compose.yml lee variables que no estan en el .env: ' + delCompose.join(', '));
    }
    if (enBlanco.length || deEjemplo.length) {
      console.log('');
      console.log('  ' + C.rojo + 'No se escribio nada: el .env habria quedado incompleto.' + C.reset);
      lector.cerrar();
      return 1;
    }
  }

  fs.writeFileSync(rutaEnv, textoEnv, { encoding: 'utf8', mode: 0o600 });
  bien('escrito ' + rutaEnv + ' (' + Object.keys(escritas).length + ' variables)');

  /* El .vflow, si lo trajo: se deja junto a los datos para que el PASO 5 sea un
     docker cp y no haya que volver a pedir el archivo. */
  let vflowEnDatos = null;
  if (rutaVflow) {
    try {
      fs.mkdirSync(datos, { recursive: true });
      const destino = path.join(datos, 'licencia.vflow');
      if (path.resolve(rutaVflow) !== path.resolve(destino)) fs.copyFileSync(rutaVflow, destino);
      vflowEnDatos = destino;
      bien('copiado el .vflow en ' + destino);
    } catch (e) {
      aviso('no se pudo copiar el .vflow: ' + e.message);
    }
  }

  const rutaInstalacion = path.join(carpeta, 'INSTALACION.txt');
  fs.writeFileSync(
    rutaInstalacion,
    textoInstalacion({
      esProveedor: esProveedor,
      cliente: datosLicencia && datosLicencia.cliente,
      tenant: datosLicencia && datosLicencia.tenant,
      urlPublica: urlPublica,
      licencia: licenciaResumen + (datosLicencia && datosLicencia.hasta ? ', vence el ' + String(datosLicencia.hasta).slice(0, 10) : ''),
      baseDatos: baseDatos,
      claveSql: claveSql,
      cedulas: bakPadron ? 'si, se restauran desde ' + bakPadron : 'no: el sistema funciona sin ellas (PADRON_ACTIVO=0)',
      bakPadron: bakPadron,
      id: id,
      rutaVflow: vflowEnDatos || rutaVflow,
    }),
    { encoding: 'utf8' }
  );
  bien('escrito ' + rutaInstalacion);

  /* 9. Lo que queda por hacer, en pantalla. */
  titulo('Listo. Lo que queda');
  console.log('   1. ' + C.blanco + (esProveedor ? 'docker compose up -d' : 'docker compose up -d bd-sistema app --no-deps') + C.reset);
  console.log('   2. docker exec -it visitaflow-app node sql/01-crear.js');
  if (bakPadron) console.log('   3. Las cedulas (PASO 3 de INSTALACION.txt)');
  console.log('   ' + (bakPadron ? '4' : '3') + '. docker compose restart app');
  console.log('   ' + (bakPadron ? '5' : '4') + '. Activar en ' + C.blanco + urlPublica + C.reset +
    (id ? ' con el ID ' + C.blanco + id + C.reset : ' con el archivo .vflow'));
  console.log('   ' + (bakPadron ? '6' : '5') + '. docker exec -it visitaflow-app cat /app/datos/CLAVE-ADMINISTRADOR.txt');
  console.log('   ' + (bakPadron ? '7' : '6') + '. ' + C.blanco + 'npm run comprobar:instalacion' + C.reset);

  console.log('');
  console.log('  ' + C.gris + 'Los pasos completos, con sus datos ya rellenados, estan en:' + C.reset);
  console.log('  ' + C.blanco + rutaInstalacion + C.reset);
  console.log('');
  console.log('  ' + C.ambar + 'Guarde el .env: tiene los secretos de esta instalacion.' + C.reset);
  console.log('');

  lector.cerrar();
  return 0;
}

/**
 * Salida del programa.
 *
 * process.exit() a secas revienta en Windows cuando el cliente HTTP dejo una
 * conexion viva: libuv se queja ("Assertion failed ... async.c") y el proceso
 * termina con un codigo que no es el nuestro, asi que quien lo ejecuta cree que
 * fallo otra cosa. Se le devuelve el codigo a Node y se deja que cierre solo;
 * solo se fuerza la salida si algo la retuviera.
 */
function salir(codigo) {
  process.exitCode = codigo;
  setTimeout(() => process.exit(codigo), 800).unref();
}

principal()
  .then(salir)
  .catch((e) => {
    console.error('');
    console.error('  ' + C.rojo + 'No se pudo preparar la instalacion: ' + e.message + C.reset);
    console.error('  ' + C.rojo + 'No se ha escrito nada.' + C.reset);
    console.error('');
    salir(1);
  });
