/**
 * VisitaFlow - Los permisos por rol, comprobados desde fuera.
 *
 *   node scripts/probar-permisos.js
 *
 * POR QUE
 * -------
 * El recepcionista de la puerta no deberia poder crear usuarios, ni cambiar la
 * configuracion, ni borrar la lista de vigilancia, ni ver los reportes si la institucion
 * no quiere. Eso lo decide el rol, y el rol se comprueba en el servidor.
 *
 * Lo que se comprueba aqui es lo que de verdad importa: que un OPERADOR reciba un 403
 * en las rutas que no le tocan. Una pantalla que esconde un boton no protege nada: si la
 * ruta no comprueba el permiso, cualquiera la llama.
 *
 * Se crea un usuario operador de prueba para poder entrar como el, se comprueba todo, y
 * se borra. El administrador no se toca.
 */
'use strict';

const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const config = require(path.join(RAIZ, 'src', 'config.js'));
const bd = require(path.join(RAIZ, 'src', 'db.js'));
const { leerCredenciales } = require(path.join(RAIZ, 'scripts', 'credenciales.js'));

const BASE = 'http://localhost:' + config.servidor.puerto;

let ok = 0;
let fallos = 0;
const detalles = [];

function bien(t) { ok++; console.log('  [ok]    ' + t); }
function mal(t) { fallos++; detalles.push(t); console.log('  [FALLO] ' + t); }
function info(t) { console.log('          ' + t); }
function paso(t) { console.log(''); console.log('  ' + t); }

/** Una peticion con el token que se le pase. */
async function api(metodo, ruta, cuerpo, token) {
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

/** Las rutas que un OPERADOR no debe poder usar, con el permiso que las protege. */
const PROHIBIDAS = [
  { metodo: 'POST', ruta: '/api/usuarios', cuerpo: { nombre: 'Intruso', correo: 'intruso@x.local', clave: 'Clave123!', rol: 'admin' }, permiso: 'usuarios.crear', que: 'crear un usuario' },
  { metodo: 'GET', ruta: '/api/usuarios', permiso: 'usuarios.ver', que: 'ver la lista de usuarios' },
  { metodo: 'PATCH', ruta: '/api/config/ajustes', cuerpo: { ajustes: { exigir_cedula: '0' } }, permiso: 'config.editar', que: 'cambiar la configuración' },
  /* Cambiar la personalización es PATCH /api/personalizacion (el POST es para el logo).
     Con el método equivocado la petición no llegaba a ninguna ruta y la prueba daba un
     404 que parecía un fallo de permisos. */
  { metodo: 'PATCH', ruta: '/api/personalizacion', cuerpo: { nombre_comercial: 'Otro nombre' }, permiso: 'personalizacion.editar', que: 'cambiar la personalización' },
  { metodo: 'POST', ruta: '/api/vigilancia', cuerpo: { cedula: '00100000017', tipo: 'bloqueado', motivo: 'Intruso' }, permiso: 'vigilancia.editar', que: 'añadir a la lista de vigilancia' },
  { metodo: 'GET', ruta: '/api/reportes/resumen', permiso: 'reportes.ver', que: 'ver los reportes' },
  /* Anular una visita NO es un DELETE: es POST a /anular. Con el método equivocado la
     petición ni llegaba a la ruta, así que la prueba no comprobaba nada. */
  { metodo: 'POST', ruta: '/api/visitas/1/anular', cuerpo: { motivo: 'Intruso' }, permiso: 'recepcion.anular', que: 'anular una visita' },
  { metodo: 'PUT', ruta: '/api/usuarios/roles/operator', cuerpo: { permisos: ['config.editar', 'usuarios.editar'] }, permiso: 'usuarios.editar', que: 'cambiarse sus propios permisos' },
];

/** Las que un operador SÍ debe poder usar: es su trabajo. */
const PERMITIDAS = [
  { metodo: 'GET', ruta: '/api/panel', que: 'ver el panel' },
  { metodo: 'GET', ruta: '/api/visitas?estado=dentro', que: 'ver los visitantes dentro' },
  { metodo: 'GET', ruta: '/api/registro/buscar?q=00100000017', que: 'buscar una cédula' },
];

async function principal() {
  console.log('');
  console.log('  VisitaFlow - permisos por rol, desde fuera');
  console.log('  ' + '='.repeat(66));

  const cred = leerCredenciales();
  const admin = await api('POST', '/api/acceso/entrar', { correo: cred.usuario, clave: cred.clave });
  if (admin.estado !== 200) throw new Error('no se pudo entrar como administrador');
  const tokenAdmin = admin.datos.token;
  bien('entré como administrador');
  info('permisos del administrador: ' + (admin.datos.permisos || []).length);

  /* ------------------------------------------------------------------ */
  paso('1. Crear un operador de prueba');

  const marca = Date.now().toString().slice(-6);
  const correo = 'operador-' + marca + '@prueba.local';
  const clave = 'ClaveOperador123!';

  const creado = await api('POST', '/api/usuarios', {
    nombre: 'Operador de Prueba ' + marca,
    correo,
    clave,
    rol: 'operator',
  }, tokenAdmin);

  if (creado.estado !== 200 && creado.estado !== 201) {
    throw new Error('no se pudo crear el operador (estado ' + creado.estado + '): ' +
      (creado.datos.mensaje || creado.datos.motivo || ''));
  }

  const idOperador = creado.datos.usuario ? creado.datos.usuario.id : creado.datos.id;
  bien('operador creado (id ' + idOperador + ')');

  try {
    /* ------------------------------------------------------------------ */
    paso('2. Entrar como el operador');

    const sesion = await api('POST', '/api/acceso/entrar', { correo, clave });
    if (sesion.estado !== 200) throw new Error('el operador no pudo entrar');

    const tokenOperador = sesion.datos.token;
    const permisos = sesion.datos.permisos || [];
    bien('el operador entra, con ' + permisos.length + ' permisos');
    info('sus permisos: ' + permisos.join(', '));

    /* Un operador no debe tener los permisos de administración. */
    const peligrosos = ['usuarios.crear', 'usuarios.editar', 'config.editar', 'reportes.ver', 'vigilancia.editar', 'recepcion.anular'];
    const tiene = peligrosos.filter((p) => permisos.indexOf(p) !== -1);
    if (!tiene.length) {
      bien('no tiene ninguno de los permisos peligrosos');
    } else {
      mal('el operador TIENE permisos que no le tocan: ' + tiene.join(', '));
    }

    /* ------------------------------------------------------------------ */
    paso('3. Lo que un operador NO puede hacer (tiene que dar 403)');

    for (const r of PROHIBIDAS) {
      const res = await api(r.metodo, r.ruta, r.cuerpo, tokenOperador);

      if (res.estado === 403) {
        bien('no puede ' + r.que + ' (403)');
      } else if (res.estado === 404) {
        /* Un 404 aquí significa que la ruta no existe o que el permiso se comprueba
           DESPUÉS de buscar el registro. Las dos cosas son un problema para una
           prueba: no está comprobando lo que cree. */
        mal('al intentar ' + r.que + ' respondió 404 en vez de 403: o la ruta no existe, ' +
          'o el permiso se comprueba después de buscar');
      } else {
        mal('PUEDE ' + r.que + ' (estado ' + res.estado + ', permiso ' + r.permiso + '). ' +
          'Una pantalla que esconde el botón no protege nada.');
      }
    }

    /* ------------------------------------------------------------------ */
    paso('4. Lo que un operador SÍ puede hacer (es su trabajo)');

    for (const r of PERMITIDAS) {
      const res = await api(r.metodo, r.ruta, r.cuerpo, tokenOperador);

      if (res.estado === 200) {
        bien('sí puede ' + r.que);
      } else {
        mal('NO puede ' + r.que + ' (estado ' + res.estado + '): el operador no podría trabajar');
      }
    }

    /* ------------------------------------------------------------------ */
    paso('5. Un operador no puede cambiarse el rol a sí mismo');

    const ascenso = await api('PATCH', '/api/usuarios/' + idOperador, { rol: 'admin' }, tokenOperador);

    if (ascenso.estado === 403) {
      bien('no puede ascenderse a administrador (403)');
    } else {
      mal('UN OPERADOR PUDO CAMBIARSE EL ROL (estado ' + ascenso.estado + '): puede hacerse administrador');

      /* Si se ascendió, se comprueba y se deja dicho. */
      const comprobar = await api('GET', '/api/usuarios', undefined, tokenOperador);
      if (comprobar.estado === 200) {
        mal('y además ya puede ver la lista de usuarios: el ascenso funcionó de verdad');
      }
    }

    /* ------------------------------------------------------------------ */
    paso('6. El administrador sí puede lo que el operador no');

    for (const r of PROHIBIDAS.slice(0, 6)) {
      /* Se prueban solo las de lectura o las que no dejan basura. */
      if (r.metodo !== 'GET') continue;
      const res = await api(r.metodo, r.ruta, r.cuerpo, tokenAdmin);
      if (res.estado === 200) {
        bien('el administrador sí puede ' + r.que);
      } else {
        mal('el administrador TAMPOCO puede ' + r.que + ' (estado ' + res.estado + ')');
      }
    }
  } finally {
    /* Se borra el operador de prueba, pase lo que pase.
     *
     * Por la API queda INACTIVO, no se borra: la baja de usuarios es lógica a propósito,
     * porque hay que poder saber quién tuvo acceso. Eso está bien para el sistema, pero
     * una prueba que corre muchas veces iría dejando un usuario inactivo cada vez. Se
     * borra de verdad por la base, y solo el que creó esta corrida. */
    if (idOperador) {
      const baja = await api('DELETE', '/api/usuarios/' + idOperador, { motivo: 'Prueba terminada' }, tokenAdmin);
      if (baja.estado === 200) info('el operador quedó dado de baja');

      try {
        await bd.conectarSistema();
        const r = await bd.consultar(
          'DELETE FROM vf_usuarios WHERE id = @id AND correo = @correo',
          { id: idOperador, correo }
        );
        if (r.rowsAffected[0]) info('y se borró de la base (no queda el resto de la prueba)');
      } catch (e) {
        mal('no se pudo borrar el operador de prueba: ' + e.message);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  paso('7. Que no quede el usuario de prueba');

  const lista = await api('GET', '/api/usuarios', undefined, tokenAdmin);
  const usuarios = (lista.datos.usuarios || lista.datos.listado || []);
  const suelto = usuarios.find((u) => u.correo === correo);

  /* La baja de usuarios es LÓGICA: se marca inactivo y se queda en el historial, que es
     lo correcto (hay que poder saber quién tuvo acceso). Así que lo que se comprueba no
     es que desaparezca, sino que NO quede activo y no pueda entrar. */
  if (!suelto) {
    bien('no quedó ningún usuario de prueba');
  } else if (suelto.activo === false || suelto.activo === 0) {
    bien('el usuario de prueba quedó inactivo (baja lógica, como debe ser)');

    const intento = await api('POST', '/api/acceso/entrar', { correo, clave: 'ClaveOperador123!' });
    if (intento.estado !== 200) {
      bien('y ya no puede entrar (estado ' + intento.estado + ')');
    } else {
      mal('un usuario dado de baja SIGUE PUDIENDO ENTRAR');
    }
  } else {
    mal('el usuario de prueba quedó ACTIVO: ' + correo);
  }
}

let error = null;

async function correr() {
  try {
    await principal();
  } catch (e) {
    error = e;
  }

  try { await bd.cerrar(); } catch (e) { /* da igual */ }

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
