/**
 * VisitaFlow - Datos de la institucion local.
 *
 *   node scripts/datos-institucion.js                 (muestra lo que hay)
 *   node scripts/datos-institucion.js "Nombre nuevo"  (lo cambia por la API)
 *
 * Cambiar el nombre se hace por la API, no con SQL directo: es exactamente lo
 * que hace la pantalla de Personalizacion, y asi se comprueba que ese camino
 * funciona.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const { leerCredenciales } = require('./credenciales');
const BASE = 'http://localhost:' + config.servidor.puerto;

async function api(metodo, ruta, cuerpo, token) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (token) cabeceras.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos;
  try { datos = JSON.parse(texto); } catch (e) { datos = { mensaje: texto.slice(0, 200) }; }
  if (!r.ok) throw new Error(metodo + ' ' + ruta + ' -> ' + r.status + ': ' + (datos.mensaje || ''));
  return datos;
}

async function principal() {
  const cred = leerCredenciales();
  if (!cred) {
    console.error('');
    console.error('  No se encontró el archivo de credenciales del administrador.');
    console.error('  Restablézcalo con:  npm run admin:restablecer <institucion>');
    console.error('');
    process.exit(1);
  }
  const { usuario, clave, tenant } = cred;

  const entrada = await api('POST', '/api/acceso/entrar', { tenant, correo: usuario, clave });
  const token = entrada.token;

  console.log('');
  console.log('  Institución: ' + tenant);

  const nuevo = process.argv[2];

  if (nuevo) {
    await api('PATCH', '/api/personalizacion', { nombre: nuevo, nombre_comercial: nuevo }, token);
    console.log('  Nombre cambiado a: ' + nuevo);
  }

  const datos = await api('GET', '/api/personalizacion', undefined, token);
  const i = datos.institucion;
  console.log('');
  console.log('  nombre            : ' + i.nombre);
  console.log('  nombre_comercial  : ' + (i.nombre_comercial || '—'));
  console.log('  color_primario    : ' + i.color_primario);
  console.log('  logo              : ' + (i.logo_url || 'sin logo'));
  console.log('');
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
