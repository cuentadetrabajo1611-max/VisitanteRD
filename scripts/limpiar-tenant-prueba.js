/**
 * VisitaFlow - Borra las instituciones de prueba.
 *
 *   node scripts/limpiar-tenant-prueba.js zz-produccion
 *   node scripts/limpiar-tenant-prueba.js            (borra todas las "zz-")
 *
 * Las suites de produccion y de primer arranque crean su propia institucion y la
 * borran al terminar. Si una corrida se interrumpe, la institucion queda, y
 * despues estorba: la pantalla de acceso muestra varias instituciones y las
 * pruebas que eligen "la primera" cogen la equivocada.
 *
 * Solo borra instituciones cuyo codigo empieza por "zz-", que es la marca que
 * usan las pruebas. Nunca una institucion de verdad.
 */
'use strict';

const path = require('path');
const readline = require('readline');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));

/* Las tablas que cuelgan de una institucion, de los hijos a los padres. */
const TABLAS = [
  'vf_vigilancia_avisos',
  'vf_gafetes',
  'vf_avisos',
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
  console.log('  VisitaFlow - borrar instituciones de prueba');
  console.log('  ' + '-'.repeat(60));

  await bd.conectarSistema();

  const r = codigo
    ? await bd.consultar('SELECT id, codigo, nombre FROM vf_tenants WHERE codigo = @c', { c: codigo })
    : await bd.consultar("SELECT id, codigo, nombre FROM vf_tenants WHERE codigo LIKE 'zz-%' ORDER BY codigo");

  if (!r.recordset.length) {
    console.log('  No hay ninguna institución de prueba que borrar.');
    console.log('');
    await bd.cerrar();
    return;
  }

  // Guarda: solo se borran las que llevan la marca de prueba.
  const deVerdad = r.recordset.filter((t) => !/^zz-/i.test(t.codigo));
  if (deVerdad.length) {
    console.log('  ATENCION: estas NO llevan la marca de prueba y no se tocarán:');
    for (const t of deVerdad) console.log('    ' + t.codigo);
    console.log('');
  }

  const borrar = r.recordset.filter((t) => /^zz-/i.test(t.codigo));
  if (!borrar.length) {
    console.log('  Nada que borrar.');
    console.log('');
    await bd.cerrar();
    return;
  }

  console.log('  Se van a borrar ' + borrar.length + ' institución(es) de prueba y todo lo suyo:');
  for (const t of borrar) console.log('    ' + t.codigo.padEnd(26) + t.nombre);
  console.log('');

  if (process.argv.indexOf('--si') === -1 && !(await preguntar('¿Continuar?'))) {
    console.log('  Cancelado.');
    console.log('');
    await bd.cerrar();
    return;
  }

  for (const t of borrar) {
    let borrados = 0;
    for (const tabla of TABLAS) {
      try {
        const d = await bd.consultar('DELETE FROM dbo.[' + tabla + '] WHERE tenant_id = @t', { t: t.id });
        borrados += d.rowsAffected[0] || 0;
      } catch (e) {
        console.log('    (no se pudo vaciar ' + tabla + ': ' + e.message.slice(0, 80) + ')');
      }
    }
    await bd.consultar('DELETE FROM vf_tenants WHERE id = @t', { t: t.id });
    console.log('  ' + t.codigo.padEnd(26) + borrados + ' registro(s) borrado(s)');
  }

  const fin = await bd.consultar('SELECT COUNT(*) AS n FROM vf_tenants');
  console.log('');
  console.log('  Quedan ' + fin.recordset[0].n + ' institución(es) en la base.');
  console.log('');

  await bd.cerrar();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
