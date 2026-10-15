/**
 * VisitaFlow - Comprobacion de punta a punta de las fechas de una visita.
 *
 *   node scripts/probar-fechas-visita.js
 *
 * Registra una visita por la API y compara su hora de entrada de TRES formas:
 * lo que dice SQL Server, lo que devuelve el driver a Node, y la hora real.
 * Despues mide la duracion contra la salida.
 *
 * Sirve para localizar donde se desvia una fecha cuando las duraciones salen
 * raras: si el problema esta al guardar, al leer, o en la comparacion.
 *
 * Borra la visita que crea.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const { leerCredenciales } = require('./credenciales');

const BASE = 'http://localhost:' + config.servidor.puerto;

function credenciales() {
  const c = leerCredenciales();
  if (!c) {
    console.error('');
    console.error('  No se encontró el archivo de credenciales del administrador.');
    console.error('  Restablézcalo con:  npm run admin:restablecer <institucion>');
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

/** Diferencia en minutos entre una fecha y ahora, con su signo. */
function difMin(fecha) {
  return Math.round((new Date(fecha).getTime() - Date.now()) / 60000);
}

function linea(etiqueta, valor) {
  console.log('  ' + etiqueta.padEnd(44) + String(valor));
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - fechas de una visita, de punta a punta');
  console.log('  ' + '='.repeat(72));
  console.log('');

  const cred = credenciales();
  const entrada = await api('POST', '/api/acceso/entrar', { tenant: cred.tenant, correo: cred.usuario, clave: cred.clave });
  const token = entrada.token;

  const ahoraAntes = Date.now();

  // 1. Hora del servidor de base de datos, para comparar.
  await bd.conectarSistema();
  const srv = await bd.consultar(
    'SELECT CONVERT(varchar(40), SYSDATETIMEOFFSET(), 127) AS con_zona, ' +
    'CONVERT(varchar(40), SYSDATETIME(), 126) AS sin_zona, ' +
    'DATEDIFF(minute, SYSUTCDATETIME(), SYSDATETIME()) AS desfase'
  );
  const s = srv.recordset[0];
  linea('Hora del servidor (con zona)', s.con_zona);
  linea('Hora del servidor (sin zona)', s.sin_zona);
  linea('Desfase del servidor', s.desfase + ' minutos');

  // 2. Registrar una visita de verdad.
  const buscar = await api('GET', '/api/registro/buscar?q=00100000017', undefined, token);
  const cedula = buscar.resultados[0].cedula;
  const consulta = await api('GET', '/api/registro/consultar?cedula=' + cedula, undefined, token);
  const cat = consulta.consulta.catalogos;

  const registro = await api('POST', '/api/registro', {
    cedula,
    motivo_id: cat.motivos[0].id,
    departamento_id: cat.departamentos[0].id,
    visitado: 'Prueba de fechas',
    observaciones: 'DEMO fechas',
    permitir_duplicado: true,
  }, token);

  const visitaId = registro.visita.id;
  const ahoraDespues = Date.now();

  console.log('');
  console.log('  --- la visita recién registrada ---');
  linea('Lo que devolvió la API (entrada)', registro.visita.entrada);
  linea('Diferencia con la hora real', difMin(registro.visita.entrada) + ' minutos');

  // 3. Y ahora lo que hay de verdad en la tabla.
  const fila = await bd.consultar(
    'SELECT momento, CONVERT(varchar(40), momento, 127) AS texto ' +
    'FROM (SELECT entrada AS momento FROM vf_visitas WHERE id = @id) AS x',
    { id: visitaId }
  );
  const enSql = fila.recordset[0];
  console.log('');
  console.log('  --- lo que hay guardado ---');
  linea('Lo que ve SQL Server', enSql.texto);
  linea('Lo que lee el driver', enSql.momento.toISOString());
  linea('Diferencia con la hora real', difMin(enSql.momento) + ' minutos');

  console.log('');
  console.log('  --- comparaciones dentro de SQL ---');
  const cmp = await bd.consultar(
    'SELECT ' +
    'DATEDIFF(minute, entrada, SYSDATETIMEOFFSET()) AS con_offset, ' +
    'DATEDIFF(minute, entrada, SYSDATETIME()) AS sin_offset ' +
    'FROM vf_visitas WHERE id = @id',
    { id: visitaId }
  );
  linea('DATEDIFF contra SYSDATETIMEOFFSET()', cmp.recordset[0].con_offset + ' minutos  <- el correcto');
  linea('DATEDIFF contra SYSDATETIME()', cmp.recordset[0].sin_offset + ' minutos  <- se desvía si no es 0');

  // 4. Diferencia entre las dos horas del servidor: esto explica el desvío.
  console.log('');
  console.log('  --- la causa ---');
  linea('SYSDATETIMEOFFSET() menos SYSDATETIME()', s.desfase + ' minutos');
  console.log('      Es el desfase de la zona del servidor. Restar una hora local');
  console.log('      (SYSDATETIME) de una hora con zona (la columna) corre el');
  console.log('      resultado exactamente esos minutos.');

  // 5. Salida y duración, que es donde se nota el problema.
  const salida = await api('POST', '/api/visitas/' + visitaId + '/salida', {}, token);
  console.log('');
  console.log('  --- la salida ---');
  linea('Duración que reporta el sistema', salida.visita.duracion);
  linea('Minutos', salida.visita.minutos);
  if (salida.visita.minutos < 0 || String(salida.visita.duracion).indexOf('-') === 0) {
    console.log('      MAL: la duración es negativa');
  } else {
    console.log('      Correcto: la duración es positiva');
  }

  // 6. Limpieza.
  await bd.consultar('DELETE FROM vf_gafetes WHERE visita_id = @id', { id: visitaId });
  await bd.consultar('DELETE FROM vf_visitas WHERE id = @id', { id: visitaId });
  await bd.consultar(
    'DELETE FROM vf_visitantes WHERE cedula = @c AND NOT EXISTS (SELECT 1 FROM vf_visitas v WHERE v.visitante_id = vf_visitantes.id)',
    { c: cedula }
  );
  await bd.cerrar();
  console.log('');
  console.log('  (la visita de prueba quedó borrada)');
  console.log('');
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  process.exit(1);
});
