/**
 * VisitaFlow - Aviso al anfitrion cuando llega una visita.
 *
 *   await avisos.avisarDeVisita(tenantId, visita, persona, departamento);
 *
 * QUE HACE
 * --------
 * Cuando se registra una visita, avisa a quien la recibe. El aviso se guarda
 * SIEMPRE en la base, y ademas se intenta mandar por correo si hay servidor de
 * correo configurado.
 *
 * POR QUE SE GUARDA AUNQUE NO HAYA CORREO
 * ---------------------------------------
 * Una junta de vecinos puede no tener correo configurado, y quedarse sin avisar
 * seria peor que no mandar el correo. El aviso queda en la base con estado
 * "sin_correo" y se ve igual en la pantalla de Recepcion. El correo es un extra,
 * no el canal principal.
 *
 * POR QUE EL CORREO ESTA ESCRITO AQUI Y NO ES UNA LIBRERIA
 * --------------------------------------------------------
 * El sistema tiene seis dependencias y ninguna sobra. Enviar un correo son unas
 * cien lineas de protocolo SMTP; traer una libreria para eso significaria
 * revisarla y actualizarla cada vez que salga un aviso de seguridad, en un
 * sistema que se instala en el servidor de un cliente y se queda ahi.
 *
 * Se implementa lo minimo: EHLO, AUTH LOGIN si hace falta, STARTTLS si el
 * servidor lo ofrece, y un mensaje. Nada de adjuntos ni de HTML complicado.
 */
'use strict';

const net = require('net');
const tls = require('tls');
const os = require('os');

const sql = require('mssql');

const config = require('./config');
const bd = require('./db');
const util = require('./util');

/* ------------------------------------------------------------------ */
/* Cliente SMTP minimo                                                 */
/* ------------------------------------------------------------------ */

/**
 * Envia un correo por SMTP.
 *
 * Devuelve { ok: true } o { ok: false, motivo }.
 *
 * Nota sobre los tiempos: todo tiene un limite. Un servidor de correo que no
 * responde no puede dejar colgada la pantalla de recepcion, que es lo que el
 * recepcionista esta esperando para imprimir el gafete.
 */
function enviarCorreo(destinatario, asunto, cuerpo) {
  return new Promise((resolve) => {
    const c = config.correo;

    if (!c.activo) return resolve({ ok: false, motivo: 'El correo no está activado (CORREO_ACTIVO=0).' });
    /* La dirección se valida ANTES que el servidor: si el destinatario está mal
       escrito, ese es el problema que hay que decir, no que falte configurar el
       servidor. */
    if (!destinatario || destinatario.indexOf('@') === -1) {
      return resolve({ ok: false, motivo: 'El destinatario no tiene una dirección válida.' });
    }
    if (!c.host) return resolve({ ok: false, motivo: 'No hay servidor de correo configurado (SMTP_HOST).' });

    const puerto = c.puerto || 587;
    const usuario = c.usuario || '';
    const clave = c.clave || '';
    const remitente = c.remitente || 'VisitaFlow <no-responder@visitaflow.local>';

    let socket = null;
    let terminado = false;
    let buffer = '';
    let esperando = null;
    let usaTls = false;
    /* El servidor anuncia sus capacidades en la respuesta al EHLO. Hay que
       guardarla para saber si acepta STARTTLS. */
    let capacidades = '';

    /* Limite total: si el servidor de correo no contesta en 12 segundos, se
       abandona. El aviso ya quedo guardado en la base. */
    const reloj = setTimeout(() => {
      cerrar({ ok: false, motivo: 'El servidor de correo no respondió a tiempo.' });
    }, 12000);

    function cerrar(resultado) {
      if (terminado) return;
      terminado = true;
      clearTimeout(reloj);
      try { if (socket) socket.destroy(); } catch (e) { /* ya estaba cerrado */ }
      resolve(resultado);
    }

    /** Espera una respuesta del servidor (una linea que empiece por el codigo). */
    function esperar(codigo, segundos) {
      return new Promise((resolveP, rejectP) => {
        const limite = setTimeout(
          () => rejectP(new Error('Sin respuesta del servidor de correo.')),
          (segundos || 10) * 1000
        );
        esperando = (linea) => {
          clearTimeout(limite);
          esperando = null;
          // El codigo de respuesta son los tres primeros caracteres.
          const cod = linea.slice(0, 3);
          if (codigo && cod !== String(codigo)) {
            rejectP(new Error('El servidor de correo respondió ' + cod + ': ' + linea.slice(4, 160)));
            return;
          }
          resolveP(linea);
        };
      });
    }

    /** Manda una orden y espera su respuesta. */
    async function orden(texto, codigo) {
      socket.write(texto + '\r\n');
      return esperar(codigo);
    }

    function alRecibir(datos) {
      buffer += datos.toString('utf8');
      // Las respuestas multilinea terminan con "250 " (espacio), no "250-".
      const lineas = buffer.split('\r\n');
      buffer = lineas.pop();
      for (const l of lineas) {
        if (!l) continue;
        capacidades += ' ' + l;
        if (esperando) esperando(l);
      }
    }

    async function conversar() {
      try {
        await esperar(220);                     // saludo del servidor
        await orden('EHLO ' + (os.hostname() || 'visitaflow'), 250);

        /* STARTTLS: se usa solo si el servidor lo anuncio. Sin esto, la
           contrasena del correo viajaria en claro por la red. Si el servidor no
           lo ofrece (tipico de un servidor interno de oficina), se sigue sin
           cifrar: es lo que ese servidor espera. */
        if (!usaTls && puerto !== 465 && /STARTTLS/i.test(capacidades)) {
          try {
            await orden('STARTTLS', 220);

            // Se pasa la conexion a TLS conservando el socket ya abierto.
            const claro = socket;
            claro.removeAllListeners('data');
            claro.removeAllListeners('error');

            socket = tls.connect({ socket: claro, servername: c.host });
            await new Promise((listo, falla) => {
              const limite = setTimeout(() => falla(new Error('No se pudo cifrar la conexión.')), 8000);
              socket.once('secureConnect', () => { clearTimeout(limite); listo(); });
              socket.once('error', (e) => { clearTimeout(limite); falla(e); });
            });

            usaTls = true;
            capacidades = '';
            socket.on('data', alRecibir);
            socket.on('error', (e) => cerrar({ ok: false, motivo: 'Se cortó la conexión cifrada: ' + e.message }));

            // Tras cifrar hay que volver a saludar: es lo que manda el protocolo.
            await orden('EHLO ' + (os.hostname() || 'visitaflow'), 250);
          } catch (e) {
            // Si el cifrado falla, se sigue sin el. Se prefiere avisar sin
            // cifrar a no avisar.
            usaTls = false;
          }
        }

        // Autenticacion, solo si hay usuario configurado.
        if (usuario) {
          await orden('AUTH LOGIN', 334);
          await orden(Buffer.from(usuario, 'utf8').toString('base64'), 334);
          await orden(Buffer.from(clave, 'utf8').toString('base64'), 235);
        }

        await orden('MAIL FROM:<' + extraerDireccion(remitente) + '>', 250);
        await orden('RCPT TO:<' + extraerDireccion(destinatario) + '>', 250);
        await orden('DATA', 354);

        socket.write(construirMensaje(remitente, destinatario, asunto, cuerpo) + '\r\n.\r\n');
        await esperar(250);

        socket.write('QUIT\r\n');
        cerrar({ ok: true });
      } catch (e) {
        cerrar({ ok: false, motivo: e.message });
      }
    }

    // Puerto 465 es TLS directo; 587 y 25 empiezan en claro y suben con STARTTLS.
    socket = puerto === 465
      ? tls.connect({ host: c.host, port: puerto, servername: c.host })
      : net.connect({ host: c.host, port: puerto });

    socket.setTimeout(10000, () => cerrar({ ok: false, motivo: 'Se agotó el tiempo de espera con el servidor de correo.' }));
    socket.on('error', (e) => cerrar({ ok: false, motivo: 'No se pudo conectar: ' + e.message }));
    socket.on('data', alRecibir);
    socket.on('connect', () => { conversar(); });
  });
}

/** Saca la direccion de algo como "Nombre <correo@dominio>". */
function extraerDireccion(texto) {
  const m = String(texto || '').match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return String(texto || '').trim();
}

/** Arma el mensaje segun el formato de correo (RFC 5322), en UTF-8. */
function construirMensaje(de, para, asunto, cuerpo) {
  const limite = 'vf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  const cabeceras = [
    'From: ' + de,
    'To: ' + para,
    'Subject: =?UTF-8?B?' + Buffer.from(String(asunto || ''), 'utf8').toString('base64') + '?=',
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + limite + '@visitaflow>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  // El cuerpo va en base64: asi los acentos y los saltos de linea llegan bien
  // sin pelearse con los limites de longitud de linea del protocolo.
  const texto = String(cuerpo || '').replace(/\r?\n/g, '\r\n');
  const enBase64 = Buffer.from(texto, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return cabeceras.join('\r\n') + '\r\n\r\n' + enBase64;
}

/* ------------------------------------------------------------------ */
/* Avisos                                                              */
/* ------------------------------------------------------------------ */

/**
 * Avisa que llego una visita.
 *
 * Se guarda el aviso siempre. El correo se intenta DESPUES de guardar, y si
 * falla el aviso queda con el motivo del fallo: asi se puede ver en pantalla
 * que el correo no salio y por que, en vez de quedarse sin saberlo.
 *
 * @param {number} tenantId
 * @param {object} visita    { id, codigo, nombre_completo, cedula, ... }
 * @param {object} persona   de vf_personas, o null si se escribio a mano
 * @param {object} depto     de vf_departamentos, o null
 */
async function avisarDeVisita(tenantId, visita, persona, depto) {
  try {
    const destinatario = (persona && persona.nombre) || (visita && visita.visitado) || (depto && depto.encargado);
    if (!destinatario) return null;

    /* El correo de destino: primero el de la persona, despues el del
       departamento. Las dos cosas son razonables segun como este armado. */
    const correoDestino = (persona && persona.correo) || (depto && depto.correo) || null;

    const asunto = 'Llegó ' + (visita.nombre_completo || 'una visita') + ' a verle';
    const cuerpo = armarTexto(visita, destinatario, depto);

    // 1. El aviso se guarda primero, pase lo que pase con el correo.
    let id = null;

    /* Se intenta guardar hasta tres veces, esperando un poco entre intentos.
       El motivo es concreto: el aviso lleva una clave ajena a la visita, y si
       la transaccion que la creo todavia no ha confirmado, el INSERT falla con
       error de clave ajena. Eso ya paso una vez, y como el fallo se tragaba en
       silencio, la visita quedaba registrada sin que nadie se enterara de que
       no se habia avisado. */
    let ultimoError = null;
    for (let intento = 1; intento <= 3 && id === null; intento++) {
      try {
        /* visita_id se declara como BigInt a mano: es un BIGINT en la tabla y,
           si se deja que el driver lo deduzca de un numero de JavaScript, lo
           manda como Int y la clave ajena no coincide. */
        const r = await bd.consultar(
          `INSERT INTO vf_avisos
             (tenant_id, visita_id, persona_id, departamento_id,
              destinatario, destinatario_correo, asunto, cuerpo, estado)
           OUTPUT INSERTED.id
           VALUES (@tenant_id, @visita_id, @persona_id, @departamento_id,
                   @destinatario, @correo, @asunto, @cuerpo, @estado)`,
          {
            tenant_id: tenantId,
            visita_id: (visita && visita.id) || null,
            persona_id: (persona && persona.id) || null,
            departamento_id: (depto && depto.id) || null,
            destinatario: util.limpiar(destinatario, 160),
            correo: util.limpiar(correoDestino, 200) || null,
            asunto: util.limpiar(asunto, 200),
            cuerpo: cuerpo,
            estado: correoDestino ? 'pendiente' : 'sin_correo',
          },
          { tipos: { visita_id: sql.BigInt } }
        );
        id = r.recordset[0].id;
      } catch (e) {
        ultimoError = e;
        if (intento < 3) await new Promise((r) => setTimeout(r, intento * 250));
      }
    }

    if (id === null) {
      /* No se pudo guardar el aviso. Se deja constancia en el registro del
         servidor: es un fallo silencioso peligroso, porque el anfitrion no se
         entera de que tiene una visita esperando. */
      console.error(
        '[visitaflow] NO se pudo guardar el aviso de la visita ' +
        ((visita && visita.codigo) || '?') + ': ' + (ultimoError && ultimoError.message)
      );
      return { id: null, estado: 'no_guardado', motivo: ultimoError ? ultimoError.message : 'error desconocido' };
    }

    if (!correoDestino) {
      return { id, estado: 'sin_correo', motivo: 'No hay correo de destino configurado.' };
    }

    // 2. Y ahora se intenta el correo.
    const envio = await enviarCorreo(correoDestino, asunto, cuerpo);

    try {
      await bd.consultar(
        `UPDATE vf_avisos
            SET estado = @estado, error = @error, enviado = @enviado
          WHERE id = @id`,
        {
          id,
          estado: envio.ok ? 'enviado' : 'error',
          error: envio.ok ? null : util.limpiar(envio.motivo, 400),
          enviado: envio.ok ? new Date() : null,
        }
      );
    } catch (e) {
      /* si no se puede anotar el resultado, el aviso queda como pendiente */
    }

    return { id, estado: envio.ok ? 'enviado' : 'error', motivo: envio.motivo || null };
  } catch (e) {
    console.error('[visitaflow] error al avisar al anfitrión: ' + e.message);
    return null;
  }
}

/**
 * El texto del aviso. Claro y sin adornos: se lee en el movil.
 *
 * Lo primero que se lee tiene que ser QUIEN llego y A QUIEN busca. El asunto ya
 * lo dice, pero el cuerpo se lee entero y muchas veces en una notificacion
 * emergente, donde el asunto no se ve.
 */
function armarTexto(v, destinatario, depto) {
  const lineas = [
    'Llegó una visita a verle.',
    '',
    '  Visitante   : ' + (v.nombre_completo || '—'),
    '  A quien busca: ' + (destinatario || v.visitado || '—'),
    v.cedula ? '  Cédula      : ' + v.cedula : null,
    v.empresa ? '  Empresa     : ' + v.empresa : null,
    '  Motivo      : ' + (v.motivo_txt || '—'),
    depto ? '  Departamento: ' + depto.nombre : null,
    '  Hora        : ' + util.fechaLegible(v.entrada),
    '  Gafete      : ' + (v.codigo || '—'),
    '',
    'Registrado por ' + (v.operador_nombre || 'recepción') + '.',
    '',
    'Este aviso lo envió VisitaFlow.',
  ].filter((l) => l !== null);
  return lineas.join('\n');
}

/**
 * Los avisos sin leer, para la pantalla de Recepcion.
 *
 * Antes de devolverlos, cierra los que ya no tienen sentido: los de visitas que
 * ya salieron. Un aviso dice "llego alguien a verle"; si esa persona ya se fue,
 * el aviso solo estorba.
 *
 * Se hace aqui y no solo al registrar la salida porque las visitas se cierran
 * por varias vias (salida normal, salida por codigo de gafete, cierre de visitas
 * vencidas) y porque una base que ya tenia avisos abiertos de antes no se
 * arregla sola. Asi se limpian solos la primera vez que alguien mira la pantalla.
 */
async function pendientes(tenantId, limite) {
  try {
    await bd.consultar(
      `UPDATE vf_avisos
          SET estado = 'leido', leido = SYSDATETIMEOFFSET()
        WHERE tenant_id = @tenant_id AND leido IS NULL
          AND visita_id IN (SELECT id FROM vf_visitas WHERE estado <> 'dentro')`,
      { tenant_id: tenantId }
    );
  } catch (e) {
    // Si no se pueden cerrar, se muestran igual: no es motivo para no avisar.
  }

  const r = await bd.consultar(
    `SELECT TOP ${Math.max(1, Math.min(100, Number(limite) || 20))}
            a.id, a.destinatario, a.destinatario_correo, a.asunto, a.cuerpo,
            a.estado, a.error, a.creado, a.visita_id,
            v.codigo AS visita_codigo, v.nombre_completo AS visitante, v.entrada
       FROM vf_avisos a
       LEFT JOIN vf_visitas v ON v.id = a.visita_id
      WHERE a.tenant_id = @tenant_id AND a.leido IS NULL
      ORDER BY a.creado DESC`,
    { tenant_id: tenantId }
  );
  return r.recordset;
}

/** Cuantos avisos hay sin leer. */
async function contarPendientes(tenantId) {
  const r = await bd.consultar(
    'SELECT COUNT(*) AS n FROM vf_avisos WHERE tenant_id = @tenant_id AND leido IS NULL',
    { tenant_id: tenantId }
  );
  return r.recordset[0].n;
}

/** Marca un aviso como leido. */
async function marcarLeido(tenantId, id) {
  const r = await bd.consultar(
    'UPDATE vf_avisos SET estado = @estado, leido = SYSDATETIMEOFFSET() ' +
    'WHERE tenant_id = @tenant_id AND id = @id AND leido IS NULL',
    { tenant_id: tenantId, id: id, estado: 'leido' }
  );
  return r.rowsAffected[0] > 0;
}

/** Marca como leidos todos los avisos de una visita (cuando ya salio). */
async function marcarLeidosDeVisita(tenantId, visitaId) {
  const r = await bd.consultar(
    'UPDATE vf_avisos SET estado = @estado, leido = SYSDATETIMEOFFSET() ' +
    'WHERE tenant_id = @tenant_id AND visita_id = @visita AND leido IS NULL',
    { tenant_id: tenantId, visita: visitaId, estado: 'leido' }
  );
  return r.rowsAffected[0];
}

/** Comprueba la configuracion de correo. Se usa en la pantalla de licencia. */
async function probarCorreo(destinatario) {
  return enviarCorreo(
    destinatario,
    'Prueba de VisitaFlow',
    'Si está leyendo esto, el envío de correo de VisitaFlow funciona.\n\n' +
    'Puede desactivarlo con CORREO_ACTIVO=0.'
  );
}

module.exports = {
  enviarCorreo,
  avisarDeVisita,
  pendientes,
  contarPendientes,
  marcarLeido,
  marcarLeidosDeVisita,
  probarCorreo,
  extraerDireccion,
  construirMensaje,
};
