/**
 * VisitaFlow - Estado de la institucion y los usuarios.
 *
 *   node scripts/estado-institucion.js
 *
 * Muestra que instituciones hay, si tienen administrador activo, y si la
 * licencia en disco concuerda. Sirve cuando las pruebas fallan con 401: casi
 * siempre es que el administrador no existe o la institucion cambio de id.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const lic = require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));
const { leerCredenciales } = require('./credenciales.js');

async function principal() {
  await bd.conectarSistema();

  console.log('');
  console.log('  VisitaFlow - estado de la institución');
  console.log('  ' + '='.repeat(66));

  // 1. La licencia en disco.
  try {
    const texto = fs.readFileSync(config.licencia.archivo, 'utf8');
    const e = lic.evaluar(texto);
    console.log('  licencia en disco : ' + e.estado + ' — ' + (e.contenido && e.contenido.cliente));
    console.log('  institución (tenant): ' + (e.contenido && e.contenido.tenant));
  } catch (err) {
    console.log('  licencia en disco : NO SE PUDO LEER (' + err.message + ')');
  }

  // 2. Las instituciones de la base.
  const t = await bd.consultar('SELECT id, codigo, nombre, estado FROM vf_tenants ORDER BY id');
  console.log('');
  console.log('  Instituciones en la base (' + t.recordset.length + '):');
  for (const x of t.recordset) {
    console.log('    id ' + String(x.id).padEnd(5) + x.codigo.padEnd(26) + x.nombre + '  [' + x.estado + ']');
  }

  // 3. Los usuarios.
  const u = await bd.consultar(
    'SELECT u.id, u.tenant_id, u.correo, u.rol, u.activo, ' +
    "CASE WHEN u.clave_hash IS NULL THEN 'SIN CLAVE' ELSE 'con clave' END AS tiene " +
    'FROM vf_usuarios u ORDER BY u.tenant_id, u.id'
  );
  console.log('');
  console.log('  Usuarios (' + u.recordset.length + '):');
  for (const x of u.recordset) {
    console.log('    tenant ' + String(x.tenant_id).padEnd(5) + String(x.correo).padEnd(34) +
      x.rol.padEnd(12) + (x.activo ? 'activo' : 'INACTIVO') + '  ' + x.tiene);
  }

  // 4. El archivo de credenciales.
  const c = leerCredenciales();
  console.log('');
  if (c) {
    console.log('  credenciales      : ' + c.usuario + '  (institución ' + c.tenant + ')');
    console.log('  archivo           : ' + c.ruta);
  } else {
    console.log('  credenciales      : NO HAY ARCHIVO');
  }

  // 5. Los avisos: tienen que ser de visitas que siguen dentro.
  const av = await bd.consultar(
    `SELECT a.id, a.destinatario, v.estado AS visita_estado, v.codigo
       FROM vf_avisos a
       LEFT JOIN vf_visitas v ON v.id = a.visita_id
      WHERE a.leido IS NULL
      ORDER BY a.id`
  );
  console.log('');
  console.log('  Avisos sin leer: ' + av.recordset.length);
  const abiertos = av.recordset.filter((x) => x.visita_estado === 'dentro').length;
  const huerfanos = av.recordset.filter((x) => x.visita_estado !== 'dentro').length;
  console.log('    de visitas que siguen dentro : ' + abiertos);
  if (huerfanos) {
    console.log('    de visitas ya cerradas       : ' + huerfanos + '  <- deberían cerrarse solos al mirar la pantalla');
  }

  // 6. La prueba de fuego: entrar de verdad.
  console.log('');
  try {
    const r = await fetch('http://localhost:' + config.servidor.puerto + '/api/acceso/entrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: c ? c.tenant : '', correo: c ? c.usuario : '', clave: c ? c.clave : '' }),
    });
    const j = await r.json();
    console.log('  entrar por la API : ' + r.status + (j.ok ? '  OK' : '  ' + (j.mensaje || j.motivo || '')));
    if (r.status === 200 && j.token) {
      console.log('  el token funciona : ' + (j.usuario ? 'sí, usuario ' + j.usuario.nombre : 'no vino usuario'));
      console.log('  tenant_id en sesión: ' + (j.usuario && j.usuario.tenant_id));
    }
  } catch (e) {
    console.log('  entrar por la API : no se pudo (' + e.message + ')');
  }

  console.log('');
  await bd.cerrar();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
