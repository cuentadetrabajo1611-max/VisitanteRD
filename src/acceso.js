/**
 * VisitaFlow - Intermediarios (middleware) de acceso.
 *
 * Aqui vive la garantia de aislamiento entre instituciones:
 *
 *   sesion -> saca el usuario del token firmado
 *   institucion -> fija req.tenant_id DESDE EL TOKEN, nunca del navegador
 *   exigePermiso -> comprueba el permiso concreto
 *   exigeModulo -> comprueba que la licencia habilite ese modulo
 *
 * Ninguna ruta del sistema lee el tenant de la peticion. Por eso cambiar un
 * numero en el cuerpo o en la direccion no da acceso a datos de otra
 * institucion: el filtro siempre sale del token.
 */
'use strict';

const path = require('path');
const config = require('./config');
const auth = require('./auth');
const bd = require('./db');
const util = require('./util');
const mantenimiento = require('./mantenimiento');

/* ------------------------------------------------------------------ */
/* Sesion                                                              */
/* ------------------------------------------------------------------ */

/**
 * Extrae el token de la peticion.
 *
 * El orden importa: primero el encabezado Authorization y despues la cookie.
 * Si se leyera la cookie primero, una cookie vieja ganaria sobre el token que el
 * cliente acaba de recibir al entrar, y el usuario veria la sesion anterior.
 * Este detalle costo un rato encontrarlo: el sintoma era que la sesion recien
 * iniciada no traia el tenant_id.
 */
function tokenDe(req) {
  const cabecera = req.headers.authorization;
  if (cabecera && cabecera.startsWith('Bearer ')) {
    const t = cabecera.slice(7).trim();
    if (t) return t;
  }
  if (req.headers['x-visitaflow-token']) {
    const t = String(req.headers['x-visitaflow-token']).trim();
    if (t) return t;
  }
  if (req.cookies && req.cookies.vf_token) return req.cookies.vf_token;
  return null;
}

/** Exige una sesion valida. Deja req.usuario, req.tenant_id y req.permisos. */
async function sesion(req, res, next) {
  try {
    const token = tokenDe(req);
    if (!token) throw util.error(401, 'Necesita iniciar sesión.');

    let datos;
    try {
      datos = auth.verificarToken(token);
    } catch (e) {
      throw util.error(401, e.name === 'TokenExpiredError' ? 'Su sesión expiró. Vuelva a entrar.' : 'Su sesión no es válida.');
    }

    // Se comprueba contra la base en cada peticion: asi, desactivar a un
    // operador o suspender una institucion surte efecto de inmediato y no hay
    // que esperar a que venza su token.
    const r = await bd.consultar(
      `SELECT u.id, u.tenant_id, u.correo, u.nombre, u.rol, u.activo, u.sede_id,
              t.codigo AS tenant, t.nombre AS tenant_nombre, t.estado AS tenant_estado
         FROM vf_usuarios u
         JOIN vf_tenants t ON t.id = u.tenant_id
        WHERE u.id = @id`,
      { id: datos.uid }
    );

    const u = r.recordset[0];
    if (!u) throw util.error(401, 'Su usuario ya no existe.');
    if (!u.activo) throw util.error(403, 'Su usuario está desactivado.');
    if (u.tenant_estado !== 'activo') throw util.error(403, 'La institución está suspendida.');

    req.usuario = { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol, sede_id: u.sede_id, tenant_id: u.tenant_id };
    req.tenant_id = u.tenant_id;
    req.tenant = { codigo: u.tenant, nombre: u.tenant_nombre };
    req.permisos = await auth.permisosDe(u.tenant_id, u.rol);

    next();
  } catch (e) {
    util.responderError(res, e);
  }
}

/**
 * Igual que sesion(), pero sin exigirla: si hay token se resuelve el usuario y
 * si no, sigue. Se usa en las rutas publicas que cambian de forma segun haya
 * sesion (por ejemplo, la marca de la institucion).
 */
async function sesionOpcional(req, res, next) {
  const token = tokenDe(req);
  if (!token) return next();
  try {
    const datos = auth.verificarToken(token);
    const r = await bd.consultar(
      `SELECT u.id, u.tenant_id, u.correo, u.nombre, u.rol, u.activo, u.sede_id,
              t.codigo AS tenant, t.nombre AS tenant_nombre, t.estado AS tenant_estado
         FROM vf_usuarios u JOIN vf_tenants t ON t.id = u.tenant_id WHERE u.id = @id`,
      { id: datos.uid }
    );
    const u = r.recordset[0];
    if (u && u.activo && u.tenant_estado === 'activo') {
      req.usuario = { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol, sede_id: u.sede_id, tenant_id: u.tenant_id };
      req.tenant_id = u.tenant_id;
      req.tenant = { codigo: u.tenant, nombre: u.tenant_nombre };
      req.permisos = await auth.permisosDe(u.tenant_id, u.rol);
    }
  } catch (e) {
    /* token vencido o invalido: se sigue como anonimo */
  }
  next();
}

/* ------------------------------------------------------------------ */
/* Permisos                                                            */
/* ------------------------------------------------------------------ */

/** Exige un permiso concreto. */
function exigePermiso(clave) {
  return (req, res, next) => {
    if (!req.usuario) return util.responderError(res, util.error(401, 'Necesita iniciar sesión.'));
    const tiene = req.usuario.rol === 'admin' || (req.permisos || []).includes(clave);
    if (!tiene) {
      return util.responderError(
        res,
        util.error(403, 'Su usuario no tiene el permiso "' + clave + '".')
      );
    }
    next();
  };
}

/** Exige uno de varios permisos. */
function exigeAlguno(claves) {
  return (req, res, next) => {
    if (!req.usuario) return util.responderError(res, util.error(401, 'Necesita iniciar sesión.'));
    if (req.usuario.rol === 'admin') return next();
    const tiene = claves.some((c) => (req.permisos || []).includes(c));
    if (!tiene) return util.responderError(res, util.error(403, 'Su usuario no tiene permiso para esta operación.'));
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Licencia                                                            */
/* ------------------------------------------------------------------ */

/**
 * Inyecta el estado de la licencia en cada peticion y bloquea las operaciones
 * comerciales cuando la licencia no permite operar.
 *
 * Decision de producto: una licencia vencida de verdad NO borra nada ni impide
 * consultar ni exportar. Lo que hace es impedir dar de alta informacion nueva,
 * para que la institucion pueda recuperar sus datos y regularizarse.
 */
function licencia(gestor) {
  return (req, res, next) => {
    const estado = gestor.estado();
    req.licencia = estado;

    // Rutas que siempre pasan: salud, licencia, acceso y estaticos.
    const ruta = req.path;
    const siempreAbiertas =
      ruta.startsWith('/api/salud') ||
      ruta.startsWith('/api/licencia') ||
      ruta.startsWith('/api/acceso') ||
      ruta.startsWith('/api/marca') ||
      !ruta.startsWith('/api/');
    if (siempreAbiertas) return next();

    if (estado.valida) return next();

    // Sin licencia valida solo se permite leer, nunca escribir.
    const soloLectura = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (soloLectura) return next();

    return util.responderError(
      res,
      util.error(402, estado.motivo || 'La licencia no permite esta operación.', {
        estado: estado.estado,
        licencia: estado.licencia ? { hasta: estado.licencia.hasta, cliente: estado.licencia.cliente } : null,
      })
    );
  };
}

/** Exige que la licencia habilite un modulo. */
function exigeModulo(gestor, nombre) {
  return (req, res, next) => {
    if (gestor.tieneModulo(nombre)) return next();
    return util.responderError(
      res,
      util.error(402, 'Su licencia no incluye el módulo "' + nombre + '".', { modulo: nombre })
    );
  };
}

/* ------------------------------------------------------------------ */
/* Limite de usuarios de la licencia                                   */
/* ------------------------------------------------------------------ */

/** Comprueba que quepa un usuario mas segun el limite de la licencia. */
async function cabeUsuario(gestor, tenantId) {
  const estado = gestor.estado();
  const limite = estado.licencia && estado.licencia.limites ? estado.licencia.limites.usuarios : 0;
  if (!limite) return { ok: true };
  const activos = await mantenimiento.usuariosActivos(tenantId);
  if (activos >= limite) {
    return {
      ok: false,
      motivo: 'Su licencia permite ' + limite + ' usuario(s) activo(s) y ya están en uso. Desactive uno o amplíe la licencia.',
    };
  }
  return { ok: true, activos, limite };
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

/**
 * Lector de cookies propio: se evita una dependencia mas para algo que son
 * quince lineas. Solo se necesita leer, no firmar.
 */
function cookies(req, res, next) {
  const cabecera = req.headers.cookie;
  req.cookies = {};
  if (cabecera) {
    for (const parte of String(cabecera).split(';')) {
      const i = parte.indexOf('=');
      if (i < 0) continue;
      const nombre = parte.slice(0, i).trim();
      const valor = parte.slice(i + 1).trim();
      if (nombre) req.cookies[nombre] = decodeURIComponent(valor);
    }
  }
  next();
}

module.exports = {
  sesion,
  sesionOpcional,
  exigePermiso,
  exigeAlguno,
  licencia,
  exigeModulo,
  cabeUsuario,
  cookies,
  tokenDe,
};
