/**
 * VisitaFlow - Limpieza de datos de demostracion.
 *
 *   node sql/94-limpiar.js
 *
 * Borra SOLO lo que creo sql/93-demo.js y lo que dejan las pruebas: las visitas
 * marcadas con "DEMO" en las observaciones, los pre-registros marcados igual y
 * los visitantes que quedaron sin ninguna visita.
 *
 * No toca la configuracion, los catalogos, los usuarios ni las visitas reales.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const bd = require(path.join(RAIZ, 'src', 'db.js'));
const util = require(path.join(RAIZ, 'src', 'util.js'));

async function principal() {
  console.log('');
  console.log('  VisitaFlow — limpieza de datos de demostración');
  console.log('  ─────────────────────────────────────────────');

  await bd.conectarSistema();

  // Los borrados van en orden inverso a las dependencias: primero los hijos.
  const pasos = [
    {
      nombre: 'gafetes de visitas de demostración',
      sql: "DELETE FROM vf_gafetes WHERE visita_id IN (SELECT id FROM vf_visitas WHERE observaciones LIKE '%DEMO%')",
    },
    {
      nombre: 'avisos de vigilancia de demostración',
      sql: "DELETE FROM vf_vigilancia_avisos WHERE motivo LIKE 'Prueba automática%' OR visita_id IN (SELECT id FROM vf_visitas WHERE observaciones LIKE '%DEMO%')",
    },
    {
      nombre: 'visitas de demostración',
      sql: "DELETE FROM vf_visitas WHERE observaciones LIKE '%DEMO%'",
    },
    {
      nombre: 'pre-registros de demostración',
      sql: "DELETE FROM vf_preregistros WHERE notas LIKE '%DEMO%' OR nombre_completo = 'Visitante Anunciado'",
    },
    {
      nombre: 'registros de vigilancia de prueba',
      sql: "DELETE FROM vf_vigilancia WHERE motivo LIKE 'Prueba automática%'",
    },
    {
      nombre: 'visitantes sin ninguna visita',
      sql: "DELETE FROM vf_visitantes WHERE NOT EXISTS (SELECT 1 FROM vf_visitas v WHERE v.visitante_id = vf_visitantes.id)",
    },
    {
      nombre: 'catálogos y usuarios de prueba',
      sql: "DELETE FROM vf_departamentos WHERE nombre LIKE 'ZZ-PRUEBA%'; DELETE FROM vf_usuarios WHERE correo LIKE '%@prueba.local' OR correo = 'admin@otra.local'",
    },
  ];

  let total = 0;
  for (const paso of pasos) {
    try {
      const r = await bd.consultar(paso.sql);
      const n = (r.rowsAffected || []).reduce((a, b) => a + (b || 0), 0);
      total += n;
      console.log('  ' + String(n).padStart(5) + '  ' + paso.nombre);
    } catch (e) {
      console.log('  FALLO  ' + paso.nombre + ' -> ' + e.message);
    }
  }

  // Una institucion de prueba del aislamiento pudo quedar a medias.
  try {
    await bd.consultar("DELETE FROM vf_rol_permisos WHERE tenant_id IN (SELECT id FROM vf_tenants WHERE codigo = 'zz-prueba-aislamiento')");
    await bd.consultar("DELETE FROM vf_usuarios WHERE tenant_id IN (SELECT id FROM vf_tenants WHERE codigo = 'zz-prueba-aislamiento')");
    const r = await bd.consultar("DELETE FROM vf_tenants WHERE codigo = 'zz-prueba-aislamiento'");
    if (r.rowsAffected[0]) console.log('  ' + String(r.rowsAffected[0]).padStart(5) + '  institución de prueba del aislamiento');
  } catch (e) {
    /* si no existe, no hay nada que hacer */
  }

  console.log('  ─────────────────────────────────────────────');
  console.log('  ' + total + ' registro(s) borrado(s)');
  console.log('');

  // Se restaura la personalizacion que las pruebas pudieran haber cambiado.
  try {
    const t = await bd.consultar("SELECT TOP 1 id FROM vf_tenants ORDER BY id");
    if (t.recordset.length) {
      await bd.consultar(
        "UPDATE vf_tenants SET color_primario = '#1e3a8a', color_secundario = '#f59e0b', color_acento = '#0ea5e9', color_texto = '#0f172a', logo_url = NULL, logo_archivo = NULL WHERE color_primario = '#0f766e'"
      );
    }
  } catch (e) {
    /* no es critico */
  }

  await bd.cerrar();
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
