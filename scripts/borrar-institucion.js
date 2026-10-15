/**
 * VisitaFlow - Borra una institucion y todo lo suyo.
 *
 *   node scripts/borrar-institucion.js club-nautico
 *   node scripts/borrar-institucion.js club-nautico --si
 *
 * Sirve para deshacer una prueba de activacion, o para quitar una institucion
 * creada por error. Pide confirmacion salvo que se le pase --si.
 *
 * Se borra en el orden correcto: primero lo que depende de la institucion
 * (visitas, avisos, gafetes) y al final la institucion. Al reves, SQL Server lo
 * rechaza con un error de clave ajena.
 */
'use strict';

const path = require('path');
const readline = require('readline');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));

/* De los hijos a los padres. */
const TABLAS = [
  'vf_avisos',
  'vf_vigilancia_avisos',
  'vf_gafetes',
  'vf_visitas',
  'vf_preregistros',
  'vf_vigilancia',
  'vf_visitantes',
  'vf_auditoria',
  'vf_plantillas_gafete',
  'vf_personas',
  'vf_departamentos',
  'vf_motivos',
  'vf_categorias',
  'vf_sedes',
  'vf_ajustes',
  'vf_rol_permisos',
  'vf_licencias',
  'vf_licencias_revisiones',
  'vf_instalaciones',
  'vf_usuarios',
];

function preguntar(texto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  ' + texto + ' [SI para continuar]: ', (r) => {
      rl.close();
      resolve(String(r).trim().toUpperCase() === 'SI');
    });
  });
}

async function principal() {
  const codigo = (process.argv[2] || '').trim().toLowerCase();

  console.log('');
  console.log('  VisitaFlow - borrar una institución');
  console.log('  ' + '-'.repeat(58));

  if (!codigo) {
    console.log('  Indique el código de la institución. Las que hay:');
    await bd.conectarSistema();
    const t = await bd.consultar('SELECT codigo, nombre FROM vf_tenants ORDER BY codigo');
    for (const x of t.recordset) console.log('    ' + x.codigo.padEnd(24) + x.nombre);
    console.log('');
    await bd.cerrar();
    process.exit(1);
  }

  await bd.conectarSistema();

  const t = await bd.consultar('SELECT id, codigo, nombre FROM vf_tenants WHERE codigo = @c', { c: codigo });
  if (!t.recordset.length) {
    console.log('  No existe la institución "' + codigo + '".');
    console.log('');
    await bd.cerrar();
    return;
  }

  const inst = t.recordset[0];

  // Cuanto se va a borrar, para que la confirmacion sea informada.
  const cuenta = await bd.consultar(
    'SELECT (SELECT COUNT(*) FROM vf_visitas WHERE tenant_id = @t) AS visitas, ' +
    '(SELECT COUNT(*) FROM vf_usuarios WHERE tenant_id = @t) AS usuarios',
    { t: inst.id }
  );
  const c = cuenta.recordset[0];

  console.log('  Institución: ' + inst.nombre + '  (' + inst.codigo + ')');
  console.log('  Se borrarán ' + c.visitas + ' visita(s) y ' + c.usuarios + ' usuario(s).');
  console.log('');

  if (process.argv.indexOf('--si') === -1 && !(await preguntar('¿Borrar de verdad?'))) {
    console.log('  Cancelado. No se tocó nada.');
    console.log('');
    await bd.cerrar();
    return;
  }

  let borrados = 0;
  for (const tabla of TABLAS) {
    try {
      const r = await bd.consultar('DELETE FROM dbo.[' + tabla + '] WHERE tenant_id = @t', { t: inst.id });
      borrados += r.rowsAffected[0] || 0;
    } catch (e) {
      console.log('  (no se pudo vaciar ' + tabla + ': ' + e.message.slice(0, 70) + ')');
    }
  }
  await bd.consultar('DELETE FROM vf_tenants WHERE id = @t', { t: inst.id });

  const quedan = await bd.consultar('SELECT COUNT(*) AS n FROM vf_tenants');
  console.log('  ' + borrados + ' registro(s) borrado(s).');
  console.log('  Quedan ' + quedan.recordset[0].n + ' institución(es).');
  console.log('');

  await bd.cerrar();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
