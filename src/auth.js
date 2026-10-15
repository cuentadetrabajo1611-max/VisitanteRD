/**
 * VisitaFlow - Sesiones, contrasenas y permisos efectivos.
 *
 * El token de sesion lleva tres cosas: el usuario, la institucion (tenant) y el
 * rol. El tenant NUNCA se toma del cuerpo de la peticion ni de una cabecera que
 * el navegador pueda inventar: sale de aqui, de un token firmado. Eso es lo que
 * impide que una institucion consulte los datos de otra cambiando un numero.
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const bcrypt = require(path.join(config.raiz, 'node_modules', 'bcryptjs'));
const jwt = require(path.join(config.raiz, 'node_modules', 'jsonwebtoken'));

const { consultar } = require('./db');
const permisos = require('./permisos');

const INTENTOS_ANTES_DE_BLOQUEAR = 6;
const MINUTOS_BLOQUEO = 15;

/* ------------------------------------------------------------------ */
/* Contrasenas                                                         */
/* ------------------------------------------------------------------ */

const REGLAS_CLAVE = [
  { prueba: (c) => c.length >= 8, mensaje: 'debe tener al menos 8 caracteres' },
  { prueba: (c) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(c), mensaje: 'debe incluir al menos una letra' },
  { prueba: (c) => /[0-9]/.test(c), mensaje: 'debe incluir al menos un número' },
];

/** Revisa una contrasena y devuelve la lista de problemas (vacia si esta bien). */
function revisarClave(clave) {
  const texto = String(clave || '');
  return REGLAS_CLAVE.filter((r) => !r.prueba(texto)).map((r) => r.mensaje);
}

async function cifrarClave(clave) {
  return bcrypt.hash(String(clave), 10);
}

async function comprobarClave(clave, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(clave), String(hash));
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

/**
 * Firma el token de sesion.
 * @param {{id:number,nombre:string,correo:string,rol:string}} usuario
 * @param {number} tenantId
 */
function firmarToken(usuario, tenantId) {
  return jwt.sign(
    {
      uid: usuario.id,
      tid: tenantId,
      rol: usuario.rol,
      nombre: usuario.nombre,
      correo: usuario.correo,
    },
    config.sesion.secreto,
    { expiresIn: config.sesion.expira, issuer: 'visitaflow' }
  );
}

function verificarToken(token) {
  return jwt.verify(token, config.sesion.secreto, { issuer: 'visitaflow' });
}

/* ------------------------------------------------------------------ */
/* Permisos efectivos                                                  */
/* ------------------------------------------------------------------ */

/**
 * Permisos de un usuario: los del rol, segun lo guardado en la base para ese
 * tenant. Si la tabla no tiene nada para el rol, se usa el catalogo por defecto.
 * El admin siempre tiene todo.
 */
async function permisosDe(tenantId, rol) {
  if (rol === 'admin') return permisos.PERMISOS.map((p) => p.clave);

  const r = await consultar(
    'SELECT permiso FROM vf_rol_permisos WHERE tenant_id = @tenant_id AND rol = @rol',
    { tenant_id: tenantId, rol }
  );
  if (!r.recordset.length) return permisos.porRol(rol);
  return r.recordset.map((f) => f.permiso);
}

/* ------------------------------------------------------------------ */
/* Inicio de sesion                                                    */
/* ------------------------------------------------------------------ */

/**
 * Busca al usuario por correo dentro de una institucion.
 * El correo puede repetirse entre instituciones distintas: por eso el codigo de
 * la institucion es parte del inicio de sesion.
 */
async function buscarUsuario(codigoTenant, correo) {
  const r = await consultar(
    `SELECT u.id, u.tenant_id, u.correo, u.clave_hash, u.nombre, u.rol, u.activo,
            u.intentos, u.bloqueado_hasta, u.sede_id,
            t.codigo AS tenant_codigo, t.nombre AS tenant_nombre, t.estado AS tenant_estado
       FROM vf_usuarios u
       JOIN vf_tenants t ON t.id = u.tenant_id
      WHERE t.codigo = @codigo AND u.correo = @correo`,
    { codigo: codigoTenant, correo }
  );
  return r.recordset[0] || null;
}

/**
 * Inicia sesion. Devuelve { ok, token, usuario, permisos } o { ok:false, motivo }.
 * Lleva la cuenta de los intentos fallidos y bloquea temporalmente la cuenta.
 */
async function iniciarSesion({ tenant, correo, clave, ip, agente }) {
  const usuario = await buscarUsuario(tenant, String(correo || '').trim().toLowerCase());

  // Mensaje unico para usuario inexistente y clave mala: no se le dice a nadie
  // que correos existen en el sistema.
  const generico = { ok: false, motivo: 'Usuario o contraseña incorrectos.' };

  if (!usuario) return generico;

  if (usuario.tenant_estado !== 'activo') {
    return { ok: false, motivo: 'La institución está suspendida. Contacte al proveedor.' };
  }

  if (!usuario.activo) {
    return { ok: false, motivo: 'Este usuario está desactivado.' };
  }

  if (usuario.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > new Date()) {
    const minutos = Math.max(1, Math.ceil((new Date(usuario.bloqueado_hasta) - Date.now()) / 60000));
    return { ok: false, motivo: 'Demasiados intentos fallidos. Vuelva a intentar en ' + minutos + ' minuto(s).' };
  }

  const correcta = await comprobarClave(clave, usuario.clave_hash);

  if (!correcta) {
    const intentos = (usuario.intentos || 0) + 1;
    const bloquear = intentos >= INTENTOS_ANTES_DE_BLOQUEAR;
    await consultar(
      `UPDATE vf_usuarios
          SET intentos = @intentos,
              bloqueado_hasta = @bloqueado_hasta,
              actualizado = SYSDATETIMEOFFSET()
        WHERE id = @id`,
      {
        id: usuario.id,
        intentos: bloquear ? 0 : intentos,
        bloqueado_hasta: bloquear ? new Date(Date.now() + MINUTOS_BLOQUEO * 60000) : null,
      }
    );
    if (bloquear) {
      return {
        ok: false,
        motivo: 'Demasiados intentos fallidos. La cuenta queda bloqueada por ' + MINUTOS_BLOQUEO + ' minutos.',
      };
    }
    return generico;
  }

  await consultar(
    `UPDATE vf_usuarios
        SET intentos = 0, bloqueado_hasta = NULL, ultimo_acceso = SYSDATETIMEOFFSET(), ultima_ip = @ip
      WHERE id = @id`,
    { id: usuario.id, ip: ip || null }
  );

  const misPermisos = await permisosDe(usuario.tenant_id, usuario.rol);

  return {
    ok: true,
    token: firmarToken(usuario, usuario.tenant_id),
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      correo: usuario.correo,
      rol: usuario.rol,
      tenant_id: usuario.tenant_id,
      tenant: usuario.tenant_codigo,
      tenant_nombre: usuario.tenant_nombre,
      sede_id: usuario.sede_id,
    },
    permisos: misPermisos,
  };
}

/* ------------------------------------------------------------------ */
/* Recuperacion de contrasena                                          */
/* ------------------------------------------------------------------ */

/** Genera el token de recuperacion y lo guarda. Devuelve el token. */
async function crearTokenRecuperacion(tenant, correo, minutosValidez) {
  const usuario = await buscarUsuario(tenant, String(correo || '').trim().toLowerCase());
  if (!usuario) return null; // quien llama responde igual, para no revelar correos

  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + (minutosValidez || 60) * 60000);
  await consultar(
    'UPDATE vf_usuarios SET reset_token = @token, reset_expira = @expira WHERE id = @id',
    { id: usuario.id, token, expira }
  );
  return { token, usuario };
}

/** Cambia la contrasena usando un token de recuperacion valido. */
async function usarTokenRecuperacion(token, claveNueva) {
  const problemas = revisarClave(claveNueva);
  if (problemas.length) return { ok: false, motivo: 'La contraseña ' + problemas.join(', ') + '.' };

  const r = await consultar(
    `SELECT id, tenant_id FROM vf_usuarios
      WHERE reset_token = @token AND reset_expira > SYSDATETIMEOFFSET()`,
    { token },
    { tipos: { token: null } }
  );
  const usuario = r.recordset[0];
  if (!usuario) return { ok: false, motivo: 'El enlace de recuperación no es válido o ya venció.' };

  const hash = await cifrarClave(claveNueva);
  await consultar(
    `UPDATE vf_usuarios
        SET clave_hash = @hash, reset_token = NULL, reset_expira = NULL,
            intentos = 0, bloqueado_hasta = NULL, actualizado = SYSDATETIMEOFFSET()
      WHERE id = @id`,
    { id: usuario.id, hash }
  );
  return { ok: true, tenant_id: usuario.tenant_id };
}

/* ------------------------------------------------------------------ */
/* Primer arranque                                                     */
/* ------------------------------------------------------------------ */

/**
 * ¿Esta instalacion todavia no tiene ninguna institucion?
 *
 * Sirve para el PRIMER ARRANQUE, y es un caso que hay que tratar aparte: sin
 * licencia no hay institucion, y sin institucion no hay ningun usuario, asi que
 * no hay forma de iniciar sesion. Si activar la licencia exigiera sesion, un
 * despliegue nuevo quedaria bloqueado para siempre: nadie podria activarlo.
 *
 * La condicion es estricta a proposito: en cuanto existe UNA institucion, la
 * activacion vuelve a exigir sesion y permiso. La puerta se abre una sola vez,
 * en una instalacion vacia, y lo que entra por ella es un archivo firmado que
 * se verifica antes de guardar nada.
 */
async function esPrimerArranque() {
  try {
    const r = await consultar('SELECT COUNT(*) AS n FROM vf_tenants');
    return r.recordset[0].n === 0;
  } catch (e) {
    // Si la tabla no existe todavia (base sin crear), tampoco hay institucion.
    return true;
  }
}

module.exports = {
  PERMISOS: permisos.PERMISOS,
  REGLAS_CLAVE,
  revisarClave,
  cifrarClave,
  comprobarClave,
  firmarToken,
  verificarToken,
  permisosDe,
  buscarUsuario,
  iniciarSesion,
  crearTokenRecuperacion,
  usarTokenRecuperacion,
  esPrimerArranque,
};
