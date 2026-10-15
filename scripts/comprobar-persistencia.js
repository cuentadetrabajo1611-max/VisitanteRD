/**
 * VisitaFlow - Comprueba si las personas sobreviven.
 *
 *   node scripts/comprobar-persistencia.js
 *
 * Crea una persona por la API y comprueba si sigue en la base acto seguido y
 * unos segundos despues. Sirve para saber si algo las esta borrando.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const { leerCredenciales } = require('./credenciales.js');

const BASE = 'http://localhost:' + config.servidor.puerto;
let token = null;

async function api(metodo, ruta, cuerpo) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (token) cabeceras.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos;
  try { datos = JSON.parse(texto); } catch (e) { datos = {}; }
  return { estado: r.status, datos };
}

async function cuantas() {
  const r = await bd.consultar('SELECT COUNT(*) AS n FROM vf_personas');
  return r.recordset[0].n;
}

async function principal() {
  const cred = leerCredenciales();
  const e = await api('POST', '/api/acceso/entrar', { tenant: cred.tenant, correo: cred.usuario, clave: cred.clave });
  token = e.datos.token;

  await bd.conectarSistema();

  console.log('');
  console.log('  VisitaFlow - ¿sobreviven las personas?');
  console.log('  ' + '='.repeat(60));

  console.log('  personas antes      : ' + (await cuantas()));

  const nombre = 'Prueba Persistencia ' + Date.now();
  const r = await api('POST', '/api/config/personas', { nombre, recibe_visitas: true });
  console.log('  creación            : ' + r.estado + '  id ' + (r.datos.id || '—'));

  console.log('  personas justo después: ' + (await cuantas()));

  const fila = await bd.consultar('SELECT id, tenant_id, nombre FROM vf_personas WHERE id = @id', { id: r.datos.id });
  console.log('  en la base          : ' + (fila.recordset.length ? JSON.stringify(fila.recordset[0]) : 'NO ESTÁ'));
  console.log('  institución de la licencia: ');
  const t = await bd.consultar('SELECT id, codigo FROM vf_tenants ORDER BY id');
  for (const x of t.recordset) console.log('    id ' + x.id + '  ' + x.codigo);

  console.log('');
  console.log('  esperando 3 segundos…');
  await new Promise((res) => setTimeout(res, 3000));

  console.log('  personas después    : ' + (await cuantas()));
  const fila2 = await bd.consultar('SELECT id FROM vf_personas WHERE id = @id', { id: r.datos.id });
  console.log('  sigue existiendo    : ' + (fila2.recordset.length ? 'SÍ' : 'NO'));

  // Limpieza de lo que creó esta comprobación.
  await bd.consultar('DELETE FROM vf_personas WHERE id = @id', { id: r.datos.id });
  console.log('  (la persona de prueba se borró)');
  console.log('');

  await bd.cerrar();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
