/**
 * VisitaFlow - Comprueba que los avisos se cierran al dar salida.
 *
 *   node scripts/comprobar-aviso-salida.js
 *
 * Registra una visita, comprueba que se crea el aviso y que esta SIN LEER, y
 * despues da la salida y comprueba que el aviso queda cerrado. Se limpia sola.
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

async function principal() {
  const cred = leerCredenciales();
  const e = await api('POST', '/api/acceso/entrar', { tenant: cred.tenant, correo: cred.usuario, clave: cred.clave });
  token = e.datos.token;

  await bd.conectarSistema();
  await bd.conectarPadron();

  console.log('');
  console.log('  VisitaFlow - ¿se cierra el aviso al dar salida?');
  console.log('  ' + '='.repeat(62));

  const p = await api('GET', '/api/personas');
  const persona = (p.datos.personas || [])[0];
  if (!persona) {
    console.log('  No hay personas en el directorio. Use: npm run demo:personas');
    await bd.cerrar();
    return;
  }
  console.log('  persona: ' + persona.nombre);

  const ce = await bd.consultarPadron("SELECT TOP 1 Cedula FROM dbo.CIUDADANOS WHERE Apellido1 LIKE 'ABAD%' ORDER BY Cedula");
  const cedula = ce.recordset[0].Cedula;

  const cat = await api('GET', '/api/registro/consultar?cedula=' + cedula);
  const motivo = cat.datos.consulta.catalogos.motivos[0];

  // 1. Registrar.
  const reg = await api('POST', '/api/registro', {
    cedula,
    motivo_id: motivo.id,
    departamento_id: persona.departamento_id,
    persona_id: persona.id,
    visitado: persona.nombre,
    observaciones: 'DEMO comprobar aviso salida',
    permitir_duplicado: true,
  });
  console.log('  registro: ' + reg.estado);

  if (reg.estado !== 201) {
    console.log('  ' + JSON.stringify(reg.datos).slice(0, 200));
    await bd.cerrar();
    return;
  }
  const visitaId = reg.datos.visita.id;

  // El aviso se genera despues de responder, asi que se espera.
  let aviso = null;
  for (let i = 0; i < 30 && !aviso; i++) {
    const r = await bd.consultar(
      'SELECT TOP 1 id, leido, estado, destinatario FROM vf_avisos WHERE visita_id = @v ORDER BY id DESC',
      { v: visitaId }
    );
    if (r.recordset.length) aviso = r.recordset[0];
    else await new Promise((res) => setTimeout(res, 150));
  }

  if (!aviso) {
    console.log('  NO se generó el aviso');
    await limpiar(visitaId, cedula);
    await bd.cerrar();
    return;
  }
  console.log('');
  console.log('  aviso creado   : id ' + aviso.id + ', destinatario ' + aviso.destinatario);
  console.log('  leido al crear : ' + (aviso.leido ? 'SÍ (mal)' : 'no (correcto)'));
  console.log('  estado         : ' + aviso.estado);

  // 2. Dar salida.
  const sal = await api('POST', '/api/visitas/' + visitaId + '/salida', {});
  console.log('');
  console.log('  salida         : ' + sal.estado);

  await new Promise((res) => setTimeout(res, 400));

  const despues = await bd.consultar('SELECT leido, estado FROM vf_avisos WHERE id = @id', { id: aviso.id });
  const d = despues.recordset[0];
  console.log('  leido despues  : ' + (d.leido ? 'SÍ (correcto)' : 'NO (mal)'));
  console.log('  estado despues : ' + d.estado);
  console.log('');
  console.log('  ' + (d.leido ? 'FUNCIONA: el aviso se cerró al dar la salida.' : 'FALLA: el aviso sigue abierto.'));

  await limpiar(visitaId, cedula);
  console.log('');
  await bd.cerrar();
}

async function limpiar(visitaId, cedula) {
  await bd.consultar('DELETE FROM vf_avisos WHERE visita_id = @v', { v: visitaId });
  await bd.consultar('DELETE FROM vf_gafetes WHERE visita_id = @v', { v: visitaId });
  await bd.consultar('DELETE FROM vf_visitas WHERE id = @v', { v: visitaId });
  await bd.consultar(
    'DELETE FROM vf_visitantes WHERE cedula = @c AND NOT EXISTS (SELECT 1 FROM vf_visitas v WHERE v.visitante_id = vf_visitantes.id)',
    { c: cedula }
  );
  console.log('  (la visita de prueba se borró)');
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
