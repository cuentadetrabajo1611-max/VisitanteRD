/**
 * VisitaFlow - Capturas de la consola de licencias.
 *
 *   node scripts/capturar-licencias.js
 *
 * Guarda una captura de la consola del servidor de licencias en capturas/.
 * Necesita el servidor de licencias en marcha (npm run licencias).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));

const PUERTO = process.env.PUERTO_LICENCIAS || 4100;
const BASE = 'http://localhost:' + PUERTO;
const DESTINO = path.join(RAIZ, 'capturas');
const PERFIL = path.join(RAIZ, 'tmp', 'chrome-perfil-licencias');

const NAVEGADORES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function navegador() {
  for (const r of NAVEGADORES) if (fs.existsSync(r)) return r;
  return null;
}

function capturar(chrome, url, archivo, alto) {
  if (fs.existsSync(archivo)) fs.unlinkSync(archivo);
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--disable-crash-reporter', '--disable-breakpad',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--user-data-dir=' + PERFIL,
    '--window-size=1440,' + (alto || 900),
    '--virtual-time-budget=9000',
    '--screenshot=' + archivo,
    url,
  ], { stdio: 'ignore', timeout: 120000 });
}

async function principal() {
  const chrome = navegador();
  if (!chrome) {
    console.error('\n  No se encontró Chrome ni Edge.\n');
    process.exit(1);
  }

  const token = process.env.ADMIN_TOKEN || config.adminToken;
  if (!token) {
    console.error('\n  Falta ADMIN_TOKEN; sin él no se puede entrar a la consola.\n');
    process.exit(1);
  }

  try {
    const r = await fetch(BASE + '/api/salud');
    if (!r.ok) throw new Error('estado ' + r.status);
  } catch (e) {
    console.error('\n  El servidor de licencias no responde en ' + BASE);
    console.error('  Arránquelo con:  npm run licencias\n');
    process.exit(1);
  }

  fs.mkdirSync(DESTINO, { recursive: true });
  fs.mkdirSync(PERFIL, { recursive: true });

  console.log('\n  Capturas de la consola de licencias');
  console.log('  ' + '-'.repeat(52));

  // Sin token: la pantalla de entrada.
  capturar(chrome, BASE + '/', path.join(DESTINO, '20-licencias-acceso.png'), 700);
  console.log('  ok   20-licencias-acceso');

  // Con token: el listado.
  capturar(chrome, BASE + '/?t=' + encodeURIComponent(token), path.join(DESTINO, '21-licencias-lista.png'), 900);
  console.log('  ok   21-licencias-lista');

  console.log('  ' + '-'.repeat(52));
  console.log('  2 capturas en capturas/\n');
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
