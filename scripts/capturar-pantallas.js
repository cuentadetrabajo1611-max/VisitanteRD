/**
 * VisitaFlow - Capturas de pantalla de la interfaz.
 *
 *   node scripts\capturar-pantallas.js [pantalla ...]
 *
 * Abre Chrome sin ventana, entra al sistema y guarda una captura de cada
 * pantalla en capturas/. Sirve para revisar la interfaz de un vistazo despues
 * de un cambio, sin abrir el navegador a mano.
 *
 * Cada captura es un arranque de Chrome independiente. El token de sesion se
 * pasa por la direccion en vez de por cookie, porque el modo sin ventana no
 * siempre alcanza a escribir las cookies en disco entre arranques.
 *
 * Requiere: el servidor en marcha (npm start) y NODE_ENV distinto de production.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));

const BASE = 'http://localhost:' + config.servidor.puerto;
const DESTINO = path.join(RAIZ, 'capturas');
const PERFIL = path.join(RAIZ, 'tmp', 'chrome-perfil');

const NAVEGADORES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/* Pantallas a capturar. */
const PANTALLAS = [
  { nombre: '01-acceso', ruta: '#/acceso', publica: true, descripcion: 'Pantalla de acceso' },
  { nombre: '02-panel', ruta: '#/panel', descripcion: 'Panel principal' },
  { nombre: '03-registro', ruta: '#/registro', descripcion: 'Registro de visita' },
  { nombre: '04-dentro', ruta: '#/dentro', descripcion: 'Visitantes dentro' },
  { nombre: '05-bitacora', ruta: '#/bitacora', descripcion: 'Bitácora de visitas' },
  { nombre: '06-preregistros', ruta: '#/preregistros', descripcion: 'Visitas anunciadas' },
  { nombre: '07-vigilancia', ruta: '#/vigilancia', descripcion: 'Lista de vigilancia' },
  { nombre: '08-reportes', ruta: '#/reportes', descripcion: 'Reportes', alto: 1400 },
  { nombre: '09-gafetes', ruta: '#/gafetes', descripcion: 'Gafetes' },
  { nombre: '10-configuracion', ruta: '#/configuracion', descripcion: 'Configuración' },
  { nombre: '14-personas', ruta: '#/configuracion?tab=personas', descripcion: 'Directorio de personas', alto: 1000 },
  { nombre: '11-personalizacion', ruta: '#/personalizacion', descripcion: 'Personalización de marca', alto: 1100 },
  { nombre: '12-usuarios', ruta: '#/usuarios', descripcion: 'Usuarios y permisos' },
  { nombre: '13-licencia', ruta: '#/licencia', descripcion: 'Estado de la licencia', alto: 1100 },
];

function navegador() {
  for (const ruta of NAVEGADORES) {
    if (fs.existsSync(ruta)) return ruta;
  }
  return null;
}

async function esperarServidor(intentos) {
  for (let i = 0; i < (intentos || 20); i++) {
    try {
      const r = await fetch(BASE + '/api/salud');
      if (r.ok) return true;
    } catch (e) {
      /* todavia no arranca */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/* El archivo de credenciales se lee con el modulo compartido: busca en la
   carpeta de datos y, si no está, en la raíz del proyecto. */
const { leerCredenciales } = require('./credenciales');

/** Lee las credenciales iniciales del archivo que deja el servidor. */
function credenciales() {
  return leerCredenciales();
}

/** Pide un token de sesion con la utilidad de desarrollo. */
async function obtenerToken(cred) {
  const url =
    BASE + '/api/acceso/dev-entrar' +
    '?tenant=' + encodeURIComponent(cred.tenant) +
    '&correo=' + encodeURIComponent(cred.usuario) +
    '&clave=' + encodeURIComponent(cred.clave);

  const r = await fetch(url);
  const texto = await r.text();
  if (!r.ok) {
    throw new Error('No se pudo iniciar sesión para las capturas (' + r.status + '): ' + texto.slice(0, 200));
  }
  let datos;
  try {
    datos = JSON.parse(texto);
  } catch (e) {
    throw new Error('La respuesta de la utilidad de desarrollo no es JSON: ' + texto.slice(0, 200));
  }
  if (!datos.token) throw new Error('La utilidad de desarrollo no devolvió token.');
  return datos.token;
}

/** Abre una direccion y guarda la captura. */
function capturar(chrome, url, archivo, alto) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  if (fs.existsSync(archivo)) fs.unlinkSync(archivo);

  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--user-data-dir=' + PERFIL,
    '--window-size=1440,' + (alto || 900),
    // Margen para que la aplicacion alcance a pedir los datos y pintarlos.
    '--virtual-time-budget=9000',
    '--screenshot=' + archivo,
    url,
  ], { stdio: 'ignore', timeout: 120000 });
}

async function principal() {
  const chrome = navegador();
  if (!chrome) {
    console.error('\n  No se encontró Chrome ni Edge. Tome las capturas a mano.\n');
    process.exit(1);
  }

  if (config.esProduccion()) {
    console.error('\n  NODE_ENV=production: la utilidad de desarrollo está desactivada.');
    console.error('  Las capturas necesitan entrar al sistema, así que no se pueden tomar aquí.\n');
    process.exit(1);
  }

  if (!(await esperarServidor())) {
    console.error('\n  El servidor no responde en ' + BASE + '\n  Arránquelo con:  npm start\n');
    process.exit(1);
  }

  const cred = credenciales();
  if (!cred || !cred.usuario || !cred.clave || !cred.tenant) {
    console.error('\n  No se pudieron leer las credenciales de CLAVE-ADMINISTRADOR.txt');
    console.error('  Lea el archivo para ver qué falta: usuario, contraseña o institución.\n');
    process.exit(1);
  }

  fs.mkdirSync(DESTINO, { recursive: true });
  fs.mkdirSync(PERFIL, { recursive: true });

  const token = await obtenerToken(cred);

  // Se pueden pedir pantallas concretas por la línea de comandos.
  const pedidas = process.argv.slice(2);
  const lista = pedidas.length
    ? PANTALLAS.filter((p) => pedidas.some((x) => p.nombre.indexOf(x) !== -1 || p.ruta.indexOf(x) !== -1))
    : PANTALLAS;

  if (!lista.length) {
    console.error('\n  Ninguna pantalla coincide con: ' + pedidas.join(', '));
    console.error('  Pantallas: ' + PANTALLAS.map((p) => p.nombre).join(', ') + '\n');
    process.exit(1);
  }

  console.log('\n  Capturas de VisitaFlow');
  console.log('  ─────────────────────────────────────────────');

  let ok = 0;
  for (const p of lista) {
    const archivo = path.join(DESTINO, p.nombre + '.png');
    // Las pantallas internas necesitan el token en la dirección.
    const url = BASE + '/' + (p.publica ? '' : '?t=' + encodeURIComponent(token)) + p.ruta;

    // Una captura que salga igual que la anterior significa que la sesión no
    // entró. Se comprueba el tamaño para no dar por buena una pantalla vacía.
    try {
      capturar(chrome, url, archivo, p.alto);
      const kb = Math.round(fs.statSync(archivo).size / 1024);
      console.log('  ok   ' + p.nombre.padEnd(18) + String(kb).padStart(5) + ' KB   ' + p.descripcion);
      ok++;
    } catch (e) {
      console.log('  FALLO ' + p.nombre + ' -> ' + e.message);
    }
  }

  console.log('  ─────────────────────────────────────────────');
  console.log('  ' + ok + ' de ' + lista.length + ' capturas en capturas/');

  // Aviso útil: si todas pesan lo mismo, casi seguro es la pantalla de acceso.
  const tamanos = lista.map((p) => {
    const f = path.join(DESTINO, p.nombre + '.png');
    return fs.existsSync(f) ? fs.statSync(f).size : 0;
  }).filter(Boolean);
  const unicos = new Set(tamanos);
  if (tamanos.length > 2 && unicos.size === 1) {
    console.log('');
    console.log('  AVISO: todas las capturas pesan igual. Probablemente la sesión no entró');
    console.log('  y lo que se capturó fue la pantalla de acceso.');
  }
  console.log('');
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
