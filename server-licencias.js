/**
 * VisitaFlow - Servidor de licencias.
 *
 *   node server-licencias.js
 *
 * Este es el componente que se queda del lado del proveedor (en el VPS). Es el
 * UNICO lugar donde vive la llave privada. Su trabajo:
 *
 *   1. Dar de alta instituciones y emitir su licencia firmada.
 *   2. Renovar, suspender y reactivar licencias.
 *   3. Responder a las instalaciones que piden renovar (una licencia mas nueva
 *      que la que tienen).
 *
 * Lo que NO hace, a proposito: no guarda cedulas, ni visitantes, ni nada de la
 * operacion de las instituciones. Cada instalacion es autonoma; el servidor de
 * licencias solo sabe quien es el cliente y hasta cuando tiene derecho a operar.
 * Eso es lo que hace que el sistema pueda funcionar sin Internet.
 *
 * Las rutas de administracion se protegen con ADMIN_TOKEN. Sin ese token, el
 * servidor se niega a arrancar en produccion.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');

const config = require('./src/config');
const lic = require('./src/licencias/licencia');
const util = require('./src/util');
const { asincrono, responder, responderError, error } = util;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ */
/* Registro de licencias emitidas (en disco, para no perder el historial)  */
/* ------------------------------------------------------------------ */

const REGISTRO = process.env.LICENCIAS_REGISTRO || path.join(config.raiz, 'datos', 'licencias-emitidas.json');

/**
 * Lee el registro de clientes.
 *
 * SI NO SE PUEDE LEER, LANZA. No devuelve una lista vacia.
 *
 * Esto era un fallo grave y silencioso: si el archivo quedaba a medio escribir o
 * con un JSON roto, esta funcion devolvia [] y el siguiente guardado escribia una
 * lista con UN solo cliente encima del archivo. Es decir: se perdian TODOS los
 * clientes de golpe, sin ningun error, y se descubria cuando uno pedia su licencia.
 *
 * Vale mas que el panel de un error y no deje guardar, que perder la cartera
 * entera sin enterarse.
 */
function leerRegistro() {
  if (!fs.existsSync(REGISTRO)) return [];

  let texto;
  try {
    texto = fs.readFileSync(REGISTRO, 'utf8');
  } catch (e) {
    throw error(500, 'No se pudo leer el registro de licencias (' + REGISTRO + '): ' + e.message +
      '. NO se ha modificado nada: arregle el archivo y vuelva a intentarlo.');
  }

  if (!texto.trim()) return [];

  try {
    const datos = JSON.parse(texto);
    if (!Array.isArray(datos)) {
      throw new Error('no es una lista');
    }
    return datos;
  } catch (e) {
    /* Deja una copia del archivo roto antes de nada, para poder recuperarlo a
       mano: es la lista de clientes del negocio. */
    try {
      const copia = REGISTRO + '.roto-' + Date.now();
      fs.copyFileSync(REGISTRO, copia);
      console.error('[licencias] El registro está dañado. Se guardó una copia en: ' + copia);
    } catch (e2) { /* si tampoco se puede copiar, el aviso de abajo ya lo dice */ }

    throw error(500, 'El registro de licencias está dañado (' + e.message + '). Se guardó una copia ' +
      'con extensión .roto-<fecha> al lado. Arréglelo antes de seguir: si se guardara ahora, se ' +
      'perderían todos los clientes.');
  }
}

/**
 * Guarda el registro SIN PODER DEJARLO A MEDIAS.
 *
 * Se escribe en un archivo temporal, se fuerza el volcado a disco y solo entonces
 * se renombra encima del bueno. El renombrado es atomico: o queda el archivo
 * anterior entero, o el nuevo entero, nunca uno mezclado.
 *
 * Escribir directamente sobre el archivo bueno tenia un riesgo real: un corte de
 * luz o un reinicio del contenedor en mitad de la escritura dejaba el JSON roto, y
 * con la version anterior de leerRegistro eso significaba perder todos los clientes.
 */
function guardarRegistro(lista) {
  const carpeta = path.dirname(REGISTRO);
  fs.mkdirSync(carpeta, { recursive: true });

  const temporal = REGISTRO + '.tmp-' + process.pid;

  const contenido = JSON.stringify(lista, null, 2);
  const descriptor = fs.openSync(temporal, 'w', 0o600);
  try {
    fs.writeFileSync(descriptor, contenido);
    // Sin esto, el renombrado puede ocurrir antes que los datos lleguen al disco.
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }

  fs.renameSync(temporal, REGISTRO);
}

/**
 * ¿Esta licencia está activa?
 *
 * Se puede desactivar a un cliente desde el panel sin borrar su historial: la
 * licencia queda suspendida y el sistema del cliente deja de funcionar al
 * renovar. Es lo que permite cortar el servicio a distancia sin tener que
 * entrar en el servidor del cliente.
 *
 * Las licencias emitidas antes de que existiera este campo no lo traen. Se
 * toman como activas: si no, al actualizar el servidor se desactivarían solos
 * todos los clientes que ya estaban trabajando.
 */
function estaActiva(entrada) {
  return entrada.estado !== 'suspendida';
}

/** Deja constancia de una emision o una renovacion. */
function anotarEnRegistro(contenido, accion) {
  const lista = leerRegistro();
  const i = lista.findIndex((l) => l.licencia_id === contenido.licencia_id);
  const anterior = i >= 0 ? lista[i] : null;
  const entrada = {
    licencia_id: contenido.licencia_id,
    tenant: contenido.tenant,
    cliente: contenido.cliente,
    contacto: contenido.contacto,
    tipo: contenido.tipo,
    desde: contenido.desde,
    hasta: contenido.hasta,
    modulos: contenido.modulos,
    limites: contenido.limites,
    huella: contenido.huella,
    notas: contenido.notas,
    /* El estado lo controla el panel, NO la emision. Si se reescribiera aqui,
       renovar una licencia reactivaria a un cliente suspendido sin querer. */
    estado: anterior && anterior.estado ? anterior.estado : 'activa',
    suspendida_en: anterior ? anterior.suspendida_en || null : null,
    suspendida_motivo: anterior ? anterior.suspendida_motivo || null : null,
    historial: (anterior ? anterior.historial : []).concat([{ accion, fecha: new Date().toISOString() }]),
  };
  if (i >= 0) lista[i] = entrada;
  else lista.push(entrada);
  guardarRegistro(lista);
  return entrada;
}

/** Guarda un cambio hecho desde el panel. */
function actualizarEnRegistro(licenciaId, cambios, accion) {
  const lista = leerRegistro();
  const i = lista.findIndex((l) => l.licencia_id === licenciaId);
  if (i < 0) return null;
  const entrada = Object.assign({}, lista[i], cambios);
  entrada.historial = (lista[i].historial || []).concat([{ accion, fecha: new Date().toISOString() }]);
  lista[i] = entrada;
  guardarRegistro(lista);
  return entrada;
}

/* ------------------------------------------------------------------ */
/* Autenticacion del administrador                                     */
/* ------------------------------------------------------------------ */

function admin(req, res, next) {
  const token = process.env.ADMIN_TOKEN || config.adminToken;
  if (!token) {
    return responderError(res, error(503, 'El servidor de licencias no tiene ADMIN_TOKEN configurado. Configure esa variable antes de usarlo.'));
  }
  const enviado = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || req.headers['x-admin-token'];
  if (enviado !== token) return responderError(res, error(401, 'Token de administración inválido.'));
  next();
}

/* ------------------------------------------------------------------ */
/* Rutas publicas                                                      */
/* ------------------------------------------------------------------ */

app.get(
  '/api/salud',
  envolver(
    async (req, res) => {
      let llaveOk = false;
      let keyId = null;
      let motivo = null;
      try {
        keyId = lic.keyId();
        llaveOk = true;
      } catch (e) {
        motivo = e.message;
      }
      responder(res, {
        servicio: 'VisitaFlow - servidor de licencias',
        version: require(path.join(config.raiz, 'package.json')).version,
        hora: new Date().toISOString(),
        llave: { disponible: llaveOk, key_id: keyId, motivo },
        licencias_emitidas: leerRegistro().length,
        modulos: lic.MODULOS,
      });
    }
  )
);

/** La llave publica, para incrustarla en una instalacion nueva. */
app.get(
  '/api/llave-publica',
  envolver(async (req, res) => {
    responder(res, { llave_publica: lic.llavePublica(), key_id: lic.keyId(), modulos: lic.MODULOS });
  })
);

/**
 * Consulta de renovacion. La llama la instalacion del cliente.
 *
 * Devuelve la licencia vigente de ese cliente si existe y es mas nueva que la
 * que el cliente ya tiene. Si no hay nada nuevo, devuelve sin_cambios para que
 * la instalacion no reescriba nada.
 *
 * EXIGE EL TOKEN DE INSTALACION, y esto cierra un robo de licencias: antes
 * cualquiera que supiera el codigo de una institucion (que es facil de adivinar o
 * de oir: "junta-los-prados") pedia aqui su licencia firmada y se la quedaba.
 * Ademas, el amarre a un equipo se saltaba simplemente omitiendo la huella.
 */
app.post(
  '/api/licencia/consultar',
  limitar('consultar', 60, 60000),
  exigeTokenDeInstalacion,
  envolver(async (req, res) => {
    const { tenant, licencia_id, huella } = req.body || {};
    if (!tenant) throw error(400, 'Falta el identificador de la institución.');

    const lista = leerRegistro();
    const registros = lista.filter((l) => l.tenant === String(tenant).toLowerCase());
    if (!registros.length) {
      throw error(404, 'No hay ninguna licencia emitida para la institución "' + tenant + '".');
    }

    // La mas reciente por fecha de vencimiento.
    const actual = registros.sort((a, b) => Date.parse(b.hasta) - Date.parse(a.hasta))[0];

    /* Si esta suspendida, se corta aqui.
       Esto es lo que permite desactivar a un cliente a distancia: su sistema
       pregunta, se le dice que no, y queda en solo lectura sin perder nada de lo
       que tenia registrado. El motivo viaja para que se vea en su pantalla de
       licencia en vez de un "no autorizado" sin explicacion. */
    if (!estaActiva(actual)) {
      throw error(403, 'La licencia de esta institución está suspendida.' +
        (actual.suspendida_motivo ? ' Motivo: ' + actual.suspendida_motivo : ''));
    }

    // Si el cliente ya tiene una licencia con la misma fecha de vencimiento,
    // no hay nada nuevo que mandarle.
    if (licencia_id && actual.licencia_id === licencia_id) {
      const emitidas = (actual.historial || []).length;
      return responder(res, {
        sin_cambios: true,
        mensaje: 'La licencia de esta institución no ha cambiado.',
        revisiones: emitidas,
      });
    }

    /* El amarre a un equipo: si la licencia tiene huella, se EXIGE que coincida.
     *
     * Antes la condicion era "si la licencia tiene huella Y el cliente manda una Y
     * no coinciden". Omitiendo la huella no se comprobaba nada, asi que el amarre
     * no servia para nada: bastaba con no mandarla. */
    if (actual.huella) {
      if (!huella) {
        throw error(403, 'Esta licencia está amarrada a un equipo concreto: hay que identificarse.');
      }
      if (actual.huella !== huella) {
        throw error(403, 'Esta licencia está amarrada a otro equipo (' + actual.huella + ').');
      }
    }

    const texto = lic.firmar(
      {
        licencia_id: actual.licencia_id,
        tenant: actual.tenant,
        cliente: actual.cliente,
        contacto: actual.contacto,
        desde: actual.desde,
        hasta: actual.hasta,
        tipo: actual.tipo,
        modulos: actual.modulos,
        limites: actual.limites,
        huella: actual.huella,
        notas: actual.notas,
      },
      {}
    );

    responder(res, {
      licencia: texto,
      licencia_id: actual.licencia_id,
      hasta: actual.hasta,
      estado: lic.evaluar(texto).estado,
    });
  })
);

/**
 * Activar por ID de licencia.
 *
 * ESTA ES LA PUERTA DEL PRIMER ARRANQUE. El cliente instala el sistema, el
 * sistema le pide el ID (LIC-XXXX), y con ese ID pregunta aqui. Si la licencia
 * esta activa, se le devuelve firmada y su sistema queda listo: crea su
 * institucion, sus catalogos y su administrador, sin que nadie tenga que mandar
 * archivos por correo.
 *
 * Es publica a proposito. En el primer arranque no hay sesion (no existe ningun
 * usuario todavia) y no se puede pedir autenticacion para algo que hay que hacer
 * antes de poder autenticarse. Lo que la protege es que el ID no se puede
 * adivinar, y que lo unico que devuelve es la licencia QUE YA ES DE ESE CLIENTE:
 * conocerla no da acceso a nada sin las credenciales despues.
 *
 * Devuelve datos utiles para la pantalla: a que cliente pertenece, hasta cuando
 * vale y que modulos incluye, para que se vea antes de confirmar.
 */
app.post(
  '/api/licencia/activar-por-id',
  envolver(async (req, res) => {
    const id = String((req.body || {}).licencia_id || '').trim().toUpperCase();
    if (!id) throw error(400, 'Escriba el ID de la licencia.');

    const lista = leerRegistro();
    // Se busca sin distinguir mayusculas: el cliente lo va a escribir a mano.
    const entrada = lista.find((l) => String(l.licencia_id || '').toUpperCase() === id);

    if (!entrada) {
      throw error(404, 'No existe ninguna licencia con el ID ' + id + '. Revise que esté bien escrito.');
    }

    if (!estaActiva(entrada)) {
      throw error(403, 'Esa licencia está suspendida.' +
        (entrada.suspendida_motivo ? ' Motivo: ' + entrada.suspendida_motivo : ''));
    }

    // Se comprueba que no haya vencido antes de entregarla.
    const vencida = Date.parse(entrada.hasta) < Date.now();
    if (vencida) {
      throw error(403, 'Esa licencia venció el ' + String(entrada.hasta).slice(0, 10) + '. Pida una renovación.');
    }

    /* La huella, si la licencia esta amarrada a un equipo.
     *
     * Se EXIGE que venga cuando la licencia la tiene: si no, el amarre se saltaba
     * simplemente omitiendo el campo, que es lo mismo que no tener amarre. */
    const huella = String((req.body || {}).huella || '').trim();
    if (entrada.huella) {
      if (!huella) {
        throw error(403, 'Esta licencia está amarrada a un equipo concreto: hay que identificarse.');
      }
      if (entrada.huella !== huella) {
        throw error(403, 'Esta licencia está amarrada a otro equipo.');
      }
    }

    const texto = lic.firmar(
      {
        licencia_id: entrada.licencia_id,
        tenant: entrada.tenant,
        cliente: entrada.cliente,
        contacto: entrada.contacto,
        desde: entrada.desde,
        hasta: entrada.hasta,
        tipo: entrada.tipo,
        modulos: entrada.modulos,
        limites: entrada.limites,
        huella: entrada.huella,
        notas: entrada.notas,
      },
      {}
    );

    console.log('[licencias] activación por ID: ' + id + ' (' + entrada.cliente + ')');

    responder(res, {
      licencia: texto,
      licencia_id: entrada.licencia_id,
      tenant: entrada.tenant,
      cliente: entrada.cliente,
      hasta: entrada.hasta,
      modulos: entrada.modulos,
      estado: 'activa',
      servidor: true,
    });
  })
);

/* ------------------------------------------------------------------ */
/* El token de activacion                                              */
/* ------------------------------------------------------------------ */

/**
 * El token que comparten el vendedor y sus instalaciones.
 *
 * POR QUE HACE FALTA
 * ------------------
 * Las rutas de renovacion y de aviso estaban ABIERTAS: cualquiera que supiera el
 * codigo de una institucion (que es facil de adivinar o de oir: "junta-los-prados")
 * podia pedir su licencia firmada y quedarse con ella. Y el aviso de activacion
 * escribia en el registro del vendedor sin ninguna autenticacion, asi que se podia
 * corromper el inventario de clientes desde fuera.
 *
 * La pieza ya existia a medias: las instalaciones YA mandaban el token, y estaba en
 * la configuracion, pero el servidor no lo comprobaba en ninguna ruta.
 *
 * QUE PASA SI NO SE CONFIGURA
 * ---------------------------
 * Si no hay token, estas rutas quedan cerradas y se avisa fuerte al arrancar. Es
 * deliberado: dejar el servidor de licencias abierto por omision es peor que
 * obligar a configurarlo. La ACTIVACION POR ID sigue funcionando, que es publica
 * porque tiene que serlo (el sistema recien instalado no tiene con que
 * autenticarse): lo que la protege es que el ID no se puede adivinar.
 */
function tokenActivacion() {
  return (process.env.LICENCIA_TOKEN_ACTIVACION || config.licencia.tokenActivacion || '').trim();
}

/** Comprueba el token en las rutas que atienden a las instalaciones. */
function exigeTokenDeInstalacion(req, res, next) {
  const esperado = tokenActivacion();

  if (!esperado) {
    return responderError(res, error(503,
      'Este servidor de licencias no tiene LICENCIA_TOKEN_ACTIVACION configurado, así que no ' +
      'atiende renovaciones. Configure esa variable aquí Y en las instalaciones de sus clientes.'));
  }

  const enviado = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  /* Comparacion de tiempo constante: comparar con === filtra cuantos caracteres
     iniciales acerto quien lo intenta. Es una debilidad teorica con un token de 36
     bytes al azar, pero evitarla cuesta dos lineas. */
  const a = Buffer.from(enviado);
  const b = Buffer.from(esperado);
  const iguales = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!iguales) {
    console.warn('[licencias] Petición rechazada desde ' +
      (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?') +
      ' por token de instalación inválido en ' + req.path);
    return responderError(res, error(401, 'Token de instalación inválido.'));
  }

  next();
}

/**
 * Un limite de peticiones por IP.
 *
 * Las rutas publicas del servidor de licencias no tenian ninguno: se podia barrer
 * el espacio de IDs y de codigos de institucion a la velocidad que aguantara el
 * disco. Con esto, un barrido deja de ser barato.
 */
function limitar(clave, maximo, ventanaMs) {
  const registros = new Map();
  return (req, res, next) => {
    const ahora = Date.now();
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket.remoteAddress || '?';
    const k = clave + ':' + ip;

    const previo = registros.get(k);
    const lista = (previo && previo.fin > ahora) ? previo.lista : [];
    lista.push(ahora);

    const recientes = lista.filter((t) => t > ahora - ventanaMs);
    registros.set(k, { lista: recientes, fin: ahora + ventanaMs });

    // Limpieza, para que el Map no crezca sin fin.
    if (registros.size > 5000) {
      for (const [kk, vv] of registros) if (vv.fin < ahora) registros.delete(kk);
    }

    if (recientes.length > maximo) {
      return responderError(res, error(429, 'Demasiadas peticiones. Espere un momento.'));
    }
    next();
  };
}

/** La instalacion avisa que se activo. Queda en el historial del cliente. */
app.post(
  '/api/licencia/activada',
  limitar('activada', 30, 60000),
  exigeTokenDeInstalacion,
  envolver(async (req, res) => {
    const { tenant, licencia_id, huella, equipo } = req.body || {};
    const lista = leerRegistro();
    const i = lista.findIndex((l) => l.licencia_id === licencia_id && l.tenant === String(tenant || '').toLowerCase());
    if (i < 0) throw error(404, 'Esa licencia no existe en este servidor.');

    /* Solo se registra si la huella coincide con la que tiene la licencia.
       Sin esto, cualquiera podia inflar la lista de instalaciones de un cliente
       hasta hacer el archivo inservible: cada aviso lo lee y lo reescribe entero. */
    if (lista[i].huella && huella && lista[i].huella !== huella) {
      throw error(403, 'Esa licencia está amarrada a otro equipo.');
    }

    /* Y hay un tope: una licencia no puede tener mas instalaciones de las que
       permite. Antes se podia anadir sin limite. */
    const topeInstalaciones = (lista[i].limites && lista[i].limites.instalaciones) || 2;
    lista[i].instalaciones = lista[i].instalaciones || [];
    const yaEsta = lista[i].instalaciones.some((x) => x.huella === huella);

    if (!yaEsta && lista[i].instalaciones.length >= topeInstalaciones) {
      throw error(403, 'Esta licencia ya está activada en ' + lista[i].instalaciones.length +
        ' equipo(s) y su límite es ' + topeInstalaciones + '.');
    }

    const existente = lista[i].instalaciones.find((x) => x.huella === huella);
    if (existente) {
      existente.ultima_vez = new Date().toISOString();
      existente.veces = (existente.veces || 1) + 1;
    } else {
      lista[i].instalaciones.push({
        huella,
        equipo: equipo || null,
        primera_vez: new Date().toISOString(),
        ultima_vez: new Date().toISOString(),
        veces: 1,
      });
    }
    guardarRegistro(lista);
    responder(res, { registrada: true, instalaciones: lista[i].instalaciones.length });
  })
);

/* ------------------------------------------------------------------ */
/* Rutas de administracion                                             */
/* ------------------------------------------------------------------ */

/** Lista de licencias emitidas. */
app.get(
  '/api/admin/licencias',
  admin,
  envolver(async (req, res) => {
    responder(res, {
      licencias: leerRegistro()
        .map((l) => {
          // Ojo con el nombre: aqui "instalaciones" es la LISTA de equipos que
          // activaron la licencia. Si se sobrescribe con el conteo, la consola
          // recibe un numero donde espera una lista.
          const equipos = Array.isArray(l.instalaciones) ? l.instalaciones : [];
          return {
            licencia_id: l.licencia_id,
            tenant: l.tenant,
            cliente: l.cliente,
            contacto: l.contacto,
            tipo: l.tipo,
            desde: l.desde,
            hasta: l.hasta,
            modulos: l.modulos || [],
            limites: l.limites || {},
            huella: l.huella,
            instalaciones: equipos,
            historial: (l.historial || []).length,
            dias_restantes: Math.floor((Date.parse(l.hasta) - Date.now()) / 86400000),
          };
        })
        // Las que vencen antes, primero: son las que hay que atender.
        .sort((a, b) => a.dias_restantes - b.dias_restantes),
    });
  })
);

/** Emite una licencia nueva. */
app.post(
  '/api/admin/licencias',
  admin,
  envolver(async (req, res) => {
    const d = req.body || {};
    const tenant = String(d.tenant || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(tenant)) {
      throw error(400, 'El identificador de la institución debe tener entre 3 y 40 caracteres: letras minúsculas, números y guiones.');
    }

    const dias = util.entero(d.dias, 365, 1, 3650);
    const desde = d.desde ? new Date(d.desde) : new Date();
    const hasta = d.hasta ? new Date(d.hasta) : new Date(desde.getTime() + dias * 86410000);

    let contenido;
    let texto;
    try {
      contenido = lic.construirContenido({
        tenant,
        tenant_nombre: d.tenant_nombre,
        cliente: d.cliente || d.tenant_nombre,
        contacto: d.contacto,
        desde: desde.toISOString(),
        hasta: hasta.toISOString(),
        tipo: d.tipo || (dias <= 30 ? 'prueba' : 'periodo'),
        modulos: Array.isArray(d.modulos) && d.modulos.length ? d.modulos : lic.MODULOS.slice(),
        limites: {
          usuarios: util.entero(d.usuarios, 5, 1, 10000),
          instalaciones: util.entero(d.instalaciones, 1, 1, 100),
          visitas_mes: util.entero(d.visitas_mes, 0, 0, 1000000),
        },
        huella: d.huella || null,
        gracia_dias: util.entero(d.gracia_dias, 15, 0, 365),
        notas: d.notas,
      });
      texto = lic.firmar(contenido, {});
    } catch (e) {
      throw error(400, 'No se pudo emitir la licencia: ' + e.message);
    }

    const entrada = anotarEnRegistro(contenido, 'emitida');
    console.log('[licencias] emitida ' + contenido.licencia_id + ' para ' + tenant + ' hasta ' + contenido.hasta.slice(0, 10));

    responder(
      res,
      {
        licencia_id: contenido.licencia_id,
        tenant,
        hasta: contenido.hasta,
        archivo: texto,
        resumen: lic.resumenLegible(lic.evaluar(texto)),
        registro: entrada,
      },
      201
    );
  })
);

/** Renueva una licencia existente: nueva fecha de vencimiento. */
app.post(
  '/api/admin/licencias/:tenant/renovar',
  admin,
  envolver(async (req, res) => {
    const tenant = String(req.params.tenant).toLowerCase();
    const lista = leerRegistro();
    const registros = lista.filter((l) => l.tenant === tenant);
    if (!registros.length) throw error(404, 'No hay ninguna licencia para "' + tenant + '".');

    const actual = registros.sort((a, b) => Date.parse(b.hasta) - Date.parse(a.hasta))[0];
    const i = lista.findIndex((l) => l.licencia_id === actual.licencia_id);

    const d = req.body || {};
    const dias = util.entero(d.dias, 365, 1, 3650);
    // Se renueva desde la fecha de vencimiento si todavia no venció: así no se
    // le regalan días al cliente por renovar antes de tiempo.
    const base = Math.max(Date.now(), Date.parse(actual.hasta));
    const hasta = new Date(base + dias * 86410000);

    const contenido = lic.construirContenido(
      Object.assign({}, actual, {
        hasta: hasta.toISOString(),
        desde: actual.desde,
        tipo: d.tipo || actual.tipo,
        modulos: Array.isArray(d.modulos) && d.modulos.length ? d.modulos : actual.modulos,
        limites: d.limites || actual.limites,
        huella: d.huella !== undefined ? d.huella : actual.huella,
        gracia_dias: d.gracia_dias !== undefined ? d.gracia_dias : 15,
        notas: d.notas !== undefined ? d.notas : actual.notas,
      })
    );
    const texto = lic.firmar(contenido, {});

    lista[i] = Object.assign({}, lista[i], {
      hasta: contenido.hasta,
      modulos: contenido.modulos,
      limites: contenido.limites,
      huella: contenido.huella,
      tipo: contenido.tipo,
      historial: (lista[i].historial || []).concat([{ accion: 'renovada +' + dias + 'd', fecha: new Date().toISOString() }]),
    });
    guardarRegistro(lista);

    console.log('[licencias] renovada ' + contenido.licencia_id + ' para ' + tenant + ' hasta ' + contenido.hasta.slice(0, 10));

    responder(res, {
      licencia_id: contenido.licencia_id,
      tenant,
      desde: contenido.desde,
      hasta: contenido.hasta,
      archivo: texto,
      resumen: lic.resumenLegible(lic.evaluar(texto)),
    });
  })
);

/** Descarga el archivo .vflow de una institucion. */
app.get(
  '/api/admin/licencias/:tenant/archivo',
  admin,
  envolver(async (req, res) => {
    const tenant = String(req.params.tenant).toLowerCase();
    const registros = leerRegistro().filter((l) => l.tenant === tenant);
    if (!registros.length) throw error(404, 'No hay ninguna licencia para "' + tenant + '".');
    const actual = registros.sort((a, b) => Date.parse(b.hasta) - Date.parse(a.hasta))[0];

    const texto = lic.firmar(
      {
        licencia_id: actual.licencia_id,
        tenant: actual.tenant,
        cliente: actual.cliente,
        contacto: actual.contacto,
        desde: actual.desde,
        hasta: actual.hasta,
        tipo: actual.tipo,
        modulos: actual.modulos,
        limites: actual.limites,
        huella: actual.huella,
        notas: actual.notas,
      },
      {}
    );
    util.descarga(res, tenant + '.vflow', texto, 'text/plain');
  })
);

/** Historial de una institucion. */
app.get(
  '/api/admin/licencias/:tenant',
  admin,
  envolver(async (req, res) => {
    const tenant = String(req.params.tenant).toLowerCase();
    const registros = leerRegistro().filter((l) => l.tenant === tenant);
    if (!registros.length) throw error(404, 'No hay ninguna licencia para "' + tenant + '".');
    responder(res, { registros });
  })
);

/** Comprueba una licencia sin necesidad de la instalacion. */
app.post(
  '/api/admin/verificar',
  admin,
  envolver(async (req, res) => {
    const { archivo } = req.body || {};
    if (!archivo) throw error(400, 'Pegue el contenido del archivo de licencia.');
    const evaluacion = lic.evaluar(archivo, {});
    responder(res, { evaluacion, resumen: lic.resumenLegible(evaluacion) });
  })
);

/* ------------------------------------------------------------------ */
/* El panel: activar, suspender y cambiar modulos                      */
/* ------------------------------------------------------------------ */

/**
 * Lista de clientes para el panel.
 *
 * Devuelve una fila por cliente con lo que hace falta para decidir: quien es,
 * hasta cuando tiene licencia, cuantos dias le quedan, si esta activo y que
 * modulos tiene. Los dias se calculan aqui para que el panel no tenga que
 * hacer cuentas de fechas.
 */
app.get(
  '/api/admin/clientes',
  admin,
  envolver(async (req, res) => {
    const lista = leerRegistro();
    const ahora = Date.now();

    const clientes = lista.map((l) => ({
      licencia_id: l.licencia_id,
      tenant: l.tenant,
      cliente: l.cliente,
      contacto: l.contacto || null,
      tipo: l.tipo || null,
      desde: l.desde,
      hasta: l.hasta,
      vencida: Date.parse(l.hasta) < ahora,
      dias_restantes: Math.floor((Date.parse(l.hasta) - ahora) / 86400000),
      activa: estaActiva(l),
      suspendida_en: l.suspendida_en || null,
      suspendida_motivo: l.suspendida_motivo || null,
      modulos: l.modulos || [],
      limites: l.limites || {},
      huella: l.huella || null,
      notas: l.notas || null,
      revisiones: (l.historial || []).length,
    }));

    // Primero los que necesitan atencion: suspendidos y por vencer.
    clientes.sort((a, b) => {
      if (a.activa !== b.activa) return a.activa ? 1 : -1;
      return a.dias_restantes - b.dias_restantes;
    });

    responder(res, {
      clientes,
      total: clientes.length,
      activos: clientes.filter((c) => c.activa && !c.vencida).length,
      suspendidos: clientes.filter((c) => !c.activa).length,
      vencidos: clientes.filter((c) => c.vencida).length,
      // Para que el panel sepa que modulos puede ofrecer al editar.
      modulos_disponibles: lic.MODULOS,
    });
  })
);

/**
 * Activa o suspende a un cliente.
 *
 * Al suspender se guarda el motivo, y ese motivo llega hasta la pantalla de
 * licencia del cliente: si le va a dejar de funcionar, mas vale que sepa por que.
 */
app.post(
  '/api/admin/clientes/:licencia/estado',
  admin,
  envolver(async (req, res) => {
    const id = String(req.params.licencia).toUpperCase();
    const { activa, motivo } = req.body || {};

    const cambios = activa
      ? { estado: 'activa', suspendida_en: null, suspendida_motivo: null }
      : {
          estado: 'suspendida',
          suspendida_en: new Date().toISOString(),
          suspendida_motivo: String(motivo || '').trim().slice(0, 200) || null,
        };

    const entrada = actualizarEnRegistro(
      id,
      cambios,
      activa ? 'reactivada desde el panel' : 'suspendida desde el panel' + (cambios.suspendida_motivo ? ': ' + cambios.suspendida_motivo : '')
    );
    if (!entrada) throw error(404, 'No existe la licencia ' + id + '.');

    console.log('[licencias] ' + id + ' -> ' + cambios.estado + (cambios.suspendida_motivo ? ' (' + cambios.suspendida_motivo + ')' : ''));

    responder(res, {
      licencia_id: entrada.licencia_id,
      cliente: entrada.cliente,
      estado: entrada.estado,
      suspendida_motivo: entrada.suspendida_motivo,
    });
  })
);

/**
 * Cambia los modulos de un cliente.
 *
 * Es lo que permite vender por partes: el mismo sistema, con reportes o sin
 * ellos. El cambio llega al cliente en la siguiente consulta; no hay que
 * reinstalar nada.
 */
app.post(
  '/api/admin/clientes/:licencia/modulos',
  admin,
  envolver(async (req, res) => {
    const id = String(req.params.licencia).toUpperCase();
    const pedidos = Array.isArray((req.body || {}).modulos) ? req.body.modulos : null;
    if (!pedidos) throw error(400, 'Indique la lista de módulos.');

    // Solo se aceptan modulos que existan: un nombre mal escrito dejaria al
    // cliente con un modulo que nunca se activa y nadie sabria por que.
    const desconocidos = pedidos.filter((m) => lic.MODULOS.indexOf(m) === -1);
    if (desconocidos.length) {
      throw error(400, 'Estos módulos no existen: ' + desconocidos.join(', ') +
        '. Los válidos son: ' + lic.MODULOS.join(', ') + '.');
    }

    const entrada = actualizarEnRegistro(
      id,
      { modulos: pedidos.slice() },
      'módulos cambiados desde el panel: ' + (pedidos.join(', ') || 'ninguno')
    );
    if (!entrada) throw error(404, 'No existe la licencia ' + id + '.');

    console.log('[licencias] ' + id + ' módulos -> ' + (pedidos.join(', ') || 'ninguno'));

    responder(res, {
      licencia_id: entrada.licencia_id,
      cliente: entrada.cliente,
      modulos: entrada.modulos,
    });
  })
);

/** El historial de un cliente, para ver que ha pasado con su licencia. */
app.get(
  '/api/admin/clientes/:licencia/historial',
  admin,
  envolver(async (req, res) => {
    const id = String(req.params.licencia).toUpperCase();
    const entrada = leerRegistro().find((l) => String(l.licencia_id).toUpperCase() === id);
    if (!entrada) throw error(404, 'No existe la licencia ' + id + '.');
    responder(res, { licencia_id: entrada.licencia_id, cliente: entrada.cliente, historial: entrada.historial || [] });
  })
);

/* ------------------------------------------------------------------ */
/* Interfaz de administracion                                          */
/* ------------------------------------------------------------------ */

app.use(express.static(path.join(config.raiz, 'public-licencias')));
app.get('*', (req, res) => {
  const index = path.join(config.raiz, 'public-licencias', 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.type('html').send(
    '<!doctype html><meta charset="utf-8"><title>VisitaFlow — servidor de licencias</title>' +
      '<body style="font-family:system-ui;max-width:44rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6">' +
      '<h1>Servidor de licencias VisitaFlow</h1>' +
      '<p>El servicio está en marcha. La consola web todavía no está instalada en esta copia.</p>' +
      '<p>Se puede usar por API con el encabezado <code>Authorization: Bearer &lt;ADMIN_TOKEN&gt;</code>:</p>' +
      '<ul>' +
      '<li><code>GET /api/salud</code></li>' +
      '<li><code>GET /api/llave-publica</code></li>' +
      '<li><code>GET /api/admin/licencias</code></li>' +
      '<li><code>POST /api/admin/licencias</code> { tenant, cliente, dias, modulos, limites }</li>' +
      '<li><code>POST /api/admin/licencias/:tenant/renovar</code> { dias }</li>' +
      '<li><code>GET /api/admin/licencias/:tenant/archivo</code></li>' +
      '<li><code>POST /api/licencia/consultar</code> { tenant, licencia_id, huella }</li>' +
      '</ul></body>'
  );
});

/* Se corrige el nombre de la funcion envoltorio, que quedó mal escrito arriba. */
function envolver(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((e) => responderError(res, e));
  };
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

const PUERTO = util.entero(process.env.PUERTO_LICENCIAS, 4100, 1, 65535);

function comprobarLlaves() {
  try {
    const id = lic.keyId();
    lic.llavePrivada();
    console.log('[licencias] llave privada disponible, key_id ' + id);

    /* Se avisa si falta el token de instalacion, porque sin el las rutas de
       renovacion y de aviso responden 401 y el sintoma que se ve desde fuera es que
       "la licencia no se renueva", que apunta a otro sitio. */
    if (!tokenActivacion()) {
      console.warn('');
      console.warn('  AVISO: falta LICENCIA_TOKEN_ACTIVACION.');
      console.warn('  Sin ese token, las instalaciones de sus clientes NO podran renovar su');
      console.warn('  licencia ni avisar que se activaron: recibiran un 401. La activacion por');
      console.warn('  ID sigue funcionando. El mismo valor va aqui y en cada instalacion.');
      console.warn('');
    } else {
      console.log('[licencias] token de instalación configurado (' + tokenActivacion().length + ' caracteres)');
    }
    return true;
  } catch (e) {
    console.error('');
    console.error('  El servidor de licencias necesita el par de llaves.');
    console.error('  ' + e.message);
    console.error('');
    console.error('  Genere el par con:  npm run keys:gen');
    console.error('  En el VPS, la privada se pasa por variable de entorno:');
    console.error('    LICENCIA_LLAVE_PRIVADA_B64=<privada.pem en base64>');
    console.error('');
    return false;
  }
}

if (require.main === module) {
  if (!comprobarLlaves()) process.exit(1);

  const token = process.env.ADMIN_TOKEN || config.adminToken;
  if (!token) {
    console.warn('[licencias] AVISO: ADMIN_TOKEN vacío. Las rutas de administración responderán 503 hasta que se configure.');
  }

  http.createServer(app).listen(PUERTO, config.servidor.host, () => {
    console.log('');
    console.log('  VisitaFlow — servidor de licencias');
    console.log('  ─────────────────────────────────────────────');
    console.log('  Dirección : http://localhost:' + PUERTO);
    console.log('  Registro  : ' + REGISTRO);
    console.log('  key_id    : ' + lic.keyId());
    console.log('');
  });
}

module.exports = { app };
