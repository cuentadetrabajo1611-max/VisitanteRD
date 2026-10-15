/**
 * VisitaFlow - Nucleo del licenciamiento.
 *
 * Una licencia es un archivo de texto (extension .vflow) con este formato:
 *
 *   -----BEGIN VISITAFLOW LICENSE-----
 *   <base64url( JSON del contenido )>.<base64url( firma RSA-SHA256 )>
 *   -----END VISITAFLOW LICENSE-----
 *
 * El contenido va firmado con la llave PRIVADA, que solo existe en el servidor
 * de licencias. Cada instalacion trae incrustada la llave PUBLICA y verifica la
 * firma antes de aceptar la licencia. Por eso un cliente no puede extender una
 * fecha ni habilitar un modulo editando el archivo: la firma deja de coincidir.
 *
 * Este modulo lo usan los dos lados:
 *   - server-licencias.js  -> firmar (necesita la llave privada)
 *   - server.js            -> verificar (solo necesita la publica)
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CABECERA = '-----BEGIN VISITAFLOW LICENSE-----';
const PIE = '-----END VISITAFLOW LICENSE-----';

/** Modulos que una licencia puede habilitar. */
const MODULOS = [
  'registro',      // registrar visitantes (recepcion)
  'recepcion',     // entradas, salidas, visitantes dentro
  'gafetes',       // emision e impresion de gafetes
  'reportes',      // metricas, filtros y exportacion
  'preregistro',   // anunciar visitas antes de que lleguen
  'vigilancia',    // lista de bloqueados y observados
  'personalizacion', // logo, colores y plantillas propias
  'usuarios',      // operadores y permisos
  'api',           // API para otros sistemas
  'sincronizacion', // varias sedes o recepciones
];

/** Campos que identifican una licencia y no se pueden dejar vacios. */
const CAMPOS_OBLIGATORIOS = ['licencia_id', 'tenant', 'cliente', 'emitida', 'desde', 'hasta', 'key_id'];

/* ------------------------------------------------------------------ */
/* Base64 de URL (sin +, / ni =) para que quepa en una linea de texto  */
/* ------------------------------------------------------------------ */

function aBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64Url(txt) {
  const s = String(txt).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64');
}

/* ------------------------------------------------------------------ */
/* Canonicalizacion                                                    */
/* ------------------------------------------------------------------ */

/**
 * JSON con las claves ordenadas y sin espacios, para que la firma sea
 * reproducible bit a bit. Sin esto, dos JSON iguales podrian firmarse distinto
 * segun el orden en que el motor los recorra.
 */
function canonicalizar(valor) {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
  if (Array.isArray(valor)) return '[' + valor.map(canonicalizar).join(',') + ']';
  const claves = Object.keys(valor).sort();
  return '{' + claves.map((k) => JSON.stringify(k) + ':' + canonicalizar(valor[k])).join(',') + '}';
}

/* ------------------------------------------------------------------ */
/* Llaves                                                              */
/* ------------------------------------------------------------------ */

/**
 * Resuelve una llave PEM desde varias fuentes, en este orden:
 *   1. Variable de entorno con el PEM completo (saltos de linea como \n)
 *   2. Variable de entorno con el PEM en base64
 *   3. Archivo en disco
 * Devuelve null si no encuentra nada.
 */
function resolverLlave({ pemEnv, b64Env, archivo }) {
  if (pemEnv && process.env[pemEnv]) {
    return String(process.env[pemEnv]).replace(/\\n/g, '\n');
  }
  if (b64Env && process.env[b64Env]) {
    return deBase64Url(process.env[b64Env]).toString('utf8');
  }
  if (archivo && fs.existsSync(archivo)) {
    return fs.readFileSync(archivo, 'utf8');
  }
  return null;
}

/** Ruta absoluta de la carpeta donde viven las llaves (visitaflow/licencias-keys). */
const CARPETA_LLAVES = path.resolve(__dirname, '..', '..', 'licencias-keys');

function rutaLlaves(nombre) {
  return path.join(CARPETA_LLAVES, nombre);
}

/** Llave privada (solo el servidor de licencias la tiene). */
function llavePrivada() {
  const pem = resolverLlave({
    pemEnv: 'LICENCIA_LLAVE_PRIVADA_PEM',
    b64Env: 'LICENCIA_LLAVE_PRIVADA_B64',
    archivo: process.env.LICENCIA_LLAVE_PRIVADA_ARCHIVO || rutaLlaves('privada.pem'),
  });
  if (!pem) {
    throw new Error(
      'No se encontro la llave privada del licenciamiento. Genere el par con "npm run keys:gen" ' +
        'o defina LICENCIA_LLAVE_PRIVADA_PEM / LICENCIA_LLAVE_PRIVADA_B64.'
    );
  }
  return pem;
}

/** Llave publica (viaja dentro de cada instalacion). */
function llavePublica() {
  const pem = resolverLlave({
    pemEnv: 'LICENCIA_LLAVE_PUBLICA_PEM',
    b64Env: 'LICENCIA_LLAVE_PUBLICA_B64',
    archivo: process.env.LICENCIA_LLAVE_PUBLICA_ARCHIVO || rutaLlaves('publica.pem'),
  });
  if (!pem) {
    throw new Error(
      'No se encontro la llave publica del licenciamiento. Copie publica.pem a licencias-keys/ ' +
        'o defina LICENCIA_LLAVE_PUBLICA_PEM / LICENCIA_LLAVE_PUBLICA_B64.'
    );
  }
  return pem;
}

/** Identificador corto de la llave publica: viaja en cada licencia. */
function keyId(pemPublico) {
  const pem = pemPublico || llavePublica();
  return crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Emision                                                             */
/* ------------------------------------------------------------------ */

/**
 * Arma el contenido de una licencia. No firma: solo normaliza y valida.
 */
function construirContenido(datos) {
  const ahora = new Date();
  const contenido = {
    licencia_id: datos.licencia_id || 'LIC-' + ahora.getTime().toString(36).toUpperCase(),
    tenant: String(datos.tenant || '').trim().toLowerCase(),
    // tenant_nombre es solo una etiqueta para mostrar: puede caer al tenant.
    tenant_nombre: datos.tenant_nombre || datos.cliente || datos.tenant,
    // cliente es el nombre legal de quien contrata: NO se inventa a partir del
    // tenant, porque un identificador como "junta-prueba" no es un nombre.
    cliente: datos.cliente || datos.tenant_nombre || '',
    contacto: datos.contacto || null,
    key_id: datos.key_id || keyId(),
    emitida: datos.emitida || ahora.toISOString(),
    desde: datos.desde || ahora.toISOString(),
    hasta: datos.hasta,
    tipo: datos.tipo || 'periodo', // prueba | periodo | anual | permanente
    modulos: Array.isArray(datos.modulos) && datos.modulos.length ? datos.modulos.slice().sort() : MODULOS.slice(),
    limites: {
      usuarios: Number.isFinite(datos.limites && datos.limites.usuarios) ? datos.limites.usuarios : 5,
      instalaciones: Number.isFinite(datos.limites && datos.limites.instalaciones) ? datos.limites.instalaciones : 1,
      visitas_mes: Number.isFinite(datos.limites && datos.limites.visitas_mes) ? datos.limites.visitas_mes : 0,
    },
    // Huella de la maquina. Si viene, la licencia solo vale en ese equipo.
    huella: datos.huella || null,
    // Dias de gracia despues del vencimiento antes de bloquear la operacion.
    gracia_dias: Number.isFinite(datos.gracia_dias) ? datos.gracia_dias : 15,
    notas: datos.notas || null,
    version_formato: 1,
  };

  for (const campo of CAMPOS_OBLIGATORIOS) {
    if (!contenido[campo]) throw new Error('La licencia necesita el campo "' + campo + '"');
  }
  if (Number.isNaN(Date.parse(contenido.hasta))) {
    throw new Error('La fecha "hasta" no es valida: ' + contenido.hasta);
  }
  if (Date.parse(contenido.hasta) <= Date.parse(contenido.desde)) {
    throw new Error('La fecha "hasta" debe ser posterior a "desde"');
  }

  const desconocidos = contenido.modulos.filter((m) => !MODULOS.includes(m));
  if (desconocidos.length) throw new Error('Modulos desconocidos: ' + desconocidos.join(', '));

  return contenido;
}

/**
 * Firma el contenido y devuelve el texto del archivo de licencia.
 * Necesita la llave privada.
 */
function firmar(datos, opciones) {
  const opts = opciones || {};
  const contenido = construirContenido(datos);
  const carga = canonicalizar(contenido);
  const firma = crypto.sign('sha256', Buffer.from(carga, 'utf8'), {
    key: opts.llavePrivada || llavePrivada(),
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  const cuerpo = aBase64Url(Buffer.from(carga, 'utf8')) + '.' + aBase64Url(firma);
  const lineas = cuerpo.match(/.{1,76}/g) || [cuerpo];
  return CABECERA + '\n' + lineas.join('\n') + '\n' + PIE + '\n';
}

/* ------------------------------------------------------------------ */
/* Lectura y verificacion                                              */
/* ------------------------------------------------------------------ */

/** Extrae el contenido y la firma del texto de una licencia. */
function desarmar(texto) {
  const limpio = String(texto || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== CABECERA && l !== PIE)
    .join('');

  if (!limpio) throw new Error('El archivo de licencia esta vacio.');

  const partes = limpio.split('.');
  if (partes.length !== 2) {
    throw new Error('El archivo de licencia no tiene el formato esperado (contenido.firma).');
  }

  let contenido;
  try {
    contenido = JSON.parse(deBase64Url(partes[0]).toString('utf8'));
  } catch (e) {
    throw new Error('No se pudo leer el contenido de la licencia: ' + e.message);
  }

  const firma = deBase64Url(partes[1]);
  if (!firma.length) throw new Error('La licencia no trae firma.');

  // La firma se calcula sobre el JSON canonicalizado, no sobre el texto
  // recibido: asi el orden de las claves no importa.
  return { contenido, firma, cargaCanonica: canonicalizar(contenido) };
}

/**
 * Verifica la firma y devuelve el contenido. Lanza si la firma no cuadra.
 * Esta es la puerta que impide que alguien edite una licencia a mano.
 */
function verificarFirma(texto, opciones) {
  const opts = opciones || {};
  const { contenido, firma, cargaCanonica } = desarmar(texto);
  const publica = opts.llavePublica || llavePublica();

  const ok = crypto.verify(
    'sha256',
    Buffer.from(cargaCanonica, 'utf8'),
    { key: publica, padding: crypto.constants.RSA_PKCS1_PADDING },
    firma
  );

  if (!ok) {
    throw new Error(
      'La firma de la licencia NO es valida. El archivo fue modificado o fue emitido con otra llave.'
    );
  }

  const esperado = keyId(publica);
  if (contenido.key_id && contenido.key_id !== esperado) {
    throw new Error(
      'La licencia fue emitida con otra llave (key_id ' + contenido.key_id + ', esta instalacion usa ' + esperado + ').'
    );
  }

  return contenido;
}

/**
 * Estado completo de una licencia: firma, vigencia, huella y modulos.
 * Nunca lanza por vencimiento: devuelve el estado para que el sistema decida.
 */
function evaluar(texto, opciones) {
  const opts = opciones || {};
  const ahora = opts.ahora ? new Date(opts.ahora) : new Date();

  let contenido;
  try {
    contenido = verificarFirma(texto, opts);
  } catch (e) {
    return {
      valida: false,
      estado: 'invalida',
      motivo: e.message,
      contenido: null,
      dias_restantes: 0,
      en_gracia: false,
      vencida: false,
      modulos: [],
    };
  }

  const desde = Date.parse(contenido.desde);
  const hasta = Date.parse(contenido.hasta);
  const graciaDias = Number.isFinite(contenido.gracia_dias) ? contenido.gracia_dias : 15;
  const limiteGracia = hasta + graciaDias * 86400000;
  const t = ahora.getTime();

  const diasRestantes = Math.ceil((hasta - t) / 86400000);

  let estado = 'activa';
  let motivo = null;
  let enGracia = false;
  let vencida = false;

  if (t < desde) {
    estado = 'no_vigente';
    motivo = 'La licencia entra en vigencia el ' + new Date(desde).toISOString().slice(0, 10);
  } else if (t > limiteGracia) {
    estado = 'vencida';
    vencida = true;
    motivo = 'La licencia venció el ' + new Date(hasta).toISOString().slice(0, 10) + ' y el periodo de gracia terminó.';
  } else if (t > hasta) {
    estado = 'gracia';
    enGracia = true;
    motivo =
      'La licencia venció el ' +
      new Date(hasta).toISOString().slice(0, 10) +
      '. Quedan ' +
      Math.max(0, Math.ceil((limiteGracia - t) / 86400000)) +
      ' días de gracia.';
  } else if (diasRestantes <= (opts.aviso_dias || 30)) {
    estado = 'por_vencer';
    motivo = 'La licencia vence en ' + diasRestantes + ' días.';
  }

  // Huella de la maquina, cuando la licencia esta amarrada a un equipo.
  let huellaOk = true;
  if (contenido.huella && opts.huella) {
    huellaOk = String(contenido.huella).toLowerCase() === String(opts.huella).toLowerCase();
    if (!huellaOk) {
      estado = 'otro_equipo';
      motivo = 'Esta licencia está amarrada a otro equipo (huella ' + contenido.huella + ').';
    }
  }

  const valida = ['activa', 'por_vencer', 'gracia'].includes(estado) && huellaOk;

  return {
    valida,
    estado,
    motivo,
    contenido,
    dias_restantes: diasRestantes,
    en_gracia: enGracia,
    vencida,
    huella_ok: huellaOk,
    modulos: contenido.modulos || [],
  };
}

/** Lee un archivo .vflow y lo evalua. */
function evaluarArchivo(ruta, opciones) {
  const texto = fs.readFileSync(ruta, 'utf8');
  return Object.assign(evaluar(texto, opciones), { archivo: ruta });
}

/** Resumen legible, para imprimir por consola o mostrar en pantalla. */
function resumenLegible(evaluacion) {
  const c = evaluacion.contenido;
  const lineas = [];
  lineas.push('Estado      : ' + evaluacion.estado.toUpperCase() + (evaluacion.valida ? ' (valida)' : ' (NO valida)'));
  if (evaluacion.motivo) lineas.push('Detalle     : ' + evaluacion.motivo);
  if (c) {
    lineas.push('Licencia    : ' + c.licencia_id);
    lineas.push('Cliente     : ' + c.cliente + '  (tenant ' + c.tenant + ')');
    lineas.push('Vigencia    : ' + c.desde.slice(0, 10) + ' -> ' + c.hasta.slice(0, 10) + '  [' + c.tipo + ']');
    lineas.push('Dias restantes: ' + evaluacion.dias_restantes);
    lineas.push('Modulos     : ' + (c.modulos || []).join(', '));
    lineas.push(
      'Limites     : ' +
        c.limites.usuarios +
        ' usuarios, ' +
        c.limites.instalaciones +
        ' instalacion(es), ' +
        (c.limites.visitas_mes ? c.limites.visitas_mes + ' visitas/mes' : 'visitas sin limite')
    );
    if (c.huella) lineas.push('Amarrada a : ' + c.huella);
  }
  return lineas.join('\n');
}

module.exports = {
  CABECERA,
  PIE,
  MODULOS,
  CAMPOS_OBLIGATORIOS,
  CARPETA_LLAVES,
  aBase64Url,
  deBase64Url,
  canonicalizar,
  llavePrivada,
  llavePublica,
  keyId,
  construirContenido,
  firmar,
  desarmar,
  verificarFirma,
  evaluar,
  evaluarArchivo,
  resumenLegible,
};
