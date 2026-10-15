/**
 * VisitaFlow - Emite una licencia e instala el estado inicial.
 *
 *   node scripts/licencia-demo.js [institucion] [dias]
 *   node scripts/licencia-demo.js junta-los-prados 365
 *
 * PARA QUE SIRVE
 * --------------
 * Deja una instalacion lista para usar en un solo paso:
 *
 *   1. Emite una licencia firmada para la institucion indicada.
 *   2. La escribe donde el sistema la lee (dentro de la carpeta de datos, que en
 *      el VPS es un volumen).
 *   3. Limpia las instituciones que hubiera antes, para que la licencia nueva
 *      sea la unica fuente de verdad. Los catalogos y el administrador se
 *      vuelven a crear solos al arrancar el sistema.
 *
 * Es la herramienta para volver a un estado limpio despues de una prueba que
 * haya dejado la base con datos de ensayo.
 *
 * OJO: borra instituciones, con todo lo que cuelga de ellas (usuarios, visitas,
 * catalogos). No es para usar en una instalacion con datos de verdad.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const lic = require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));

const TENANT = (process.argv[2] || 'junta-los-prados').toLowerCase();
const DIAS = Number(process.argv[3]) || 365;
const CONFIRMAR = process.argv.indexOf('--si') !== -1;

/* Nombres con los que se conocen las instituciones de ejemplo. Si el
   identificador no está aquí, se arma uno a partir de él. */
const NOMBRES = {
  'junta-los-prados': 'Junta de Vecinos Los Prados',
  'club-nautico': 'Club Náutico de Santo Domingo',
  'residencial-alto': 'Residencial Alto Prado',
  'junta-prueba': 'Junta de Vecinos de Prueba',
};
/* Tablas que cuelgan de una institucion, de los hijos a los padres. */
const TABLAS = [
  'vf_vigilancia_avisos',
  'vf_gafetes',
  'vf_visitas',
  'vf_preregistros',
  'vf_vigilancia',
  'vf_visitantes',
  'vf_auditoria',
  'vf_plantillas_gafete',
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
  'vf_tenants',
];

function confirmar(pregunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  ' + pregunta + ' [escriba SI para continuar]: ', (r) => {
      rl.close();
      resolve(String(r).trim().toUpperCase() === 'SI');
    });
  });
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - licencia e instalación inicial');
  console.log('  ' + '-'.repeat(60));
  console.log('  Institución: ' + TENANT);
  console.log('  Vigencia   : ' + DIAS + ' días');
  console.log('');

  await bd.conectarSistema();

  const antes = await bd.consultar(
    'SELECT t.codigo, ' +
    '(SELECT COUNT(*) FROM vf_visitas v WHERE v.tenant_id = t.id) AS visitas ' +
    'FROM vf_tenants t'
  );

  if (antes.recordset.length) {
    console.log('  Instituciones que hay ahora:');
    for (const t of antes.recordset) console.log('    ' + t.codigo.padEnd(28) + t.visitas + ' visita(s)');
    console.log('');
    console.log('  Esto va a BORRAR esas instituciones y todo lo que cuelga de ellas.');
    console.log('  Los catálogos y el administrador se vuelven a crear al arrancar.');
    console.log('');
    if (!CONFIRMAR && !(await confirmar('¿Continuar?'))) {
      console.log('  Cancelado. No se tocó nada.');
      console.log('');
      await bd.cerrar();
      return;
    }
  }

  // 1. Emitir la licencia.
  const ahora = new Date();
  const hasta = new Date(ahora.getTime() + DIAS * 86400000);
  const nombre = NOMBRES[TENANT] || 'Junta de Vecinos ' + TENANT.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const texto = lic.firmar({
    tenant: TENANT,
    tenant_nombre: nombre,
    cliente: nombre,
    contacto: 'admin@' + TENANT + '.local',
    desde: ahora.toISOString(),
    hasta: hasta.toISOString(),
    tipo: DIAS <= 30 ? 'prueba' : 'periodo',
    modulos: lic.MODULOS.slice(),
    limites: { usuarios: 10, instalaciones: 2, visitas_mes: 0 },
    gracia_dias: 15,
    notas: 'Licencia de desarrollo local',
  });

  // 2. Escribirla donde el sistema la lee (dentro de la carpeta de datos).
  fs.mkdirSync(path.dirname(config.licencia.archivo), { recursive: true });
  fs.writeFileSync(config.licencia.archivo, texto, { mode: 0o600 });
  console.log('  Licencia escrita en: ' + path.relative(RAIZ, config.licencia.archivo));

  // Se deja tambien una copia con nombre propio, para poder entregarla.
  const copia = path.join(config.archivos.datos, TENANT + '.vflow');
  fs.writeFileSync(copia, texto, { mode: 0o600 });
  console.log('  Copia para entregar: ' + path.relative(RAIZ, copia));

  // 3. Limpiar las instituciones anteriores.
  for (const t of TABLAS) {
    try {
      await bd.consultar('DELETE FROM dbo.[' + t + ']');
    } catch (e) {
      console.log('  (no se pudo vaciar ' + t + ': ' + e.message + ')');
    }
  }
  console.log('  Instituciones anteriores borradas.');

  // 4. Comprobar la licencia recién emitida.
  const e = lic.evaluar(texto);
  console.log('');
  console.log('  ' + lic.resumenLegible(e).split('\n').join('\n  '));
  console.log('');
  console.log('  Arranque el sistema (npm start) para que cree la institución,');
  console.log('  sus catálogos y el administrador inicial.');
  console.log('');

  await bd.cerrar();
}

principal().catch(async (e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  try { await bd.cerrar(); } catch (e2) { /* ya estaba cerrada */ }
  process.exit(1);
});
