/**
 * VisitaFlow - Prepara el directorio de ejemplo.
 *
 *   node scripts/demo-personas.js
 *
 * Crea unas cuantas personas en el directorio de la institucion local, para que
 * la pantalla de Configuracion no salga vacia y se pueda ver como funciona.
 *
 * Marca todo con "DEMO" para poder borrarlo con: npm run limpiar:personas
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
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

/* Personas de ejemplo, repartidas en los departamentos que ya existen.
   Los nombres son ficticios a proposito: no se inventan personas reales. */
const PERSONAS = [
  { nombre: 'Ana Rodríguez Peña', cargo: 'Presidenta de la junta', correo: 'ana.rodriguez@ejemplo.local' },
  { nombre: 'Luis Martínez Guzmán', cargo: 'Tesorero', correo: 'luis.martinez@ejemplo.local' },
  { nombre: 'Carmen Jiménez Reyes', cargo: 'Secretaria', correo: 'carmen.jimenez@ejemplo.local' },
  { nombre: 'Pedro Santana Cruz', cargo: 'Encargado de mantenimiento', correo: 'pedro.santana@ejemplo.local' },
  { nombre: 'Rosa Fernández Lora', cargo: 'Atención al residente', correo: 'rosa.fernandez@ejemplo.local' },
  { nombre: 'Miguel Ángel Torres', cargo: 'Vigilancia', correo: null },
];

async function principal() {
  console.log('');
  console.log('  VisitaFlow - directorio de ejemplo');
  console.log('  ' + '-'.repeat(58));

  const cred = leerCredenciales();
  if (!cred) {
    console.error('  No hay credenciales. Use: npm run admin:restablecer <institucion>');
    process.exit(1);
  }

  const entrada = await api('POST', '/api/acceso/entrar', { tenant: cred.tenant, correo: cred.usuario, clave: cred.clave });
  token = entrada.datos.token;
  if (!token) {
    console.error('  No se pudo iniciar sesión.');
    process.exit(1);
  }

  // Se reparten entre los departamentos que existan.
  const cfg = await api('GET', '/api/config');
  const deptos = (cfg.datos.departamentos || []).filter((d) => d.activo);
  if (!deptos.length) {
    console.error('  No hay departamentos. Arranque el sistema una vez para que se creen.');
    process.exit(1);
  }
  console.log('  departamentos disponibles: ' + deptos.map((d) => d.nombre).join(', '));

  // Los ya existentes, para no duplicar.
  const ya = new Set((cfg.datos.personas || []).map((p) => p.nombre));
  const nuevas = PERSONAS.filter((p) => !ya.has(p.nombre));
  console.log('  por crear: ' + nuevas.length + ' de ' + PERSONAS.length);
  console.log('');

  let creadas = 0;
  for (let i = 0; i < nuevas.length; i++) {
    const p = nuevas[i];
    const depto = deptos[i % deptos.length];
    const r = await api('POST', '/api/config/personas', {
      nombre: p.nombre,
      cargo: p.cargo,
      correo: p.correo,
      departamento_id: depto.id,
      recibe_visitas: true,
    });
    if (r.estado === 201) {
      creadas++;
      console.log('  ' + p.nombre.padEnd(28) + ' -> ' + depto.nombre);
    } else {
      console.log('  FALLÓ ' + p.nombre + ': ' + (r.datos.mensaje || r.estado));
    }
  }

  console.log('');
  console.log('  ' + creadas + ' persona(s) creada(s) en el directorio.');
  console.log('  Vea la pestaña "Personas" en Configuración.');
  console.log('');

  /* Y una visita de ejemplo eligiendo a una persona del directorio, para que se
     vea el aviso en la pantalla de Recepción. Sin esto, el panel de avisos sale
     vacío y no se puede ver cómo funciona. */
  const conVisita = process.argv.indexOf('--sin-visita') === -1;
  if (conVisita && deptos.length) {
    const r = await api('GET', '/api/personas');
    const persona = (r.datos.personas || [])[0];

    if (persona) {
      const bd = require(path.join(RAIZ, 'src', 'db.js'));
      let cedula = null;
      try {
        await bd.conectarPadron();
        const ce = await bd.consultarPadron(
          "SELECT TOP 1 Cedula FROM dbo.CIUDADANOS WHERE Apellido1 LIKE 'ABAD%' ORDER BY Cedula"
        );
        cedula = ce.recordset.length ? ce.recordset[0].Cedula : null;
        await bd.cerrar();
      } catch (e) {
        /* si no hay base de cedulas, no se registra la visita */
      }

      if (cedula) {
        const cat = await api('GET', '/api/registro/consultar?cedula=' + cedula);
        const motivo = cat.datos.consulta && cat.datos.consulta.catalogos.motivos[0];

        const reg = await api('POST', '/api/registro', {
          cedula,
          motivo_id: motivo ? motivo.id : undefined,
          departamento_id: persona.departamento_id,
          persona_id: persona.id,
          visitado: persona.nombre,
          observaciones: 'DEMO personas y avisos',
          permitir_duplicado: true,
        });

        if (reg.estado === 201) {
          console.log('  Visita de ejemplo registrada a nombre de ' + persona.nombre + '.');
          console.log('  El aviso aparece en la pantalla "Visitantes dentro".');
        } else {
          console.log('  (no se pudo registrar la visita de ejemplo: ' + (reg.datos.motivo || reg.estado) + ')');
        }
      }
    }
  }

  console.log('');
  console.log('  Para borrarlas:  npm run limpiar:personas');
  console.log('');
}

principal().catch((e) => {
  console.error('');
  console.error('  Error: ' + e.message);
  console.error('');
  process.exit(1);
});
