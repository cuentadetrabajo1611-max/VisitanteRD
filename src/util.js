/**
 * VisitaFlow - Utilidades compartidas.
 */
'use strict';

const crypto = require('crypto');

/**
 * Envuelve un manejador de ruta para que los errores no tumben el servidor y
 * para que todas las respuestas de error tengan la misma forma.
 */
function asincrono(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Error con codigo HTTP, para responder con el estado correcto. */
class ErrorHttp extends Error {
  constructor(codigo, mensaje, detalles) {
    super(mensaje);
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

function error(codigo, mensaje, detalles) {
  return new ErrorHttp(codigo, mensaje, detalles);
}

/** Respuesta de error uniforme. */
function responderError(res, e) {
  const codigo = e instanceof ErrorHttp ? e.codigo : 500;
  const cuerpo = { ok: false, mensaje: e.message || 'Error inesperado.' };
  if (e.detalles) cuerpo.detalles = e.detalles;
  if (codigo >= 500) console.error('[visitaflow]', e);
  res.status(codigo).json(cuerpo);
}

/**
 * Responde con exito. Se usa una sola forma en todo el sistema:
 *   { ok: true, ...datos }
 */
function responder(res, datos, codigo) {
  res.status(codigo || 200).json(Object.assign({ ok: true }, datos || {}));
}

/* ------------------------------------------------------------------ */
/* Texto                                                               */
/* ------------------------------------------------------------------ */

/** Quita acentos y pasa a mayusculas, para comparar y para el padron. */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** Recorta y devuelve null si queda vacio. */
function limpiar(valor, maximo) {
  if (valor === null || valor === undefined) return null;
  let t = String(valor).trim();
  if (!t) return null;
  if (maximo && t.length > maximo) t = t.slice(0, maximo);
  return t;
}

/** Titulo con iniciales en mayuscula, respetando el resto. */
function titulo(texto) {
  const t = limpiar(texto);
  if (!t) return null;
  return t
    .toLowerCase()
    .split(/\s+/)
    .map((p) => (p.length > 2 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(' ');
}

/** Correo valido y en minusculas. */
function correo(valor) {
  const t = limpiar(valor, 200);
  if (!t) return null;
  const c = t.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c)) return null;
  return c;
}

/** Entero, con valor por defecto y limites. */
function entero(valor, porDefecto, minimo, maximo) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return porDefecto;
  const r = Math.trunc(n);
  if (minimo !== undefined && r < minimo) return minimo;
  if (maximo !== undefined && r > maximo) return maximo;
  return r;
}

/** Booleano tolerante: acepta 1, "true", "si", "on". */
function booleano(valor, porDefecto) {
  if (valor === undefined || valor === null || valor === '') return porDefecto;
  if (typeof valor === 'boolean') return valor;
  return ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(String(valor).toLowerCase());
}

/** Color hexadecimal, con valor por defecto si no sirve. */
function color(valor, porDefecto) {
  const t = limpiar(valor, 9);
  if (!t) return porDefecto;
  const c = t.startsWith('#') ? t : '#' + t;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c)) return porDefecto;
  // Se expande #abc a #aabbcc para que el CSS y el calculo de contraste no
  // tengan que tratar dos formatos.
  if (c.length === 4) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  return c.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Contraste de color                                                  */
/* ------------------------------------------------------------------ */

function aRgb(hex) {
  const c = color(hex, '#000000');
  return {
    r: parseInt(c.slice(1, 3), 16),
    g: parseInt(c.slice(3, 5), 16),
    b: parseInt(c.slice(5, 7), 16),
  };
}

/** Luminancia relativa segun WCAG. */
function luminancia(hex) {
  const { r, g, b } = aRgb(hex);
  const canal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

/** Razon de contraste entre dos colores (1 a 21). */
function contraste(a, b) {
  const l1 = luminancia(a);
  const l2 = luminancia(b);
  const mayor = Math.max(l1, l2);
  const menor = Math.min(l1, l2);
  return (mayor + 0.05) / (menor + 0.05);
}

/**
 * Devuelve el color de texto que mejor contrasta sobre un fondo.
 * Esto es lo que permite respetar la marca de la institucion sin sacrificar la
 * legibilidad: si pintan el menu de amarillo claro, el texto se vuelve oscuro.
 */
function textoSobre(fondo, claro, oscuro) {
  const c = contraste(fondo, claro || '#ffffff');
  const o = contraste(fondo, oscuro || '#0f172a');
  return c >= o ? claro || '#ffffff' : oscuro || '#0f172a';
}

/** Aclara u oscurece un color. cantidad: -1 a 1. */
function mezclar(hex, cantidad) {
  const { r, g, b } = aRgb(hex);
  const destino = cantidad >= 0 ? 255 : 0;
  const k = Math.abs(cantidad);
  const f = (v) => Math.round(v + (destino - v) * k);
  return '#' + [f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Fechas                                                              */
/* ------------------------------------------------------------------ */

/** Fecha de hoy en la zona de la institucion, como YYYY-MM-DD. */
function hoyISO(zona) {
  return new Date().toLocaleDateString('en-CA', { timeZone: zona || 'America/Santo_Domingo' });
}

/** Fecha a texto legible. */
function fechaLegible(valor, zona) {
  if (!valor) return null;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('es-DO', {
    timeZone: zona || 'America/Santo_Domingo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Convierte a Date un valor de SQL Server, respetando null. */
function aFecha(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Fecha como YYYY-MM-DD, para viajar en JSON.
 *
 * Ojo: el driver de SQL Server devuelve las columnas DATE como objeto Date, no
 * como texto. Cortar los primeros diez caracteres de un Date da "Mon Nov 10",
 * que es un dato inservible. Aqui se convierte de verdad.
 */
function fechaISO(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  // Se usan los componentes UTC: las columnas DATE no tienen hora ni zona, y
  // pasarlas a local las correria un dia en zonas con desfase negativo.
  return (
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

/** Fecha y hora como YYYY-MM-DD HH:MM, para viajar en JSON. */
function fechaHoraISO(valor) {
  const d = aFecha(valor);
  if (!d) return null;
  return fechaISO(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** Duracion en minutos entre dos fechas. */
function minutosEntre(desde, hasta) {
  const a = aFecha(desde);
  const b = aFecha(hasta);
  if (!a || !b) return null;
  return Math.max(0, Math.round((b - a) / 60000));
}

/** Duracion como "1 h 25 min". */
function duracionLegible(minutos) {
  if (minutos === null || minutos === undefined) return null;
  const m = Number(minutos);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? h + ' h ' + r + ' min' : h + ' h';
}

/* ------------------------------------------------------------------ */
/* Codigos                                                             */
/* ------------------------------------------------------------------ */

/* Alfabeto sin O/0 ni I/1: el codigo se dicta por telefono y se lee en un
   gafete impreso, asi que conviene que no haya caracteres confundibles. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Codigo legible de 8 caracteres, con guion: KRT-4821. */
function codigoLegible(prefijo) {
  const bytes = crypto.randomBytes(7);
  let cuerpo = '';
  for (let i = 0; i < 7; i++) cuerpo += ALFABETO[bytes[i] % ALFABETO.length];
  const p = (prefijo || '').toUpperCase().slice(0, 3) || 'VF';
  return p + '-' + cuerpo.slice(0, 4);
}

/** Codigo de visita: VF-AAAAMMDD-XXXX. */
function codigoVisita(fecha) {
  const d = fecha ? new Date(fecha) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  const bytes = crypto.randomBytes(3);
  let sufijo = '';
  for (let i = 0; i < 4; i++) sufijo += ALFABETO[bytes[i % 3] % ALFABETO.length];
  return 'VF-' + y + m + dia + '-' + sufijo;
}

/** Token aleatorio en hexadecimal. */
function token(bytes) {
  return crypto.randomBytes(bytes || 24).toString('hex');
}

/* ------------------------------------------------------------------ */
/* Paginacion                                                          */
/* ------------------------------------------------------------------ */

/** Lee pagina y tamano de la consulta, con topes sanos. */
function paginacion(query) {
  const pagina = Math.max(1, entero(query.pagina, 1, 1, 100000));
  const tamano = Math.min(Math.max(entero(query.tamano, 25, 5), 5), 200);
  return { pagina, tamano, salto: (pagina - 1) * tamano };
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Genera CSV con BOM UTF-8, para que Excel respete los acentos al abrirlo.
 * Se usa punto y coma como separador porque Excel en espanol lo espera asi.
 */
function csv(filas, columnas, separador) {
  const sep = separador || ';';
  const escapar = (v) => {
    if (v === null || v === undefined) return '';
    const t = String(v);
    if (t.includes(sep) || t.includes('"') || t.includes('\n') || t.includes('\r')) {
      return '"' + t.replace(/"/g, '""') + '"';
    }
    return t;
  };

  const lineas = [columnas.map((c) => escapar(c.titulo)).join(sep)];
  for (const fila of filas) {
    lineas.push(columnas.map((c) => escapar(typeof c.valor === 'function' ? c.valor(fila) : fila[c.valor])).join(sep));
  }
  return '\ufeff' + lineas.join('\r\n') + '\r\n';
}

/** Encabezados para descargar un archivo. */
function descarga(res, nombre, contenido, tipo) {
  res.setHeader('Content-Type', (tipo || 'text/octet-stream') + '; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '"');
  // Se envia como Buffer, no como texto: el BOM del CSV tiene que llegar tal
  // cual a Excel. Con res.send(texto), Express lo reescribe y se pierde.
  res.send(Buffer.isBuffer(contenido) ? contenido : Buffer.from(String(contenido), 'utf8'));
}

/* ------------------------------------------------------------------ */
/* IP y agente                                                         */
/* ------------------------------------------------------------------ */

/**
 * IP real del cliente, teniendo en cuenta el proxy del VPS.
 *
 * Se comprueba que la peticion traiga encabezados antes de leerlos: hay sitios
 * (como la bitacora de un acceso fallido) donde se pasa un objeto minimo con
 * solo el usuario y la institucion, y sin esta comprobacion el registro de
 * auditoria fallaba con "Cannot read properties of undefined".
 */
function ip(req) {
  if (!req || !req.headers) {
    return (req && req.socket && req.socket.remoteAddress) || null;
  }
  const reenviada = req.headers['x-forwarded-for'];
  if (reenviada) return String(reenviada).split(',')[0].trim().slice(0, 60);
  return (req.socket && req.socket.remoteAddress) || null;
}

/** Navegador del cliente, recortado. */
function agente(req) {
  if (!req || !req.headers) return null;
  return limpiar(req.headers['user-agent'], 300);
}

module.exports = {
  asincrono,
  ErrorHttp,
  error,
  responder,
  responderError,
  normalizar,
  limpiar,
  titulo,
  correo,
  entero,
  booleano,
  color,
  contraste,
  textoSobre,
  mezclar,
  luminancia,
  hoyISO,
  fechaISO,
  fechaHoraISO,
  fechaLegible,
  aFecha,
  minutosEntre,
  duracionLegible,
  codigoLegible,
  codigoVisita,
  token,
  paginacion,
  csv,
  descarga,
  ip,
  agente,
  ALFABETO,
};
