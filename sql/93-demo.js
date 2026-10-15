/**
 * VisitaFlow - Datos de demostracion.
 *
 *   node sql/93-demo.js [cantidad]
 *
 * Crea visitas repartidas en los ultimos 45 dias usando cedulas REALES del
 * padron, para poder ver el panel, la bitacora y los reportes con contenido
 * antes de usar el sistema de verdad.
 *
 * Todo lo que crea queda marcado con el prefijo "DEMO" o con observaciones de
 * demostracion, para poder borrarlo despues con:  npm run limpiar
 *
 * Va por la API, no por SQL directo: asi los datos pasan por las mismas
 * validaciones que usaria recepcion.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const { leerCredenciales } = require(path.join(RAIZ, 'scripts', 'credenciales.js'));
const BASE = process.env.DEMO_URL || 'http://localhost:' + config.servidor.puerto;

const CANTIDAD = Number(process.argv[2]) || 70;

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
  let datos = null;
  try { datos = JSON.parse(texto); } catch (e) { datos = { crudo: texto.slice(0, 200) }; }
  if (!r.ok) throw new Error(metodo + ' ' + ruta + ' -> ' + r.status + ': ' + (datos.mensaje || texto.slice(0, 160)));
  return datos;
}

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

/** Numero al azar entre min y max. */
const azar = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const elegir = (lista) => lista[Math.floor(Math.random() * lista.length)];

async function principal() {
  console.log('');
  console.log('  VisitaFlow — datos de demostración');
  console.log('  ─────────────────────────────────────────────');

  const cred = credenciales();
  const entrada = await api('POST', '/api/acceso/entrar', { tenant: cred.tenant, correo: cred.usuario, clave: cred.clave });
  token = entrada.token;
  console.log('  Entró como ' + entrada.usuario.nombre + ' (' + cred.tenant + ')');

  const catalogos = (await api('GET', '/api/registro/consultar?cedula=00100000017')).consulta.catalogos;
  if (!catalogos.motivos.length || !catalogos.departamentos.length) {
    console.error('  La institución no tiene motivos ni departamentos. Ejecute primero: npm run db:crear');
    process.exit(1);
  }

  // Se toman cedulas reales del padron para que las fichas tengan datos.
  console.log('  Buscando visitantes en la base de cédulas…');
  const cedulas = new Map();
  const apellidos = ['ABREU', 'ACOSTA', 'ALMONTE', 'BELTRE', 'CABRERA', 'DIAZ', 'ENCARNACION', 'FELIZ', 'GUZMAN', 'HERNANDEZ', 'JIMENEZ', 'MARTINEZ', 'NUNEZ', 'PENA', 'RAMIREZ', 'REYES', 'SANTANA', 'VASQUEZ'];
  for (const apellido of apellidos) {
    try {
      const r = await api('GET', '/api/registro/buscar?q=' + apellido + '&limite=6');
      for (const c of r.resultados || []) cedulas.set(c.cedula, c);
    } catch (e) {
      /* si el padron no responde, se sigue con lo que haya */
    }
    if (cedulas.size >= 40) break;
  }

  if (cedulas.size < 5) {
    console.error('  No se pudieron leer cédulas de la base. ¿Está configurado el padrón?');
    process.exit(1);
  }
  console.log('  ' + cedulas.size + ' cédulas reales encontradas');

  const lista = Array.from(cedulas.values());
  const empresas = ['Constructora del Este', 'Ferretería Central', 'Distribuidora Nacional', 'Seguros Popular', 'Claro', 'Banco Reservas', null, null];

  /* A quién se visita. Si hay directorio de personas, se usa: es lo que hace
     que los avisos al anfitrión tengan destinatario y correo de verdad, y que
     la demo se parezca a como funciona el sistema en una institución real.
     Si no lo hay, se usan cargos sueltos como antes. */
  const directorio = await api('GET', '/api/personas');
  const gente = (directorio.personas || []).map((p) => ({ id: p.id, nombre: p.nombre, departamento_id: p.departamento_id }));
  const personas = gente.length
    ? gente
    : ['Encargado de Recursos Humanos', 'Presidenta de la junta', 'Tesorero', 'Administración', 'Secretaría', 'Mantenimiento']
        .map((n) => ({ id: null, nombre: n, departamento_id: null }));

  if (gente.length) {
    console.log('  ' + gente.length + ' persona(s) del directorio para las visitas');
  }

  let creadas = 0;
  let salidas = 0;
  let fallos = 0;

  for (let i = 0; i < CANTIDAD; i++) {
    const c = elegir(lista);
    const motivo = elegir(catalogos.motivos);
    const depto = elegir(catalogos.departamentos);
    // Reparto en los ultimos 45 dias, con mas peso en los ultimos dias.
    const diasAtras = Math.floor(Math.pow(Math.random(), 1.6) * 45);

    /* La hora se elige dentro del horario de oficina, PERO nunca despues de la
       hora actual cuando la visita es de hoy: una entrada de las 10 de la noche
       registrada a las 9 de la manana queda en el futuro, y eso descuadra los
       reportes y hace que el sistema marque tiempos negativos.
       Para los dias anteriores la hora completa es valida. */
    const ahora = new Date();
    const horaMaxima = diasAtras === 0 ? ahora.getHours() : 18;
    const hora = azar(7, Math.max(7, horaMaxima));
    const minutoMaximo = diasAtras === 0 && hora === ahora.getHours() ? ahora.getMinutes() : 55;
    const minuto = Math.min(elegir([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]), minutoMaximo);

    try {
      // La fecha de entrada se reparte en los ultimos 45 dias. El servidor solo
      // la acepta fuera de produccion (es para demostracion).
      const entradaFecha = new Date();
      entradaFecha.setDate(entradaFecha.getDate() - diasAtras);
      entradaFecha.setHours(hora, minuto, azar(0, 59), 0);

      const r = await api('POST', '/api/registro', {
        cedula: c.cedula,
        motivo_id: motivo.id,
        departamento_id: depto.id,
        visitado: elegir(personas),
        empresa: elegir(empresas),
        telefono: '809-' + azar(200, 999) + '-' + azar(1000, 9999),
        acompanantes: Math.random() < 0.2 ? azar(1, 3) : 0,
        vehiculo: Math.random() < 0.3 ? elegir(['Toyota Corolla', 'Honda Civic', 'Hyundai Tucson', 'Motocicleta']) : null,
        placa: Math.random() < 0.3 ? 'A' + azar(100000, 999999) : null,
        observaciones: 'DEMO',
        fecha_entrada: entradaFecha.toISOString(),
        permitir_duplicado: false,
      });
      creadas++;

      const visitaId = r.visita.id;
      // 85% de las visitas de dias anteriores ya salieron.
      const esDeHoy = diasAtras === 0;
      if (!esDeHoy && Math.random() < 0.85) {
        try {
          // La salida se pone entre 15 minutos y 3 horas despues de la entrada.
          const salidaFecha = new Date(entradaFecha.getTime() + azar(15, 180) * 60000);
          await api('POST', '/api/visitas/' + visitaId + '/salida', { fecha_salida: salidaFecha.toISOString() });
          salidas++;
        } catch (e) {
          /* si ya estaba cerrada, da igual */
        }
      }
    } catch (e) {
      fallos++;
      if (fallos <= 3) console.log('    (omitida: ' + e.message.slice(0, 90) + ')');
    }
  }

  // Visitas anunciadas para las proximas horas.
  // Se usan cedulas de la base pero con un sufijo "DEMO" en las notas, y se
  // salta la que ya tenga un anuncio pendiente: asi el demo se puede correr
  // varias veces sin chocar con lo que ya existe.
  let anunciadas = 0;
  const yaAnunciadas = new Set();
  try {
    const existentes = await api('GET', '/api/preregistros?estado=pendiente&tamano=200');
    for (const p of existentes.listado.filas) if (p.cedula) yaAnunciadas.add(p.cedula);
  } catch (e) {
    /* si no se pueden leer, se intenta igual */
  }

  for (let i = 0; i < 5 && anunciadas + yaAnunciadas.size < 200; i++) {
    const c = elegir(lista);
    if (yaAnunciadas.has(c.cedula)) continue;
    try {
      await api('POST', '/api/preregistros', {
        nombre_completo: c.nombre_completo,
        cedula: c.cedula,
        empresa: elegir(empresas),
        telefono: '809-' + azar(200, 999) + '-' + azar(1000, 9999),
        departamento_id: elegir(catalogos.departamentos).id,
        motivo_id: elegir(catalogos.motivos).id,
        visitado: elegir(personas),
        fecha_prevista: new Date(Date.now() + azar(1, 40) * 3600000).toISOString().slice(0, 16),
        notas: 'DEMO',
      });
      anunciadas++;
      yaAnunciadas.add(c.cedula);
    } catch (e) {
      /* la cedula puede tener ya un pre-registro */
    }
  }

  console.log('  ' + creadas + ' visitas registradas (' + salidas + ' con salida)');
  if (fallos) console.log('  ' + fallos + ' omitidas (cédula ya dentro o dato repetido)');
  console.log('  ' + anunciadas + ' visitas anunciadas');
  console.log('');
  console.log('  Abra el sistema y verá el panel y los reportes con contenido.');
  console.log('  Para borrar estos datos:  npm run limpiar');
  console.log('');
}

principal().catch((e) => {
  console.error('');
  console.error('  ' + e.message);
  console.error('  ¿Está el servidor en marcha?  npm start');
  console.error('');
  process.exit(1);
});
