/**
 * VisitaFlow - Pruebas del servidor de licencias.
 *
 *   node sql/91-pruebas-servidor-licencias.js
 *
 * Necesita el servidor de licencias en marcha (npm run licencias).
 *
 * Comprueba el ciclo completo del lado del proveedor: emitir una licencia,
 * consultarla desde una instalacion, renovarla y rechazar lo que debe rechazar.
 * Es lo que garantiza que el licenciamiento sirve para algo y no es un adorno.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const lic = require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));

/* El puerto 4100 es el del servidor de licencias. No se usa el 4000 porque en
   esta maquina ya lo tiene ocupado otro proyecto. */
const BASE = process.env.PRUEBA_LICENCIAS_URL || 'http://localhost:' + (process.env.PUERTO_LICENCIAS || 4100);
const TOKEN = process.env.ADMIN_TOKEN || config.adminToken;

let ok = 0;
let fallos = 0;
const detalleFallos = [];

async function prueba(nombre, fn) {
  try {
    await fn();
    ok++;
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallos++;
    detalleFallos.push(nombre + ' -> ' + e.message);
    console.log('  FALLO ' + nombre + '\n         -> ' + e.message);
  }
}

function esperar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje || 'condición no cumplida');
}

async function pedir(metodo, ruta, cuerpo, conToken) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (conToken !== false) cabeceras.Authorization = 'Bearer ' + TOKEN;
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  let datos = null;
  const texto = await r.text();
  try { datos = JSON.parse(texto); } catch (e) { datos = { crudo: texto.slice(0, 300) }; }
  return { estado: r.status, datos };
}

/* Datos de la prueba. Se usa un identificador con prefijo claro para poder
   reconocer y limpiar lo que deje. */
const TENANT = 'zz-prueba-licencias';
const HUELLA = 'huella-de-prueba-1234567890abcdef';

async function principal() {
  console.log('');
  console.log('  === VisitaFlow: pruebas del servidor de licencias ===');
  console.log('  Servidor: ' + BASE);
  console.log('');

  if (!TOKEN) {
    console.error('  Falta ADMIN_TOKEN. Definelo en .env para poder probar la administración.');
    process.exit(1);
  }

  /* ---------------------------------------------------------------- */
  console.log('Servicio');

  await prueba('el servicio responde y tiene la llave privada cargada', async () => {
    const r = await pedir('GET', '/api/salud', undefined, false);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.llave && r.datos.llave.disponible, 'la llave privada no está disponible: ' + (r.datos.llave || {}).motivo);
    esperar(r.datos.llave.key_id, 'no viene el key_id');
  });

  await prueba('la llave pública se puede consultar sin autenticación', async () => {
    const r = await pedir('GET', '/api/llave-publica', undefined, false);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.llave_publica.indexOf('BEGIN PUBLIC KEY') !== -1, 'la llave pública no tiene el formato esperado');
    esperar(r.datos.modulos.length > 5, 'no vienen los módulos disponibles');
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Administración protegida');

  await prueba('sin token no se puede administrar', async () => {
    const r = await pedir('GET', '/api/admin/licencias', undefined, false);
    esperar(r.estado === 401, 'debería responder 401 y respondió ' + r.estado);
  });

  await prueba('con un token equivocado tampoco', async () => {
    const cabeceras = { 'Content-Type': 'application/json', Authorization: 'Bearer token-inventado' };
    const r = await fetch(BASE + '/api/admin/licencias', { headers: cabeceras });
    esperar(r.status === 401, 'debería responder 401 y respondió ' + r.status);
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Emisión');

  // Limpieza de la corrida anterior, para que la suite sea repetible.
  try {
    const fs = require('fs');
    const ruta = process.env.LICENCIAS_REGISTRO || path.join(RAIZ, 'datos', 'licencias-emitidas.json');
    if (fs.existsSync(ruta)) {
      const lista = JSON.parse(fs.readFileSync(ruta, 'utf8')).filter((l) => l.tenant !== TENANT);
      fs.writeFileSync(ruta, JSON.stringify(lista, null, 2));
    }
  } catch (e) {
    /* si no se puede limpiar, las pruebas de emisión avisarán */
  }

  let emitida = null;

  await prueba('se emite una licencia para una institución nueva', async () => {
    const r = await pedir('POST', '/api/admin/licencias', {
      tenant: TENANT,
      cliente: 'Institución de Prueba',
      contacto: 'prueba@ejemplo.local',
      dias: 90,
      usuarios: 3,
      instalaciones: 1,
      modulos: ['registro', 'recepcion', 'gafetes'],
      notas: 'Emitida por las pruebas automáticas',
    });
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    esperar(r.datos.archivo, 'no vino el archivo de licencia');
    esperar(r.datos.archivo.indexOf('BEGIN VISITAFLOW LICENSE') !== -1, 'el archivo no tiene la cabecera esperada');
    emitida = r.datos;
  });

  await prueba('la licencia emitida se verifica con la llave pública', async () => {
    const contenido = lic.verificarFirma(emitida.archivo);
    esperar(contenido.tenant === TENANT, 'el tenant no coincide: ' + contenido.tenant);
    esperar(contenido.cliente === 'Institución de Prueba', 'el cliente no coincide');
    esperar(contenido.limites.usuarios === 3, 'el límite de usuarios no coincide');
    esperar(contenido.modulos.length === 3, 'los módulos no coinciden');
  });

  await prueba('la licencia emitida es válida y tiene los días pedidos', async () => {
    const e = lic.evaluar(emitida.archivo);
    esperar(e.valida, 'la licencia no es válida: ' + e.motivo);
    // El conteo se redondea hacia arriba, asi que 90 dias puede dar 90 o 91
    // segun hayan pasado unos milisegundos desde la emision.
    esperar(e.dias_restantes >= 89 && e.dias_restantes <= 91, 'días restantes raros: ' + e.dias_restantes);
  });

  await prueba('no se puede emitir con un identificador inválido', async () => {
    const r = await pedir('POST', '/api/admin/licencias', { tenant: 'CON MAYÚSCULAS Y ESPACIOS', cliente: 'X', dias: 30 });
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('no se puede emitir sin nombre de cliente', async () => {
    const r = await pedir('POST', '/api/admin/licencias', { tenant: 'otro-cliente', dias: 30 });
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('no se puede emitir con un módulo que no existe', async () => {
    const r = await pedir('POST', '/api/admin/licencias', {
      tenant: 'otro-cliente', cliente: 'Otro', dias: 30, modulos: ['teletransporte'],
    });
    esperar(r.estado === 400, 'debería responder 400 y respondió ' + r.estado);
  });

  await prueba('la institución aparece en el listado', async () => {
    const r = await pedir('GET', '/api/admin/licencias');
    esperar(r.estado === 200, 'estado ' + r.estado);
    const l = r.datos.licencias.find((x) => x.tenant === TENANT);
    esperar(l, 'la institución no aparece en el listado');
    esperar(l.dias_restantes > 80, 'días restantes raros: ' + l.dias_restantes);
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Consulta desde una instalación');

  await prueba('una instalación puede pedir su licencia', async () => {
    const r = await pedir('POST', '/api/licencia/consultar', { tenant: TENANT, huella: HUELLA }, false);
    esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    esperar(r.datos.licencia, 'no vino la licencia');
    const contenido = lic.verificarFirma(r.datos.licencia);
    esperar(contenido.tenant === TENANT, 'el tenant no coincide');
  });

  await prueba('si la instalación ya tiene la última, el servidor dice "sin cambios"', async () => {
    const r = await pedir('POST', '/api/licencia/consultar', {
      tenant: TENANT, licencia_id: emitida.licencia_id, huella: HUELLA,
    }, false);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.sin_cambios === true, 'debería decir que no hay cambios');
  });

  await prueba('una institución desconocida no obtiene licencia', async () => {
    const r = await pedir('POST', '/api/licencia/consultar', { tenant: 'no-existe-esta', huella: HUELLA }, false);
    esperar(r.estado === 404, 'debería responder 404 y respondió ' + r.estado);
  });

  await prueba('la instalación puede avisar que se activó', async () => {
    const r = await pedir('POST', '/api/licencia/activada', {
      tenant: TENANT, licencia_id: emitida.licencia_id, huella: HUELLA,
      equipo: { nombre: 'EQUIPO-PRUEBA', sistema: 'test' },
    }, false);
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.registrada === true, 'no se registró la activación');
  });

  await prueba('la activación queda anotada en la institución', async () => {
    const r = await pedir('GET', '/api/admin/licencias');
    const l = r.datos.licencias.find((x) => x.tenant === TENANT);
    esperar(l.instalaciones && l.instalaciones.length === 1, 'no se anotó la instalación');
    esperar(l.instalaciones[0].huella === HUELLA, 'la huella anotada no coincide');
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Renovación');

  await prueba('se renueva la licencia', async () => {
    const r = await pedir('POST', '/api/admin/licencias/' + TENANT + '/renovar', { dias: 365 });
    esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    esperar(r.datos.archivo, 'no vino el archivo renovado');
  });

  await prueba('la renovación suma días a partir del vencimiento anterior', async () => {
    const r = await pedir('GET', '/api/admin/licencias');
    const l = r.datos.licencias.find((x) => x.tenant === TENANT);
    // 90 días emitidos + 365 de la renovación = unos 455 desde hoy.
    esperar(l.dias_restantes >= 450, 'después de renovar deberían quedar ~455 días y quedan ' + l.dias_restantes);
  });

  await prueba('la licencia renovada sigue siendo válida', async () => {
    const r = await pedir('POST', '/api/licencia/consultar', { tenant: TENANT, huella: HUELLA }, false);
    const e = lic.evaluar(r.datos.licencia);
    esperar(e.valida, 'la licencia renovada no es válida: ' + e.motivo);
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Archivo y verificación');

  await prueba('el archivo de la licencia se puede descargar', async () => {
    const r = await fetch(BASE + '/api/admin/licencias/' + TENANT + '/archivo', {
      headers: { Authorization: 'Bearer ' + TOKEN },
    });
    esperar(r.status === 200, 'estado ' + r.status);
    const texto = await r.text();
    esperar(texto.indexOf('BEGIN VISITAFLOW LICENSE') !== -1, 'el archivo descargado no es una licencia');
    const e = lic.evaluar(texto);
    esperar(e.valida, 'el archivo descargado no es válido');
  });

  await prueba('el verificador acepta una licencia buena', async () => {
    const r = await pedir('POST', '/api/admin/verificar', { archivo: emitida.archivo });
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.evaluacion.valida, 'debería ser válida');
    esperar(r.datos.resumen.indexOf('ACTIVA') !== -1 || r.datos.resumen.indexOf('POR VENCER') !== -1, 'el resumen no dice que esté activa');
  });

  await prueba('el verificador RECHAZA una licencia alterada', async () => {
    // Se estira la fecha a mano y se comprueba que la firma deja de cuadrar.
    const cuerpo = emitida.archivo
      .replace(lic.CABECERA, '').replace(lic.PIE, '')
      .split('\n').map((l) => l.trim()).filter(Boolean).join('');
    const partes = cuerpo.split('.');
    const contenido = JSON.parse(lic.deBase64Url(partes[0]).toString('utf8'));
    contenido.hasta = new Date(Date.now() + 3650 * 86400000).toISOString();
    const nuevaCarga = lic.aBase64Url(Buffer.from(JSON.stringify(contenido), 'utf8'));
    const falsa = lic.CABECERA + '\n' + nuevaCarga + '.' + partes[1] + '\n' + lic.PIE + '\n';

    const r = await pedir('POST', '/api/admin/verificar', { archivo: falsa });
    esperar(r.estado === 200, 'estado ' + r.estado);
    esperar(r.datos.evaluacion.valida === false, 'una licencia alterada NO debería pasar');
    esperar(/firma/i.test(r.datos.evaluacion.motivo || ''), 'el motivo no menciona la firma: ' + r.datos.evaluacion.motivo);
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Amarre a un equipo');

  await prueba('una licencia amarrada a un equipo solo vale en ese equipo', async () => {
    const r = await pedir('POST', '/api/admin/licencias', {
      tenant: 'zz-prueba-amarrada', cliente: 'Amarrada', dias: 30, huella: HUELLA,
    });
    esperar(r.estado === 201, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));

    const enSuEquipo = lic.evaluar(r.datos.archivo, { huella: HUELLA });
    esperar(enSuEquipo.valida, 'debería ser válida en su equipo');

    const enOtro = lic.evaluar(r.datos.archivo, { huella: 'otro-equipo-distinto' });
    esperar(!enOtro.valida, 'no debería ser válida en otro equipo');
    esperar(enOtro.estado === 'otro_equipo', 'el estado debería ser otro_equipo y es ' + enOtro.estado);

    // Limpieza
    const fs = require('fs');
    const ruta = process.env.LICENCIAS_REGISTRO || path.join(RAIZ, 'datos', 'licencias-emitidas.json');
    if (fs.existsSync(ruta)) {
      const lista = JSON.parse(fs.readFileSync(ruta, 'utf8')).filter((l) => l.tenant !== 'zz-prueba-amarrada');
      fs.writeFileSync(ruta, JSON.stringify(lista, null, 2));
    }
  });

  /* ---------------------------------------------------------------- */
  console.log('');
  console.log('Limpieza');

  await prueba('se borra la institución de prueba del registro', async () => {
    const fs = require('fs');
    const ruta = process.env.LICENCIAS_REGISTRO || path.join(RAIZ, 'datos', 'licencias-emitidas.json');
    esperar(fs.existsSync(ruta), 'no existe el registro de licencias');
    const lista = JSON.parse(fs.readFileSync(ruta, 'utf8')).filter((l) => l.tenant !== TENANT);
    fs.writeFileSync(ruta, JSON.stringify(lista, null, 2));
  });

  console.log('');
  console.log('  ─────────────────────────────────────────────');
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ─────────────────────────────────────────────');
  if (fallos) {
    console.log('');
    for (const f of detalleFallos) console.log('    ' + f);
  }
  console.log('');
  process.exit(fallos ? 1 : 0);
}

principal().catch((e) => {
  console.error('');
  console.error('  No se pudieron correr las pruebas: ' + e.message);
  console.error('  ¿Está el servidor de licencias en marcha?  npm run licencias');
  console.error('');
  process.exit(1);
});
