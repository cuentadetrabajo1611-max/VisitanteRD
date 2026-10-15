/**
 * VisitaFlow - Alguien llega SIN CÉDULA.
 *
 *   node scripts/probar-sin-cedula.js
 *
 * POR QUE
 * -------
 * Es el caso mas comun en una puerta: el visitante no trae la cedula. El sistema tiene
 * un ajuste para decidirlo: `exigir_cedula`. Con el activado (viene asi de fabrica) hay
 * que teclearla; con el desactivado se registra con el nombre.
 *
 * Lo que se comprueba aqui, y que no estaba probado:
 *
 *   1. Con el ajuste en exigir, sin cedula NO se puede registrar, y el motivo lo dice.
 *   2. Con el ajuste en NO exigir, se registra escribiendo el nombre a mano.
 *   3. El nombre que se escribe es el que queda en la bitacora, sin inventarse nada.
 *   4. Se puede buscar despues por ese nombre.
 *   5. Al visitante sin cedula no se le confunde con otro que si la tenga.
 *
 * Se deja el ajuste como estaba, aunque la prueba falle.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const { leerCredenciales } = require(path.join(RAIZ, 'scripts', 'credenciales.js'));

const BASE = 'http://localhost:' + config.servidor.puerto;

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

let token = null;

async function api(metodo, ruta, cuerpo) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (token) cabeceras.Authorization = 'Bearer ' + token;

  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });

  let datos = null;
  const texto = await r.text();
  try { datos = JSON.parse(texto); } catch (e) { datos = { crudo: texto.slice(0, 200) }; }
  return { estado: r.status, datos };
}

/** Cambia (o devuelve) el ajuste de exigir cedula.
 *
 * `guardarAjustes` espera un OBJETO {clave: valor}, no un arreglo. Y la lectura va por
 * `valores`, que es donde vienen los valores; `ajustes` es la metadata (para que sirve
 * cada uno), no lo que tiene puesto. Confundirlos hace que la prueba no cambie nada y
 * parezca que el ajuste no funciona. */
async function ponerExigirCedula(valor) {
  return api('PATCH', '/api/config/ajustes', { ajustes: { exigir_cedula: valor ? '1' : '0' } });
}

async function leerExigirCedula() {
  const cfg = await api('GET', '/api/config');
  const c = cfg.datos.config || cfg.datos;
  const v = (c.valores || {}).exigir_cedula;
  return v === undefined || v === null ? null : String(v);
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - el visitante que llega sin cédula');
  console.log('  ' + '='.repeat(66));

  const cred = leerCredenciales();
  const sesion = await api('POST', '/api/acceso/entrar', { correo: cred.usuario, clave: cred.clave });
  if (sesion.estado !== 200) throw new Error('no se pudo entrar');
  token = sesion.datos.token;
  bien('sesión iniciada');

  const cfg = await api('GET', '/api/config');
  const c = cfg.datos.config || cfg.datos;
  const motivos = c.motivos || [];
  if (!motivos.length) throw new Error('no hay motivos de visita');

  const original = await leerExigirCedula();
  info('el ajuste "exigir cédula" está en: ' + original);

  const marca = 'SC-' + Date.now().toString().slice(-6);
  const nombre = 'Persona Sin Cedula ' + marca;
  const visitas = [];

  try {
    /* ------------------------------------------------------------------ */
    paso('1. Con el ajuste EXIGIENDO cédula, no se puede registrar sin ella');

    await ponerExigirCedula(true);
    bien('ajuste puesto en exigir la cédula');

    const sinCedula = await api('POST', '/api/registro', {
      nombre_completo: nombre,
      visitado: 'Administrador',
      motivo_id: motivos[0].id,
    });

    if (sinCedula.estado >= 400) {
      bien('se rechazó (estado ' + sinCedula.estado + ')');
      const m = (sinCedula.datos.mensaje || sinCedula.datos.motivo || '');
      if (/c[eé]dula/i.test(m)) {
        bien('el motivo habla de la cédula: "' + m.slice(0, 70) + '"');
      } else {
        mal('el motivo no menciona la cédula, así que el recepcionista no sabe qué falta: "' + m + '"');
      }
    } else {
      mal('SE REGISTRÓ sin cédula con el ajuste exigiéndola (estado ' + sinCedula.estado + ')');
      if (sinCedula.datos.visita) visitas.push(sinCedula.datos.visita.id);
    }

    /* ------------------------------------------------------------------ */
    paso('2. Con el ajuste SIN exigir, se registra escribiendo el nombre');

    await ponerExigirCedula(false);
    bien('ajuste puesto en no exigir la cédula');

    const conNombre = await api('POST', '/api/registro', {
      nombre_completo: nombre,
      visitado: 'Administrador',
      motivo_id: motivos[0].id,
      empresa: 'Sin identificación',
    });

    if (conNombre.estado === 200 || conNombre.estado === 201) {
      bien('se registró escribiendo el nombre');
      const v = conNombre.datos.visita || {};
      if (v.id) visitas.push(v.id);

      /* ------------------------------------------------------------------ */
      paso('3. El nombre que queda es el que se escribió');

      if (v.nombre_completo === nombre) {
        bien('el nombre quedó tal cual se escribió');
      } else {
        mal('quedó otro nombre: "' + (v.nombre_completo || '') + '" en vez de "' + nombre + '"');
      }

      if (!v.cedula || String(v.cedula).trim() === '') {
        bien('la visita quedó sin cédula (no se inventó ninguna)');
      } else {
        mal('se le puso una cédula que nadie dio: ' + v.cedula);
      }

      /* ------------------------------------------------------------------ */
      paso('4. Se puede encontrar después en la bitácora');

      /* Se busca por el NOMBRE COMPLETO, no por la marca suelta: el filtro mira también
         el campo de empresa, y con la marca a secas entraba la otra visita de prueba y
         la comprobación no distinguía una de otra. */
      const lista = await api('GET', '/api/visitas?texto=' + encodeURIComponent(nombre));
      const filas = (lista.datos.listado && lista.datos.listado.filas) || [];
      /* En el LISTADO el campo se llama `nombre`; `nombre_completo` es como se llama en
         el detalle de una visita. Usar el equivocado hace que la búsqueda parezca rota
         cuando funciona. */
      const encontrada = filas.find((f) => f.nombre === nombre);

      if (encontrada) {
        bien('se encuentra buscándola por su nombre');
      } else {
        mal('no se encuentra en la bitácora por su nombre (' + filas.length + ' fila(s))');
      }

      /* ------------------------------------------------------------------ */
      paso('5. No se confunde con quien sí tiene cédula');

      const dos = await api('POST', '/api/registro', {
        cedula: '00100000017',
        visitado: 'Administrador',
        motivo_id: motivos[0].id,
      });

      if (dos.estado === 200 || dos.estado === 201) {
        const v2 = dos.datos.visita || {};
        if (v2.id) visitas.push(v2.id);

        if (v2.cedula && String(v2.cedula).replace(/\D/g, '') === '00100000017') {
          bien('el que sí trae cédula queda con la suya');
        } else {
          mal('el visitante con cédula quedó con: ' + (v2.cedula || 'ninguna'));
        }

        if (v2.nombre_completo !== nombre) {
          bien('y no se mezcló con el que vino sin cédula');
        } else {
          mal('los dos quedaron con el mismo nombre');
        }
      } else {
        info('no se pudo registrar al de la cédula (estado ' + dos.estado + ')');
      }
    } else {
      mal('con el ajuste sin exigir, TAMPOCO se pudo registrar sin cédula (estado ' +
        conNombre.estado + '): ' + (conNombre.datos.mensaje || conNombre.datos.motivo || ''));
    }
  } finally {
    /* Se devuelve el ajuste a como estaba: es configuración del cliente. */
    const valorOriginal = original === '1' || original === 'true';
    await ponerExigirCedula(valorOriginal);
    const comprobado = await leerExigirCedula();
    if (comprobado === original) {
      info('el ajuste quedó como estaba (' + comprobado + ')');
    } else {
      mal('el ajuste quedó en ' + comprobado + ' y estaba en ' + original);
    }

    /* Y se cierran las visitas de prueba. */
    for (const id of visitas) {
      try {
        await api('POST', '/api/visitas/' + id + '/salida', {});
        await api('POST', '/api/visitas/' + id + '/anular', { motivo: 'Prueba terminada' });
      } catch (e) { /* da igual */ }
    }
    if (visitas.length) info('se cerraron ' + visitas.length + ' visita(s) de prueba');
  }
}

let error = null;

async function correr() {
  try {
    await principal();
  } catch (e) {
    error = e;
  }

  console.log('');
  console.log('  ' + '='.repeat(66));
  console.log('  ' + ok + ' pruebas correctas, ' + fallos + ' fallidas');
  console.log('  ' + '='.repeat(66));
  if (error) console.log('  Se detuvo: ' + error.message);
  if (detalles.length) {
    console.log('');
    for (const d of detalles) console.log('    ' + d);
  }
  console.log('');

  process.exitCode = (fallos || error) ? 1 : 0;
}

correr();
