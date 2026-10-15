/**
 * VisitaFlow - Borra los datos de prueba de la suite de personas.
 *
 *   node scripts/limpiar-pruebas-personas.js
 *
 * La suite (sql/95-pruebas-personas.js) se limpia sola, pero si una corrida se
 * interrumpe a medias pueden quedar restos. Este script los borra en el orden
 * correcto: primero lo que depende, despues lo que es dependido.
 *
 * Los registros de prueba se reconocen porque empiezan por "ZZ-".
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));

/* El orden importa: las visitas apuntan al departamento, a la persona y al
   motivo. Si se borrara el departamento antes que las visitas, SQL Server lo
   rechaza con un error de clave ajena. */
const PASOS = [
  ['avisos de visitas de prueba',
    "DELETE FROM vf_avisos WHERE visita_id IN (SELECT id FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%')"],
  ['avisos dirigidos a nombres de prueba',
    "DELETE FROM vf_avisos WHERE destinatario LIKE 'ZZ-%'"],
  ['gafetes de visitas de prueba',
    "DELETE FROM vf_gafetes WHERE visita_id IN (SELECT id FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%')"],
  ['visitas de prueba',
    "DELETE FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%'"],
  /* Las visitas que apunten a un departamento de prueba, aunque no lleven la
     marca DEMO: es lo que hacia fallar el borrado del departamento. Hay que
     quitar antes los avisos y los gafetes que las referencian. */
  ['avisos de visitas que apuntan a departamentos de prueba',
    "DELETE FROM vf_avisos WHERE visita_id IN (SELECT v.id FROM vf_visitas v JOIN vf_departamentos d ON d.id = v.departamento_id WHERE d.nombre LIKE 'ZZ-%')"],
  ['gafetes de visitas que apuntan a departamentos de prueba',
    "DELETE FROM vf_gafetes WHERE visita_id IN (SELECT v.id FROM vf_visitas v JOIN vf_departamentos d ON d.id = v.departamento_id WHERE d.nombre LIKE 'ZZ-%')"],
  ['visitas que apuntan a departamentos de prueba',
    "DELETE FROM vf_visitas WHERE departamento_id IN (SELECT id FROM vf_departamentos WHERE nombre LIKE 'ZZ-%')"],
  ['personas de prueba',
    "DELETE FROM vf_personas WHERE nombre LIKE 'ZZ-%'"],
  ['departamentos de prueba',
    "DELETE FROM vf_departamentos WHERE nombre LIKE 'ZZ-%'"],
  ['visitantes sin ninguna visita',
    'DELETE FROM vf_visitantes WHERE NOT EXISTS (SELECT 1 FROM vf_visitas v WHERE v.visitante_id = vf_visitantes.id)'],
];

async function principal() {
  console.log('');
  console.log('  VisitaFlow - limpieza de la suite de personas');
  console.log('  ' + '-'.repeat(58));

  await bd.conectarSistema();

  let total = 0;
  for (const [queEs, sql] of PASOS) {
    try {
      const r = await bd.consultar(sql);
      const n = r.rowsAffected[0] || 0;
      total += n;
      if (n) console.log('  ' + String(n).padStart(5) + '  ' + queEs);
    } catch (e) {
      console.log('  FALLO  ' + queEs + ': ' + e.message);
    }
  }

  console.log('  ' + '-'.repeat(58));
  console.log('  ' + total + ' registro(s) borrado(s)');

  // Se comprueba que no queda nada.
  const queda = await bd.consultar(
    "SELECT (SELECT COUNT(*) FROM vf_personas WHERE nombre LIKE 'ZZ-%') AS personas, " +
    "(SELECT COUNT(*) FROM vf_departamentos WHERE nombre LIKE 'ZZ-%') AS deptos, " +
    "(SELECT COUNT(*) FROM vf_avisos WHERE destinatario LIKE 'ZZ-%') AS avisos, " +
    "(SELECT COUNT(*) FROM vf_visitas WHERE observaciones LIKE 'DEMO personas%' OR observaciones LIKE 'DEMO aviso%') AS visitas"
  );
  const q = queda.recordset[0];
  console.log('  quedan: ' + q.personas + ' personas, ' + q.deptos + ' departamentos, ' +
    q.avisos + ' avisos, ' + q.visitas + ' visitas');
  console.log('');

  await bd.cerrar();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
