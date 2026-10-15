/**
 * VisitaFlow - Captura del gafete de una visita.
 *
 *   node scripts/capturar-gafete.js
 *
 * Registra una visita de prueba, abre su gafete y guarda la captura en
 * capturas/. Sirve para revisar de un vistazo que el gafete —con su código QR,
 * su código de barras y los colores de la institución— se ve bien antes de
 * imprimirlo de verdad.
 *
 * Al terminar borra la visita que creó.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));

const BASE = 'http://localhost:' + config.servidor.puerto;
const DESTINO = path.join(RAIZ, 'capturas');
const PERFIL = path.join(RAIZ, 'tmp', 'chrome-perfil-gafete');

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

/* El archivo de credenciales se lee con el modulo compartido: busca en la
   carpeta de datos y, si no está, en la raíz del proyecto. */
const { leerCredenciales } = require('./credenciales');

function credenciales() {
  const c = leerCredenciales();
  if (!c || !c.usuario || !c.clave) {
    console.error('');
    console.error('  No se encontró el archivo de credenciales del administrador.');
    console.error('  Lo crea el servidor al arrancar. Restablézcalo con:');
    console.error('      npm run admin:restablecer <institucion>');
    console.error('');
    process.exit(1);
  }
  return c;
}

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
  const chrome = navegador();
  if (!chrome) {
    console.error('\n  No se encontró Chrome ni Edge.\n');
    process.exit(1);
  }

  const cred = credenciales();
  const entrada = await api('POST', '/api/acceso/entrar', { tenant: cred.tenant, correo: cred.usuario, clave: cred.clave });
  const token = entrada.token;

  // Una cédula real del padrón, para que el gafete lleve datos de verdad.
  const busqueda = await api('GET', '/api/registro/buscar?q=ABREU&limite=1', undefined, token);
  const ciudadano = busqueda.resultados[0];
  if (!ciudadano) throw new Error('No se encontró ninguna cédula en el padrón para la prueba.');

  const catalogos = (await api('GET', '/api/registro/consultar?cedula=' + ciudadano.cedula, undefined, token)).consulta.catalogos;

  // Si esa persona ya está dentro, se le registra la salida para poder volver a entrar.
  try {
    await api('POST', '/api/registro', {
      cedula: ciudadano.cedula,
      motivo_id: catalogos.motivos[0].id,
      departamento_id: catalogos.departamentos[0].id,
      visitado: 'Presidenta de la junta',
      empresa: 'Constructora del Este',
      telefono: '809-555-1234',
      acompanantes: 1,
      vehiculo: 'Toyota Corolla',
      placa: 'A123456',
      observaciones: 'DEMO gafete',
      permitir_duplicado: true,
    }, token);
  } catch (e) {
    console.log('  (no se pudo registrar la visita: ' + e.message.slice(0, 90) + ')');
    process.exit(1);
  }

  const listado = await api('GET', '/api/visitas?estado=dentro&texto=' + encodeURIComponent(ciudadano.cedula) + '&tamano=1', undefined, token);
  const visita = listado.listado.filas[0];
  if (!visita) throw new Error('No se encontró la visita recién registrada.');

  console.log('\n  Captura del gafete');
  console.log('  ' + '-'.repeat(52));
  console.log('  Visita  : ' + visita.codigo);
  console.log('  Visitante: ' + visita.nombre);

  fs.mkdirSync(DESTINO, { recursive: true });
  fs.mkdirSync(PERFIL, { recursive: true });

  const archivo = path.join(DESTINO, '19-gafete.png');
  if (fs.existsSync(archivo)) fs.unlinkSync(archivo);

  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--disable-crash-reporter', '--disable-breakpad',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--user-data-dir=' + PERFIL,
    '--window-size=1100,760',
    '--virtual-time-budget=9000',
    '--screenshot=' + archivo,
    BASE + '/?t=' + encodeURIComponent(token) + '#/gafetes?gafete=' + visita.id,
  ], { stdio: 'ignore', timeout: 120000 });

  console.log('  ' + (fs.existsSync(archivo) ? 'ok   ' : 'FALLO') + ' 19-gafete.png');

  // Limpieza: se borra la visita de la prueba.
  await api('POST', '/api/visitas/' + visita.id + '/anular', { motivo: 'Demo del gafete terminada' }, token);
  await bd.conectarSistema();
  await bd.consultar("DELETE FROM vf_gafetes WHERE visita_id = @id", { id: visita.id });
  await bd.consultar("DELETE FROM vf_visitas WHERE id = @id", { id: visita.id });
  await bd.consultar("DELETE FROM vf_visitantes WHERE cedula = @c AND NOT EXISTS (SELECT 1 FROM vf_visitas v WHERE v.visitante_id = vf_visitantes.id)", { c: ciudadano.cedula });
  await bd.cerrar();

  console.log('  (la visita de prueba quedó borrada)');
  console.log('  ' + '-'.repeat(52) + '\n');
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
