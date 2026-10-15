/**
 * VisitaFlow - La lista de vigilancia IMPIDE de verdad, o solo avisa?
 *
 *   node scripts/probar-vigilancia-real.js
 *
 * LA PREGUNTA
 * -----------
 * Las pruebas comprueban que la API dice "esta cedula esta bloqueada". Eso no es lo
 * mismo que impedir que entre: si la comprobacion solo pinta un aviso en la pantalla,
 * cualquiera que llame a la API directamente -o que use una pantalla que no lo
 * compruebe- registra a una persona bloqueada.
 *
 * Esta prueba lo comprueba por la API, sin pantalla de por medio: se bloquea una
 * cedula, se intenta registrar su entrada, y se mira que pasa. Despues se mira si la
 * vigilancia quedo anotada, porque "bloqueado" sin constancia de quien lo intento no
 * sirve para nada.
 *
 * Se limpia todo lo que deja.
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

/** Una cédula real del padrón, para que el registro no falle por otra razón. */
async function unaCedulaReal() {
  await bd.conectarPadron();
  const r = await bd.consultarPadron(
    'SELECT TOP 1 Cedula FROM dbo.CIUDADANOS WHERE Cedula IS NOT NULL AND LEN(Cedula) >= 6 ORDER BY Cedula DESC'
  );
  return String(r.recordset[0].Cedula).trim();
}

async function principal() {
  console.log('');
  console.log('  VisitaFlow - la vigilancia impide, o solo avisa');
  console.log('  ' + '='.repeat(66));

  /* Entrar. */
  const cred = leerCredenciales();
  if (!cred || !cred.usuario) throw new Error('no se pudieron leer las credenciales del administrador');

  const sesion = await api('POST', '/api/acceso/entrar', { correo: cred.usuario, clave: cred.clave });
  if (sesion.estado !== 200) throw new Error('no se pudo entrar: ' + (sesion.datos.mensaje || sesion.estado));
  token = sesion.datos.token;
  bien('sesión iniciada como ' + sesion.datos.usuario.nombre);

  const cedula = await unaCedulaReal();
  info('cédula de prueba: ' + cedula);

  /* Un motivo real: el registro lo exige, y sin él la prueba fallaría por una razón
     que no tiene nada que ver con la vigilancia. */
  let motivoId = null;
  try {
    const cfg = await api('GET', '/api/config');
    const motivos = (cfg.datos.config && cfg.datos.config.motivos) || cfg.datos.motivos || [];
    if (motivos.length) motivoId = motivos[0].id;
  } catch (e) { /* se sigue sin motivo */ }
  info('motivo de la visita: ' + (motivoId || 'ninguno'));

  let idVigilancia = null;

  /* Cuántos avisos había antes, para poder decir si esta corrida añadió el suyo. */
  const previos = await api('GET', '/api/vigilancia/avisos?cedula=' + cedula);
  const pagPrevios = previos.datos.listado || {};
  const avisosAntes = (Array.isArray(pagPrevios) ? pagPrevios : (pagPrevios.filas || [])).length;

  try {
    /* ------------------------------------------------------------------ */
    paso('1. Bloquear la cédula en la lista de vigilancia');

    const alta = await api('POST', '/api/vigilancia', {
      cedula,
      tipo: 'bloqueado',
      motivo: 'Prueba automática de vigilancia',
      severidad: 'alta',
    });
    esperar(alta.estado === 200 || alta.estado === 201,
      'no se pudo bloquear (estado ' + alta.estado + '): ' + (alta.datos.mensaje || ''));
    idVigilancia = alta.datos.vigilancia ? alta.datos.vigilancia.id : alta.datos.id;
    bien('la cédula quedó bloqueada' + (idVigilancia ? ' (id ' + idVigilancia + ')' : ''));

    const consulta = await api('GET', '/api/vigilancia/cedula/' + cedula);
    esperar(consulta.datos.vigilancia && consulta.datos.vigilancia.bloqueado, 'la API no la reporta como bloqueada');
    bien('la API la reporta como bloqueada');

    /* ------------------------------------------------------------------ */
    paso('2. Intentar registrar su entrada — esto es lo que importa');

    const registro = await api('POST', '/api/registro', {
      cedula,
      visitado: 'Administrador',
      motivo_id: motivoId,
    });

    /* Lo importante NO es el código exacto, es que NO se registre. */
    if (registro.estado >= 400) {
      bien('la entrada NO se registró (estado ' + registro.estado + ')');
      const m = (registro.datos.mensaje || registro.datos.motivo || '').toLowerCase();
      if (m.indexOf('bloquead') !== -1) {
        bien('el motivo dice que está bloqueada, no un error genérico');
      } else {
        info('el mensaje no menciona el bloqueo: "' + (registro.datos.mensaje || registro.datos.motivo || '') + '"');
      }
    } else {
      mal('LA ENTRADA SE REGISTRÓ con la cédula bloqueada (estado ' + registro.estado + '). ' +
        'La lista de vigilancia solo está avisando, no impidiendo.');

      /* Si se registró, se limpia esa visita para no dejar basura. */
      const idVisita = registro.datos.visita ? registro.datos.visita.id : null;
      if (idVisita) {
        await api('POST', '/api/visitas/' + idVisita + '/anular', { motivo: 'Prueba de vigilancia' });
        info('se anuló la visita que se coló (id ' + idVisita + ')');
      }
    }

    /* ------------------------------------------------------------------ */
    paso('3. Que haya quedado constancia del intento');

    /* La respuesta viene paginada: { listado: { filas, total } }. Confundir eso con
       un arreglo da "no quedó anotado" cuando sí quedó, que es un falso negativo. */
    const avisos = await api('GET', '/api/vigilancia/avisos?cedula=' + cedula);
    const paginado = avisos.datos.listado || {};
    const lista = Array.isArray(paginado) ? paginado : (paginado.filas || []);

    /* Se mira lo que AÑADIÓ esta corrida, no el total: la API no filtra por
       vigilancia_id, y leer todos los avisos de esa cédula arrastra los de corridas
       anteriores. Contar la diferencia es lo que dice si ESTA prueba anotó, y de paso
       detecta que se anote dos veces el mismo intento. */
    const nuevos = lista.length - avisosAntes;

    if (nuevos === 1) {
      bien('quedó anotado el intento (exactamente un aviso)');
    } else if (nuevos > 1) {
      mal('se anotó ' + nuevos + ' veces el mismo intento: la tabla se llena de ruido');
    } else {
      mal('NO quedó anotado el intento: el vigilante no puede saber que alguien ' +
        'bloqueado intentó entrar, que es para lo que sirve la lista');
    }

    if (nuevos >= 1 && lista.length) {
      if (lista[0].decision === 'denegado') {
        bien('consta como DENEGADO, que es lo que pasó');
      } else {
        mal('consta como "' + lista[0].decision + '" y se denegó la entrada');
      }

      if (lista[0].operador) bien('consta QUIÉN lo intentó: ' + lista[0].operador);
      else info('no consta el operador');

      info('motivo: ' + (lista[0].motivo || '—'));
    }

    /* ------------------------------------------------------------------ */
    paso('4. Con la cédula desbloqueada, el registro sí tiene que funcionar');

    /* Esto comprueba que el bloqueo es lo que impedía, y no otra cosa que estuviera
       rota: si al quitar el bloqueo el registro sigue fallando, el problema es otro. */
    await api('DELETE', '/api/vigilancia/' + idVigilancia, { motivo: 'Prueba terminada' });
    idVigilancia = null;

    const despues = await api('POST', '/api/registro', {
      cedula,
      visitado: 'Administrador',
      motivo_id: motivoId,
    });

    if (despues.estado === 200 || despues.estado === 201) {
      bien('desbloqueada, la entrada sí se registra (el bloqueo era lo que impedía)');
      const idVisita = despues.datos.visita ? despues.datos.visita.id : null;
      if (idVisita) {
        await api('POST', '/api/visitas/' + idVisita + '/salida', {});
        info('visita de prueba cerrada');
      }
    } else {
      mal('desbloqueada TAMPOCO se registra (estado ' + despues.estado + '): ' +
        (despues.datos.mensaje || despues.datos.motivo || '') +
        ' — el bloqueo no era la causa, hay otro problema');
    }
  } finally {
    /* Limpieza: no debe quedar ni el bloqueo ni restos.
     *
     * Los avisos se borran por la base y no por la API, porque la API no permite
     * borrarlos: son constancia de auditoría y no deben poder borrarse desde fuera.
     * Que la prueba los limpie por dentro es correcto; que lo pudiera hacer un
     * usuario con la API, no. */
    if (idVigilancia) {
      try { await api('DELETE', '/api/vigilancia/' + idVigilancia, { motivo: 'Limpieza' }); } catch (e) { /* da igual */ }
    }
    try {
      await bd.conectarSistema();
      const r = await bd.consultar('DELETE FROM vf_vigilancia_avisos WHERE cedula = @c', { c: cedula });
      if (r.rowsAffected[0]) info('se borraron los ' + r.rowsAffected[0] + ' aviso(s) de la prueba');

      /* El registro de vigilancia se borra DE VERDAD y no con la API, porque la API
       * hace baja lógica: lo marca inactivo y lo deja en el historial. Eso es lo
       * correcto para el sistema (levantar un bloqueo no debe borrar su rastro),
       * pero una prueba que se ejecuta muchas veces iría dejando registros
       * inactivos. Se borran por dentro, que para eso la prueba es del proyecto. */
      const v = await bd.consultar(
        "DELETE FROM vf_vigilancia WHERE cedula = @c AND motivo = 'Prueba automática de vigilancia'",
        { c: cedula }
      );
      if (v.rowsAffected[0]) info('se borraron los ' + v.rowsAffected[0] + ' registro(s) de la prueba');
    } catch (e) {
      info('no se pudieron borrar los restos de la prueba: ' + e.message);
    }
  }

  /* ------------------------------------------------------------------ */
  paso('5. La limpieza');

  const quedan = await api('GET', '/api/vigilancia/cedula/' + cedula);
  if (!quedan.datos.vigilancia || !quedan.datos.vigilancia.bloqueado) {
    bien('la cédula quedó desbloqueada');
  } else {
    mal('la cédula quedó bloqueada: la prueba dejó basura');
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
