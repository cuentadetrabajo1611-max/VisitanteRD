/**
 * VisitaFlow - Prueba del panel de licencias.
 *
 *   node scripts/probar-panel-licencias.js
 *
 * Comprueba, contra el servidor de licencias en marcha:
 *
 *   1. Listar clientes.
 *   2. Activar por ID (la puerta del primer arranque de una instalacion nueva).
 *   3. Suspender a un cliente y comprobar que su instalacion ya no puede
 *      activarse ni renovar.
 *   4. Reactivarlo.
 *   5. Cambiarle los modulos y comprobar que el cambio llega.
 *
 * Trabaja sobre un cliente de prueba que crea y borra, para no tocar los reales.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const lic = require(path.join(RAIZ, 'src', 'licencias', 'licencia.js'));

const BASE = 'http://localhost:' + (process.env.PUERTO_LICENCIAS || 4100);
const ADMIN = (process.env.ADMIN_TOKEN || config.adminToken || '').trim();

/* El token de INSTALACION, que es distinto del de administracion: el primero lo
   tiene el cliente y el segundo el vendedor. Las rutas de renovacion exigen el de
   instalacion, porque antes no exigian ninguno y cualquiera que supiera el codigo
   de una institucion se llevaba su licencia firmada. */
const TOKEN_INSTALACION = (process.env.LICENCIA_TOKEN_ACTIVACION || config.licencia.tokenActivacion || '').trim();

let ok = 0;
let fallos = 0;
const detalle = [];

async function prueba(nombre, fn) {
  try {
    await fn();
    ok++;
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallos++;
    detalle.push(nombre + ' -> ' + e.message);
    console.log('  FALLO ' + nombre + '\n         -> ' + e.message);
  }
}

function esperar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje || 'condición no cumplida');
}

async function api(metodo, ruta, cuerpo, conAdmin) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (conAdmin) cabeceras.Authorization = 'Bearer ' + ADMIN;
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos;
  try { datos = JSON.parse(texto); } catch (e) { datos = { mensaje: texto.slice(0, 200) }; }
  return { estado: r.status, datos };
}

/* El cliente de prueba que se crea y se borra. */
const TENANT = 'zz-panel-prueba';
const REGISTRO = process.env.LICENCIAS_REGISTRO || path.join(RAIZ, 'datos', 'licencias-emitidas.json');

function borrarDelRegistro(tenant) {
  try {
    const lista = JSON.parse(fs.readFileSync(REGISTRO, 'utf8'));
    const quedan = lista.filter((l) => l.tenant !== tenant);
    fs.writeFileSync(REGISTRO, JSON.stringify(quedan, null, 2), { mode: 0o600 });
    return lista.length - quedan.length;
  } catch (e) {
    return 0;
  }
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - panel de licencias');
  console.log('  ' + '='.repeat(64));

  if (!ADMIN) {
    console.error('\n  Falta ADMIN_TOKEN. Configúrelo en el .env antes de probar.\n');
    process.exit(1);
  }

  try {
    const r = await fetch(BASE + '/api/salud');
    if (!r.ok) throw new Error('estado ' + r.status);
  } catch (e) {
    console.error('\n  El servidor de licencias no responde en ' + BASE);
    console.error('  Arránquelo con:  npm run licencias\n');
    process.exit(1);
  }

  // Se limpia cualquier resto de una corrida anterior y se crea el cliente.
  borrarDelRegistro(TENANT);
  const creada = await api('POST', '/api/admin/licencias', {
    tenant: TENANT,
    cliente: 'Cliente de Prueba del Panel',
    contacto: 'prueba@panel.local',
    dias: 30,
    tipo: 'prueba',
    modulos: ['registro', 'recepcion', 'gafetes', 'reportes'],
  }, true);

  if (creada.estado !== 201 && creada.estado !== 200) {
    console.error('\n  No se pudo crear el cliente de prueba: ' + JSON.stringify(creada.datos).slice(0, 200) + '\n');
    process.exit(1);
  }

  const id = creada.datos.licencia_id;
  console.log('  cliente de prueba: ' + id + ' (' + TENANT + ')');
  console.log('');

  try {
    /* ---------------------------------------------------------------- */
    console.log('Listar clientes');

    await prueba('la lista trae los clientes con lo que hace falta para decidir', async () => {
      const r = await api('GET', '/api/admin/clientes', undefined, true);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(Array.isArray(r.datos.clientes), 'no viene la lista');
      esperar(typeof r.datos.activos === 'number', 'no vienen los conteos');
      esperar(Array.isArray(r.datos.modulos_disponibles), 'no vienen los módulos disponibles');

      const mio = r.datos.clientes.find((c) => c.licencia_id === id);
      esperar(mio, 'el cliente de prueba no aparece');
      esperar(mio.activa === true, 'debería estar activo');
      esperar(mio.dias_restantes > 20 && mio.dias_restantes <= 30, 'días restantes raros: ' + mio.dias_restantes);
      esperar(mio.modulos.length === 4, 'debería tener 4 módulos y tiene ' + mio.modulos.length);
    });

    /* ---------------------------------------------------------------- */
    console.log('');
    console.log('Activar por ID (primer arranque de una instalación)');

    await prueba('el ID de la licencia activa una instalación nueva', async () => {
      // Esta es la ruta pública: la usa el sistema recién instalado.
      const r = await api('POST', '/api/licencia/activar-por-id', { licencia_id: id });
      esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
      esperar(r.datos.licencia, 'no vino la licencia firmada');
      esperar(r.datos.tenant === TENANT, 'el tenant es ' + r.datos.tenant);
      esperar(r.datos.cliente === 'Cliente de Prueba del Panel', 'el cliente es ' + r.datos.cliente);
      esperar((r.datos.modulos || []).length === 4, 'los módulos no coinciden');
    });

    await prueba('la licencia que entrega es válida y verificable', async () => {
      const r = await api('POST', '/api/licencia/activar-por-id', { licencia_id: id });
      const e = lic.evaluar(r.datos.licencia);
      esperar(e.valida === true, 'la licencia entregada no es válida: ' + e.estado);
      esperar(e.contenido.tenant === TENANT, 'el tenant de la licencia no coincide');
      esperar(e.contenido.modulos.length === 4, 'los módulos de la licencia no coinciden');
    });

    await prueba('el ID se puede escribir en minúsculas', async () => {
      // El cliente lo va a escribir a mano; exigir mayúsculas sería una trampa.
      const r = await api('POST', '/api/licencia/activar-por-id', { licencia_id: id.toLowerCase() });
      esperar(r.estado === 200, 'no lo aceptó en minúsculas: ' + r.estado);
    });

    await prueba('un ID que no existe se rechaza con un mensaje que se entiende', async () => {
      const r = await api('POST', '/api/licencia/activar-por-id', { licencia_id: 'LIC-NO-EXISTE' });
      esperar(r.estado === 404, 'debería ser 404 y fue ' + r.estado);
      esperar(/no existe/i.test(r.datos.mensaje || ''), 'el mensaje no lo explica: ' + r.datos.mensaje);
    });

    await prueba('sin ID se rechaza', async () => {
      const r = await api('POST', '/api/licencia/activar-por-id', {});
      esperar(r.estado === 400, 'debería ser 400 y fue ' + r.estado);
    });

    /* ---------------------------------------------------------------- */
    console.log('');
    console.log('Suspender y reactivar');

    await prueba('se puede suspender a un cliente con un motivo', async () => {
      const r = await api('POST', '/api/admin/clientes/' + id + '/estado', {
        activa: false,
        motivo: 'Factura de marzo sin pagar',
      }, true);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.estado === 'suspendida', 'quedó en ' + r.datos.estado);
      esperar(/marzo/.test(r.datos.suspendida_motivo || ''), 'no se guardó el motivo');
    });

    await prueba('un cliente suspendido ya NO puede activar una instalación', async () => {
      const r = await api('POST', '/api/licencia/activar-por-id', { licencia_id: id });
      esperar(r.estado === 403, 'debería ser 403 y fue ' + r.estado);
      esperar(/suspendida/i.test(r.datos.mensaje || ''), 'el mensaje no lo dice: ' + r.datos.mensaje);
      esperar(/marzo/.test(r.datos.mensaje || ''), 'el motivo no llega al cliente: ' + r.datos.mensaje);
    });

    await prueba('un cliente suspendido tampoco puede renovar', async () => {
      /* Es lo que permite cortar el servicio a distancia de verdad.
       *
       * Ahora hace falta el token de instalación, y el orden importa: sin token la
       * respuesta es 401 (no se le dice nada a quien no se ha identificado), y con
       * token válido es 403 por estar suspendido. Se comprueban las dos. */
      const sinToken = await api('POST', '/api/licencia/consultar', { tenant: TENANT, huella: null });
      esperar(sinToken.estado === 401, 'sin token debería ser 401 y fue ' + sinToken.estado);

      const conToken = await fetch(BASE + '/api/licencia/consultar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN_INSTALACION },
        body: JSON.stringify({ tenant: TENANT, huella: null }),
      });
      esperar(conToken.status === 403, 'con token válido debería ser 403 y fue ' + conToken.status);
    });

    await prueba('pero su historial sigue estando', async () => {
      // Suspender no es borrar: hay que poder ver qué pasó.
      const r = await api('GET', '/api/admin/clientes', undefined, true);
      const mio = r.datos.clientes.find((c) => c.licencia_id === id);
      esperar(mio, 'desapareció de la lista');
      esperar(mio.activa === false, 'debería salir como inactivo');
      esperar(mio.suspendida_motivo, 'no se ve el motivo en la lista');
    });

    await prueba('la lista pone primero a los que necesitan atención', async () => {
      const r = await api('GET', '/api/admin/clientes', undefined, true);
      esperar(r.datos.clientes[0].licencia_id === id,
        'el suspendido debería ir primero y va ' + r.datos.clientes[0].licencia_id);
    });

    await prueba('se puede reactivar', async () => {
      const r = await api('POST', '/api/admin/clientes/' + id + '/estado', { activa: true }, true);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.estado === 'activa', 'quedó en ' + r.datos.estado);
    });

    await prueba('reactivado, vuelve a poder activar', async () => {
      const r = await api('POST', '/api/licencia/activar-por-id', { licencia_id: id });
      esperar(r.estado === 200, 'estado ' + r.estado + ': ' + (r.datos.mensaje || ''));
    });

    /* ---------------------------------------------------------------- */
    console.log('');
    console.log('Cambiar los módulos');

    await prueba('se le pueden quitar módulos a un cliente', async () => {
      const r = await api('POST', '/api/admin/clientes/' + id + '/modulos', {
        modulos: ['registro', 'recepcion'],
      }, true);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.modulos.length === 2, 'quedaron ' + r.datos.modulos.length);
    });

    await prueba('el cambio llega a la licencia que se entrega', async () => {
      const r = await api('POST', '/api/licencia/activar-por-id', { licencia_id: id });
      esperar(r.estado === 200, 'estado ' + r.estado);
      const e = lic.evaluar(r.datos.licencia);
      esperar(e.contenido.modulos.length === 2, 'la licencia trae ' + e.contenido.modulos.length + ' módulos');
      esperar(e.contenido.modulos.indexOf('reportes') === -1, 'reportes debería estar fuera');
    });

    await prueba('un módulo que no existe se rechaza y dice cuáles valen', async () => {
      const r = await api('POST', '/api/admin/clientes/' + id + '/modulos', {
        modulos: ['registro', 'modulo-inventado'],
      }, true);
      esperar(r.estado === 400, 'debería ser 400 y fue ' + r.estado);
      esperar(/no existen/i.test(r.datos.mensaje || ''), 'el mensaje no lo explica');
      esperar(/vigilancia/.test(r.datos.mensaje || ''), 'no dice cuáles son válidos');
    });

    await prueba('quitarle todos los módulos es posible (dejar solo lo básico)', async () => {
      const r = await api('POST', '/api/admin/clientes/' + id + '/modulos', { modulos: [] }, true);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.modulos.length === 0, 'quedaron ' + r.datos.modulos.length);
    });

    /* ---------------------------------------------------------------- */
    console.log('');
    console.log('Historial y permisos');

    await prueba('el historial cuenta lo que ha pasado con la licencia', async () => {
      const r = await api('GET', '/api/admin/clientes/' + id + '/historial', undefined, true);
      esperar(r.estado === 200, 'estado ' + r.estado);
      esperar(r.datos.historial.length >= 4, 'solo hay ' + r.datos.historial.length + ' entradas');

      const acciones = r.datos.historial.map((h) => h.accion).join(' | ');
      esperar(/suspendida/.test(acciones), 'no consta la suspensión: ' + acciones);
      esperar(/reactivada/.test(acciones), 'no consta la reactivación: ' + acciones);
      esperar(/módulos cambiados/.test(acciones), 'no constan los cambios de módulos: ' + acciones);
    });

    await prueba('sin token de administración no se ve nada', async () => {
      for (const ruta of ['/api/admin/clientes', '/' + id + '/historial']) {
        const r = await api('GET', '/api/admin/clientes' === ruta ? ruta : '/api/admin/clientes/' + id + '/historial');
        esperar(r.estado === 401, ruta + ' respondió ' + r.estado + ' sin token');
      }
    });

    await prueba('con un token inventado tampoco', async () => {
      const r = await fetch(BASE + '/api/admin/clientes', { headers: { Authorization: 'Bearer inventado' } });
      esperar(r.status === 401, 'respondió ' + r.status);
    });
  } finally {
    const n = borrarDelRegistro(TENANT);
    console.log('');
    console.log('  (el cliente de prueba se borró' + (n ? '' : ' — no estaba') + ')');
  }

  console.log('');
  console.log('  ' + '='.repeat(64));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(64));
  if (fallos) {
    console.log('');
    for (const d of detalle) console.log('    ' + d);
  }
  console.log('');
  process.exit(fallos ? 1 : 0);
}

principal().catch((e) => {
  console.error('\n  Error: ' + e.message + '\n');
  try { borrarDelRegistro(TENANT); } catch (e2) { /* da igual */ }
  process.exit(1);
});
