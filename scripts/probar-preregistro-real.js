/**
 * VisitaFlow - El preregistro de punta a punta.
 *
 *   node scripts/probar-preregistro-real.js
 *
 * QUE ES UN PREREGISTRO
 * ---------------------
 * Alguien llama por telefono: "voy manana a las diez a ver a la presidenta". Se anota
 * en el sistema, y al llegar el visitante solo tiene que dar su codigo. Es lo que
 * evita que el recepcionista teclee todo de nuevo con la persona delante.
 *
 * QUE COMPRUEBA
 * -------------
 * El recorrido completo, que es donde aparecen los problemas:
 *
 *   1. Se anota la visita anunciada y sale un codigo.
 *   2. El codigo se puede buscar por telefono (llegar sin la cedula a mano).
 *   3. Al llegar, se registra la entrada con ese codigo.
 *   4. El preregistro queda USADO y enlazado a la visita. Esto es lo importante: si
 *      se quedara pendiente, apareceria para siempre en la lista de "por llegar" y
 *      nadie sabria quien ya vino.
 *   5. No se puede usar dos veces el mismo codigo.
 *   6. Un preregistro cancelado no sirve para entrar.
 *
 * Se limpia todo lo que deja.
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

const esperar = (cond, msg) => { if (!cond) throw new Error(msg || 'no se cumplió'); };

async function principal() {
  console.log('');
  console.log('  VisitaFlow - el preregistro, de punta a punta');
  console.log('  ' + '='.repeat(66));

  const cred = leerCredenciales();
  if (!cred || !cred.usuario) throw new Error('no se pudieron leer las credenciales');

  const sesion = await api('POST', '/api/acceso/entrar', { correo: cred.usuario, clave: cred.clave });
  if (sesion.estado !== 200) throw new Error('no se pudo entrar: ' + (sesion.datos.mensaje || sesion.estado));
  token = sesion.datos.token;
  bien('sesión iniciada');

  /* Los catálogos que hacen falta para anotar la visita. */
  const cfg = await api('GET', '/api/config');
  const c = cfg.datos.config || cfg.datos;
  const motivos = c.motivos || [];
  const departamentos = c.departamentos || [];

  if (!motivos.length) throw new Error('la institución no tiene motivos de visita: no se puede probar');
  bien('catálogos disponibles: ' + motivos.length + ' motivo(s), ' + departamentos.length + ' departamento(s)');

  /* Una cédula real del padrón. Hace falta porque esta institución exige la cédula
     para registrar (es un ajuste suyo), y además es lo normal: al anunciar una visita
     se apunta la cédula si se tiene. Lo que se está probando no es saltarse ese
     requisito, sino que el CÓDIGO sirva de llave para no teclear nada de nuevo. */
  const bd = require(path.join(RAIZ, 'src', 'db.js'));
  await bd.conectarPadron();
  const fila = await bd.consultarPadron(
    'SELECT TOP 1 Cedula FROM dbo.CIUDADANOS WHERE Cedula IS NOT NULL AND LEN(Cedula) >= 6 ORDER BY Cedula DESC'
  );
  const cedulaReal = String(fila.recordset[0].Cedula).trim();
  info('cédula de prueba: ' + cedulaReal);

  let idPreregistro = null;
  let idVisita = null;

  /* Una marca que no choque con nada, para poder reconocer y limpiar lo propio. */
  const marca = 'PRUEBA-PRE-' + Date.now().toString().slice(-6);
  const nombre = 'Visitante Anunciado ' + marca;

  try {
    /* ------------------------------------------------------------------ */
    paso('1. Anotar la visita anunciada');

    const alta = await api('POST', '/api/preregistros', {
      nombre_completo: nombre,
      cedula: cedulaReal,
      empresa: 'Empresa de Prueba',
      telefono: '809-555-0000',
      motivo_id: motivos[0].id,
      departamento_id: departamentos.length ? departamentos[0].id : null,
      visitado: 'Presidenta de la junta',
      acompanantes: 1,
      fecha_prevista: new Date(Date.now() + 3600000).toISOString(),
      notas: marca,
    });

    esperar(alta.estado === 200 || alta.estado === 201,
      'no se pudo anotar (estado ' + alta.estado + '): ' + (alta.datos.mensaje || alta.datos.motivo || ''));

    /* Lo que devuelve crear: { ok, id, codigo, vence, vigencia_horas }. El estado no
       viene, porque un preregistro recién creado siempre nace pendiente: se comprueba
       leyéndolo después, que es además lo que hace el recepcionista. */
    const pre = alta.datos;
    idPreregistro = pre.id;
    const codigo = pre.codigo;

    esperar(codigo, 'no devolvió ningún código');
    bien('quedó anotada con el código ' + codigo);
    if (pre.vence) info('vence: ' + String(pre.vence).slice(0, 16).replace('T', ' '));

    /* ------------------------------------------------------------------ */
    paso('2. Buscarla por el código, como se haría al llegar');

    const porCodigo = await api('GET', '/api/preregistros/codigo/' + encodeURIComponent(codigo));
    esperar(porCodigo.estado === 200, 'no se encontró por el código (estado ' + porCodigo.estado + ')');

    const encontrado = porCodigo.datos.preregistro;
    esperar(encontrado, 'no devolvió el preregistro');
    esperar(encontrado.nombre_completo === nombre, 'el nombre no coincide: ' + encontrado.nombre_completo);
    bien('se encuentra por el código, con su nombre');

    if (encontrado.estado === 'pendiente') {
      bien('nace como PENDIENTE, que es lo correcto');
    } else {
      mal('debería estar pendiente y está "' + encontrado.estado + '"');
    }

    /* Y que aparezca en la lista de los que están por llegar. */
    const pendientes = await api('GET', '/api/preregistros?estado=pendiente');
    const filas = (pendientes.datos.listado && pendientes.datos.listado.filas) || [];
    if (filas.some((f) => f.codigo === codigo)) {
      bien('aparece en la lista de visitas anunciadas');
    } else {
      mal('no aparece en la lista de pendientes (' + filas.length + ' filas)');
    }

    /* ------------------------------------------------------------------ */
    paso('3. Registrar la entrada con ese código');

    const entrada = await api('POST', '/api/registro', {
      codigo_preregistro: codigo,
      visitado: 'Presidenta de la junta',
      motivo_id: motivos[0].id,
    });

    if (entrada.estado === 200 || entrada.estado === 201) {
      bien('la entrada se registró usando el código');
      idVisita = entrada.datos.visita ? entrada.datos.visita.id : null;

      /* El nombre que sale NO es el del preregistro, y está bien: cuando hay cédula,
         el nombre lo pone el PADRÓN, que es la fuente de verdad. Quien anunció la
         visita pudo escribir el nombre de otra forma, o de oído por teléfono; el
         padrón manda. Lo que hay que comprobar es que la visita quedó con la persona
         correcta, no con el texto que se tecleó al anunciarla. */
      const v = entrada.datos.visita || {};
      if (v.cedula && String(v.cedula).replace(/\D/g, '') === cedulaReal.replace(/\D/g, '')) {
        bien('la visita quedó con la cédula anunciada (' + cedulaReal + ')');
      } else {
        mal('la visita quedó con otra cédula: ' + (v.cedula || 'ninguna'));
      }

      if (v.nombre_completo) {
        info('nombre en la visita: ' + v.nombre_completo);
      }

      /* ------------------------------------------------------------------ */
      paso('4. El preregistro tiene que quedar USADO y enlazado');

      const despues = await api('GET', '/api/preregistros/codigo/' + encodeURIComponent(codigo));
      const p2 = despues.datos.preregistro || {};

      if (p2.estado === 'usado') {
        bien('quedó como USADO');
      } else {
        mal('quedó como "' + p2.estado + '": seguiría apareciendo en la lista de por llegar');
      }

      if (idVisita && p2.visita_id === idVisita) {
        bien('quedó enlazado a la visita (' + idVisita + ')');
      } else if (p2.visita_id) {
        mal('quedó enlazado a otra visita: ' + p2.visita_id + ' en vez de ' + idVisita);
      } else {
        mal('no quedó enlazado a ninguna visita');
      }

      if (p2.usado) bien('consta la hora en que se usó');
      else mal('no consta cuándo se usó');

      /* Y ya no debe estar entre los pendientes. */
      const otraVez = await api('GET', '/api/preregistros?estado=pendiente');
      const filas2 = (otraVez.datos.listado && otraVez.datos.listado.filas) || [];
      if (!filas2.some((f) => f.codigo === codigo)) {
        bien('ya no aparece en la lista de visitas por llegar');
      } else {
        mal('sigue apareciendo como pendiente después de usarse');
      }

      /* ------------------------------------------------------------------ */
      paso('5. El mismo código no puede usarse dos veces');

      const repetido = await api('POST', '/api/registro', {
        codigo_preregistro: codigo,
        visitado: 'Presidenta de la junta',
        motivo_id: motivos[0].id,
      });

      if (repetido.estado >= 400) {
        bien('el segundo intento se rechazó (estado ' + repetido.estado + ')');
      } else {
        mal('EL MISMO CÓDIGO SIRVIÓ DOS VECES: se puede entrar de nuevo con un código ya usado');
        const idDoble = repetido.datos.visita ? repetido.datos.visita.id : null;
        if (idDoble) await api('POST', '/api/visitas/' + idDoble + '/anular', { motivo: 'Prueba' });
      }
    } else {
      mal('no se pudo registrar la entrada con el código (estado ' + entrada.estado + '): ' +
        (entrada.datos.mensaje || entrada.datos.motivo || ''));
      info('el preregistro quedó pendiente; se limpia más abajo');
    }

    /* ------------------------------------------------------------------ */
    paso('6. Un preregistro cancelado no sirve para entrar');

    const alta2 = await api('POST', '/api/preregistros', {
      nombre_completo: 'Cancelado ' + marca,
      cedula: cedulaReal,
      motivo_id: motivos[0].id,
      telefono: '809-555-0001',
      notas: marca,
    });

    const pre2 = alta2.datos.preregistro || alta2.datos;
    if (pre2 && pre2.codigo) {
      const cancelar = await api('DELETE', '/api/preregistros/' + pre2.id, { motivo: 'Prueba' });
      if (cancelar.estado === 200) {
        bien('se pudo cancelar');
      } else {
        info('no se pudo cancelar (estado ' + cancelar.estado + ')');
      }

      const conCancelado = await api('POST', '/api/registro', {
        codigo_preregistro: pre2.codigo,
        visitado: 'Alguien',
        motivo_id: motivos[0].id,
      });

      if (conCancelado.estado >= 400) {
        bien('un código cancelado NO sirve para entrar (estado ' + conCancelado.estado + ')');
      } else {
        mal('un código CANCELADO sirvió para entrar');
        const idMalo = conCancelado.datos.visita ? conCancelado.datos.visita.id : null;
        if (idMalo) await api('POST', '/api/visitas/' + idMalo + '/anular', { motivo: 'Prueba' });
      }

      /* Limpieza del segundo. */
      try { await api('DELETE', '/api/preregistros/' + pre2.id, { motivo: 'Limpieza' }); } catch (e) { /* da igual */ }
    } else {
      info('no se pudo crear el segundo preregistro para probar la cancelación');
    }
  } finally {
    /* Limpieza: cerrar la visita y cancelar el preregistro que quede. */
    if (idVisita) {
      try {
        await api('POST', '/api/visitas/' + idVisita + '/salida', {});
        await api('POST', '/api/visitas/' + idVisita + '/anular', { motivo: 'Prueba terminada' });
      } catch (e) { /* da igual */ }
    }
    if (idPreregistro) {
      try { await api('DELETE', '/api/preregistros/' + idPreregistro, { motivo: 'Limpieza' }); } catch (e) { /* da igual */ }
    }
  }

  /* ------------------------------------------------------------------ */
  paso('7. Que no quede basura');

  const restos = await api('GET', '/api/preregistros?texto=' + encodeURIComponent(marca));
  const filas = (restos.datos.listado && restos.datos.listado.filas) || [];
  const vivos = filas.filter((f) => f.estado === 'pendiente');
  if (!vivos.length) {
    bien('no quedó ningún preregistro pendiente de la prueba');
  } else {
    mal('quedaron ' + vivos.length + ' preregistro(s) pendientes de la prueba');
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
